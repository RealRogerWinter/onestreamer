/**
 * Characterization tests for server/routes/admin-recordings.js
 *
 * These PIN the CURRENT observable behavior of the admin-review route surface
 * (status codes, response shapes, and that the expected repository/service
 * methods are invoked with the expected args) so that the route-module
 * decomposition that follows can be kept green without behavior drift.
 *
 * The module instantiates its repositories + reads the db/B2 singletons at
 * require-time, so those collaborators are jest.mock()'d. The real
 * authenticateAdmin middleware is mocked to a configurable pass-through; one
 * test flips it to the real reject behavior to pin the auth gate.
 */

// --- Mock collaborators BEFORE requiring the route under test ---------------

// authenticateAdmin: configurable. Default pass-through; can be made to reject.
let mockAuthBehavior = 'pass';
jest.mock('../../middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => {
    if (mockAuthBehavior === 'reject') {
      return res.status(401).json({ error: 'Access token required' });
    }
    req.user = { id: 'admin-1', userId: 'admin-1' };
    return next();
  },
}));

// database singletons: the route uses allAsync/getAsync/runAsync directly for
// the cross-table reads (timeline + chat-stream). Repos also receive these but
// are themselves mocked below, so these stand in only for the inline queries.
const mockAllAsync = jest.fn();
const mockGetAsync = jest.fn();
const mockRunAsync = jest.fn();
jest.mock('../../database/database', () => ({
  allAsync: (...a) => mockAllAsync(...a),
  getAsync: (...a) => mockGetAsync(...a),
  runAsync: (...a) => mockRunAsync(...a),
}));

// Repositories: each constructor returns a shared mock instance so the test
// can assert on the methods the handlers call.
const mockRecordingRepo = {
  countSessionsForAdmin: jest.fn(),
  listSessionsForAdmin: jest.fn(),
  getSessionById: jest.fn(),
  countAllSessions: jest.fn(),
  countSessionsByStatus: jest.fn(),
  listSessionsWithLocalPathBasic: jest.fn(),
  listSessionsWithLocalPathFull: jest.fn(),
  listSessionsWithLocalPathIdsOnly: jest.fn(),
  listStreamSegmentsSince: jest.fn(),
  getSessionLocalPath: jest.fn(),
};
const mockChatRepo = {
  listBySession: jest.fn(),
  countBySessionIds: jest.fn(),
};
const mockSettingsRepo = {
  listAll: jest.fn(),
  upsertSetting: jest.fn(),
};
jest.mock('../../database/repository/ContinuousRecordingRepository', () =>
  jest.fn().mockImplementation(() => mockRecordingRepo)
);
jest.mock('../../database/repository/SessionChatMessageRepository', () =>
  jest.fn().mockImplementation(() => mockChatRepo)
);
jest.mock('../../database/repository/AdminReviewSettingsRepository', () =>
  jest.fn().mockImplementation(() => mockSettingsRepo)
);

// B2 storage singleton.
const mockB2 = {
  isEnabled: jest.fn().mockReturnValue(false),
  getSignedUrl: jest.fn(),
};
jest.mock('../../services/B2StorageService', () => mockB2);

// fs: only the file-serving / disk-counting routes touch it. Default to
// "nothing on disk" so those paths exercise their 404 / empty branches.
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn().mockReturnValue(''),
  statSync: jest.fn().mockReturnValue({ size: 0 }),
  createReadStream: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const adminRecordingsRouter = require('../../routes/admin-recordings');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/review', adminRecordingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe('routes/admin-recordings (characterization)', () => {
  let app;
  const services = {
    uploadScheduler: { forceUpload: jest.fn(), getStatus: jest.fn() },
    cleanupScheduler: { deleteSessionById: jest.fn(), getStatus: jest.fn() },
    chatCaptureService: { getStatus: jest.fn() },
  };

  beforeAll(() => {
    adminRecordingsRouter.setServices(services);
    app = buildApp();
  });

  beforeEach(() => {
    mockAuthBehavior = 'pass';
    jest.clearAllMocks();
    mockB2.isEnabled.mockReturnValue(false);
  });

  // --- Group: sessions list/detail -----------------------------------------

  test('GET /sessions returns paginated, formatted sessions', async () => {
    mockRecordingRepo.countSessionsForAdmin.mockResolvedValue({ count: 1 });
    mockRecordingRepo.listSessionsForAdmin.mockResolvedValue([
      {
        session_id: 's1',
        streamer_identity: 'id1',
        streamer_username: 'bob',
        start_time: 100,
        end_time: 200,
        duration_ms: 100,
        status: 'uploaded',
        segment_count: 5,
        chat_message_count: 3,
        file_size_bytes: 999,
        b2_file_id: 'b2id',
        created_at: 50,
      },
    ]);

    const res = await request(app).get('/admin/review/sessions?page=2&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sessions).toEqual([
      {
        sessionId: 's1',
        streamerIdentity: 'id1',
        streamerUsername: 'bob',
        startTime: 100,
        endTime: 200,
        durationMs: 100,
        status: 'uploaded',
        segmentCount: 5,
        chatMessageCount: 3,
        fileSizeBytes: 999,
        hasB2Upload: true,
        createdAt: 50,
      },
    ]);
    expect(res.body.pagination).toEqual({
      page: 2,
      limit: 10,
      totalCount: 1,
      totalPages: 1,
    });
    // offset = (page-1)*limit = 10
    expect(mockRecordingRepo.listSessionsForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 10 })
    );
  });

  test('GET /sessions/:sessionId returns 404 when missing', async () => {
    mockRecordingRepo.getSessionById.mockResolvedValue(null);

    const res = await request(app).get('/admin/review/sessions/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Session not found' });
    expect(mockRecordingRepo.getSessionById).toHaveBeenCalledWith('nope');
  });

  test('GET /sessions/:sessionId returns mapped session detail', async () => {
    mockRecordingRepo.getSessionById.mockResolvedValue({
      session_id: 's2',
      streamer_identity: 'id2',
      streamer_username: 'al',
      streamer_user_id: 'u2',
      start_time: 1,
      end_time: 2,
      duration_ms: 1,
      status: 'recording',
      local_path: '/tmp/s2',
      b2_file_id: null,
      b2_file_name: null,
      file_size_bytes: 0,
      segment_count: 0,
      chat_message_count: 0,
      metadata_json: '{"k":"v"}',
      created_at: 0,
      updated_at: 0,
    });

    const res = await request(app).get('/admin/review/sessions/s2');

    expect(res.status).toBe(200);
    expect(res.body.session.sessionId).toBe('s2');
    expect(res.body.session.metadata).toEqual({ k: 'v' });
  });

  // --- Group: video / stream / segment (filesystem) ------------------------

  test('GET /sessions/:sessionId/video returns 404 when no video available', async () => {
    mockRecordingRepo.getSessionById.mockResolvedValue({
      session_id: 's3',
      b2_file_name: null,
      local_path: null,
    });

    const res = await request(app).get('/admin/review/sessions/s3/video');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Video file not available' });
  });

  test('GET /segment/:sessionId/:filename returns 404 when session has no path', async () => {
    mockRecordingRepo.getSessionLocalPath.mockResolvedValue(null);

    const res = await request(app).get('/admin/review/segment/s4/seg.ts');

    expect(res.status).toBe(404);
    expect(mockRecordingRepo.getSessionLocalPath).toHaveBeenCalledWith('s4');
  });

  // --- S6: path-traversal confinement --------------------------------------
  test('GET /segment/:sessionId/:filename rejects a traversal filename with 400', async () => {
    mockRecordingRepo.getSessionLocalPath.mockResolvedValue({ local_path: '/rec/s6' });

    // encoded ../../../../etc/passwd — express decodes it into the :filename param
    const res = await request(app).get('/admin/review/segment/s6/..%2f..%2f..%2f..%2fetc%2fpasswd');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Invalid segment filename' });
  });

  test('GET /sessions/:sessionId/stream?file= rejects a traversal file with 400', async () => {
    mockRecordingRepo.getSessionById.mockResolvedValue({ session_id: 's6', local_path: '/rec/s6' });

    const res = await request(app)
      .get('/admin/review/sessions/s6/stream')
      .query({ file: '../../../../etc/passwd' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Invalid segment filename' });
  });

  // --- Group: chat ---------------------------------------------------------

  test('GET /sessions/:sessionId/chat returns mapped messages with flags', async () => {
    mockChatRepo.listBySession.mockResolvedValue([
      {
        id: 1,
        username: 'u',
        message: 'hi',
        color: '#fff',
        relative_time_ms: -50,
        absolute_time_ms: 950,
        is_system: 1,
      },
    ]);

    const res = await request(app).get('/admin/review/sessions/s5/chat?fromMs=10&toMs=20');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.messages[0]).toEqual({
      id: 1,
      username: 'u',
      message: 'hi',
      color: '#fff',
      relative_time_ms: -50,
      absolute_time_ms: 950,
      isSystem: true,
      isContext: true,
    });
    expect(mockChatRepo.listBySession).toHaveBeenCalledWith('s5', { fromMs: 10, toMs: 20 });
  });

  // (P2.3/R10: the clips group was deleted with its endpoint — POST
  // /sessions/:sessionId/clip never worked: it called the nonexistent
  // ClipService.checkRateLimit and passed sessionId where the method
  // expected recordingPath.)

  // --- Group: delete / upload (schedulers) ---------------------------------

  test('DELETE /sessions/:sessionId delegates to cleanupScheduler', async () => {
    services.cleanupScheduler.deleteSessionById.mockResolvedValue({ success: true, deleted: 's7' });

    const res = await request(app).delete('/admin/review/sessions/s7');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 's7' });
    expect(services.cleanupScheduler.deleteSessionById).toHaveBeenCalledWith('s7');
  });

  test('POST /sessions/:sessionId/upload delegates to uploadScheduler.forceUpload', async () => {
    services.uploadScheduler.forceUpload.mockResolvedValue({ success: true, uploaded: 's8' });

    const res = await request(app).post('/admin/review/sessions/s8/upload');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, uploaded: 's8' });
    expect(services.uploadScheduler.forceUpload).toHaveBeenCalledWith('s8');
  });

  // --- Group: settings -----------------------------------------------------

  test('GET /settings merges repo settings with b2 + scheduler status', async () => {
    mockSettingsRepo.listAll.mockResolvedValue([{ key: 'retention_days', value: '5' }]);
    services.cleanupScheduler.getStatus.mockResolvedValue({ running: true });
    services.uploadScheduler.getStatus.mockReturnValue({ queued: 0 });
    mockB2.isEnabled.mockReturnValue(true);

    const res = await request(app).get('/admin/review/settings');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings.retention_days).toBe('5');
    expect(res.body.settings.b2Enabled).toBe(true);
    expect(res.body.settings.cleanupStatus).toEqual({ running: true });
    expect(res.body.settings.uploadStatus).toEqual({ queued: 0 });
  });

  test('PUT /settings clamps + upserts provided settings', async () => {
    mockSettingsRepo.upsertSetting.mockResolvedValue();

    const res = await request(app)
      .put('/admin/review/settings')
      .send({ retention_days: 99, upload_enabled: true, local_buffer_hours: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Settings updated' });
    // retention clamped to max 7
    expect(mockSettingsRepo.upsertSetting).toHaveBeenCalledWith('retention_days', '7');
    expect(mockSettingsRepo.upsertSetting).toHaveBeenCalledWith('upload_enabled', 'true');
    // local_buffer_hours clamped to min 1
    expect(mockSettingsRepo.upsertSetting).toHaveBeenCalledWith('local_buffer_hours', '1');
  });

  // --- Group: status -------------------------------------------------------

  test('GET /status aggregates session counts + chat capture status', async () => {
    mockRecordingRepo.countAllSessions.mockResolvedValue({ count: 10 });
    mockRecordingRepo.countSessionsByStatus
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 4 });
    services.chatCaptureService.getStatus.mockReturnValue({ activeSessions: ['a'], sessionCount: 1 });

    const res = await request(app).get('/admin/review/status');

    expect(res.status).toBe(200);
    expect(res.body.status).toEqual({
      totalSessions: 10,
      activeSessions: 2,
      uploadedSessions: 4,
      b2Enabled: false,
      chatCapture: { activeSessions: ['a'], sessionCount: 1 },
    });
    expect(mockRecordingRepo.countSessionsByStatus).toHaveBeenCalledWith('recording');
    expect(mockRecordingRepo.countSessionsByStatus).toHaveBeenCalledWith('uploaded');
  });

  // --- Group: timeline / playback / master-stream (continuous) -------------

  test('GET /timeline returns empty timeline when no recording sessions', async () => {
    mockRecordingRepo.listSessionsWithLocalPathBasic.mockResolvedValue([]);

    const res = await request(app).get('/admin/review/timeline');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.timeline.events).toEqual([]);
    expect(res.body.timeline.recordings).toEqual([]);
  });

  test('GET /playback reports hasRecordings=false when none on disk', async () => {
    mockRecordingRepo.listSessionsWithLocalPathFull.mockResolvedValue([]);

    const res = await request(app).get('/admin/review/playback');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      hasRecordings: false,
      message: 'No recordings available',
    });
  });

  test('GET /master-stream returns 404 when no sessions with local paths', async () => {
    mockRecordingRepo.listSessionsWithLocalPathIdsOnly.mockResolvedValue([]);

    const res = await request(app).get('/admin/review/master-stream');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'No recordings available' });
  });

  test('GET /chat-stream maps inline-query rows to message shape', async () => {
    mockAllAsync.mockResolvedValue([
      {
        id: 7,
        session_id: 's9',
        username: 'cc',
        message: 'yo',
        color: '#0f0',
        absolute_time_ms: 4242,
        relative_time_ms: 42,
        is_system: 0,
      },
    ]);

    const res = await request(app).get('/admin/review/chat-stream?fromMs=1&toMs=9&limit=5');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.messages[0]).toEqual({
      id: 7,
      sessionId: 's9',
      username: 'cc',
      message: 'yo',
      color: '#0f0',
      timestamp: 4242,
      relativeMs: 42,
      isSystem: false,
    });
    expect(mockAllAsync).toHaveBeenCalled();
  });

  // --- Group: auth gate ----------------------------------------------------

  test('rejects with 401 when authenticateAdmin denies', async () => {
    mockAuthBehavior = 'reject';

    const res = await request(app).get('/admin/review/sessions');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Access token required' });
    // Handler never reached: repository not queried.
    expect(mockRecordingRepo.countSessionsForAdmin).not.toHaveBeenCalled();
  });
});
