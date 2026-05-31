/**
 * Characterization tests for the routes defined in server/routes/viewbot-admin.js
 * (the ViewBot HTTP admin bridge factory `createViewBotAdminRouter(deps)`).
 *
 * These PIN the CURRENT HTTP behavior (status codes, response shapes, and which
 * injected service method is invoked with which args) of a REPRESENTATIVE
 * endpoint from each route group, so that a follow-up decomposition into
 * cohesive sub-route modules can be verified as behavior-preserving.
 *
 * DI reality being characterized:
 *   - The module exports a FACTORY: `createViewBotAdminRouter(deps)` returning an
 *     express.Router(). Every dependency (auth middleware, services, getters,
 *     io, logger, etc.) arrives in the `deps` bag — there is NO app.locals /
 *     req.app.get usage. So tests inject plain jest mocks straight into the bag.
 *   - The three lazy services (viewbotService, viewBotClientService,
 *     viewBotWebRTCService) are reached through getter functions
 *     (getViewbotService / getViewBotClientService / getViewBotWebRTCService).
 *     When a getter returns falsy, every guarded handler short-circuits with a
 *     503 { error: '<Service> not initialized' } — pinned below.
 *   - Auth middleware (adminKeyAuth / viewBotAuth / authenticateAdmin) is passed
 *     in via the bag. We supply pass-through stubs that record which guard fired,
 *     and one test flips a stub to 401 to pin the auth-gating contract.
 *   - The router internally `require('./viewbot-diagnostics')`, which pulls in
 *     the real middleware/auth (needs JWT_SECRET). We jest.mock that module so
 *     the suite loads without env setup; this does not affect the endpoints
 *     under test (they all live directly on the parent router).
 */

const express = require('express');
const request = require('supertest');

// Avoid loading the real middleware/auth (requires JWT_SECRET at import time)
// via the transitive require('./viewbot-diagnostics') inside the router.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, _res, next) => next()),
  authenticateAdmin: jest.fn((req, _res, next) => next()),
}));

const createViewBotAdminRouter = require('../../routes/viewbot-admin');

// --- Auth stubs -------------------------------------------------------------
const authState = { rejectViewBotAuth: false };

const adminKeyAuth = jest.fn((req, _res, next) => { req._guard = 'adminKeyAuth'; next(); });
const viewBotAuth = jest.fn((req, res, next) => {
  if (authState.rejectViewBotAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req._guard = 'viewBotAuth';
  next();
});
const authenticateAdmin = jest.fn((req, _res, next) => { req._guard = 'authenticateAdmin'; next(); });

// --- Lazy service mocks -----------------------------------------------------
let viewbotService;
let viewBotClientService;
let viewBotWebRTCService;

// --- Other deps -------------------------------------------------------------
const streamService = {
  setStreamer: jest.fn(),
  getCurrentStreamer: jest.fn(() => null),
  clearStreamer: jest.fn(),
};
const sessionService = { linkUserToSocket: jest.fn(), getUserIdBySocketId: jest.fn() };
const mediasoupService = { currentStreamer: null };
const testStreamService = {
  startTestStream: jest.fn(),
  stopTestStream: jest.fn(),
  getTestStreamStatus: jest.fn(() => ({ isActive: false })),
  getTestStreamMetrics: jest.fn(() => ({})),
  updateTestStreamConfig: jest.fn(),
  generateTestFrame: jest.fn(),
};
const mediaStreamService = { stopIngestion: jest.fn() };
const buffNotifier = { streamerBuffsUpdate: jest.fn() };
const streamNotifier = { streamEnded: jest.fn() };
const viewerCountNotifier = { broadcast: jest.fn() };
const cleanupViewbotUsername = jest.fn();
const broadcastGlobalCooldown = jest.fn().mockResolvedValue(undefined);
const notifyViewersStreamEnded = jest.fn();
const io = { emit: jest.fn() };
const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
const ADMIN_KEY = 'test-admin-key';
const upload = { single: () => (req, _res, next) => next() };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(
    createViewBotAdminRouter({
      adminKeyAuth,
      viewBotAuth,
      authenticateAdmin,
      streamService,
      mediasoupService,
      sessionService,
      testStreamService,
      mediaStreamService,
      buffNotifier,
      streamNotifier,
      viewerCountNotifier,
      cleanupViewbotUsername,
      broadcastGlobalCooldown,
      notifyViewersStreamEnded,
      io,
      ADMIN_KEY,
      upload,
      uploadsDir: '/tmp/uploads',
      path: require('path'),
      logger,
      getViewbotService: () => viewbotService,
      getViewBotClientService: () => viewBotClientService,
      getViewBotWebRTCService: () => viewBotWebRTCService,
    })
  );
  return app;
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  authState.rejectViewBotAuth = false;
  streamService.getCurrentStreamer.mockReturnValue(null);
  viewbotService = {
    startViewbot: jest.fn().mockResolvedValue({ success: false }),
    stopViewbot: jest.fn(),
    getViewbotStatus: jest.fn(() => ({ running: false })),
    getViewbotMetrics: jest.fn(() => ({ count: 0 })),
    isHealthy: jest.fn(() => ({ healthy: true })),
    updateViewbotConfig: jest.fn(() => ({ success: true })),
    spawnAdditionalViewbot: jest.fn(),
    removeViewbot: jest.fn(),
    isViewbotStream: jest.fn(() => false),
  };
  viewBotClientService = {
    createBot: jest.fn(),
    createStreamerBot: jest.fn(),
    startBotStreaming: jest.fn(),
    stopBotStreaming: jest.fn(),
    destroyAllBots: jest.fn(),
    destroyBot: jest.fn(),
    getAllBotsStatus: jest.fn(),
    getBotStatus: jest.fn(() => ({ id: 'b1', streaming: false })),
    updateBotConfig: jest.fn(),
    updateBotName: jest.fn(),
    getHealthStatus: jest.fn(() => ({ healthy: true })),
    validateRealStreamerStatus: jest.fn(),
    getRotationStatus: jest.fn(() => ({ enabled: true, currentLiveBot: null })),
    setRealStreamerStatus: jest.fn(() => ({ success: true })),
    getStreamingMethod: jest.fn(() => ({ method: 'ffmpeg' })),
    setStreamingMethod: jest.fn(),
    activeBots: new Map(),
  };
  viewBotWebRTCService = {
    createViewBot: jest.fn(),
    startViewBot: jest.fn(),
    stopViewBot: jest.fn(),
    listViewBots: jest.fn(() => []),
  };
  app = buildApp();
});

describe('viewbot-admin router — characterization', () => {
  // --- GROUP: viewbot CRUD (adminKeyAuth) -----------------------------------
  test('GET /admin/viewbot/status returns {status,metrics,health} from viewbotService', async () => {
    const res = await request(app).get('/admin/viewbot/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: { running: false },
      metrics: { count: 0 },
      health: { healthy: true },
    });
    expect(viewbotService.getViewbotStatus).toHaveBeenCalledTimes(1);
    expect(adminKeyAuth).toHaveBeenCalled();
  });

  test('POST /admin/viewbot/config forwards req.body to updateViewbotConfig', async () => {
    const res = await request(app)
      .post('/admin/viewbot/config')
      .send({ density: 42 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(viewbotService.updateViewbotConfig).toHaveBeenCalledWith({ density: 42 });
  });

  test('GET /admin/viewbot/status returns 503 when viewbotService getter is falsy', async () => {
    viewbotService = null;
    app = buildApp();
    const res = await request(app).get('/admin/viewbot/status');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'ViewbotService not initialized' });
    expect(viewerCountNotifier.broadcast).not.toHaveBeenCalled();
  });

  // --- GROUP: test-stream (adminKeyAuth) ------------------------------------
  test('GET /admin/test-stream/status returns {status,metrics} from testStreamService', async () => {
    const res = await request(app).get('/admin/test-stream/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: { isActive: false }, metrics: {} });
    expect(testStreamService.getTestStreamStatus).toHaveBeenCalled();
  });

  test('GET /admin/test-stream/frame returns 400 when stream not active', async () => {
    testStreamService.getTestStreamStatus.mockReturnValue({ isActive: false });
    const res = await request(app).get('/admin/test-stream/frame');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Test stream is not active' });
    expect(testStreamService.generateTestFrame).not.toHaveBeenCalled();
  });

  // --- GROUP: viewbot-client (viewBotAuth / authenticateAdmin) --------------
  test('POST /admin/viewbot-client/create forwards flat body as config to createBot', async () => {
    viewBotClientService.createBot.mockResolvedValue({ success: true, botId: 'abc' });
    const res = await request(app)
      .post('/admin/viewbot-client/create')
      .send({ contentType: 'videoFile', autoStart: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, botId: 'abc' });
    expect(viewBotClientService.createBot).toHaveBeenCalledWith({
      contentType: 'videoFile',
      autoStart: true,
    });
    expect(viewBotAuth).toHaveBeenCalled();
  });

  test('GET /admin/viewbot-client/:botId/status is guarded by authenticateAdmin', async () => {
    const res = await request(app).get('/admin/viewbot-client/bot-7/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'b1', streaming: false });
    expect(viewBotClientService.getBotStatus).toHaveBeenCalledWith('bot-7');
    expect(authenticateAdmin).toHaveBeenCalled();
    expect(viewBotAuth).not.toHaveBeenCalled();
  });

  // --- GROUP: streaming-method (viewBotAuth) --------------------------------
  test('GET /admin/viewbot-client/streaming-method returns getStreamingMethod result', async () => {
    const res = await request(app).get('/admin/viewbot-client/streaming-method');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: 'ffmpeg' });
    expect(viewBotClientService.getStreamingMethod).toHaveBeenCalledTimes(1);
  });

  test('POST /admin/viewbot-client/streaming-method rejects invalid method with 400', async () => {
    const res = await request(app)
      .post('/admin/viewbot-client/streaming-method')
      .send({ method: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid streaming method. Must be "ffmpeg" or "gstreamer"',
    });
    expect(viewBotClientService.setStreamingMethod).not.toHaveBeenCalled();
  });

  // --- GROUP: rotation control ----------------------------------------------
  test('POST /admin/viewbot-client/rotation/force calls forceRotation', async () => {
    viewBotClientService.forceRotation = jest.fn().mockResolvedValue({ rotated: true });
    const res = await request(app).post('/admin/viewbot-client/rotation/force');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rotated: true });
    expect(viewBotClientService.forceRotation).toHaveBeenCalledTimes(1);
  });

  // --- GROUP: webrtc (viewBotAuth) ------------------------------------------
  test('GET /admin/viewbot-webrtc/status returns {viewbots} from listViewBots', async () => {
    viewBotWebRTCService.listViewBots.mockReturnValue([{ id: 'w1' }]);
    const res = await request(app).get('/admin/viewbot-webrtc/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ viewbots: [{ id: 'w1' }] });
    expect(viewBotWebRTCService.listViewBots).toHaveBeenCalledTimes(1);
  });

  // --- GROUP: debug / no-auth -----------------------------------------------
  test('GET /debug/rotation-status returns rotation status with no auth middleware', async () => {
    const res = await request(app).get('/debug/rotation-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, currentLiveBot: null });
    expect(viewBotAuth).not.toHaveBeenCalled();
    expect(adminKeyAuth).not.toHaveBeenCalled();
  });

  test('GET /admin/test-rotation-auth returns 401 without matching admin key', async () => {
    const res = await request(app).get('/admin/test-rotation-auth');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Admin key required' });
  });

  test('GET /admin/test-rotation-auth returns success when X-Admin-Key matches ADMIN_KEY', async () => {
    const res = await request(app)
      .get('/admin/test-rotation-auth')
      .set('X-Admin-Key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: { enabled: true, currentLiveBot: null } });
  });

  // --- GROUP: auth-rejection contract ---------------------------------------
  test('viewBotAuth gating: 401 short-circuits before handler runs', async () => {
    authState.rejectViewBotAuth = true;
    const res = await request(app).get('/admin/viewbot-client/streaming-method');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(viewBotClientService.getStreamingMethod).not.toHaveBeenCalled();
  });
});
