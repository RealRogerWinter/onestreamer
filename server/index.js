// Server orchestrator. Services live in services/, route clusters mount from
// routes/, startup helpers in bootstrap/, middleware in middleware/. Stateful
// services are instantiated here and exposed via app.locals for route modules;
// see CLAUDE.md ("Sharing services across route modules"). A small number of
// route handlers (user chat-color, admin dashboard) are still inline below.

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { safeCompare } = require('./utils/safeCompare');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const session = require('express-session');
const passport = require('passport');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Fail-fast: surface every missing/malformed required env var in one error
// rather than letting requireEnv() trip on whichever happens to import first.
require('./bootstrap/env').validateEnv();
const logger = require('./bootstrap/logger').child({ svc: 'index' });
const requireEnv = require('./config/requireEnv');

logger.info({
    smtpHost: process.env.SMTP_HOST ? 'configured' : 'NOT SET',
    smtpUser: process.env.SMTP_USER ? 'configured' : 'NOT SET',
    fromEmail: process.env.FROM_EMAIL || 'NOT SET',
}, 'Environment check on server start');

// ViewBot stack: ViewBotLiveKitService is constructed by
// server/bootstrap/services.js::createViewBotServices (PR-I4) inside
// startServer() once the LiveKit backend is ready. The former ViewbotService
// is now the stateless `isViewbotStream` predicate, bound directly to
// `viewbotService` at that point.
// PR 9.3 (Phase 9): ViewBotURLService, URLStreamHealthService,
// RandomStreamRotationService, WhitelistEnforcer, and ModerationActionArbiter
// are now constructed inside server/bootstrap/start-streaming-backend.js.
// SimpleViewBotRotation stays required at module scope because its
// setStreamService is hoisted ABOVE the streaming-backend call (PR-I4);
// WhitelistService stays here because its construction surrounds the
// streaming-backend call (the whitelistService it produces is a dep).
const SimpleViewBotRotation = require('./services/SimpleViewBotRotation');
const WhitelistService = require('./services/WhitelistService');
const AuthService = require('./services/AuthService');
// ChatBotService / StreamBotService / MovieBotService are constructed by the
// services factory (PR-I3). See server/bootstrap/services.js for wiring.
const IPBanService = require('./services/IPBanService');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const moderationRoutes = require('./routes/moderation');
const itemRoutes = require('./routes/items');
const buffRoutes = require('./routes/buffs');
const soundfxRoutes = require('./routes/soundfx');
const { router: chatbotRoutes, initializeChatBotRoutes } = require('./routes/chatbots');
const streambotRoutes = require('./routes/streambot');
const bugReportsRoutes = require('./routes/bug-reports');
const clipsRoutes = require('./routes/clips');
const adminRecordingsRoutes = require('./routes/admin-recordings');
const turnRoutes = require('./routes/turn');
const mountSocialEmbedRoutes = require('./routes/social-embed');
const startListeners = require('./bootstrap/start-listeners');
const startStreamingBackend = require('./bootstrap/start-streaming-backend');
// Socket handler modules (PR-H pilot extraction — see server/sockets/).
const registerAdminHandler = require('./sockets/AdminHandler');
const registerBuffHandler = require('./sockets/BuffHandler');
const registerDisconnectHandler = require('./sockets/DisconnectHandler');
const registerDrawingHandler = require('./sockets/DrawingHandler');
const registerGameHandler = require('./sockets/GameHandler');
const registerStreamHandler = require('./sockets/StreamHandler');
const database = require('./database/database');
const { runAsync } = database;

// =========================================================================
// SERVER INIT (Phase 15B.6 — express + http/https server objects)
//   Express app instance, HTTP server, and (optional) HTTPS server are
//   wired here. The HTTPS-cert load lives in startServer() (lifecycle —
//   see 15B.4); the server objects themselves are module-scope because
//   shutdown() (also lifecycle) needs to close them at exit time.
// =========================================================================
const app = express();

// Create both HTTP and HTTPS servers
const httpServer = http.createServer(app);

// HTTPS configuration
let httpsServer;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

if (USE_HTTPS || fs.existsSync(path.join(__dirname, '..', 'certificates', 'cert.pem'))) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(path.join(__dirname, '..', 'certificates', 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, '..', 'certificates', 'cert.pem'))
    };
    httpsServer = https.createServer(httpsOptions, app);
    logger.info('🔒 HTTPS: SSL certificates loaded successfully');
  } catch (err) {
    logger.error({ err }, '⚠️ HTTPS: Failed to load SSL certificates');
    if (USE_HTTPS) {
      // Refuse to start rather than silently fall through to the plain-HTTP
      // listener (which, under host networking, would serve plaintext on the
      // livekit-ingress :8080 port). ADR-0025.
      logger.error('❌ HTTPS: USE_HTTPS=true but certificate load failed — exiting instead of serving plaintext.');
      process.exit(1);
    }
  }
}

// TURN credential generation for coturn with static-auth-secret
// Coturn uses HMAC-SHA1 for time-limited credentials
const TURN_SECRET = requireEnv('TURN_SECRET');
const ADMIN_KEY = requireEnv('ADMIN_KEY');
const TURN_TTL = 24 * 60 * 60; // 24 hours in seconds

function generateTurnCredentials(username = 'viewer') {
  // Username format: timestamp:username (timestamp is when credential expires)
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const turnUsername = `${expiry}:${username}`;

  // Credential is HMAC-SHA1 of the username using the static auth secret
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(turnUsername);
  const turnCredential = hmac.digest('base64');

  return {
    username: turnUsername,
    credential: turnCredential,
    ttl: TURN_TTL
  };
}

// Use HTTP server for Socket.IO by default, can be switched to HTTPS
const server = httpsServer || httpServer;

// Optimized Socket.IO configuration for better performance
const io = socketIo(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow ViewBot connections from the same server
      const allowedOrigins = [
        process.env.CLIENT_URL || "https://onestreamer.live",
        `https://${process.env.SERVER_HOST}:${process.env.HTTPS_PORT}`,
        "https://onestreamer.live:8443",
        "https://onestreamer.live:3443",
        "https://onestreamer.live",
        "https://127.0.0.1:8443",
        "https://127.0.0.1:3443"
      ];
      
      // Allow requests with no origin (e.g., server-side connections, ViewBots)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else if (process.env.CORS_ALLOW_ALL === 'true') {
        // Explicit, opt-in debug escape hatch (was unconditionally on, which is
        // cross-site WebSocket hijacking with credentials:true). Keep OFF in prod.
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  // Connection settings
  pingTimeout: 20000, // Increased from default 5000ms for better stability
  pingInterval: 10000, // Increased from default 2500ms to reduce overhead
  upgradeTimeout: 15000, // Increased from default 10000ms
  // Buffer settings
  maxHttpBufferSize: 1e7, // 10MB buffer for large payloads
  // Transport settings
  transports: ['websocket', 'polling'], // Prefer websocket
  allowEIO3: true, // Allow Engine.IO v3 clients
  // Compression settings
  perMessageDeflate: {
    threshold: 1024, // Only compress messages > 1KB
    zlibDeflateOptions: {
      level: 6, // Compression level (1-9)
      memLevel: 8,
      strategy: 0
    },
    zlibInflateOptions: {
      windowBits: 15,
      memLevel: 8
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 15,
    concurrencyLimit: 10
  }
});

const PORT = process.env.PORT || 8080;
// Single source of truth for the built React index.html. Used by the
// catch-all React route AND by the social-embed clip handler — PR 4.3's
// first review pass caught a duplicate inline path that survived the
// initial extraction.
const CLIENT_BUILD_INDEX_PATH = process.env.CLIENT_BUILD_INDEX_PATH || path.join(__dirname, '..', 'client', 'build', 'index.html');

// =========================================================================
// MIDDLEWARE SETUP (Phase 15B.6 — order matters; do not reorder without
// reading the relevant ADRs first)
//   - compression  → cors  → trace-context (ADR-0020) → security headers
//   - express.json / urlencoded → static (public, uploads/{emojis,avatars})
//   - session (express-session)  →  passport.initialize()
// Routes mount BELOW this block. Body-parsing and CORS must precede every
// route mount; static must precede any route that could shadow the static
// file paths; session + passport must precede any route that reads req.user.
// =========================================================================

// Compression middleware for better performance
const compression = require('compression');
app.use(compression({
  level: 6, // Compression level (0-9)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress streaming responses
    if (req.headers['accept'] && req.headers['accept'].includes('text/event-stream')) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(cors());

// ADR-0020 §4: per-request trace ID propagation. Runs before any route
// handler so every downstream logger.X(...) call gets the `traceId`
// binding via the AsyncLocalStorage mixin in bootstrap/logger.js.
const { expressMiddleware: traceContextMiddleware } = require('./bootstrap/trace-context');
app.use(traceContextMiddleware);

// Add security headers to prevent XSS attacks
app.use((req, res, next) => {
  // Content Security Policy - prevents inline scripts and limits sources
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://www.googletagmanager.com; " + // Allow inline scripts for React, Cloudflare Turnstile, and Google Analytics
    "style-src 'self' 'unsafe-inline'; " + // Allow inline styles
    "img-src 'self' data: http: https:; " + // Allow images from any source
    "connect-src 'self' ws: wss: http: https:; " + // Allow WebSocket and API connections
    "font-src 'self' data:; " +
    "media-src 'self' blob:; " +
    "object-src 'none'; " +
    "frame-src https://challenges.cloudflare.com; " + // Allow Cloudflare Turnstile iframe
    "frame-ancestors 'none';"
  );
  
  // Other security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  next();
});

app.use(express.json({ limit: '5gb' }));
app.use(express.urlencoded({ limit: '5gb', extended: true }));
app.use(express.static('public', {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0, // Cache static assets in production
  etag: true,
  lastModified: true
}));

// Serve uploaded emojis
app.use('/uploads/emojis', express.static(path.join(__dirname, 'uploads', 'emojis'), {
  maxAge: '7d', // Cache emojis for 7 days
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Set proper MIME types for all image formats
    if (filePath.endsWith('.avif')) {
      res.setHeader('Content-Type', 'image/avif');
    } else if (filePath.endsWith('.webp')) {
      res.setHeader('Content-Type', 'image/webp');
    } else if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.gif')) {
      res.setHeader('Content-Type', 'image/gif');
    } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    }
  }
}));

// Serve uploaded avatars
app.use('/uploads/avatars', express.static(path.join(__dirname, 'uploads', 'avatars'), {
  maxAge: '7d', // Cache avatars for 7 days
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Set proper MIME types for all image formats
    if (filePath.endsWith('.webp')) {
      res.setHeader('Content-Type', 'image/webp');
    } else if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.gif')) {
      res.setHeader('Content-Type', 'image/gif');
    } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Session configuration
app.use(session({
  secret: requireEnv('SESSION_SECRET'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize AuthService early to register passport strategies
const authService = new AuthService();

// Initialize Passport
app.use(passport.initialize());
// Note: Not using passport.session() as we're using JWT tokens

// Auth routes
// =========================================================================
// ROUTE MOUNTS (Phase 15B.6 — top-of-tree first, /api/* fanout follows)
//   /auth/*, /api/moderation/*  → identity-adjacent
//   /api/admin/* (key gate)  →  /api/admin/* (JWT)
//   /api/<feature>/* fanout — each route module is in server/routes/
//   /admin/review/*  → recording-review surface
//   /api/internal/*  → app.locals-bag (chat-bonus, etc.)
// =========================================================================

app.use('/auth', authRoutes);

// Moderation routes
app.use('/api/moderation', moderationRoutes);

// Debug middleware to log all requests
app.use('/api', (req, res, next) => {
  logger.info(`🌐 HTTP: ${req.method} ${req.url} from ${req.get('origin') || 'unknown'}`);
  next();
});

// API routes
app.use('/api/admin', adminRoutes);
app.use('/api', itemRoutes);
app.use('/api/buffs', buffRoutes);
app.use('/api/soundfx', soundfxRoutes);
// ViewBot API routes will be added after services are initialized
app.use('/api/chatbots', chatbotRoutes);
app.use('/api/streambot', streambotRoutes);
app.use('/api/bug-reports', bugReportsRoutes);
app.use('/api/clips', clipsRoutes);
app.use('/api/turn', turnRoutes);
app.use('/admin/review', adminRecordingsRoutes);

// Extracted route modules (see also routes/* — these were inline blocks
// before PR-G; they read services from app.locals where state-sharing matters).
app.use('/api/tutorial', require('./routes/tutorial'));
app.use('/api/audio', require('./routes/audio'));
// /api/media + /api/stream/* + /api/webrtc/backend + /api/livekit/token
// share the streamService/webrtcService/adapter wiring, so they're all
// in routes/media.js mounted at /api (PR-G3).
app.use('/api', require('./routes/media'));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for video file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `${name}_${timestamp}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit for large video files
  },
  fileFilter: (req, file, cb) => {
    // Check if file is a video
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Serve HLS streams
app.use('/hls', express.static('public/hls', {
  setHeaders: (res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/x-mpegURL'
    });
  }
}));

// Serve React build files
// Commented out during development to prevent Socket.IO interference
// app.use(express.static(path.join(__dirname, '..', 'client', 'build')));

// Phase 15B.2.b — initializeRedis moved to bootstrap/redis.js. The
// `let redisClient` stays here because (a) shutdown() at the bottom of
// this file calls `redisClient.quit()` on it, and (b) the in-flight
// `createServices({ ..., redisClient, ... })` call below is intentional —
// services receive `undefined` at module-load and consult it lazily via
// the module-scope binding after startServer() runs the assignment.
let redisClient;
const { initializeRedis: bootInitializeRedis } = require('./bootstrap/redis');

// WebRTC backend. LiveKit is the sole backend (ADR-0024). Built BEFORE the
// service factory because the recording/transcription services consume it as
// a dep. The local is still named `webrtcService` — the historical name
// threaded through the service factory + socket handlers; a rename is a
// deferred cosmetic follow-up.
const LiveKitService = require('./services/LiveKitService');
const webrtcService = new LiveKitService();
logger.info('🎬 WebRTC backend: LiveKit (ADR-0024)');

// PR 16.1: userBonusCooldowns is the shared Map<userId, lastClaimEpochMs>
// backing /claim-chat-bonus and /bonus-status/:userId. Created here so the
// services factory can hand it to GameMechanicsService (passed by reference
// — same pattern as lastEmittedStreamReady), and so app.locals can expose it
// to the routes module. The previous Map-construction site (just before the
// /api/internal mount, ~50 lines below) is removed in favor of this one.
const userBonusCooldowns = new Map();

// Composition root for the early-core services. See
// server/bootstrap/services.js for the dependency graph and PR-I2 scope.
const createServices = require('./bootstrap/services');
const { createViewBotServices } = createServices; // PR-I4 late-init helper.
const { services, stoppables: coreStoppables } = createServices({ io, redisClient, database, env: process.env, webrtcService, userBonusCooldowns });

// PR 1.2: accumulator for graceful-shutdown iteration. Construction order;
// the SIGINT handler reverses at shutdown time so newer services stop first.
// createViewBotServices and inline-constructed services (ViewBotManager,
// PortMonitorService, LiveKitService) append below.
const stoppables = [...coreStoppables];

const {
  streamService,
  sessionService,
  takeoverService,
  testStreamService,
  mediaStreamService,
  audioOptimizationService,
  resourceMonitor,
  accountService,
  timeTrackingService,
  itemService,
  inventoryService,
  shopService,
  buffDebuffService,
  canvasFxService,
  soundFxService,
  // Optional Discord live-announcement bot.
  discordBotService,
  // PR-I2:
  clipStorageService,
  clipProcessorService,
  continuousRecordingService,
  clipService,
  sessionChatCaptureService,
  recordingUploadScheduler,
  recordingCleanupScheduler,
  transcriptionService,
  gameService,
  gameStreamService,
  // PR-I3:
  chatBotService,
  streamBotService,
  movieBotService,
  // VisionBot phase: sibling of MovieBotService.
  visionBotService,
  // PR 3.1: single `stream-ended` emit chokepoint.
  streamNotifier,
  // PR 3.2: single `viewer-count-update` emit chokepoint.
  viewerCountNotifier,
  // PR 3.3: buff/inventory event-cluster chokepoint.
  buffNotifier,
  // PR-M1 (ADR-0013): AI-moderation event chokepoint.
  moderationNotifier,
  // PR 4.2: deferred-work registry.
  lifecycleManager,
} = services;

// Expose the whole bag for extracted routes/sockets (PR-G2 / PR-H2 onwards
// will read `req.app.locals.services.<name>` instead of individual locals).
app.locals.services = services;

// authService already initialized earlier for passport strategies.
global.streamService = streamService;

// Keep the per-service app.locals lines that PR-G's extracted routes
// (server/routes/audio.js, etc.) currently depend on. Once PR-G2 migrates
// those readers to `req.app.locals.services.X`, these can be dropped.
app.locals.audioOptimizationService = audioOptimizationService;

// The WebRTC backend (LiveKit, ADR-0024) is built before the PR-I services
// factory because the recording/transcription services consume it. Exposed here so
// server/routes/media.js + routes/health.js can read it via
// req.app.locals.webrtcService.
app.locals.webrtcService = webrtcService;
app.locals.adminKey = ADMIN_KEY; // for routes/health.js admin-config endpoint
// generateTurnCredentials is a top-level helper in server/index.js; expose
// it for server/routes/media.js (used by /api/livekit/token).
app.locals.generateTurnCredentials = generateTurnCredentials;

// Phase 15B.2.c — getActiveVisualEffects + startVisualEffectSync deleted as
// dead code. Discovered during the extraction prep: startVisualEffectSync()
// has zero callers (verified by `grep -rn "startVisualEffectSync" server/
// client/ chat-service/`). getActiveVisualEffects was only called from
// inside startVisualEffectSync. The only remaining reference is a
// commented-out block in sockets/StreamHandler.js:159 (visual-effects-sync-pulse
// path disabled to debug
// rotate_90). The "Sync will be started after server initialization"
// comment lines below those helpers also no-op'd because the boot code
// never invoked the function. Removed rather than extracted — the truest
// "state unification" for an unreachable broadcast pulse is no pulse.

// chatBotService / streamBotService / movieBotService built by the services
// factory (PR-I2). setMovieBotService was
// eliminated in PR 1.3 by the BotEventBus; remaining post-construction setters
// (setIoInstance, setChatBotService, setChatBotLLMService) are still
// factory-internal.

// Recording + clip + admin-review services are all built by the services
// factory (PR-I2). See server/bootstrap/services.js for the dep graph.

// Wire up services
adminRecordingsRoutes.setServices({
  uploadScheduler: recordingUploadScheduler,
  cleanupScheduler: recordingCleanupScheduler,
  chatCaptureService: sessionChatCaptureService
});

// Listen for recording events to trigger chat capture and upload scheduling
continuousRecordingService.on('recording-started', (event) => {
  logger.info(`📝 ADMIN REVIEW: Recording started - ${event.sessionId}`);
  sessionChatCaptureService.startCapturing(event.sessionId, event.startTime);
});

continuousRecordingService.on('recording-stopped', (event) => {
  logger.info(`📝 ADMIN REVIEW: Recording stopped - ${event.sessionId}`);
  sessionChatCaptureService.stopCapturing(event.sessionId);
  recordingUploadScheduler.scheduleUpload(event.sessionId, event.endTime);
});

// Start schedulers
recordingUploadScheduler.start();
recordingCleanupScheduler.start();
logger.info('📹 ADMIN REVIEW: Recording review services initialized');

// Connect clip processor to clip service for status updates
clipProcessorService.setProcessedCallback(async (clipId, result) => {
  await clipService.updateClipProcessingResult(clipId, result);
});

// transcriptionService + movieBotService built by the services factory
// (PR-I2 / PR-I3). The chatServiceWrapper closure that MovieBot consumes
// lives inside the factory body alongside its consumer.

// Recording service is initialized, no need to load state separately
logger.info('📼 RECORDING: Recording service initialized');
logger.info('🎙️ TRANSCRIPTION: Transcription service initialized');
logger.info('🎬 MOVIEBOT: MovieBot service initialized');

// Set Socket.IO for sound effects broadcasting
soundFxService.setSocketIO(io);

// chatBotService.setIoInstance(io) happens inside the services factory
// (PR-I3). PR 1.3 deleted setMovieBotService — ChatBot ↔ MovieBot
// communicate via BotEventBus, and the moviePromptTemplate read uses a
// factory-built closure (services.getMoviePromptTemplate).

// Set the buff-debuff service dependency on inventory service after creation
inventoryService.setBuffDebuffService(buffDebuffService);
// Set stream and session services for proper buff targeting
inventoryService.setStreamAndSessionServices(streamService, sessionService);

// Set dependencies for canvas fx service
canvasFxService.setDependencies(io, itemService, buffDebuffService, streamService, sessionService);

// streamBotService.setChatBotService / setChatBotLLMService now happen inside
// the services factory (PR-I3).

// Make services available to routes
app.set('sessionService', sessionService);
app.set('timeTrackingService', timeTrackingService);
app.set('streamService', streamService);
app.set('takeoverService', takeoverService);
app.set('itemService', itemService);
app.set('inventoryService', inventoryService);
app.set('shopService', shopService);
app.set('buffDebuffService', buffDebuffService);
// PR 3.3: routes/items.js reads buffNotifier via req.app.get to route the
// 3 inline inventory-updated emits through the chokepoint.
app.set('buffNotifier', buffNotifier);
app.set('chatBotService', chatBotService);
app.set('streamBotService', streamBotService);

// Make services available to routes via app.locals for easier access
app.locals.buffDebuffService = buffDebuffService;
app.locals.itemService = itemService;
app.locals.inventoryService = inventoryService;
app.locals.sessionService = sessionService;
app.locals.streamService = streamService;
app.set('io', io);
app.set('canvasFxService', canvasFxService);
app.set('soundFxService', soundFxService);
app.set('transcriptionService', transcriptionService);
app.set('clipStorageService', clipStorageService);
app.set('clipProcessorService', clipProcessorService);
app.set('clipService', clipService);
app.set('continuousRecordingService', continuousRecordingService);

// ============================================
// Game System Initialization
// ============================================
// gameService + gameStreamService built by the services factory (PR-I2).

// Connect game stream service to takeover service for game mode blocking
takeoverService.setGameStreamService(gameStreamService);

// Initialize game service (loads world data)
gameService.initialize().catch(err => {
  logger.error({ err }, 'Failed to initialize game service');
});

// Make game services available to routes
app.set('gameService', gameService);
app.set('gameStreamService', gameStreamService);
app.locals.gameService = gameService;
app.locals.gameStreamService = gameStreamService;

logger.info('🎮 Game system initialized');
// ============================================

// Give clip processor access to Socket.IO for real-time updates
clipProcessorService.setSocketIO(io);

// /api/internal/* routes — chat-service callbacks, point economy, gift,
// gamble/slots, leaderboard, admin point grants. Extracted in PR-G2.
// userBonusCooldowns is exposed on app.locals so /claim-chat-bonus and
// /bonus-status/:userId in the extracted router share the same Map.
// PR 16.1: the Map itself is now created earlier (just before createServices)
// so it can be threaded into GameMechanicsService; we only stamp the
// app.locals alias here. Same reference — mutations through
// gameMechanicsService and reads through req.app.locals.userBonusCooldowns
// see the same data.
app.locals.userBonusCooldowns = userBonusCooldowns;
app.use('/api/internal', require('./routes/internal'));

// Initialize ViewbotService after MediasoupService
let viewbotService;

// Track which streamers have already been notified to prevent duplicates
const notifiedStreamers = new Set();

// PR 3.4: removed three dead-code module-scope helpers
// (createViewBotProducer, startSyntheticMediaGeneration,
// generateViewBotRtpParameters) and the `global.viewBotIntervals` Map
// they alone populated. The briefing flagged this Map as a leak because
// disconnect cleanup was incomplete; closer inspection showed the
// helpers had zero callers (confirmed by grep across server/, client/,
// chat-service/, and against `git log --all -S "createViewBotProducer("`).
// Dead since the initial commit. Removal supersedes relocation — the
// truest "state unification" for an unreachable Map is no Map.
// See docs/architecture/background-work.md and the CHANGELOG entry.

// Phase 15B.2.a — broadcastGlobalCooldown, enrichStreamStatus, and
// verifyAndEmitStreamReady extracted to server/services/StreamOrchestration.js.
// The factory is invoked below, after `getStreamerDisplayName` is defined
// (since that helper is a constructor dep — see the StreamOrchestration
// module docstring for the closure-audit reasoning).

// Phase 15B.2.b — viewbot username cache + generator moved to
// server/services/viewbot/UsernameCache.js. The cache and socketIds sets
// stay accessible as module-scope bindings here because they are
// referenced from getStreamerDisplayName (below), from socket-handler
// deps bags, and exposed on app.locals for server/routes/internal.js.
const { createUsernameCache } = require('./services/viewbot/UsernameCache');
const _usernameCache = createUsernameCache();
const viewbotUsernameCache = _usernameCache.cache;
const viewbotSocketIds = _usernameCache.socketIds;
const cleanupViewbotUsername = _usernameCache.cleanup;
const generateViewbotUsername = _usernameCache.generate;

// Expose viewbot caches on app.locals so server/routes/internal.js can read
// them (extracted in PR-G2 — used by /api/internal/test-viewbot-username).
app.locals.viewbotUsernameCache = viewbotUsernameCache;
app.locals.viewbotSocketIds = viewbotSocketIds;

// =========================================================================
// HELPER: getStreamerDisplayName — Phase 15B residual (kept inline by 15B.2.c).
// Resolves the human-readable streamer name from one of four sources
// depending on the stream type (random-rotation URL stream, ViewBotURLService
// URL stream, viewbot socket, or session/authenticated user). Closes over
// THREE lazy-init services (`global.randomStreamRotationService`,
// `global.viewBotURLService`, `viewbotService`) — all assigned inside
// `startServer()` → `bootstrap/start-streaming-backend.js`. The PR-15B.1
// closure audit predicted that extracting this would force the destination
// service to accept those three deps via setters OR force lazy init to move
// earlier (both larger surgeries than 15B.2.b's scope). 15B.2.c's
// maintainer-defer call: stays inline with this section header so a future
// reader sees the residual and the reason. If a Phase 16 ever opens with
// scope to wire those lazy services into a UserService surface, this is
// the natural follow-up — but it's NOT Phase 15 scope.
// =========================================================================
const getStreamerDisplayName = async (streamerId) => {
  if (!streamerId) return null;

  try {
    // CRITICAL: Check for URL streams first (Random Rotation streams)
    // These have IDs like "url-stream-123456" and have display names stored in ViewBotURLService
    if (streamerId.startsWith('url-stream-')) {
      // First check RandomStreamRotationService for the display name
      if (global.randomStreamRotationService && global.randomStreamRotationService.currentStream) {
        const currentStream = global.randomStreamRotationService.currentStream;
        if (currentStream.urlId === streamerId) {
          logger.info(`🎲 STREAMER: Using random rotation display name "${currentStream.displayName}" for ${streamerId}`);
          return currentStream.displayName;
        }
      }

      // Fallback: Check ViewBotURLService for the display name
      if (global.viewBotURLService && global.viewBotURLService.activeStreams) {
        const streamEntry = global.viewBotURLService.activeStreams.get(streamerId);
        if (streamEntry && streamEntry.displayName) {
          logger.info(`📺 STREAMER: Using URL stream display name "${streamEntry.displayName}" for ${streamerId}`);
          return streamEntry.displayName;
        }
      }

      // No display name found, use a generic fallback
      logger.info(`⚠️ STREAMER: No display name found for URL stream ${streamerId}, using generic`);
      return 'Random Stream';
    }

    // Check if this is a viewbot stream (either by ViewbotService or by socket ID tracking)
    const isViewbotByService = viewbotService && viewbotService.isViewbotStream(streamerId);
    const isViewbotBySocketId = viewbotSocketIds.has(streamerId);

    if (isViewbotByService || isViewbotBySocketId) {
      logger.info(`🤖 VIEWBOT: Detected viewbot stream ${streamerId} (service: ${isViewbotByService}, socketId: ${isViewbotBySocketId}), generating random username`);
      return generateViewbotUsername(streamerId);
    }

    const session = sessionService.getSessionBySocketId(streamerId);
    if (session) {
      if (session.userId) {
        // For authenticated users, try to get their username from the database
        try {
          logger.info(`🔍 STREAMER: Looking up user ${session.userId} in database for streamer ${streamerId}`);
          logger.info({ authService: !!authService }, `🔍 STREAMER: authService available`);
          logger.info({ accountService: !!authService?.accountService }, `🔍 STREAMER: authService.accountService available`);
          
          if (authService && authService.accountService) {
            const user = await authService.accountService.getUserById(session.userId);
            if (user && user.username) {
              logger.info(`✅ STREAMER: Using authenticated username "${user.username}" for streamer ${streamerId}`);
              return user.username;
            } else {
              logger.info(`❌ STREAMER: No user or username found in database for user ID ${session.userId}`);
            }
          } else {
            logger.info(`❌ STREAMER: authService or accountService not available`);
          }
        } catch (dbError) {
          logger.info({ err: dbError }, '❌ STREAMER: Could not fetch user from database');
        }
        // Fallback to chat username if available
        logger.info(`📝 STREAMER: Using fallback for user ${session.userId}: ${session.chatUsername || `User-${streamerId.substring(0, 8)}`}`);
        return session.chatUsername || `User-${streamerId.substring(0, 8)}`;
      } else {
        // For anonymous users, check for chat username by IP
        const ip = session.ip;
        logger.info(`🔍 STREAMER: Checking for chat username for anonymous streamer ${streamerId} (IP: ${ip})`);
        
        const chatInfo = sessionService.getChatUsername(ip);
        logger.info({ chatInfo }, `🔍 STREAMER: Chat info from sessionService`);
        
        if (chatInfo && chatInfo.username) {
          logger.info(`👤 STREAMER: Using chat username "${chatInfo.username}" for anonymous streamer ${streamerId} (IP: ${ip})`);
          return chatInfo.username;
        }
        
        // Also check the session's chatUsername as fallback
        if (session.chatUsername) {
          logger.info(`👤 STREAMER: Using session chat username "${session.chatUsername}" for anonymous streamer ${streamerId}`);
          return session.chatUsername;
        }
        
        logger.info(`⚠️ STREAMER: No chat username found for anonymous streamer ${streamerId} (IP: ${ip})`);
      }
    }
    
    // Fallback to abbreviated socket ID
    logger.info(`🔤 STREAMER: Using socket ID fallback for streamer ${streamerId}`);
    return `User-${streamerId.substring(0, 8)}`;
  } catch (error) {
    logger.error({ err: error }, '❌ STREAMER: Failed to get streamer display name');
    return `User-${streamerId.substring(0, 8)}`;
  }
};

// Expose helper for extracted routes (PR-G2: server/routes/internal.js uses
// it in /api/internal/test-viewbot-username).
app.locals.getStreamerDisplayName = getStreamerDisplayName;

// DEDUP: Track last emitted stream-ready to prevent duplicate emissions.
// NOTE: declared `const` and mutated in place so the same reference can be
// shared with `server/sockets/StreamHandler.js` (passed via deps bag at
// the socket-handler registration site) AND with StreamOrchestration's
// `verifyAndEmitStreamReady` (passed via factory args below).
const lastEmittedStreamReady = { streamerId: null, timestamp: 0 };

// Phase 15B.2.a — construct StreamOrchestration once `getStreamerDisplayName`
// is in scope. The factory binds the three orchestration helpers to their
// deps at construction time; the lazy services those helpers transitively
// read (via getStreamerDisplayName) are still read at call time, so this
// construction can land here (before startServer() and before the lazy
// services exist).
const { createStreamOrchestration } = require('./services/StreamOrchestration');
const streamOrchestration = createStreamOrchestration({
  io,
  takeoverService,
  webrtcService,
  getStreamerDisplayName,
  lastEmittedStreamReady,
});
const { broadcastGlobalCooldown, enrichStreamStatus, verifyAndEmitStreamReady } = streamOrchestration;

// Phase 15B.3.a — health/root/webrtc-config moved to routes/health.js
// (covers GET /, GET /health, GET /api/admin/webrtc/config).
app.use(require('./routes/health'));

// /api/stream/status, /api/stream/active, /api/media/*,
// /api/webrtc/backend, and /api/livekit/token live in
// server/routes/media.js (mounted above).
// PR-G3.

// Import JWT admin authentication middleware
const { authenticateAdmin, authenticateModerator } = require('./middleware/auth');
// AuthService already imported at the top of the file

// Phase 15B.3.c — admin moderation/IP-ban/streaming-logs cluster extracted
// to routes/admin-moderation.js (16 routes; all auth via authenticateModerator).
// Mounted here — after `authenticateModerator` is in scope.
// `streamingLogsService` is not part of the eager `services` factory bag
// (it's a singleton lazy-required by callers); require it here so the
// deps-bag arg has a real value at module-load.
const streamingLogsService = require('./services/StreamingLogsService');
app.use(require('./routes/admin-moderation')({
  authenticateModerator,
  authService,
  IPBanService,
  streamService,
  streamingLogsService,
  webrtcService,
  streamNotifier,
  io,
  axios,
  https,
  logger,
}));

// Simple admin auth middleware (kept for legacy endpoints that might need admin key)
const adminKeyAuth = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];

  if (!safeCompare(adminKey, ADMIN_KEY)) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin key' });
  }
  next();
};

// Accept either the legacy admin-key OR a valid admin JWT. Lets the admin-panel
// UI hit endpoints with just the bearer token it already carries, while still
// honoring scripts/automation that send X-Admin-Key. Used by the visionbot
// routes; safe to widen to MovieBot/Groq when those panels need it too.
const adminKeyOrJwt = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];
  if (safeCompare(adminKey, ADMIN_KEY)) return next();
  return authenticateAdmin(req, res, next);
};

// Phase 15B.3.b — custom emoji CRUD + usage tracker extracted to
// routes/emojis.js. 6 routes; serverDir passed as absolute path.
app.use(require("./routes/emojis")({
  authenticateAdmin, database, fs, path, logger, uploadsDir,
  serverDir: __dirname,
}));

// User chat-color preferences + admin dashboard extracted to routes/user.js.
// chat-color routes use `database`; the dashboard reads
// streamService/takeoverService.
app.use(require("./routes/user")({
  authenticateAdmin, database, streamService, takeoverService, logger,
}));

// Fallback auth middleware for ViewBot endpoints - try JWT first, then admin key
const viewBotAuth = (req, res, next) => {
  logger.info({ path: req.path }, '🔐 ViewBot Auth - Request path');
  logger.info({
    'x-admin-key': req.headers['x-admin-key'] ? '<redacted>' : undefined,
    'authorization': req.headers['authorization'] ? '<bearer>' : undefined,
  }, '🔐 ViewBot Auth - Headers');

  // Check for admin key first (simpler auth for ViewBot operations)
  const adminKey = req.headers['x-admin-key'];
  const adminKeyValid = safeCompare(adminKey, ADMIN_KEY);

  logger.info({
    provided: !!adminKey,
    matches: adminKeyValid,
  }, '🔐 ViewBot Auth - Admin key check');
  
  if (adminKeyValid) {
    logger.info('✅ ViewBot: Using admin key authentication');
    // Create a mock user object for compatibility
    req.user = { id: 'admin-key-user' };
    req.userRecord = { username: 'admin-key', is_admin: true };
    return next();
  }
  
  // If no admin key, check for JWT token
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token) {
    // Try JWT authentication synchronously
    const decoded = authService.verifyToken(token);
    if (decoded) {
      logger.info('✅ ViewBot: Using JWT authentication');
      req.user = decoded;
      return next();
    }
  }
  
  logger.info('❌ ViewBot: Authentication failed - no valid JWT or admin key');
  return res.status(401).json({ 
    error: 'Authentication required for ViewBot operations',
    details: 'Provide either x-admin-key header or valid JWT token'
  });
};

// Admin API Routes
// (GET /admin/dashboard extracted to routes/user.js, mounted above with the
// user chat-color routes.)

// Phase 15B.3.e — ViewBot HTTP admin bridge extracted to routes/viewbot-admin.js.
// Now only the test-stream/ path family survives: the viewbot/, viewbot-webrtc,
// viewbot-client, simple-rotation, debug/, streaming-method, and viewbot-manager
// families were removed with the ViewbotService creation half + ViewBotWebRTCService
// + the viewbot-client fleet. Lazy services pass via getters.
app.use(require("./routes/viewbot-admin")({
  adminKeyAuth,
  streamService, webrtcService, testStreamService, mediaStreamService,
  streamNotifier, viewerCountNotifier,
  broadcastGlobalCooldown, notifyViewersStreamEnded,
  io, logger,
}));

// Phase 15B.3.f+g — admin-ops bundle (stream control + cooldowns + debug
// + system metrics + uploaded videos) extracted to routes/admin-ops.js.
// 15 routes; auth mix of authenticateAdmin/adminKeyAuth/(none for /debug).
app.use(require("./routes/admin-ops")({
  authenticateAdmin, adminKeyAuth,
  sessionService, streamService, takeoverService, accountService,
  itemService, timeTrackingService, webrtcService, resourceMonitor,
  streamNotifier, viewerCountNotifier,
  database, io, fs, path, upload, uploadsDir, logger,
}));

// ================================
// CONTINUOUS RECORDING ADMIN API ENDPOINTS
// ================================

// routes/admin-recordings-ext.js — the /admin/recordings/continuous/{enable,
// disable,status} controls, wired to the LiveKit egress recorder
// (continuousRecordingService). The MediaSoup-era recorder routes that used to
// live here were retired with ADR-0024; the live recording surface is
// /admin/review/* (routes/admin-recordings.js, recording_sessions table).
app.use(require("./routes/admin-recordings-ext")({
  authenticateAdmin, logger,
  getContinuousRecordingService: () => continuousRecordingService,
}));

// Helper functions for stream state changes
function notifyViewersStreamStarted() {
  logger.info('📊 TIME: Stream started - notifying viewers to start earning view time');

  // Start continuous recording for clips
  if (continuousRecordingService) {
    continuousRecordingService.startRecording().catch(err => {
      logger.error({ err }, 'Failed to start continuous recording');
    });
  }

  // Emit to all viewers
  io.to('viewers').emit('stream-started-for-viewing');
  
  // Also manually start existing viewing sessions
  for (const [socketId, viewerSession] of sessionService.socketToIp.entries()) {
    const ip = sessionService.socketToIp.get(socketId);
    if (ip) {
      const session = sessionService.getSessionByIp(ip);
      if (session && session.userId) {
        // Check if this viewer is in viewers room
        const viewerSocket = io.sockets.sockets.get(socketId);
        if (viewerSocket && viewerSocket.rooms.has('viewers')) {
          timeTrackingService.startViewingSession(session.userId, socketId, true);
          logger.info(`📊 TIME: Started view tracking for existing viewer ${session.userId}`);
        }
      }
    }
  }
}

function notifyViewersStreamEnded() {
  logger.info('📊 TIME: Stream ended - stopping view time tracking for all viewers');
  
  // Emit to all viewers
  io.to('viewers').emit('stream-ended-for-viewing');
  
  // Also manually stop existing viewing sessions
  for (const [socketId, session] of timeTrackingService.viewingSessions.entries()) {
    timeTrackingService.endViewingSessionBySocket(socketId);
    logger.info(`📊 TIME: Stopped view tracking for viewer socket ${socketId}`);
  }
  
}

// Transcription API endpoints
// Phase 15B.3.i — transcription cluster extracted to routes/admin-transcription.js.
// 10 routes; transcriptionService passed via getter.
app.use(require("./routes/admin-transcription")({
  authenticateAdmin, streamService, webrtcService, io, logger,
  getTranscriptionService: () => transcriptionService,
}));

// AI bot admin HTTP surface (MovieBot/VisionBot/Groq/OpenAI) → routes/admin-ai.js
app.use(require('./routes/admin-ai')({
  adminKeyAuth, adminKeyOrJwt,
  movieBotService, chatBotService,
  webrtcService, streamService, database, logger,
}));

// Forward transcription events to clients
transcriptionService.on('transcription-chunk', (data) => {
  io.emit('transcription-update', data);
  logger.info(`📝 TRANSCRIPTION: Broadcasting chunk ${data.chunkNumber} for session ${data.sessionId}`);
});

// Forward audio buffer status updates
if (transcriptionService.audioBufferService) {
  transcriptionService.audioBufferService.on('buffer-update', (data) => {
    io.emit('buffer-status', data);
  });
}

transcriptionService.on('transcription-started', (data) => {
  io.emit('transcription-started', data);
});

transcriptionService.on('transcription-stopped', (data) => {
  io.emit('transcription-stopped', data);
});

// Forward MovieBot events to clients
movieBotService.on('moviebot-enabled', (data) => {
  io.emit('moviebot-enabled', data);
  logger.info(`🎬 MOVIEBOT: Broadcasting enabled event`);
});

movieBotService.on('moviebot-disabled', (data) => {
  io.emit('moviebot-disabled', data);
  logger.info(`🎬 MOVIEBOT: Broadcasting disabled event`);
});

movieBotService.on('moviebot-comment', (data) => {
  io.emit('moviebot-comment', data);
  logger.info(`🎬 MOVIEBOT: Broadcasting comment from ${data.bot}`);
});

// VisionBot lifecycle events forwarded to clients (parallel to MovieBot above).
visionBotService.on('visionbot-enabled', (data) => {
  io.emit('visionbot-enabled', data);
});
visionBotService.on('visionbot-disabled', (data) => {
  io.emit('visionbot-disabled', data);
});

movieBotService.on('prompt-logged', (data) => {
  io.emit('moviebot-prompt-logged', data);
  logger.info(`📋 MOVIEBOT: Prompt logged for ${data.bot}`);
});

// Phase 15B.5 — io.on('connection', ...) registration extracted to
// bootstrap/register-socket-handlers.js. The lazy-service getters
// (viewbotService / transcriptionService) are passed
// via getter functions so they resolve at connection-callback time
// (always after startServer's lazy inits).
require('./bootstrap/register-socket-handlers')(io, {
  // Connection-level services
  IPBanService,
  authService,
  sessionService,

  // Per-handler register functions
  registerStreamHandler,
  registerBuffHandler,
  registerDrawingHandler,
  registerAdminHandler,
  registerGameHandler,
  registerDisconnectHandler,

  // Connection-level service touches
  canvasFxService,

  // Eager per-handler service deps
  streamService,
  takeoverService,
  webrtcService,
  testStreamService,
  timeTrackingService,
  buffDebuffService,
  streamingLogsService,
  SimpleViewBotRotation,
  lifecycleManager,
  itemService,
  inventoryService,
  gameStreamService,
  gameService,
  accountService,

  // Shared module-scope state
  notifiedStreamers,
  viewbotSocketIds,
  lastEmittedStreamReady,

  // Orchestration helpers + cache helpers
  enrichStreamStatus,
  verifyAndEmitStreamReady,
  getStreamerDisplayName,
  notifyViewersStreamStarted,
  notifyViewersStreamEnded,
  broadcastGlobalCooldown,
  cleanupViewbotUsername,

  // Chokepoint notifiers
  streamNotifier,
  viewerCountNotifier,
  buffNotifier,

  // Optional Discord live-announcement bot (real-streamer go-live cards).
  discordBotService,

  // Utility imports
  runAsync,
  database,
  axios,
  https,

  // Lazy-service getters (resolved at connection-callback time)
  getViewbotService: () => viewbotService,
  getTranscriptionService: () => transcriptionService,
});


async function startServer() {
  redisClient = await bootInitializeRedis();

  // B1 (audit Plan 07): hand the just-connected Redis client to services
  // that were constructed at module load with `undefined` (createServices ran
  // before this point). Without this, TakeoverService's cooldown persistence
  // — including the T5 guard-item extended cooldown — silently ran on the
  // process-local in-memory fallback and never survived a restart.
  if (redisClient && takeoverService.setRedisClient) {
    takeoverService.setRedisClient(redisClient);
  }


  // Initialize resource monitoring
  resourceMonitor.setCallbacks({
    onAlert: (alert) => {
      logger.warn(`🚨 RESOURCE ALERT: ${alert.message} (${alert.value})`);
      // Could emit to admin clients here
    },
    onMetricsUpdate: (metrics) => {
      // Could emit real-time metrics to admin clients
      if (metrics.system.cpuUsage > 90 || metrics.system.memoryUsage > 95) {
        logger.error('🔴 CRITICAL: System resources critically high!');
      }
    }
  });
  
  resourceMonitor.startMonitoring(10000); // Update every 10 seconds
  
  // Start time tracking cleanup
  timeTrackingService.startPeriodicCleanup();
  timeTrackingService.setSocketIO(io); // Pass Socket.IO instance to time tracking service
  logger.info('✅ TIME: Started periodic cleanup for time tracking service');

  // Log the Discord live-announcement bot into the gateway (no-op + immediate
  // return when graceful-disabled). start() never throws — a login failure just
  // disables announcements for this run. Intentionally not awaited (void).
  void discordBotService.start();
  
  // Initialize the WebRTC backend (LiveKit, ADR-0024).
  try {
    await webrtcService.initialize();
    logger.info('✅ WEBRTC: LiveKit backend initialized');
    
    // ── PR-I4: late ViewBot service construction ───────────────────────────
    // The four named ViewBot services (Viewbot, ViewBotWebRTC,
    // ViewBotLiveKit, ViewBotClient) are constructed by the
    // bootstrap/services factory. Everything else in this block is
    // orchestration (URL/Random services, SimpleViewBotRotation setters,
    // route mounts, autostarts) that stays inline — see the deferred-list
    // note in bootstrap/services.js for the rationale.
    // LiveKit is the sole WebRTC backend (ADR-0024); webrtcService IS the
    // LiveKitService. Kept as a named local because the downstream LiveKit
    // cross-wires + the start-streaming-backend branch key off it.
    const livekitService = webrtcService;

    const { services: viewBotBag, stoppables: viewBotStoppables } = await createViewBotServices({
      webrtcService,
      livekitService,
      streamService,
    });
    // ViewbotService was demoted to the stateless `isViewbotStream` predicate
    // (no longer in the ViewBot bag). Bind the module directly so the existing
    // `viewbotService.isViewbotStream(...)` call sites (routes, socket handlers,
    // InventoryService) keep working unchanged.
    viewbotService = require('./services/ViewbotService');
    const viewBotLiveKitService = viewBotBag.viewBotLiveKitService; // null without LiveKit.

    // Push livekit BEFORE viewbot stoppables so reverse-iteration stops the
    // viewbot services (which consume livekit) before the livekit client
    // itself is torn down — avoids noisy "call against shut-down client"
    // errors on the way out.
    if (livekitService && typeof livekitService.stop === 'function') {
      stoppables.push(livekitService);
    }
    stoppables.push(...viewBotStoppables);
    logger.info('✅ VIEWBOT: isViewbotStream predicate bound');
    if (viewBotLiveKitService) {
      logger.info('✅ VIEWBOT: ViewBotLiveKitService initialized for LiveKit RTMP ingress');
    }

    // Branch-shared orchestration: SimpleViewBotRotation always learns about
    // streamService (real-streamer protection). On the MediaSoup branch this
    // was previously inside the `if (!livekitService)` block; on the LiveKit
    // branch it lived in the `else`. Hoisting is behavior-preserving because
    // both branches called it unconditionally.
    SimpleViewBotRotation.setStreamService(streamService);

    // PR 3.1: LiveKitService is constructed at module load (before the
    // bootstrap factory runs), so it can't take streamNotifier in its ctor.
    // Wire it post-construction here, before the LiveKit branch starts using
    // clearStaleStreamer.
    if (livekitService && typeof livekitService.setStreamNotifier === 'function') {
      livekitService.setStreamNotifier(streamNotifier);
    }

    // URL-relay whitelist (ADR-0010). Initialized eagerly so the policy data
    // is in memory before the first relay attempt. Phase 0 only exposes it on
    // app.locals; callers in ViewBotURLService / random services come in
    // Phases 1–3.
    let whitelistService = new WhitelistService();
    try {
      await whitelistService.initialize();
      app.locals.whitelistService = whitelistService;
      global.whitelistService = whitelistService;
    } catch (e) {
      logger.error({ err: e }, '❌ WhitelistService failed to initialize');
      if (process.env.URL_RELAY_REQUIRE_WHITELIST_SERVICE === 'true') {
        throw e;
      }
      // Phase 0: continue without it; Phase 5 sets the env flag in production.
      // Null the local so the `if (whitelistService)` wire-up guards below
      // skip cleanly — without this, the constructed-but-uninitialized
      // object would still be truthy and the first checkAllowed call would
      // throw "cache not initialized" from inside ViewBotURLService.
      whitelistService = null;
    }

    // PR-W5: mount admin routes for the whitelist (no-op when service unset).
    // Mounted unconditionally — the route handlers themselves return 503 when
    // app.locals.whitelistService is missing.
    const whitelistRoutes = require('./routes/whitelist');
    app.use('/api/whitelist', whitelistRoutes());
    logger.info('✅ WHITELIST: API routes mounted at /api/whitelist');

    // PR-M1 (ADR-0013): AI-moderation pipeline. Inline init because
    // initialize() is async — applies the schema, verifies seed integrity
    // (fails closed on SHA-256 mismatch), upserts the embedded core word
    // list into moderation_terms, loads the enabled-terms cache, and
    // subscribes to transcriptionService's `transcription-chunk` event.
    // PR-M2 adds the Stage 2 Groq classifier (demand-gated on a Stage 1
    // hit). M3 wires enforcement actions and the AI_MODERATION_ENFORCE
    // env flag; M2 stays log-only.
    const ModerationService = require('./services/ModerationService');
    const ModerationStage2 = require('./services/ModerationStage2');
    const ModerationStage3 = require('./services/ModerationStage3');

    // Resolve the Groq API key for Stage 2. Three sources in priority order:
    //   1. `MODERATION_GROQ_API_KEY` env  (ops override for quota isolation)
    //   2. `GROQ_API_KEY` env             (shared with MovieBot)
    //   3. `groq_config.api_key` DB row   (admin-managed, same row ChatBotLLMService.loadGroqConfig reads)
    //
    // The fall-through to the DB is the production hotfix: a live install
    // had the Groq key stored ONLY in `groq_config` (admin-set via the
    // existing /admin/groq UI) and the env unset, so ChatBotLLMService /
    // MovieBot worked but moderation Stage 2 never fired. Without this
    // fall-through, every Stage 1 hit produced an `admin_review` row with
    // empty `stage2_verdict_json` — the LLM classifier was dark.
    let moderationGroqKey = process.env.MODERATION_GROQ_API_KEY || process.env.GROQ_API_KEY || null;
    if (!moderationGroqKey) {
      try {
        const row = await database.getAsync('SELECT api_key, enabled FROM groq_config WHERE id = 1');
        if (row && row.enabled === 1 && row.api_key) {
          moderationGroqKey = row.api_key;
          logger.info('✅ ModerationStage2: Groq key loaded from groq_config table (env unset)');
        } else {
          logger.info('⚠️ ModerationStage2: no Groq key in env OR groq_config — Stage 2 will be skipped');
        }
      } catch (e) {
        logger.warn({ err: e }, '⚠️ ModerationStage2: could not read groq_config');
      }
    }
    const moderationStage2 = new ModerationStage2({
      apiKey: moderationGroqKey,
      model: process.env.MODERATION_GROQ_MODEL || undefined,
    });
    // PR-M3: Stage 3 is the free OpenAI omni-moderation cross-check. Optional —
    // when OPENAI_API_KEY is absent the service runs without it and high-risk
    // events route to admin_review (no auto-action). The action arbiter is
    // injected LATER via setActionArbiter() — after RandomStreamRotationService
    // is built in the MediaSoup or LiveKit branch below.
    //
    // PR-M8 (follow-up to ADR-0021): resolve the OpenAI key in priority order:
    //   1. OPENAI_API_KEY env  (operator-set, the standard path)
    //   2. openai_config.api_key DB row WHERE enabled=1
    //
    // This mirrors the Groq Stage 2 DB-fallback hotfix above. The same
    // production install pattern (keys live in DB, admin UI manages them)
    // had Stage 3 silently degraded — every Stage 2 risk-3 verdict routed
    // to admin_review because Stage 3 had no second opinion to give, and
    // OmniImageMod's image moderation path (which reuses Stage 3) would
    // have been silently dark the moment image_moderation_enabled=1 was
    // flipped. This fall-through closes the gap without forcing operators
    // to migrate their key from DB to env.
    let moderationOpenAiKey = process.env.OPENAI_API_KEY || null;
    if (!moderationOpenAiKey) {
      try {
        const row = await database.getAsync('SELECT api_key, enabled FROM openai_config WHERE id = 1');
        if (row && row.enabled === 1 && row.api_key) {
          moderationOpenAiKey = row.api_key;
          logger.info('✅ ModerationStage3: OpenAI key loaded from openai_config table (env unset)');
        } else {
          logger.info('⚠️ ModerationStage3: no OpenAI key in env OR openai_config — Stage 3 (text + image) will be skipped');
        }
      } catch (e) {
        logger.warn({ err: e }, '⚠️ ModerationStage3: could not read openai_config');
      }
    }
    const moderationStage3 = new ModerationStage3({
      apiKey: moderationOpenAiKey,
    });
    // OmniImageMod PR 2 (ADR-0021): a SECOND Stage 3 instance for the image
    // input pipeline. Same endpoint + key, but a separate circuit-breaker
    // state so a stall on the heavier-payload image path can't blind text
    // moderation (and vice versa).
    const moderationStage3Image = new ModerationStage3({
      apiKey: moderationOpenAiKey,
    });
    let moderationService = new ModerationService({
      database,
      transcriptionService,
      moderationNotifier,
      streamService,
      stage2: moderationStage2,
      stage3: moderationStage3,
      stage3Image: moderationStage3Image,
      frameCaptureService: services.egressFrameCaptureService,
      failClosed: process.env.AI_MODERATION_FAIL_CLOSED !== 'false',
    });
    try {
      await moderationService.initialize();
      app.locals.moderationService = moderationService;
      global.moderationService = moderationService;
      // PR-M6: kick off the 24h retention purger. First run after a 60s
      // grace; ticks every 24h. The timer is .unref()'d so SIGTERM still
      // exits cleanly. moderationService.stop() (deferred wiring) also
      // clears it. Retention is 90d for non-clean rows, 30d for clean.
      moderationService.startRetentionScheduler({
        flaggedRetentionDays: parseInt(process.env.AI_MODERATION_RETENTION_FLAGGED_DAYS, 10) || 90,
        cleanRetentionDays: parseInt(process.env.AI_MODERATION_RETENTION_CLEAN_DAYS, 10) || 30,
      });
    } catch (e) {
      logger.error({ err: e }, '❌ ModerationService failed to initialize');
      if (process.env.AI_MODERATION_REQUIRE_SERVICE === 'true') {
        throw e;
      }
      // Default (M1): continue without it. The transcription pipeline is
      // unaffected — ModerationService just never subscribes. Operators
      // flip AI_MODERATION_REQUIRE_SERVICE=true once the service is
      // production-ready (PR-M6).
      moderationService = null;
    }

    // PR-M4 (ADR-0013): wire the MovieBot output-moderation gate. When a
    // bot reply is generated, ChatBotService.generateMovieComment runs it
    // through moderationService.checkBotOutput before the chat-service
    // emit. Flagged replies are dropped silently and a 'mb_output_dropped'
    // event row is written. No-op if moderationService failed to init.
    if (moderationService && chatBotService && typeof chatBotService.setModerationService === 'function') {
      chatBotService.setModerationService(moderationService);
    }

    // OmniImageMod PR 3 (ADR-0021): wire the image-moderation gate into
    // VisionBotService. VisionBotService is built by the bootstrap factory
    // (no moderation dep at construction time, since ModerationService's
    // async init isn't done yet); the setter here injects the now-ready
    // service so _runCycle can call handleVisionFrame on every frame
    // capture. No-op if moderationService failed to init or the method
    // doesn't exist (older VisionBot builds).
    if (moderationService && services.visionBotService
        && typeof services.visionBotService.setModerationService === 'function') {
      services.visionBotService.setModerationService(moderationService);
    }

    // PR-M5 (ADR-0013): mount the admin API surface. Handlers themselves
    // return 503 when the underlying moderationService is unset, so this is
    // safe to mount unconditionally (matches the PR-W5 whitelist pattern).
    const moderationAIRoutes = require('./routes/moderation-ai');
    app.use('/api/moderation-ai', moderationAIRoutes());
    logger.info('✅ MODERATION-AI: API routes mounted at /api/moderation-ai');

    // ── Streaming-backend orchestration (extracted in PR 9.3) ─────────────
    // The aligned ~160-line block produced by PR 9.2 lives in
    // server/bootstrap/start-streaming-backend.js. Side effects (globals +
    // app.locals + route mounts + stoppables push + lifecycleManager schedule)
    // are preserved verbatim; see that module's JSDoc for the contract.
    startStreamingBackend({
      streamService,
      SimpleViewBotRotation,
      whitelistService,
      io,
      streamNotifier,
      moderationService,
      sessionService,
      moderationNotifier,
      database,
      lifecycleManager,
      app,
      stoppables,
      livekitService,
      viewBotLiveKitService,
      authenticateAdmin,
    });

    // Make viewbotService available to routes
    app.locals.viewbotService = viewbotService;
    
    // Recording + clips tables are created by the database.js bootstrap
    // (ADR-0030: single DDL source). The setup-recording-tables /
    // setup-clips-tables re-runs that used to live here were duplicate,
    // conflicting DDL on a second boot-time connection and were deleted.

    // Inject viewbotService into InventoryService for viewbot targeting
    inventoryService.setViewbotService(viewbotService);
    // Inject viewbot socket checker function
    inventoryService.setViewbotSocketChecker((socketId) => viewbotSocketIds.has(socketId));

    // Expose io + streamService on the global for legacy rotation paths
    global.io = io;
    global.streamService = streamService;
    global.streamManager = streamService;  // streamManager and streamService are same
    logger.info('✅ GLOBAL OBJECTS: Set global.io and global.streamService for event emission');
    // PR 4.2: removed a 5-second dev-only "test-event" emit that fired on
    // every boot just to sanity-check global.io. The two preceding typeof
    // log lines already cover that — the deferred broadcast was dead-code
    // debug that shouldn't have shipped to production but did.

    // Helper function to get video files
    async function getVideoFiles() {
      const uploadsDir = path.join(__dirname, 'uploads');
      try {
        const files = await fs.promises.readdir(uploadsDir);
        return files
          .filter(file => ['.mp4', '.webm', '.mkv', '.avi', '.mov'].includes(path.extname(file).toLowerCase()))
          .map(file => path.join(uploadsDir, file));
      } catch (error) {
        logger.error({ err: error }, 'Failed to read video files');
        return [];
      }
    }
    
    // Port Monitor Service (was nested in the now-removed viewbot rotation
    // block; depends only on webrtcService).
    try {
      const PortMonitorService = require('./services/PortMonitorService');
      const portMonitor = new PortMonitorService(webrtcService);
      global.portMonitor = portMonitor;
      portMonitor.startMonitoring();
      stoppables.push(portMonitor);
      logger.info('✅ PORT MONITOR: Service started');
    } catch (error) {
      logger.error({ err: error }, '❌ PORT MONITOR: Failed to start');
    }
    
    // ViewBots are now persisted in database and restored automatically
    // No need to recreate from uploads on every startup
    // To add new viewbots from uploads, run: node /root/onestreamer/create-viewbots-from-uploads.js
  } catch (error) {
    logger.error({ err: error }, '❌ LIVEKIT: Initialization failed');
    logger.info('⚠️ Continuing without LiveKit and viewbot services...');
    viewbotService = null;
  }
  
  // Initialize ChatBot service
  try {
    logger.info('🤖 SERVER: Initializing ChatBot service...');
    initializeChatBotRoutes(chatBotService);
    logger.info('🤖 SERVER: ChatBot routes initialized');
    
    await chatBotService.initialize();
    logger.info('🤖 SERVER: ChatBot service initialization completed');
    
    // Initialize StreamBot service
    await streamBotService.initialize();
    logger.info('📢 SERVER: StreamBot service initialized');
    
    // Set up periodic cleanup for expired temporary bots. unref() so this
    // maintenance timer never holds the process open on its own — the HTTP
    // and Socket.IO listeners own the event loop (audit B6).
    const botCleanupTimer = setInterval(async () => {
      try {
        const cleaned = await chatBotService.cleanupExpiredBots();
        if (cleaned > 0) {
          logger.info(`🧹 Cleaned up ${cleaned} expired temporary bots`);
        }
      } catch (error) {
        logger.error({ err: error }, '❌ Error during bot cleanup');
      }
    }, 5 * 60 * 1000); // Run every 5 minutes
    if (typeof botCleanupTimer.unref === 'function') botCleanupTimer.unref();
    logger.info('⏰ Scheduled periodic cleanup for expired bots');
  } catch (error) {
    logger.error({ err: error }, '❌ SERVER: ChatBot service initialization failed');
    logger.error({ err: error }, '❌ SERVER: ChatBot service stack trace');
    // Continue without ChatBot service rather than crashing
    logger.info('⚠️ SERVER: Continuing without ChatBot service...');
  }

  // Social-media embed routes (Open Graph + Twitter Card + JSON-LD for the
  // blog and clip URLs). Extracted to server/routes/social-embed.js as part
  // of PR 4.3's startServer() decomposition — two ~140-line Express handler
  // blocks that didn't touch any internal service except clipService.
  // Mounted here so it still sits BEFORE the catch-all route below
  // (registration order matters for Express).
  mountSocialEmbedRoutes(app, {
    clipService,
    clientBuildIndexPath: CLIENT_BUILD_INDEX_PATH,
  });

  // Catch-all route - serve React app for client-side routing
  app.get('*', (req, res, next) => {
    // Don't intercept Socket.IO requests
    if (req.path.startsWith('/socket.io/')) {
      return next();
    }
    // Don't intercept API requests
    if (req.path.startsWith('/api/')) {
      return next();
    }
    // List of auth API endpoints to skip (not client routes)
    // Note: /auth/complete-registration is a CLIENT route, not API
    // while /auth/complete-oauth-registration is the API endpoint
    const authApiPaths = [
      '/auth/signup',
      '/auth/login', 
      '/auth/logout',
      '/auth/refresh',
      '/auth/verify-email/',
      '/auth/resend-verification',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/auth/me',
      '/auth/change-username',
      '/auth/profile',
      '/auth/google',
      '/auth/google/callback',
      '/auth/check-username/',
      '/auth/complete-oauth-registration', // API endpoint
      '/auth/request-deletion',
      '/auth/confirm-deletion',
      '/auth/restore-account'
    ];
    
    // Check if this is an auth API endpoint
    if (authApiPaths.some(apiPath => req.path.startsWith(apiPath))) {
      return next();
    }
    
    // Serve React app for all other routes including /auth/complete-registration
    res.sendFile(CLIENT_BUILD_INDEX_PATH);
  });

  // Start account deletion scheduler after a delay to ensure database is ready.
  // PR 4.2: routed through LifecycleManager so SIGTERM during the 5 s grace
  // window cancels the scheduler's own `setInterval` start against a
  // torn-down DB connection. The body below is intentionally fully
  // synchronous (require → new → start → push → log): SIGTERM can't
  // interleave a half-pushed scheduler because all four steps complete
  // atomically with respect to the event loop. Either the timer fires
  // before SIGTERM and the push completes, or lifecycleManager.stop()
  // cancels the timer before fire and the scheduler is never
  // constructed.
  lifecycleManager.schedule('account-deletion-scheduler-start', () => {
    const AccountDeletionScheduler = require('./services/AccountDeletionScheduler');
    const deletionScheduler = new AccountDeletionScheduler();
    deletionScheduler.start();
    stoppables.push(deletionScheduler);
    logger.info('🗑️ Account deletion scheduler started');
  }, 5000);

  // HTTP + HTTPS listener startup extracted to server/bootstrap/start-listeners.js
  // (PR 4.3). The error handler below is left inline because it's a long-
  // lived runtime concern, not a startup concern.
  startListeners({ httpServer, httpsServer, port: PORT, httpsPort: HTTPS_PORT });

  // PR 4.3: deleted a 5-second-interval "keep-alive log" setInterval whose
  // body was a commented-out log call — the timer was no-op work that
  // contributed to the leaked-handle tally in background-work.md. Node
  // doesn't need a setInterval to stay alive — the httpServer/httpsServer
  // listening sockets already keep the process up.

  // B3 (audit Plan 07): a listener error (e.g. EADDRINUSE in dev/no-HTTPS
  // mode) is fatal — logging alone left a zombie process bound to nothing.
  // Mirrors the HTTPS-listener + cert-load exits already in
  // start-listeners.js / the USE_HTTPS block above.
  httpServer.on('error', (err) => {
    logger.error({ err }, '❌ SERVER: HTTP listener error - exiting');
    process.exit(1);
  });
}

// B3: a throw inside startServer() used to only log and leave a half-booted
// zombie (listeners maybe up, services not). Exit non-zero so the container
// restarts cleanly instead of running degraded.
startServer().catch((err) => {
  logger.error({ err }, 'startServer failed - exiting');
  process.exit(1);
});

// Phase 15B.4 — shutdown sequence + signal handlers + cleanupMediaProcesses
// extracted to bootstrap/shutdown.js. Lazy services are passed via getters
// so the lookup happens at signal-time. The two `// console-allowed:
// uncaughtException fallback` markers ride along inside that module.
require('./bootstrap/shutdown')({
  stoppables,
  io,
  // ADR-0032: pass BOTH listeners — shutdown closes whichever are actually
  // listening (today exactly one is, per start-listeners.js, but this keeps
  // shutdown correct if the second listener ever returns).
  httpServer,
  httpsServer,
  getRedisClient: () => redisClient,
  getWebrtcService: () => webrtcService,
  getViewbotService: () => viewbotService,
  getTimeTrackingService: () => timeTrackingService,
  getResourceMonitor: () => resourceMonitor,
  getSessionService: () => sessionService,
  getSimpleMediaStreamService: () => (typeof simpleMediaStreamService !== 'undefined' ? simpleMediaStreamService : undefined),
});
