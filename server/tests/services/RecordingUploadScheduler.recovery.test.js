/**
 * Upload recovery + retry-backoff semantics (ADR-0028, audit R3).
 *
 * The old loadPendingUploads selected WHERE status = 'completed' — a status
 * the retired per-day session model never wrote — so a restart recovered
 * nothing, forever. Recovery is now status-agnostic (b2_file_id IS NULL AND
 * end_time IS NOT NULL) and ADDITIVE: re-discovery must never overwrite an
 * in-queue entry, or a failed upload's +30min backoff collapses into a tight
 * retry loop (re-derived end_time+buffer is long past due).
 */

jest.mock('../../database/database', () => ({
  runAsync: jest.fn().mockResolvedValue({}),
  getAsync: jest.fn().mockResolvedValue(undefined),
  allAsync: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../services/B2StorageService', () => ({
  isEnabled: jest.fn(() => true),
  processAndUploadSession: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAsync, getAsync, allAsync } = require('../../database/database');
const b2Storage = require('../../services/B2StorageService');
const RecordingUploadScheduler = require('../../services/RecordingUploadScheduler');

describe('RecordingUploadScheduler recovery (ADR-0028)', () => {
  let scheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    b2Storage.isEnabled.mockReturnValue(true);
    scheduler = new RecordingUploadScheduler({ localBufferHours: 2 });
  });

  afterEach(() => scheduler.stop());

  test('recovery is status-agnostic: picks up finished, un-archived rows whatever their label', async () => {
    allAsync.mockResolvedValue([
      { session_id: 'recording_2026-07-13_100', end_time: 100, status: 'recording' },   // legacy stuck row
      { session_id: 'recording_2026-07-13_200', end_time: 200, status: 'processing' },  // crashed mid-upload
      { session_id: 'recording_2026-07-14_300', end_time: 300, status: 'completed' },   // normal terminal
    ]);

    await scheduler.loadPendingUploads();

    const twoHours = 2 * 60 * 60 * 1000;
    expect(scheduler.uploadQueue.get('recording_2026-07-13_100')).toBe(100 + twoHours);
    expect(scheduler.uploadQueue.get('recording_2026-07-13_200')).toBe(200 + twoHours);
    expect(scheduler.uploadQueue.get('recording_2026-07-14_300')).toBe(300 + twoHours);

    const [sql] = allAsync.mock.calls[0];
    expect(sql).toMatch(/b2_file_id IS NULL/);
    expect(sql).toMatch(/end_time IS NOT NULL/);
  });

  test('re-discovery is ADDITIVE: an in-queue backoff entry is never overwritten', async () => {
    const backoffTime = Date.now() + 30 * 60 * 1000;
    scheduler.uploadQueue.set('recording_2026-07-14_400', backoffTime);
    allAsync.mockResolvedValue([
      { session_id: 'recording_2026-07-14_400', end_time: 400, status: 'completed' },
    ]);

    await scheduler.loadPendingUploads();

    expect(scheduler.uploadQueue.get('recording_2026-07-14_400')).toBe(backoffTime);
  });

  test('a failed upload keeps its +30min backoff across the next discovery tick', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uprec-'));
    try {
      const sessionId = 'recording_2026-07-14_500';
      const endTime = Date.now() - 3 * 60 * 60 * 1000; // past the 2h buffer → due now
      const row = {
        session_id: sessionId, end_time: endTime, status: 'completed',
        b2_file_id: null, local_path: sessionDir,
      };
      allAsync.mockResolvedValue([row]);
      getAsync.mockResolvedValue(row);
      b2Storage.processAndUploadSession.mockResolvedValue({ success: false, error: 'B2 5xx' });

      // Tick 1: discovered, due, upload fails → rescheduled ~now+30min.
      await scheduler.processPendingUploads();
      expect(b2Storage.processAndUploadSession).toHaveBeenCalledTimes(1);
      const backoff = scheduler.uploadQueue.get(sessionId);
      expect(backoff).toBeGreaterThan(Date.now() + 29 * 60 * 1000);

      // Tick 2: discovery re-runs but must not clobber the backoff or retry early.
      await scheduler.processPendingUploads();
      expect(b2Storage.processAndUploadSession).toHaveBeenCalledTimes(1); // no tight retry
      expect(scheduler.uploadQueue.get(sessionId)).toBe(backoff);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('a successful upload marks the row uploaded and leaves the queue', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uprec-'));
    const sessionId = 'recording_2026-07-14_600';
    const endTime = Date.now() - 3 * 60 * 60 * 1000;
    const row = {
      session_id: sessionId, end_time: endTime, status: 'completed',
      b2_file_id: null, local_path: sessionDir,
      streamer_identity: 'alice', streamer_username: 'alice',
      start_time: endTime - 1000, duration_ms: 1000, segment_count: 3,
    };
    allAsync.mockResolvedValue([row]);
    getAsync.mockResolvedValue(row);
    b2Storage.processAndUploadSession.mockResolvedValue({
      success: true, fileId: 'f1', fileName: 'n1', fileSize: 42,
    });

    await scheduler.processPendingUploads();

    expect(scheduler.uploadQueue.has(sessionId)).toBe(false);
    const uploadedWrite = runAsync.mock.calls.find(([sql]) => /status = 'uploaded'/.test(sql));
    expect(uploadedWrite).toBeDefined();
    expect(uploadedWrite[1]).toEqual(['f1', 'n1', 42, sessionId]);
    // Success path also cleaned up the local dir.
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  test('stays fully dormant when B2 is off', async () => {
    b2Storage.isEnabled.mockReturnValue(false);
    scheduler.start();
    expect(scheduler.checkInterval).toBeNull();
    scheduler.scheduleUpload('recording_2026-07-14_700', Date.now());
    expect(scheduler.uploadQueue.size).toBe(0);
  });
});
