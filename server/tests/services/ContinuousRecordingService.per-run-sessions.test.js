/**
 * Per-run recording sessions (ADR-0028): every startRecording() run must own
 * a distinct session id (recording_<date>_<epochMs>), a distinct on-disk dir,
 * and a distinct recording_sessions row — and stopRecording() must drive the
 * run's row to its terminal state and emit that run's id.
 *
 * Pattern reused from ContinuousRecordingService.viewbot-gate.test.js: mock
 * the DB module before require, real service instance, collaborators stubbed
 * directly on the instance.
 */

jest.mock('../../database/database', () => ({
  getAsync: jest.fn().mockResolvedValue(undefined),
  runAsync: jest.fn().mockResolvedValue(undefined),
  allAsync: jest.fn().mockResolvedValue([]),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const ContinuousRecordingService = require('../../services/ContinuousRecordingService');
const RecordingSessionStore = require('../../services/recording/RecordingSessionStore');

function makeService(outputDir) {
  const service = new ContinuousRecordingService({
    apiKey: 'k',
    apiSecret: 's',
    outputDir,
  });
  let egressSeq = 0;
  service.egressClient = {
    startParticipantEgress: jest.fn().mockImplementation(async () => ({ egressId: `eg-${++egressSeq}` })),
    startRoomCompositeEgress: jest.fn().mockImplementation(async () => ({ egressId: `eg-${++egressSeq}` })),
    stopEgress: jest.fn().mockResolvedValue(undefined),
  };
  service.listActiveEgress = jest.fn().mockResolvedValue([]);
  service.sessionStore = {
    createSessionRecord: jest.fn().mockResolvedValue({ success: true }),
    updateSessionRecord: jest.fn().mockResolvedValue({ success: true }),
    endAllOpenSegments: jest.fn().mockResolvedValue(undefined),
    trackStreamIdentityChange: jest.fn().mockResolvedValue(undefined),
  };
  return service;
}

describe('ContinuousRecordingService per-run sessions (ADR-0028)', () => {
  let outputDir;
  let service;

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perrun-'));
    service = makeService(outputDir);
  });

  afterEach(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  test('two same-day runs get distinct ids, dirs, and session rows; stop emits the run id', async () => {
    const stopEvents = [];
    service.on('recording-stopped', (e) => stopEvents.push(e));

    const r1 = await service.startRecording('alice');
    expect(r1.success).toBe(true);
    const id1 = r1.sessionId;
    expect(id1).toMatch(/^recording_\d{4}-\d{2}-\d{2}_\d+$/);
    expect(fs.existsSync(path.join(outputDir, id1))).toBe(true);

    await service.stopRecording();
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0].sessionId).toBe(id1);
    expect(stopEvents[0].endTime).toEqual(expect.any(Number));
    expect(service.sessionStore.updateSessionRecord).toHaveBeenCalledWith(
      id1, expect.any(Number), expect.any(Number)
    );

    // Same UTC day, later start — must be a NEW session, not the day bucket.
    await new Promise((r) => setTimeout(r, 5)); // ensure a different epoch
    const r2 = await service.startRecording('alice');
    expect(r2.success).toBe(true);
    const id2 = r2.sessionId;
    expect(id2).not.toBe(id1);
    expect(id2).toMatch(/^recording_\d{4}-\d{2}-\d{2}_\d+$/);
    expect(fs.existsSync(path.join(outputDir, id2))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, id1))).toBe(true); // first run's dir immutable

    expect(service.sessionStore.createSessionRecord).toHaveBeenCalledTimes(2);
    expect(service.sessionStore.createSessionRecord.mock.calls[0][0]).toBe(id1);
    expect(service.sessionStore.createSessionRecord.mock.calls[1][0]).toBe(id2);
  });

  test('the run id embeds the run-start epoch (what the disk scanner parses for age)', async () => {
    const before = Date.now();
    const { sessionId } = await service.startRecording('alice');
    const after = Date.now();
    const epoch = parseInt(sessionId.split('_')[2], 10);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(after);
  });
});

describe('RecordingSessionStore terminal state (ADR-0028)', () => {
  test('updateSessionRecord drives the run to markSessionCompleted after updating end fields', async () => {
    const calls = [];
    const recordingRepository = {
      getSessionStartTime: jest.fn().mockResolvedValue({ start_time: 1000 }),
      updateSessionEnd: jest.fn().mockImplementation(async () => calls.push('end')),
      markSessionCompleted: jest.fn().mockImplementation(async () => calls.push('completed')),
    };
    const store = new RecordingSessionStore({
      recordingRepository, userRepository: {}, inspector: {}, owner: {},
    });

    const res = await store.updateSessionRecord('recording_2026-07-14_1752480000000', 5000, 7);

    expect(res.success).toBe(true);
    expect(recordingRepository.updateSessionEnd).toHaveBeenCalledWith(
      'recording_2026-07-14_1752480000000',
      { endTime: 5000, durationMs: 4000, segmentCount: 7 }
    );
    expect(recordingRepository.markSessionCompleted).toHaveBeenCalledWith('recording_2026-07-14_1752480000000');
    expect(calls).toEqual(['end', 'completed']); // terminal state only after end fields land
  });

  test('a failed end-update does not mark the session completed', async () => {
    const recordingRepository = {
      getSessionStartTime: jest.fn().mockResolvedValue({ start_time: 1000 }),
      updateSessionEnd: jest.fn().mockRejectedValue(new Error('db down')),
      markSessionCompleted: jest.fn(),
    };
    const store = new RecordingSessionStore({
      recordingRepository, userRepository: {}, inspector: {}, owner: {},
    });

    const res = await store.updateSessionRecord('recording_2026-07-14_1752480000000', 5000, 7);

    expect(res.success).toBe(false);
    expect(recordingRepository.markSessionCompleted).not.toHaveBeenCalled();
  });
});
