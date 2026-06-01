/**
 * Characterization tests for the routes defined in server/routes/viewbot-admin.js
 * (the ViewBot HTTP admin bridge factory `createViewBotAdminRouter(deps)`).
 *
 * These PIN the CURRENT HTTP behavior (status codes, response shapes, and which
 * injected service method is invoked with which args) of a REPRESENTATIVE
 * endpoint from each SURVIVING route group.
 *
 * NOTE: the admin viewbot-CLIENT fleet sub-routers (viewbot-client.js,
 * rotation.js, debug.js, streaming-method.js) were deleted along with
 * ViewBotClientService. The ViewbotService CREATION/STREAMING half (the
 * viewbots.js sub-router: /admin/viewbot/{start,stop,status,config,spawn,
 * :viewbotId,health}) and the ViewBotWebRTCService backend (webrtc.js
 * sub-router: /admin/viewbot-webrtc/*) were likewise removed — all dead under
 * LiveKit (live viewbots run via SimpleViewBotRotation → ViewBotLiveKitService,
 * never through ViewbotService.startViewbot). Their characterization tests were
 * removed with them. What remains here is the only surviving sub-router:
 * test-stream.js (legacy TestStreamService client-side patterns).
 *
 * DI reality being characterized:
 *   - The module exports a FACTORY: `createViewBotAdminRouter(deps)` returning an
 *     express.Router(). Every dependency (auth middleware, services, getters,
 *     io, logger, etc.) arrives in the `deps` bag — there is NO app.locals /
 *     req.app.get usage. So tests inject plain jest mocks straight into the bag.
 *   - The surviving test-stream routes are all guarded by `adminKeyAuth`,
 *     passed in via the bag as a pass-through stub.
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

// --- Lazy service mock ------------------------------------------------------
// ViewbotService is now stateless (only isViewbotStream); the surviving
// test-stream router no longer reaches it, but the getter is still supplied in
// the deps bag by server/index.js, so we mirror that.
let viewbotService;

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
    })
  );
  return app;
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  streamService.getCurrentStreamer.mockReturnValue(null);
  viewbotService = {
    isViewbotStream: jest.fn(() => false),
  };
  app = buildApp();
});

describe('viewbot-admin router — characterization', () => {
  // --- GROUP: test-stream (adminKeyAuth) ------------------------------------
  test('GET /admin/test-stream/status returns {status,metrics} from testStreamService', async () => {
    const res = await request(app).get('/admin/test-stream/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: { isActive: false }, metrics: {} });
    expect(testStreamService.getTestStreamStatus).toHaveBeenCalled();
    expect(adminKeyAuth).toHaveBeenCalled();
  });

  test('GET /admin/test-stream/frame returns 400 when stream not active', async () => {
    testStreamService.getTestStreamStatus.mockReturnValue({ isActive: false });
    const res = await request(app).get('/admin/test-stream/frame');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Test stream is not active' });
    expect(testStreamService.generateTestFrame).not.toHaveBeenCalled();
  });

  test('POST /admin/test-stream/stop delegates to testStreamService (no ViewbotService path)', async () => {
    testStreamService.stopTestStream.mockReturnValue({ success: true, streamId: 'test-1' });
    const res = await request(app).post('/admin/test-stream/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, streamId: 'test-1' });
    expect(testStreamService.stopTestStream).toHaveBeenCalledTimes(1);
    // The removed creation half is never consulted on stop.
    expect(viewbotService.isViewbotStream).not.toHaveBeenCalled();
  });
});
