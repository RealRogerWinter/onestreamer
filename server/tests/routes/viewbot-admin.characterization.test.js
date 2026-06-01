/**
 * Characterization tests for the routes defined in server/routes/viewbot-admin.js
 * (the ViewBot HTTP admin bridge factory `createViewBotAdminRouter(deps)`).
 *
 * These PIN the CURRENT HTTP behavior (status codes, response shapes, and which
 * injected service method is invoked with which args) of a REPRESENTATIVE
 * endpoint from each SURVIVING route group.
 *
 * NOTE: the admin viewbot-CLIENT fleet sub-routers (viewbot-client.js,
 * rotation.js, debug.js, streaming-method.js) and the standalone
 * viewbot-api.js / viewbot-diagnostics.js were deleted along with
 * ViewBotClientService (dead under LiveKit). The endpoints those owned
 * (/admin/viewbot-client/*, /debug/rotation-status, /admin/test-rotation-auth,
 * streaming-method) no longer exist, so their characterization tests were
 * removed. What remains here covers the LIVE sub-routers still mounted by the
 * parent: viewbots.js, test-stream.js, and webrtc.js.
 *
 * DI reality being characterized:
 *   - The module exports a FACTORY: `createViewBotAdminRouter(deps)` returning an
 *     express.Router(). Every dependency (auth middleware, services, getters,
 *     io, logger, etc.) arrives in the `deps` bag — there is NO app.locals /
 *     req.app.get usage. So tests inject plain jest mocks straight into the bag.
 *   - The lazy services (viewbotService, viewBotWebRTCService) are reached
 *     through getter functions (getViewbotService / getViewBotWebRTCService).
 *     When a getter returns falsy, every guarded handler short-circuits with a
 *     503 { error: '<Service> not initialized' } — pinned below.
 *   - Auth middleware (adminKeyAuth / viewBotAuth / authenticateAdmin) is passed
 *     in via the bag. We supply pass-through stubs that record which guard fired.
 */

const express = require('express');
const request = require('supertest');

// Avoid loading the real middleware/auth (requires JWT_SECRET at import time).
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, _res, next) => next()),
  authenticateAdmin: jest.fn((req, _res, next) => next()),
}));

const createViewBotAdminRouter = require('../../routes/viewbot-admin');

// --- Auth stubs -------------------------------------------------------------
const adminKeyAuth = jest.fn((req, _res, next) => { req._guard = 'adminKeyAuth'; next(); });
const viewBotAuth = jest.fn((req, _res, next) => { req._guard = 'viewBotAuth'; next(); });
const authenticateAdmin = jest.fn((req, _res, next) => { req._guard = 'authenticateAdmin'; next(); });

// --- Lazy service mocks -----------------------------------------------------
let viewbotService;
let viewBotWebRTCService;

// --- Other deps -------------------------------------------------------------
const streamService = {
  setStreamer: jest.fn(),
  getCurrentStreamer: jest.fn(() => null),
  clearStreamer: jest.fn(),
};
const sessionService = { linkUserToSocket: jest.fn(), getUserIdBySocketId: jest.fn() };
const webrtcService = { currentStreamer: null };
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
      webrtcService,
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
      getViewBotWebRTCService: () => viewBotWebRTCService,
    })
  );
  return app;
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
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

  // --- GROUP: webrtc (viewBotAuth) ------------------------------------------
  test('GET /admin/viewbot-webrtc/status returns {viewbots} from listViewBots', async () => {
    viewBotWebRTCService.listViewBots.mockReturnValue([{ id: 'w1' }]);
    const res = await request(app).get('/admin/viewbot-webrtc/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ viewbots: [{ id: 'w1' }] });
    expect(viewBotWebRTCService.listViewBots).toHaveBeenCalledTimes(1);
  });
});
