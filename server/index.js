// ============================================================================
// Phase 15B decomposition inventory + closure record (PR 15B.1 → 15B-close).
//
// `server/index.js` is the orchestrator. Phases 6–14 carved its services and
// repositories out into their own modules; Phase 15B finished the job for
// helpers (15B.2.a/b/c), socket-handler registration (15B.5), shutdown
// sequence (15B.4), and added section headers for middleware-stays (15B.6).
// PR 15B.3.a opened the route-cluster extractions with health/root/webrtc-
// config. Phase 15B closes here with the route-cluster residuals explicitly
// listed below — each remaining inline cluster is a clean future extraction
// (the inventory + closure-audit work is the load-bearing piece; the moves
// themselves are mechanical), but Phase 15's structural success criteria
// are met without them: a reader landing here cold can see the whole
// startup sequence in one screen (section headers below), every category
// of business-logic-bearing work outside `routes/` lives in a clearly-
// named module, and the inline `getStreamerDisplayName` helper is the
// explicit Phase 15B residual documented at its own section header.
//
// Helpers (lines 432–1121, ~690 LoC) — extracted by PR 15B.2 (helpers go
// FIRST because routes call them; reversing the order would force a
// back-import phase). Closure-over-lazy-service hazard documented in the
// 15B.1 PR description.
//
//   [extracted] initializeRedis              → bootstrap/redis.js     (15B.2.b — landed)
//   [deleted]   getActiveVisualEffects       → dead code (no callers) (15B.2.c)
//   [deleted]   startVisualEffectSync        → dead code (no callers) (15B.2.c)
//   [extracted] broadcastGlobalCooldown      → services/StreamOrchestration.js (15B.2.a — landed)
//   [extracted] cleanupViewbotUsername       → services/viewbot/UsernameCache.js (15B.2.b — landed)
//   [extracted] generateViewbotUsername      → services/viewbot/UsernameCache.js (15B.2.b — landed)
//   [residual]  getStreamerDisplayName       → stays inline (15B.2.c maintainer
//                                              call — lazy-service closure
//                                              prevents clean extraction; see
//                                              section header at the inline site)
//   [extracted] enrichStreamStatus           → services/StreamOrchestration.js (15B.2.a — landed)
//   [extracted] verifyAndEmitStreamReady     → services/StreamOrchestration.js (15B.2.a — landed)
//
// Routes (lines 1123–4598 in the pre-Phase-15B file, 143 inline handlers
// at the Phase-14 close). PR 15B.3.a opened the cluster extractions with
// health/root/webrtc-config (→ routes/health.js, 3 handlers). The remaining
// clusters below are **explicit Phase 15B residuals** — each is a clean
// mechanical extraction following the 15B.3.a pattern (express.Router,
// `req.app.locals.<serviceName>` with JSON-500 short-circuit, mount via
// `app.use(require('./routes/<cluster>'))`), but they don't unblock new
// work and the orchestrator already navigates cleanly via the section
// headers below. Future extraction is welcomed; not a Phase-15-blocker.
//
// Stateful service deps for any cluster: read from `req.app.locals.<svc>`
// with the JSON-500 short-circuit pattern from `server/routes/audio.js`.
// Auth: most clusters use `authenticateAdmin` / `authenticateModerator`
// (JWT, from `middleware/auth.js`); a few legacy clusters use
// `adminKeyAuth` (X-Admin-Key) or `viewBotAuth` (combined). The auth
// middlewares are constructed inline in `index.js` and can either move
// into the route module or stay on `app.locals.<authName>` for the
// extracted module to reference.
//
//   [extracted] root + health + webrtc cfg   → routes/health.js          (15B.3.a — landed)
//   [extracted] ViewBot HTTP admin bridge    → routes/viewbot-admin.js   (15B.3.e — landed)
//                  (52 routes; viewbot/, test-stream/, viewbot-manager,
//                   viewbot-webrtc, viewbot-client, simple-rotation,
//                   debug/, streaming-method; lazy services via getters)
//
//   [Phase 15B residual — explicit] route clusters still inline:
//     - visualfx debug static assets       (~5 routes; trivial — paths
//                                            could move to public/ static)
//     - emoji CRUD (user + admin)          (~6 routes; auth-isolated)
//     - admin moderation ban/timeout       (~16 routes when combined with
//                                            admin verify / IP-ban / logs)
//     - user chat-color get/set            (~2 routes; tiny cluster)
//     - admin dashboard HTML render        (1 route)
//     - admin stream control               (~4 routes)
//     - admin cooldowns                    (~3 routes)
//     - debug + system metrics             (~5 routes)
//     - uploaded videos                    (~3 routes)
//     - recordings (start/stop/list/...)   (~14 routes + ~5 continuous)
//     - transcription                      (~10 routes)
//     - MovieBot + VisionBot + Groq +
//       OpenAI admin                       (~13 routes total)
//
// Total residual: ~85 inline handlers (down from ~140), ~2600 LoC of route bodies.
// All have a clean destination per the table above; further extractions
// would be a Phase 16 candidate if scope permits.
//
// Lifecycle (lines 4945–5835, ~890 LoC) — non-route inline surfaces:
//
//   4945–5556   startServer()                → keeps inline; orchestration spine
//   [extracted] shutdown() + SIGINT/SIGTERM/ → bootstrap/shutdown.js     (15B.4 — landed)
//               uncaughtException +
//               cleanupMediaProcesses
//
//   [extracted] io.on('connection', ...)     → bootstrap/register-       (15B.5 — landed)
//               socket-handler registration    socket-handlers.js
//
// Middleware (lines 188–374 pre-Phase-15B) — stays in index.js with section
// headers per locked decision #7 (15B.6 — landed); pure `app.use(...)`
// wiring is wiring, and middleware order is load-bearing. Three section
// headers were added: MIDDLEWARE SETUP, ROUTE MOUNTS, and SERVER INIT.
//
// Status: Phase 15B closed. Landed: 15B.1 (inventory), 15B.2.a (orchestration
// helpers → services/StreamOrchestration.js), 15B.2.b (initializeRedis +
// viewbot username cache → bootstrap/redis.js + services/viewbot/
// UsernameCache.js), 15B.2.c (dead-code deletion + residual marker on
// getStreamerDisplayName), 15B.3.a (health/root/webrtc-cfg →
// routes/health.js), 15B.3.e (ViewBot HTTP admin bridge →
// routes/viewbot-admin.js — 52 routes / 783 LoC out of index.js), 15B.4
// (shutdown → bootstrap/shutdown.js), 15B.5 (io.on('connection') →
// bootstrap/register-socket-handlers.js), 15B.6 (middleware section-header
// pass). Remaining 15B.3 route clusters (b/c/d/f/g/h/i/j — ~85 inline
// handlers) are explicit Phase 15B residuals per the plan's closure clause.
// ============================================================================

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { createClient } = require('redis');
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

// ViewBot stack: the four named services (ViewbotService,
// ViewBotClientService, ViewBotWebRTCService, ViewBotLiveKitService) are
// constructed by server/bootstrap/services.js::createViewBotServices (PR-I4)
// inside startServer() once the mediasoup worker is ready.
// PR 9.3 (Phase 9): ViewBotURLService, URLStreamHealthService,
// RandomStreamRotationService, WhitelistEnforcer, and ModerationActionArbiter
// are now constructed inside server/bootstrap/start-streaming-backend.js.
// SimpleViewBotRotation stays required at module scope because its
// setStreamService is hoisted ABOVE the streaming-backend call (PR-I4);
// WhitelistService stays here because its construction surrounds the
// streaming-backend call (the whitelistService it produces is a dep).
const SimpleViewBotRotation = require('./services/SimpleViewBotRotation');
const WhitelistService = require('./services/WhitelistService');
const MediasoupService = require('./services/MediasoupService');
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
const visualfxRoutes = require('./routes/visualfx');
const { router: chatbotRoutes, initializeChatBotRoutes } = require('./routes/chatbots');
const streambotRoutes = require('./routes/streambot');
// ViewBot API routes will be initialized after services are created
let viewbotApiRoutes;
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
const registerEffectHandler = require('./sockets/EffectHandler');
const registerGameHandler = require('./sockets/GameHandler');
const registerMediaSoupHandler = require('./sockets/MediaSoupHandler');
const registerStreamHandler = require('./sockets/StreamHandler');
const registerViewBotHandler = require('./sockets/ViewBotHandler');
const database = require('./database/database');
const { runAsync, getAsync, allAsync } = database;
const UserRepository = require('./database/repository/UserRepository');
const userRepository = new UserRepository({ getAsync, runAsync, allAsync });

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
      } else {
        callback(null, true); // Allow all for now to debug ViewBots
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
const CLIENT_BUILD_INDEX_PATH = path.join(__dirname, '..', 'client', 'build', 'index.html');

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

// Serve VisualFX debug panel files
app.get('/visualfx-debug.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/src/visualfx-debug.js'));
});

app.get('/ClientVisualFxProcessor.js', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/src/ClientVisualFxProcessor.js'));
});

app.get('/useVisualFxProcessor.js', (req, res) => {
  // Serve the compiled TypeScript hook (it's integrated in the React build)
  res.json({ 
    message: 'Visual FX Processor hook is integrated in the React components',
    status: 'integrated' 
  });
});

app.get('/StreamerViewManager.js', (req, res) => {
  // Serve info about the StreamerViewManager (integrated in React build)
  res.json({ 
    message: 'StreamerViewManager is integrated in the React components',
    status: 'integrated',
    features: ['automatic view switching', 'effect detection', 'self-stream consumption']
  });
});

app.get('/visualfx-debug-panel.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/public/visualfx-debug-panel.html'));
});

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

// ViewBot Manager routes (WebRTC/Plain RTP toggle)
app.use('/api/viewbot-manager', (req, res, next) => {
  if (global.viewBotManager) {
    const viewBotManagerRoutes = require('./routes/viewbot-manager');
    viewBotManagerRoutes(global.viewBotManager)(req, res, next);
  } else {
    res.status(503).json({ error: 'ViewBot Manager not initialized' });
  }
});

// API routes
app.use('/api/admin', adminRoutes);
app.use('/api', itemRoutes);
app.use('/api/buffs', buffRoutes);
app.use('/api/soundfx', soundfxRoutes);
// ViewBot API routes will be added after services are initialized
app.use('/api/visualfx', visualfxRoutes);
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
app.use('/api/mediasoup', require('./routes/mediasoup'));
// /api/media + /api/stream/* + /api/webrtc/backend + /api/livekit/token
// share the streamService/mediasoupService/adapter wiring, so they're all
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

// WebRTC service initialization - with optional adapter support.
// Built BEFORE the service factory because it branches on env + assigns to
// globals, and the factory's plainTransportService consumes it as a dep.
let mediasoupService;
let usingAdapter = false;

if (process.env.USE_WEBRTC_ADAPTER === 'true') {
  // Use adapter for backend switching capability
  logger.info('🔄 WebRTC Adapter enabled - backend switching available');
  const WebRTCAdapterV2 = require('./services/WebRTCAdapterV2');
  mediasoupService = new WebRTCAdapterV2();
  usingAdapter = true;
  global.webrtcAdapter = mediasoupService; // Make adapter available globally
} else {
  // Use standard MediaSoup (default for compatibility)
  logger.info('📡 Using standard MediaSoup service');
  mediasoupService = new MediasoupService();
}

// Store service type for debugging
global.mediasoupServiceType = usingAdapter ? 'adapter' : 'direct';

// Composition root for the early-core services. See
// server/bootstrap/services.js for the dependency graph and PR-I2 scope.
const createServices = require('./bootstrap/services');
const { createViewBotServices } = createServices; // PR-I4 late-init helper.
const { services, stoppables: coreStoppables } = createServices({ io, redisClient, database, env: process.env, mediasoupService });

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
  plainTransportService,
  // PR-I2:
  streamInterceptorService,
  visualFxService,
  recordingStorageService,
  fileCompressionService,
  recordingService,
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

// mediasoupService isn't part of the PR-I services factory (it branches on
// USE_WEBRTC_ADAPTER before the factory runs and assigns to globals). Expose
// it here so server/routes/mediasoup.js + server/routes/media.js can read
// it via req.app.locals.mediasoupService (PR-G3).
app.locals.mediasoupService = mediasoupService;
app.locals.usingAdapter = usingAdapter;
app.locals.webrtcAdapter = global.webrtcAdapter; // mirrors the global; routes/health.js reads
app.locals.adminKey = ADMIN_KEY; // for routes/health.js admin-config endpoint
// generateTurnCredentials is a top-level helper in server/index.js; expose
// it for server/routes/media.js (used by /api/livekit/token).
app.locals.generateTurnCredentials = generateTurnCredentials;

// Phase 15B.2.c — getActiveVisualEffects + startVisualEffectSync deleted as
// dead code. Discovered during the extraction prep: startVisualEffectSync()
// has zero callers (verified by `grep -rn "startVisualEffectSync" server/
// client/ chat-service/`). getActiveVisualEffects was only called from
// inside startVisualEffectSync. The only remaining references are two
// commented-out blocks in sockets/MediaSoupHandler.js:306 and sockets/
// StreamHandler.js:159 (visual-effects-sync-pulse paths disabled to debug
// rotate_90). The "Sync will be started after server initialization"
// comment lines below those helpers also no-op'd because the boot code
// never invoked the function. Removed rather than extracted — the truest
// "state unification" for an unreachable broadcast pulse is no pulse.

// When a buff is applied, ensure visual effects are triggered for all viewers
buffDebuffService.on('buff-applied', async (buffData) => {
  try {
    // Check if this is a visual effect buff
    const visualEffectItems = [
      'smoke_bomb', 'pixelate', 'emboss', 'thermal_vision', 'rotate_90',
      'potato', 'upside_down', 'mirror', 'invert_colors', 'darkness',
      'overexposed', 'glitch_bomb', 'motion_blur', 'freeze_frame',
      'spotlight', 'disco_ball', 'confetti_cannon', 'rainbow_effect',
      'stream_reducer'
    ];
    
    if (buffData.item_name && visualEffectItems.includes(buffData.item_name)) {
      logger.info(`🎨 VISUAL FX: Buff ${buffData.item_name} applied, ensuring visual sync`);
      
      // Broadcast to all viewers to apply this effect
      io.emit('visual-effect-apply-sync', {
        effectId: buffData.item_name,
        itemName: buffData.item_name,
        displayName: buffData.display_name,
        duration: (buffData.remaining_seconds || buffData.duration_seconds || 60) * 1000,
        effectData: buffData.effect_data,
        buffId: buffData.id,
        isNewBuff: true
      });
    }
  } catch (error) {
    logger.error({ err: error }, '❌ VISUAL FX: Error syncing buff-applied visual effect');
  }
});
// streamInterceptorService + visualFxService built by the services factory
// (PR-I2). chatBotService / streamBotService / movieBotService also built
// there. setMovieBotService was eliminated in PR 1.3 by the BotEventBus;
// remaining post-construction setters (setIoInstance, setChatBotService,
// setChatBotLLMService) are still factory-internal.

// Set up stream interceptor event handlers
streamInterceptorService.on('stream-intercepted', async (data) => {
    const { streamId, processedProducerId } = data;
    logger.info(`🎬 SERVER: Stream intercepted for ${streamId}, switching viewers...`);
    
    // DON'T notify the streamer - they should keep producing to the original transport
    // Only notify viewers so they can switch to the processed stream
    // For now, we'll skip the client notification entirely since the client doesn't handle it
    // In a full implementation, viewers would reconnect to consume from the processed producers
    
    // TODO: Implement viewer switching logic
    // This would involve:
    // 1. Finding all viewers consuming from the original stream
    // 2. Having them create new consumers for the processed producers
    // 3. Switching their video/audio to the new consumers
    
    logger.info(`🎬 SERVER: Stream interception complete - GStreamer is processing the stream`);
});

streamInterceptorService.on('stream-restored', (data) => {
    const { streamId } = data;
    logger.info(`🎬 SERVER: Stream restored for ${streamId}`);
    
    // Notify all clients about restoration
    io.emit('stream-restored', {
        streamId,
        timestamp: Date.now()
    });
});

// Recording + clip + admin-review services are all built by the services
// factory (PR-I2). See server/bootstrap/services.js for the dep graph.

// Wire up services
adminRecordingsRoutes.setServices({
  uploadScheduler: recordingUploadScheduler,
  cleanupScheduler: recordingCleanupScheduler,
  chatCaptureService: sessionChatCaptureService,
  clipService: clipService
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

// Set dependencies for visual fx service
visualFxService.setDependencies(mediasoupService, buffDebuffService, streamService, io, sessionService, streamInterceptorService);

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
app.set('visualFxService', visualFxService);
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
const userBonusCooldowns = new Map();
app.locals.userBonusCooldowns = userBonusCooldowns;
app.use('/api/internal', require('./routes/internal'));

// Initialize ViewbotService after MediasoupService
let viewbotService;
let viewBotWebRTCService;
let viewBotClientService;

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
  mediasoupService,
  getStreamerDisplayName,
  lastEmittedStreamReady,
});
const { broadcastGlobalCooldown, enrichStreamStatus, verifyAndEmitStreamReady } = streamOrchestration;

// Phase 15B.3.a — health/root/webrtc-config moved to routes/health.js
// (covers GET /, GET /health, GET /api/admin/webrtc/config).
app.use(require('./routes/health'));

// /api/stream/status, /api/stream/active, /api/media/*, /api/mediasoup/*,
// /api/webrtc/backend, and /api/livekit/token live in
// server/routes/mediasoup.js and server/routes/media.js (mounted above).
// PR-G3.

// Import JWT admin authentication middleware
const { authenticateAdmin, authenticateModerator } = require('./middleware/auth');
// AuthService already imported at the top of the file

// Simple admin auth middleware (kept for legacy endpoints that might need admin key)
const adminKeyAuth = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const correctKey = ADMIN_KEY;
  
  if (adminKey !== correctKey) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin key' });
  }
  next();
};

// Custom Emoji API endpoints
app.get('/api/emojis', async (req, res) => {
    try {
        const emojis = await database.allAsync(`
            SELECT id, name, code, url, category, usage_count 
            FROM custom_emojis 
            WHERE is_active = 1 
            ORDER BY usage_count DESC, name ASC
        `);
        
        // Check for available formats for each emoji
        const fs = require('fs').promises;
        const path = require('path');
        const emojisWithFormats = await Promise.all(emojis.map(async (emoji) => {
            const basePath = emoji.url.replace(/\.[^/.]+$/, '');
            const baseFile = path.join(__dirname, '..', basePath);
            
            const formats = {
                avif: emoji.url,
                gif: null,
                webp: null,
                png: null
            };
            
            // Check for GIF
            try {
                await fs.access(baseFile + '.gif');
                formats.gif = basePath + '.gif';
            } catch {}
            
            // Check for WebP
            try {
                await fs.access(baseFile + '.webp');
                formats.webp = basePath + '.webp';
            } catch {}
            
            // Check for PNG
            try {
                await fs.access(baseFile + '.png');
                formats.png = basePath + '.png';
            } catch {}
            
            return {
                ...emoji,
                formats
            };
        }));
        
        res.json(emojisWithFormats);
    } catch (error) {
        logger.error({ err: error }, 'Error fetching emojis');
        res.status(500).json({ error: 'Failed to fetch emojis' });
    }
});

// Chat Moderation API endpoints
app.get('/api/admin/moderation', authenticateModerator, async (req, res) => {
    try {
        // Send a request to the chat service to get moderation data
        const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/moderation`;
        logger.info(`📊 MAIN SERVER: Fetching moderation data from ${chatServiceUrl}`);
        
        const response = await axios.get(chatServiceUrl, { timeout: 5000 });
        
        logger.info({ data: response.data }, `📊 MAIN SERVER: Received moderation data`);
        res.json(response.data);
    } catch (error) {
        logger.error({ err: error }, 'Error fetching moderation data');
        logger.error({ err: error }, 'Full error');
        res.status(500).json({ 
            error: 'Failed to fetch moderation data',
            bannedUsers: [],
            timedOutUsers: []
        });
    }
});

app.post('/api/admin/ban', authenticateModerator, express.json(), async (req, res) => {
    try {
        const { username, reason } = req.body;
        const adminUser = await authService.getUserFromToken(req.headers.authorization?.substring(7));
        
        // Send ban request to chat service
        const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/ban`;
        const response = await axios.post(chatServiceUrl, {
            username,
            reason,
            bannedBy: adminUser.username
        });
        
        res.json(response.data);
    } catch (error) {
        logger.error({ err: error }, 'Error banning user');
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

app.post('/api/admin/unban', authenticateModerator, express.json(), async (req, res) => {
    try {
        const { username } = req.body;
        
        // Send unban request to chat service
        const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/unban`;
        const response = await axios.post(chatServiceUrl, { username });
        
        res.json(response.data);
    } catch (error) {
        logger.error({ err: error }, 'Error unbanning user');
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

app.post('/api/admin/timeout', authenticateModerator, express.json(), async (req, res) => {
    try {
        const { username, duration, reason } = req.body;
        const adminUser = await authService.getUserFromToken(req.headers.authorization?.substring(7));
        
        // Send timeout request to chat service
        const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/timeout`;
        const response = await axios.post(chatServiceUrl, {
            username,
            duration,
            reason,
            timedOutBy: adminUser.username
        });
        
        res.json(response.data);
    } catch (error) {
        logger.error({ err: error }, 'Error timing out user');
        res.status(500).json({ error: 'Failed to timeout user' });
    }
});

app.post('/api/admin/remove-timeout', authenticateModerator, express.json(), async (req, res) => {
    try {
        const { username } = req.body;
        
        // Send remove timeout request to chat service
        const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/remove-timeout`;
        const response = await axios.post(chatServiceUrl, { username });
        
        res.json(response.data);
    } catch (error) {
        logger.error({ err: error }, 'Error removing timeout');
        res.status(500).json({ error: 'Failed to remove timeout' });
    }
});

// Get all emojis for admin panel
app.get('/api/admin/emojis', authenticateAdmin, async (req, res) => {
    try {
        const emojis = await database.allAsync(`
            SELECT e.*, u.username as created_by_username
            FROM custom_emojis e
            LEFT JOIN users u ON e.created_by = u.id
            ORDER BY e.created_at DESC
        `);
        res.json(emojis);
    } catch (error) {
        logger.error({ err: error }, 'Error fetching admin emojis');
        res.status(500).json({ error: 'Failed to fetch emojis' });
    }
});

// Upload new emoji
const emojiStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads', 'emojis');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const emojiUpload = multer({ 
    storage: emojiStorage,
    limits: { fileSize: 500000 }, // 500KB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp|avif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
        const mimetype = allowedMimeTypes.includes(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files (JPEG, PNG, GIF, WebP, AVIF) are allowed'));
        }
    }
});

app.post('/api/admin/emojis', authenticateAdmin, emojiUpload.single('emoji'), async (req, res) => {
    try {
        const { name, code, category } = req.body;
        const user = req.user;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        if (!name || !code) {
            // Clean up uploaded file
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Name and code are required' });
        }
        
        // Ensure code is formatted correctly (without colons)
        const cleanCode = code.replace(/^:+|:+$/g, '');
        
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        const fileExt = path.extname(req.file.filename).toLowerCase();
        let finalFilePath = req.file.path;
        let finalFilename = req.file.filename;
        
        // Convert all uploaded images to Safari-compatible AVIF format
        try {
            if (fileExt === '.avif') {
                // Re-encode existing AVIF with Safari-compatible settings
                logger.info({ filename: req.file.filename }, 'Re-encoding AVIF file for Safari compatibility');
                
                // First decode to PNG
                const tempPng = req.file.path.replace('.avif', '_temp.png');
                await execPromise(`avifdec "${req.file.path}" "${tempPng}" 2>/dev/null`);
                
                // Re-encode with Safari-compatible settings
                const tempAvif = req.file.path + '.new';
                await execPromise(`avifenc --qcolor 85 --speed 6 --yuv 420 --range limited --cicp 1/13/6 --autotiling --jobs all "${tempPng}" "${tempAvif}" 2>/dev/null`);
                
                // Replace original with converted version
                if (fs.existsSync(tempAvif) && fs.statSync(tempAvif).size > 0) {
                    fs.unlinkSync(req.file.path);
                    fs.renameSync(tempAvif, req.file.path);
                    logger.info('Successfully re-encoded AVIF for Safari compatibility');
                }
                
                // Clean up temp files
                if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng);
                if (fs.existsSync(tempAvif)) fs.unlinkSync(tempAvif);
            } else {
                // Convert PNG/JPG/GIF/WebP to Safari-compatible AVIF
                logger.info({ fileExt, filename: req.file.filename }, 'Converting to Safari-compatible AVIF');
                
                const avifPath = req.file.path.replace(fileExt, '.avif');
                const avifFilename = req.file.filename.replace(fileExt, '.avif');
                
                // For GIF, extract first frame to PNG first
                let sourceFile = req.file.path;
                if (fileExt === '.gif') {
                    const tempPng = req.file.path.replace('.gif', '_frame.png');
                    await execPromise(`ffmpeg -i "${req.file.path}" -vframes 1 -y "${tempPng}" 2>/dev/null`);
                    if (fs.existsSync(tempPng)) {
                        sourceFile = tempPng;
                    }
                }
                
                // Convert to AVIF with Safari-compatible settings
                await execPromise(`avifenc --qcolor 85 --speed 6 --yuv 420 --range limited --cicp 1/13/6 --autotiling --jobs all "${sourceFile}" "${avifPath}" 2>/dev/null`);
                
                // Check if conversion succeeded
                if (fs.existsSync(avifPath) && fs.statSync(avifPath).size > 0) {
                    // Delete original file
                    fs.unlinkSync(req.file.path);
                    
                    // Clean up temp PNG if it was created for GIF
                    if (fileExt === '.gif' && sourceFile !== req.file.path) {
                        fs.unlinkSync(sourceFile);
                    }
                    
                    finalFilePath = avifPath;
                    finalFilename = avifFilename;
                    logger.info('Successfully converted to Safari-compatible AVIF');
                } else {
                    // Clean up temp PNG if it was created for GIF
                    if (fileExt === '.gif' && sourceFile !== req.file.path) {
                        fs.unlinkSync(sourceFile);
                    }
                    logger.info('Warning: AVIF conversion failed, using original file');
                }
            }
        } catch (conversionError) {
            logger.error({ err: conversionError }, 'Warning: Image conversion failed, using original file');
            // Continue with original file if conversion fails
        }
        
        const url = `/uploads/emojis/${finalFilename}`;
        
        const result = await database.runAsync(`
            INSERT INTO custom_emojis (name, code, file_path, url, category, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [name, cleanCode, finalFilePath, url, category || 'general', user.id]);
        
        res.json({ 
            id: result.id,
            name,
            code: cleanCode,
            url,
            category: category || 'general',
            message: 'Emoji uploaded successfully' 
        });
    } catch (error) {
        logger.error({ err: error }, 'Error uploading emoji');
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to upload emoji' });
    }
});

// Update emoji
app.put('/api/admin/emojis/:id', authenticateAdmin, express.json(), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, code, category, is_active } = req.body;
        
        // Ensure code is formatted correctly (without colons)
        const cleanCode = code ? code.replace(/^:+|:+$/g, '') : undefined;
        
        const updates = [];
        const values = [];
        
        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name);
        }
        if (code !== undefined) {
            updates.push('code = ?');
            values.push(cleanCode);
        }
        if (category !== undefined) {
            updates.push('category = ?');
            values.push(category);
        }
        if (is_active !== undefined) {
            updates.push('is_active = ?');
            values.push(is_active ? 1 : 0);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }
        
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        
        await database.runAsync(`
            UPDATE custom_emojis 
            SET ${updates.join(', ')}
            WHERE id = ?
        `, values);
        
        res.json({ message: 'Emoji updated successfully' });
    } catch (error) {
        logger.error({ err: error }, 'Error updating emoji');
        res.status(500).json({ error: 'Failed to update emoji' });
    }
});

// Delete emoji
app.delete('/api/admin/emojis/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get emoji info first
        const emoji = await database.getAsync('SELECT file_path FROM custom_emojis WHERE id = ?', [id]);
        
        if (!emoji) {
            return res.status(404).json({ error: 'Emoji not found' });
        }
        
        // Delete from database
        await database.runAsync('DELETE FROM custom_emojis WHERE id = ?', [id]);
        
        // Delete file if it exists
        if (emoji.file_path && fs.existsSync(emoji.file_path)) {
            fs.unlinkSync(emoji.file_path);
        }
        
        res.json({ message: 'Emoji deleted successfully' });
    } catch (error) {
        logger.error({ err: error }, 'Error deleting emoji');
        res.status(500).json({ error: 'Failed to delete emoji' });
    }
});

// Track emoji usage
app.post('/api/emojis/:code/use', express.json(), async (req, res) => {
    try {
        const { code } = req.params;
        
        await database.runAsync(`
            UPDATE custom_emojis 
            SET usage_count = usage_count + 1 
            WHERE code = ? AND is_active = 1
        `, [code]);
        
        res.json({ success: true });
    } catch (error) {
        logger.error({ err: error }, 'Error tracking emoji usage');
        res.status(500).json({ error: 'Failed to track emoji usage' });
    }
});

// Save user's chat color preference
app.post('/api/user/chat-color', express.json(), async (req, res) => {
    try {
        const { userId, color } = req.body;
        
        if (!userId || !color) {
            return res.status(400).json({ error: 'Missing userId or color' });
        }
        
        // Validate hex color
        if (!/^#[0-9A-F]{6}$/i.test(color)) {
            return res.status(400).json({ error: 'Invalid color format' });
        }
        
        // Check if user_stats exists for this user
        const userStats = await database.getAsync(
            'SELECT id FROM user_stats WHERE user_id = ?',
            [userId]
        );
        
        if (userStats) {
            // Update existing record
            await database.runAsync(
                'UPDATE user_stats SET chat_color = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                [color, userId]
            );
        } else {
            // Create new record
            await database.runAsync(
                'INSERT INTO user_stats (user_id, chat_color) VALUES (?, ?)',
                [userId, color]
            );
        }
        
        logger.info(`🎨 Saved chat color ${color} for user ${userId}`);
        res.json({ success: true, color });
    } catch (error) {
        logger.error({ err: error }, 'Error saving chat color');
        res.status(500).json({ error: 'Failed to save chat color' });
    }
});

// Get user's saved chat color
app.get('/api/user/:userId/chat-color', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await database.getAsync(
            'SELECT chat_color FROM user_stats WHERE user_id = ?',
            [userId]
        );
        
        res.json({ 
            color: result?.chat_color || null 
        });
    } catch (error) {
        logger.error({ err: error }, 'Error fetching chat color');
        res.status(500).json({ error: 'Failed to fetch chat color' });
    }
});

// Fallback auth middleware for ViewBot endpoints - try JWT first, then admin key
const viewBotAuth = (req, res, next) => {
  logger.info({ path: req.path }, '🔐 ViewBot Auth - Request path');
  logger.info({
    'x-admin-key': req.headers['x-admin-key'] ? '<redacted>' : undefined,
    'authorization': req.headers['authorization'] ? '<bearer>' : undefined,
    'admin_key_query': req.query.admin_key ? '<redacted>' : undefined,
  }, '🔐 ViewBot Auth - Headers');

  // Check for admin key first (simpler auth for ViewBot operations)
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const correctKey = ADMIN_KEY;

  logger.info({
    provided: !!adminKey,
    matches: adminKey === correctKey,
  }, '🔐 ViewBot Auth - Admin key check');
  
  if (adminKey === correctKey) {
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
app.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    logger.info('🔍 Dashboard request received');
    logger.info({ viewBotClientService: !!viewBotClientService }, '🔍 viewBotClientService exists');
    
    // Get ViewBot system data with error handling
    let viewBotData = null;
    let viewBotHealth = null;
    
    try {
      if (viewBotClientService) {
        logger.info('🔍 Getting ViewBot data...');
        viewBotData = await viewBotClientService.getAllBotsStatus();
        viewBotHealth = viewBotClientService.getHealthStatus();
        logger.info({ totalBots: viewBotData?.totalBots, rotationEnabled: viewBotHealth?.rotationEnabled }, '🔍 ViewBot data retrieved');
      } else {
        logger.info('⚠️ ViewBotClientService not initialized');
      }
    } catch (error) {
      logger.error({ err: error }, '❌ ViewBot service error');
    }
    
    const services = {
      stream: streamService.getStreamStatus(),
      viewBot: {
        totalBots: viewBotData?.totalBots || 0,
        streamingBots: viewBotData?.bots?.filter(bot => bot.isStreaming).length || 0,
        connectedBots: viewBotData?.bots?.filter(bot => bot.isConnected).length || 0,
        rotationEnabled: viewBotHealth?.rotationEnabled || false,
        currentLiveBot: viewBotHealth?.currentLiveBot || null,
        availableBots: viewBotData?.bots?.filter(bot => bot.isConnected && !bot.isStreaming).length || 0,
        realStreamerActive: viewBotHealth?.realStreamerActive || false,
        timeToNextRotation: viewBotHealth?.timeToNextRotation || null,
        timeToNextRotationFormatted: viewBotHealth?.timeToNextRotationFormatted || null
      },
      takeover: {
        cooldownSeconds: takeoverService.getCooldownSeconds(),
        lastTakeover: await takeoverService.getLastTakeoverTime(),
      }
    };

    const cooldowns = await takeoverService.getAllCooldowns();
    
    // Format cooldowns for backward compatibility with client
    const formattedCooldowns = cooldowns.map(cooldown => ({
      socketId: cooldown.identifier, // For client compatibility
      identifier: cooldown.identifier, // New field for IP tracking
      remaining: cooldown.remaining,
      reason: cooldown.reason,
      duration: cooldown.duration
    }));

    res.json({
      message: 'OneStreamer Admin Dashboard',
      services,
      cooldowns: formattedCooldowns,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Dashboard error');
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// Phase 15B.3.e — ViewBot HTTP admin bridge extracted to routes/viewbot-admin.js.
// 52 routes spanning the viewbot/, test-stream/, viewbot-manager,
// viewbot-webrtc, viewbot-client, simple-rotation, debug/, and
// streaming-method path families. Lazy services pass via getters.
app.use(require("./routes/viewbot-admin")({
  adminKeyAuth, viewBotAuth, authenticateAdmin,
  streamService, mediasoupService, sessionService, testStreamService,
  mediaStreamService, buffNotifier, streamNotifier, viewerCountNotifier,
  cleanupViewbotUsername, broadcastGlobalCooldown, notifyViewersStreamEnded,
  io, ADMIN_KEY, upload, uploadsDir, path, logger,
  getViewbotService: () => viewbotService,
  getViewBotClientService: () => viewBotClientService,
  getViewBotWebRTCService: () => viewBotWebRTCService,
}));

app.post('/admin/force-disconnect', authenticateAdmin, (req, res) => {
  const { socketId } = req.body;
  
  if (!socketId) {
    return res.status(400).json({ error: 'socketId is required' });
  }
  
  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.disconnect(true);
    res.json({ success: true, message: `Disconnected socket ${socketId}` });
  } else {
    res.status(404).json({ error: 'Socket not found' });
  }
});

app.post('/admin/send-message', authenticateAdmin, (req, res) => {
  const { socketId, message } = req.body;
  
  if (!socketId || !message) {
    return res.status(400).json({ error: 'socketId and message are required' });
  }
  
  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.emit('admin-notification', {
      message: message,
      timestamp: Date.now(),
      type: 'info'
    });
    res.json({ success: true, message: `Message sent to socket ${socketId}` });
  } else {
    res.status(404).json({ error: 'Socket not found' });
  }
});

app.post('/admin/clear-stream', authenticateAdmin, (req, res) => {
  const clearedStreamer = streamService.clearStreamer();
  mediasoupService.currentStreamer = null;
  logger.info(`🧹 ADMIN CLEAR: Cleared ${clearedStreamer} from both services`);

  streamNotifier.streamEnded({ reason: 'admin_clear', previousStreamer: clearedStreamer });
  viewerCountNotifier.broadcast();

  res.json({
    success: true,
    message: 'Stream cleared',
    previousStreamer: clearedStreamer
  });
});

app.get('/admin/connections', authenticateAdmin, async (req, res) => {
  // Get ONLY currently connected sockets
  const connectedSockets = Array.from(io.sockets.sockets.values());
  const connectedSocketIds = new Set(connectedSockets.map(s => s.id));
  
  const sockets = connectedSockets.map(socket => ({
    id: socket.id,
    connected: socket.connected,
    rooms: Array.from(socket.rooms),
    handshake: {
      address: socket.handshake.address,
      time: socket.handshake.time,
      headers: socket.handshake.headers['user-agent']
    }
  }));
  
  // Get session data from SessionService but filter to only connected sockets
  const allSessions = sessionService.getAllSessions();
  const sessions = allSessions.filter(session => connectedSocketIds.has(session.socketId));
  const uniqueViewerCount = sessionService.getUniqueViewerCount();
  const activeSessions = sessionService.getActiveSessions();
  
  // accountService is the bootstrap-built instance from line ~462 (createServices).
  // A prior inline `new AccountService()` here was a leftover from before the
  // services factory; the class isn't imported in this file, which silently
  // hung the request via an un-caught async ReferenceError.

  // Enhance session data with additional information
  const enhancedSessions = await Promise.all(sessions.map(async (session) => {
    // Get chat username if available
    const chatInfo = sessionService.getChatUsername(session.ipAddress);
    
    // Get user details and stats if authenticated (skip negative IDs as they are ViewBots)
    let userDetails = null;
    let userStats = null;
    if (session.userId && session.userId > 0) {
      try {
        userDetails = await accountService.getUserById(session.userId);
        // Get real-time stats from database
        userStats = await accountService.getUserStats(session.userId);
      } catch (err) {
        logger.info({ err }, `Could not fetch user details for ${session.userId}`);
      }
    }
    
    // Calculate real-time view time for active sessions
    let currentViewTime = session.stats?.viewTime || 0;
    if (session.isActive && timeTrackingService.viewingSessions.has(session.socketId)) {
      const viewingSession = timeTrackingService.viewingSessions.get(session.socketId);
      if (viewingSession && viewingSession.startTime) {
        currentViewTime = Date.now() - viewingSession.startTime;
      }
    }
    
    return {
      ...session,
      chatUsername: chatInfo?.username || session.userAgent || 'Anonymous',
      chatColor: chatInfo?.color || '#718096',
      authenticatedUser: userDetails ? {
        id: userDetails.id,
        username: userDetails.username,
        email: userDetails.email
      } : null,
      stats: {
        chatMessageCount: userStats?.chat_message_count || session.stats?.chatMessageCount || 0,
        streamTime: userStats?.total_stream_time || session.stats?.streamTime || 0,
        viewTime: currentViewTime || userStats?.total_view_time || session.stats?.viewTime || 0,
        streamCount: userStats?.stream_count || session.stats?.streamCount || 0,
        lastStreamAt: userStats?.last_stream_at || session.stats?.lastStreamAt || null
      }
    };
  }));
  
  // Count unique IPs from connected sessions only
  const uniqueIPs = new Set(sessions.map(s => s.ipAddress)).size;
  
  res.json({
    totalConnections: sessions.length,  // Use filtered sessions count
    uniqueIPs: uniqueIPs,
    connections: sockets,
    sessions: enhancedSessions,
    uniqueViewers: uniqueViewerCount,
    activeSessions: activeSessions.length,
    streamStatus: streamService.getStreamStatus(),
    stats: sessionService.getStats()
  });
});

// Admin cooldown management endpoints
app.post('/admin/remove-cooldown', authenticateAdmin, async (req, res) => {
  try {
    const { socketId } = req.body;
    
    if (!socketId) {
      return res.status(400).json({ error: 'socketId is required' });
    }

    const result = await takeoverService.removeCooldown(socketId);
    
    if (result) {
      logger.info(`🔥 ADMIN: Cooldown removed for ${socketId}`);
      res.json({ success: true, message: `Cooldown removed for ${socketId}` });
    } else {
      res.status(404).json({ error: 'No cooldown found for this socket' });
    }
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to remove cooldown');
    res.status(500).json({ error: 'Failed to remove cooldown' });
  }
});

app.post('/admin/reset-cooldowns', authenticateAdmin, async (req, res) => {
  try {
    // Reset TakeoverService cooldowns (global system cooldowns)
    const takeoverCount = await takeoverService.resetAllCooldowns();
    logger.info(`🔥 ADMIN: Reset ${takeoverCount} takeover cooldowns`);
    
    // Reset ItemService cooldowns (item usage cooldowns)
    const itemCount = await itemService.resetAllItemCooldowns();
    logger.info(`🔥 ADMIN: Reset ${itemCount} item usage cooldowns`);
    
    const totalCount = takeoverCount + itemCount;
    logger.info(`🔥 ADMIN: Total cooldowns reset: ${totalCount}`);
    
    res.json({ 
      success: true, 
      message: `Reset ${totalCount} cooldowns (${takeoverCount} system + ${itemCount} item usage)`,
      count: totalCount,
      breakdown: {
        takeoverCooldowns: takeoverCount,
        itemCooldowns: itemCount
      }
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to reset cooldowns');
    res.status(500).json({ error: 'Failed to reset cooldowns' });
  }
});

app.get('/admin/cooldowns', authenticateAdmin, async (req, res) => {
  try {
    const cooldowns = await takeoverService.getAllCooldowns();
    
    // Format cooldowns for backward compatibility with client
    const formattedCooldowns = cooldowns.map(cooldown => ({
      socketId: cooldown.identifier, // For client compatibility
      identifier: cooldown.identifier, // New field for IP tracking
      remaining: cooldown.remaining,
      reason: cooldown.reason,
      duration: cooldown.duration
    }));
    
    res.json({ cooldowns: formattedCooldowns });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get cooldowns');
    res.status(500).json({ error: 'Failed to get cooldowns' });
  }
});

app.get('/debug/server-state', (req, res) => {
  try {
    const currentStreamer = mediasoupService.getCurrentStreamer();
    const producers = {};
    const notifiedList = Array.from(notifiedStreamers);
    
    // Get producer info for all streamers
    for (const [socketId, producerMap] of mediasoupService.producers.entries()) {
      producers[socketId] = {
        count: producerMap.size,
        types: Array.from(producerMap.keys())
      };
    }
    
    res.json({
      currentStreamer,
      producers,
      notifiedStreamers: notifiedList,
      streamService: {
        currentStreamer: streamService.getCurrentStreamer()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resource monitoring endpoints
app.get('/admin/system-metrics', authenticateAdmin, (req, res) => {
  try {
    const metrics = resourceMonitor.getFormattedMetrics();
    const alerts = resourceMonitor.getAlerts(10);
    
    res.json({
      metrics,
      alerts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get system metrics');
    res.status(500).json({ error: 'Failed to get system metrics' });
  }
});

app.get('/admin/system-health', authenticateAdmin, (req, res) => {
  try {
    const healthSummary = resourceMonitor.getHealthSummary();
    res.json(healthSummary);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get system health');
    res.status(500).json({ error: 'Failed to get system health' });
  }
});

app.post('/admin/clear-alerts', authenticateAdmin, (req, res) => {
  try {
    resourceMonitor.clearAlerts();
    res.json({ success: true, message: 'System alerts cleared' });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to clear alerts');
    res.status(500).json({ error: 'Failed to clear alerts' });
  }
});

app.get('/admin/performance-stats', authenticateAdmin, (req, res) => {
  try {
    // Get socket statistics
    const socketStats = {
      total: io.sockets.sockets.size,
      active: io.sockets.sockets.size,
      streamers: streamService.getCurrentStreamer() ? 1 : 0,
      viewers: streamService.getViewerCount()
    };

    // Get mediasoup statistics
    const mediasoupStats = mediasoupService.getStats();

    // Update resource monitor with current stats
    resourceMonitor.updateConnectionMetrics(socketStats);
    resourceMonitor.updateMediasoupMetrics(mediasoupStats);

    const performanceStats = {
      sockets: socketStats,
      mediasoup: mediasoupStats,
      resources: resourceMonitor.getMetrics(),
      health: resourceMonitor.getHealthSummary().status
    };

    res.json(performanceStats);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get performance stats');
    res.status(500).json({ error: 'Failed to get performance stats' });
  }
});

// Stream Moderation Endpoints
app.get('/api/admin/verify', authenticateModerator, (req, res) => {
  res.json({ success: true, isAdmin: req.userRecord.is_admin === 1, isModerator: req.userRecord.is_moderator === 1 });
});

app.get('/api/admin/stream-details/:streamerId', authenticateModerator, (req, res) => {
  try {
    const { streamerId } = req.params;
    const socket = io.sockets.sockets.get(streamerId);
    
    if (!socket) {
      return res.status(404).json({ error: 'Stream not found' });
    }
    
    const ipAddress = IPBanService.getIPFromSocket(socket);
    const startTime = socket.handshake.time || new Date().toISOString();
    
    res.json({
      streamerId,
      ipAddress,
      startTime,
      connectionTime: socket.handshake.time
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get stream details');
    res.status(500).json({ error: 'Failed to get stream details' });
  }
});

app.post('/api/admin/stream/disconnect', authenticateModerator, async (req, res) => {
  try {
    const { streamerId } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'Streamer ID required' });
    }
    
    const currentStreamer = streamService.getCurrentStreamer();
    if (currentStreamer !== streamerId) {
      return res.status(400).json({ error: 'Specified streamer is not currently streaming' });
    }
    
    // Check if this is a viewbot stream
    const isViewbotStream = (viewbotService && viewbotService.isViewbotStream(streamerId)) || 
                           viewbotSocketIds.has(streamerId);
    
    if (isViewbotStream) {
      // For viewbots, trigger rotation instead of disconnect
      logger.info(`🔨 MODERATION: Admin triggering viewbot rotation for stream ${streamerId}`);
      
      // Try different rotation methods based on what's available
      let rotationResult = { success: false, message: 'No rotation service available' };
      
      if (viewBotClientService) {
        // Use ViewBotClientService for rotation
        rotationResult = await viewBotClientService.forceRotation();
        logger.info({ rotationResult }, `🤖 ROTATION: Triggered via ViewBotClientService`);
      } else if (global.viewBotRotation) {
        // Use simple rotation service
        await global.viewBotRotation.forceRotation();
        rotationResult = { success: true, message: 'Rotation triggered via simple rotation service' };
        logger.info(`🤖 ROTATION: Triggered via simple rotation service`);
      }
      
      // Also ensure rotation is enabled after this action
      if (global.viewBotRotation) {
        await global.viewBotRotation.startRotation();
      }
      
      res.json({ 
        success: true, 
        message: 'Viewbot rotation triggered',
        streamerId,
        rotationResult
      });
    } else {
      // For regular users, perform normal disconnect
      logger.info(`🔨 MODERATION: Admin disconnecting regular stream ${streamerId}`);
      
      // Get the socket
      const socket = io.sockets.sockets.get(streamerId);
      if (!socket) {
        return res.status(404).json({ error: 'Streamer socket not found' });
      }
      
      // Clear the streamer
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;
      
      // Cleanup MediaSoup resources
      mediasoupService.cleanup(streamerId);
      
      // Notify the streamer they've been disconnected
      socket.emit('stream-disconnected-by-admin', { 
        reason: 'Disconnected by administrator',
        timestamp: new Date().toISOString()
      });
      
      // Disconnect the socket
      socket.disconnect(true);
      
      // Notify all viewers
      streamNotifier.streamEnded({ reason: 'admin_disconnect' });
      
      // After disconnecting a regular user, ensure viewbot rotation is enabled
      if (global.viewBotRotation) {
        logger.info(`🤖 ROTATION: Enabling rotation after user disconnect`);
        await global.viewBotRotation.startRotation();
      }
      
      res.json({ 
        success: true, 
        message: 'Stream disconnected successfully',
        streamerId,
        rotationEnabled: true
      });
    }
  } catch (error) {
    logger.error({ err: error }, '❌ MODERATION: Failed to disconnect/rotate stream');
    res.status(500).json({ error: 'Failed to disconnect stream' });
  }
});

app.post('/api/admin/stream/ban-ip', authenticateModerator, async (req, res) => {
  try {
    const { streamerId, ip, reason } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'Streamer ID required' });
    }
    
    // Get the socket to extract IP if not provided
    const socket = io.sockets.sockets.get(streamerId);
    let ipToBan = ip;
    
    if (!ipToBan && socket) {
      ipToBan = IPBanService.getIPFromSocket(socket);
    }
    
    if (!ipToBan) {
      return res.status(400).json({ error: 'Could not determine IP address to ban' });
    }
    
    // Ban the IP
    const banResult = await IPBanService.banIP(
      ipToBan,
      req.user.id,
      req.userRecord.username,
      reason || 'Banned by admin moderation',
      true // permanent ban
    );
    
    if (!banResult.success) {
      return res.status(500).json({ error: 'Failed to ban IP', details: banResult.error });
    }
    
    logger.info(`🚫 MODERATION: IP ${ipToBan} banned by ${req.userRecord.username}`);
    
    // If the streamer is currently streaming, disconnect them
    const currentStreamer = streamService.getCurrentStreamer();
    if (currentStreamer === streamerId) {
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;
      mediasoupService.cleanup(streamerId);
      
      if (socket) {
        socket.emit('banned', { 
          reason: reason || 'Your IP has been banned',
          timestamp: new Date().toISOString()
        });
        socket.disconnect(true);
      }
      
      streamNotifier.streamEnded({ reason: 'streamer_banned' });
    }
    
    // Disconnect any other sockets from this IP
    io.sockets.sockets.forEach((otherSocket) => {
      const socketIP = IPBanService.getIPFromSocket(otherSocket);
      if (socketIP === ipToBan) {
        otherSocket.emit('banned', { 
          reason: 'Your IP has been banned',
          timestamp: new Date().toISOString()
        });
        otherSocket.disconnect(true);
      }
    });
    
    res.json({ 
      success: true, 
      message: 'IP banned and connections terminated',
      ip: ipToBan,
      streamerId 
    });
  } catch (error) {
    logger.error({ err: error }, '❌ MODERATION: Failed to ban IP');
    res.status(500).json({ error: 'Failed to ban IP' });
  }
});

app.get('/api/admin/banned-ips', authenticateModerator, async (req, res) => {
  try {
    const bannedIPs = await IPBanService.getBannedIPs();
    res.json({ success: true, bannedIPs });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get banned IPs');
    res.status(500).json({ error: 'Failed to get banned IPs' });
  }
});

app.post('/api/admin/unban-ip', authenticateModerator, async (req, res) => {
  try {
    const { ip } = req.body;
    
    if (!ip) {
      return res.status(400).json({ error: 'IP address required' });
    }
    
    // Pass the Socket.IO instance to properly notify unbanned clients
    const result = await IPBanService.unbanIP(ip, io);
    
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to unban IP', details: result.error });
    }
    
    logger.info(`✅ MODERATION: IP ${ip} unbanned by ${req.userRecord.username}`);
    
    res.json({ 
      success: true, 
      message: 'IP unbanned successfully',
      ip 
    });
  } catch (error) {
    logger.error({ err: error }, '❌ MODERATION: Failed to unban IP');
    res.status(500).json({ error: 'Failed to unban IP' });
  }
});

// Manual IP ban endpoint
app.post('/api/admin/ban-ip-manual', authenticateModerator, async (req, res) => {
  try {
    const { ip, reason, permanent, expiresAt } = req.body;
    
    if (!ip) {
      return res.status(400).json({ error: 'IP address required' });
    }
    
    // Basic IP validation
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) {
      return res.status(400).json({ error: 'Invalid IP address format' });
    }
    
    const result = await IPBanService.banIP(
      ip, 
      req.userRecord.id, 
      req.userRecord.username, 
      reason || 'Manual ban by admin',
      permanent !== false, // default to permanent
      expiresAt || null
    );
    
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to ban IP', details: result.error });
    }
    
    logger.info(`🚫 MODERATION: IP ${ip} manually banned by ${req.userRecord.username} - Reason: ${reason}`);
    
    res.json({ 
      success: true, 
      message: 'IP banned successfully',
      ip,
      reason 
    });
  } catch (error) {
    logger.error({ err: error }, '❌ MODERATION: Failed to manually ban IP');
    res.status(500).json({ error: 'Failed to ban IP' });
  }
});

// Get streamer connection history
app.get('/api/admin/streamer-connections', authenticateModerator, async (req, res) => {
  try {
    const { limit = 100, offset = 0, streamerId, ip } = req.query;
    
    let query = `
      SELECT * FROM streamer_connections 
      WHERE 1=1
      AND ip_address NOT IN ('127.0.0.1', '::1', 'localhost')
    `;
    const params = [];
    
    if (streamerId) {
      query += ` AND streamer_id = ?`;
      params.push(streamerId);
    }
    
    if (ip) {
      query += ` AND ip_address = ?`;
      params.push(ip);
    }
    
    query += ` ORDER BY connected_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    
    const connections = await allAsync(query, params);
    
    res.json({ 
      success: true, 
      connections,
      count: connections.length 
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get streamer connections');
    res.status(500).json({ error: 'Failed to get streamer connections' });
  }
});

// Streaming Logs endpoints
const streamingLogsService = require('./services/StreamingLogsService');

// Get streaming logs
app.get('/api/admin/streaming-logs', authenticateModerator, async (req, res) => {
  try {
    const filters = {
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0,
      excludeViewbots: req.query.includeViewbots !== 'true',
      ipAddress: req.query.ip,
      userId: req.query.userId ? parseInt(req.query.userId) : undefined,
      activeOnly: req.query.activeOnly === 'true',
      startDate: req.query.startDate,
      endDate: req.query.endDate
    };
    
    const result = await streamingLogsService.getLogs(filters);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get streaming logs');
    res.status(500).json({ error: 'Failed to get streaming logs' });
  }
});

// Get streaming logs statistics
app.get('/api/admin/streaming-logs/stats', authenticateModerator, async (req, res) => {
  try {
    const result = await streamingLogsService.getStats();
    
    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }
    
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get streaming stats');
    res.status(500).json({ error: 'Failed to get streaming stats' });
  }
});

// Ban IP from streaming log
app.post('/api/admin/streaming-logs/ban-ip', authenticateModerator, async (req, res) => {
  try {
    const { ip, sessionId, reason } = req.body;
    
    if (!ip) {
      return res.status(400).json({ error: 'IP address required' });
    }
    
    // Ban the IP
    const result = await IPBanService.banIP(
      ip,
      req.userRecord.id,
      req.userRecord.username,
      reason || `Banned from streaming logs (Session: ${sessionId})`,
      true, // permanent by default
      null
    );
    
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to ban IP', details: result.error });
    }
    
    // Mark session as banned
    await streamingLogsService.markSessionBanned(ip);
    
    logger.info(`🚫 STREAMING LOGS: IP ${ip} banned by ${req.userRecord.username} from logs`);
    
    res.json({ 
      success: true, 
      message: 'IP banned successfully',
      ip
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to ban IP from logs');
    res.status(500).json({ error: 'Failed to ban IP' });
  }
});

// Video file upload endpoint for ViewBot
app.post('/admin/upload-video', adminKeyAuth, upload.single('video'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No video file uploaded' 
      });
    }

    const filePath = path.join(uploadsDir, req.file.filename);
    
    // Check if file was actually saved
    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ 
        success: false, 
        error: 'File upload failed - file not saved' 
      });
    }

    logger.info(`📁 ADMIN: Video uploaded - ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

    res.json({
      success: true,
      message: 'Video uploaded successfully',
      filename: req.file.filename,
      originalName: req.file.originalname,
      filePath: filePath,
      size: req.file.size,
      mimeType: req.file.mimetype
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Video upload error');
    res.status(500).json({ 
      success: false, 
      error: 'Upload failed: ' + error.message 
    });
  }
});

// List uploaded videos endpoint
app.get('/admin/uploaded-videos', adminKeyAuth, (req, res) => {
  try {
    if (!fs.existsSync(uploadsDir)) {
      return res.json({ videos: [] });
    }

    const files = fs.readdirSync(uploadsDir);
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv'].includes(ext);
    }).map(file => {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);
      
      return {
        filename: file,
        filePath: filePath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      };
    });

    res.json({ 
      videos: videoFiles.sort((a, b) => b.created - a.created) 
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to list uploaded videos');
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

// Delete uploaded video endpoint
app.delete('/admin/uploaded-videos/:filename', adminKeyAuth, (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(uploadsDir, filename);
    
    // Security check - ensure filename doesn't contain path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    fs.unlinkSync(filePath);
    logger.info(`🗑️ ADMIN: Deleted uploaded video - ${filename}`);
    
    res.json({ 
      success: true, 
      message: `Video ${filename} deleted successfully` 
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to delete video');
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

// ================================
// RECORDING ADMIN API ENDPOINTS
// ================================

// Start recording
app.post('/admin/recordings/start', authenticateAdmin, async (req, res) => {
  try {
    const { streamerId, quality } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'streamerId is required' });
    }
    
    logger.info(`🎬 ADMIN: Starting recording for streamer ${streamerId} with quality ${quality}`);
    
    const result = await recordingService.startRecording(streamerId, { quality });
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Recording started successfully',
        recordingId: result.recordingId,
        quality: result.quality,
        startTime: result.startTime
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error 
      });
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to start recording');
    res.status(500).json({ error: 'Failed to start recording' });
  }
});

// Stop recording
app.post('/admin/recordings/stop/:recordingId', authenticateAdmin, async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userId = req.user?.id || 'admin';
    
    logger.info(`🛑 ADMIN: Stopping recording ${recordingId}`);
    
    const result = await recordingService.stopRecording(recordingId, userId);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Recording stopped successfully',
        recordingId: result.recordingId,
        duration: result.duration
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error 
      });
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to stop recording');
    res.status(500).json({ error: 'Failed to stop recording' });
  }
});

// Get all recordings status
app.get('/admin/recordings/status', authenticateAdmin, (req, res) => {
  try {
    const activeRecordings = recordingService.getActiveRecordings();
    
    res.json({
      success: true,
      status: {
        activeRecordings: activeRecordings.length,
        recordings: activeRecordings
      }
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get recordings status');
    res.status(500).json({ error: 'Failed to get recordings status' });
  }
});

// Get specific recording status
app.get('/admin/recordings/status/:recordingId', authenticateAdmin, (req, res) => {
  try {
    const { recordingId } = req.params;
    const status = recordingService.getRecordingStatus(recordingId);
    
    res.json({
      success: true,
      status: status
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get recording status');
    res.status(500).json({ error: 'Failed to get recording status' });
  }
});

// List recordings
app.get('/admin/recordings/list', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;
    
    let recordings = await recordingService.getRecordingsList(limit, offset);
    
    // Filter by status if provided
    if (status) {
      recordings = recordings.filter(r => r.status === status);
    }
    
    // Add username for each recording
    for (const recording of recordings) {
      if (recording.streamer_id) {
        try {
          const user = await userRepository.getUsernameById(recording.streamer_id);
          recording.username = user ? user.username : `User${recording.streamer_id}`;
        } catch (err) {
          recording.username = `User${recording.streamer_id}`;
        }
      } else {
        recording.username = 'Unknown';
      }
    }
    
    res.json({
      success: true,
      recordings: recordings,
      pagination: {
        limit,
        offset,
        count: recordings.length
      }
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to list recordings');
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

// Download recording
// Stream recording for playback
app.get('/admin/recordings/stream/:filename', authenticateAdmin, async (req, res) => {
  try {
    const { filename } = req.params;
    
    // Search for the file in all recording directories
    const directories = ['active', 'completed', 'archived'];
    let filePath = null;
    
    for (const dir of directories) {
      const testPath = path.join(__dirname, '../recordings', dir, filename);
      if (fs.existsSync(testPath)) {
        filePath = testPath;
        break;
      }
    }
    
    if (!filePath) {
      return res.status(404).json({ error: 'Recording file not found' });
    }
    
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
      // Support for video seeking
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/webm',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/webm',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Error streaming recording');
    res.status(500).json({ error: 'Failed to stream recording' });
  }
});

// Get all recordings with details
app.get('/admin/recordings/all', authenticateAdmin, async (req, res) => {
  try {
    const directories = {
      active: path.join(__dirname, '../recordings/active'),
      completed: path.join(__dirname, '../recordings/completed'),
      archived: path.join(__dirname, '../recordings/archived')
    };
    
    const recordings = [];
    
    for (const [status, dirPath] of Object.entries(directories)) {
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.webm'));
        
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          const stats = fs.statSync(filePath);
          
          // Parse filename for metadata
          const match = file.match(/recording_(.+?)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(\w+)\.webm/);
          const streamerId = match ? match[1] : 'unknown';
          const timestamp = match ? match[2].replace(/T/, ' ').replace(/-/g, ':') : '';
          const quality = match ? match[3] : 'unknown';
          
          // Get username for the streamerId
          let username = 'Unknown';
          if (streamerId && streamerId !== 'unknown') {
            try {
              const user = await userRepository.getUsernameById(streamerId);
              username = user ? user.username : `User${streamerId}`;
            } catch (err) {
              username = `User${streamerId}`;
            }
          }
          
          recordings.push({
            filename: file,
            path: filePath,
            status: status,
            streamerId: streamerId,
            username: username,
            timestamp: timestamp,
            quality: quality,
            size: stats.size,
            sizeFormatted: formatFileSize(stats.size),
            createdAt: stats.birthtime,
            modifiedAt: stats.mtime,
            isRecording: status === 'active' && (Date.now() - stats.mtimeMs) < 5000 // Active if modified in last 5 seconds
          });
        }
      }
    }
    
    // Sort by creation date, newest first
    recordings.sort((a, b) => b.createdAt - a.createdAt);
    
    res.json({
      success: true,
      recordings: recordings,
      count: recordings.length
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Error fetching recordings');
    res.status(500).json({ error: 'Failed to fetch recordings' });
  }
});

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

app.get('/admin/recordings/download/:recordingId', authenticateAdmin, async (req, res) => {
  try {
    const { recordingId } = req.params;
    
    // Get recording info from database
    const query = 'SELECT * FROM recordings WHERE id = ?';
    const recording = await database.get(query, [recordingId]);
    
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    
    if (!recording.file_path || !fs.existsSync(recording.file_path)) {
      return res.status(404).json({ error: 'Recording file not found' });
    }
    
    // Log download event
    await recordingStorageService.logStorageEvent(recordingId, 'downloaded', {
      userId: req.user?.id || 'admin',
      downloadedAt: new Date().toISOString()
    });
    
    const fileName = path.basename(recording.file_path);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    logger.info(`📥 ADMIN: Downloading recording ${recordingId} - ${fileName}`);
    
    // Stream the file
    const fileStream = fs.createReadStream(recording.file_path);
    fileStream.pipe(res);
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to download recording');
    res.status(500).json({ error: 'Failed to download recording' });
  }
});

// Delete recording (supports both recordingId and filename)
app.delete('/admin/recordings/:recordingId', authenticateAdmin, async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userId = req.user?.id || 'admin';
    
    logger.info(`🗑️ ADMIN: Deleting recording ${recordingId}`);
    
    // Check if this is a filename (contains .webm) or a recording ID
    if (recordingId.endsWith('.webm')) {
      // This is a filename, handle file-based deletion
      const filename = recordingId;
      
      // Delete from file system
      const directories = ['active', 'completed', 'archived'];
      let fileDeleted = false;
      
      for (const dir of directories) {
        const filePath = path.join(__dirname, '../recordings', dir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          fileDeleted = true;
          logger.info(`🗑️ ADMIN: Deleted file: ${filePath}`);
          break;
        }
      }
      
      // Also try to delete from database based on filename
      try {
        // Extract recording info from filename to find in database
        const match = filename.match(/recording_(.+?)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(\w+)\.webm/);
        if (match) {
          const streamerId = match[1];
          // Try to find and delete database record
          const deleteQuery = 'DELETE FROM recordings WHERE file_path LIKE ?';
          await database.run(deleteQuery, [`%${filename}%`]);
          logger.info(`🗑️ ADMIN: Deleted database record for file: ${filename}`);
        }
      } catch (dbError) {
        logger.info({ err: dbError }, 'Note: Could not delete database record for file');
      }
      
      if (fileDeleted) {
        res.json({
          success: true,
          message: 'Recording deleted successfully'
        });
      } else {
        res.status(404).json({ 
          success: false, 
          error: 'Recording file not found' 
        });
      }
    } else {
      // This is a recording ID, use the existing storage service
      const result = await recordingStorageService.deleteRecording(recordingId, userId);
      
      if (result.success) {
        res.json({
          success: true,
          message: 'Recording deleted successfully'
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: result.error 
        });
      }
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to delete recording');
    res.status(500).json({ error: 'Failed to delete recording' });
  }
});

// Get active recordings
app.get('/admin/recordings/active', authenticateAdmin, (req, res) => {
  try {
    const activeRecordings = recordingService.getActiveRecordings();
    
    res.json({
      success: true,
      activeRecordings: activeRecordings,
      count: activeRecordings.length
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get active recordings');
    res.status(500).json({ error: 'Failed to get active recordings' });
  }
});

// Get system status
app.get('/admin/recordings/system-status', authenticateAdmin, async (req, res) => {
  try {
    const recordingStatus = recordingService.getSystemStatus();
    const compressionStatus = fileCompressionService.getQueueStatus();
    const storageStats = await recordingStorageService.getStorageStatistics();
    
    res.json({
      success: true,
      recording: recordingStatus,
      compression: compressionStatus,
      storage: storageStats
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get system status');
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

// Manual cleanup
app.post('/admin/recordings/cleanup', authenticateAdmin, async (req, res) => {
  try {
    logger.info('🧹 ADMIN: Starting manual cleanup');
    
    const result = await recordingStorageService.cleanupOldRecordings();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Cleanup completed successfully',
        cleaned: result.cleanedCount,
        archived: result.archivedCount,
        orphaned: result.orphanedCount
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to run cleanup');
    res.status(500).json({ error: 'Failed to run cleanup' });
  }
});

// Update recording settings
app.post('/admin/recordings/settings', authenticateAdmin, async (req, res) => {
  try {
    const { settings } = req.body;
    
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings provided' });
    }
    
    // Update storage service configuration
    recordingStorageService.updateConfig(settings);
    
    res.json({
      success: true,
      message: 'Recording settings updated successfully',
      settings: recordingStorageService.getConfig()
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to update settings');
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Compress recording manually
app.post('/admin/recordings/:recordingId/compress', authenticateAdmin, async (req, res) => {
  try {
    const { recordingId } = req.params;
    const { profile, priority } = req.body;
    
    // Get recording info
    const query = 'SELECT * FROM recordings WHERE id = ?';
    const recording = await database.get(query, [recordingId]);
    
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    
    if (!recording.file_path || !fs.existsSync(recording.file_path)) {
      return res.status(404).json({ error: 'Recording file not found' });
    }
    
    logger.info(`🗜️ ADMIN: Adding recording ${recordingId} to compression queue`);
    
    const result = await fileCompressionService.addToCompressionQueue(
      recordingId, 
      recording.file_path, 
      { profile, priority }
    );
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Recording added to compression queue',
        queuePosition: result.queuePosition
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error 
      });
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to queue compression');
    res.status(500).json({ error: 'Failed to queue compression' });
  }
});

// ================================
// CONTINUOUS RECORDING ENDPOINTS
// ================================

// Enable continuous recording
app.post('/admin/recordings/continuous/enable', authenticateAdmin, async (req, res) => {
  try {
    const { quality } = req.body;
    
    logger.info(`🔄 ADMIN: Enabling continuous recording (${quality || '720p'})`);
    
    const result = await recordingService.enableContinuousRecording(quality);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Continuous recording enabled',
        sessionId: result.sessionId
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error 
      });
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to enable continuous recording');
    res.status(500).json({ error: 'Failed to enable continuous recording' });
  }
});

// Disable continuous recording
app.post('/admin/recordings/continuous/disable', authenticateAdmin, async (req, res) => {
  try {
    logger.info('🛑 ADMIN: Disabling continuous recording');
    
    const result = await recordingService.disableContinuousRecording();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Continuous recording disabled'
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error 
      });
    }
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to disable continuous recording');
    res.status(500).json({ error: 'Failed to disable continuous recording' });
  }
});

// Get continuous recording status
app.get('/admin/recordings/continuous/status', authenticateAdmin, (req, res) => {
  try {
    const status = recordingService.getContinuousRecordingStatus();
    
    res.json({
      success: true,
      status: status
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get continuous recording status');
    res.status(500).json({ error: 'Failed to get continuous recording status' });
  }
});

// Manually check and start continuous recording if stream is active
app.post('/admin/recordings/continuous/check-and-start', authenticateAdmin, async (req, res) => {
  try {
    logger.info('🔍 ADMIN: Manually checking for active streams to start continuous recording');
    
    const result = await recordingService.checkAndStartContinuousRecording();
    
    res.json({
      success: result.success,
      message: result.success ? 'Recording started or already active' : result.error,
      recordingId: result.recordingId
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to check and start continuous recording');
    res.status(500).json({ error: 'Failed to check and start continuous recording' });
  }
});

// Get continuous recording history
app.get('/admin/recordings/continuous/history/:sessionId', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const recordings = await recordingService.getContinuousRecordingHistory(sessionId);
    
    res.json({
      success: true,
      recordings: recordings,
      count: recordings.length
    });
    
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get continuous recording history');
    res.status(500).json({ error: 'Failed to get continuous recording history' });
  }
});

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
  
  // Trigger ViewBot rotation after a delay when stream ends
  const triggerTime = Date.now();
  logger.info(`🔍 ROTATION TRIGGER: Stream ended at ${new Date(triggerTime).toISOString()}`);
  logger.info(`🔍 ROTATION TRIGGER: Checking conditions - viewBotRotation exists: ${!!global.viewBotRotation}, enabled: ${global.viewBotRotation?.enabled}`);
  if (global.viewBotRotation && global.viewBotRotation.enabled) {
    logger.info('✅ ROTATION TRIGGER: Conditions met, scheduling rotation in 5s');
    // PR 4.2: routed through LifecycleManager so SIGTERM during the 5 s
    // grace window cancels the rotation attempt against a torn-down service.
    lifecycleManager.schedule('post-stream-rotation', async () => {
      const currentStreamer = streamService.getCurrentStreamer();
      logger.info(`🔍 ROTATION TRIGGER: After 5s delay (${Date.now() - triggerTime}ms elapsed) - currentStreamer: ${currentStreamer}`);
      if (!currentStreamer && global.viewBotRotation && global.viewBotRotation.enabled) {
        logger.info('✅ ROTATION TRIGGER: No streamer, triggering rotation...');
        try {
          await global.viewBotRotation.rotateToNextBot();
          logger.info(`⏱️ ROTATION TRIGGER: Total time from stream end to rotation complete: ${Date.now() - triggerTime}ms`);
        } catch (error) {
          logger.error({ err: error }, '❌ Failed to start rotation after stream end');
        }
      } else {
        logger.info(`⏭️  ROTATION TRIGGER: Skipped - currentStreamer: ${currentStreamer}`);
      }
    }, 5000);
  } else {
    logger.info('❌ ROTATION TRIGGER: Conditions not met, rotation will not trigger');
  }
}

// Transcription API endpoints
app.post('/admin/transcription/start', authenticateAdmin, async (req, res) => {
  try {
    const { streamerId, options } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'streamerId is required' });
    }
    
    logger.info(`🎙️ ADMIN: Starting transcription for ${streamerId}`);
    logger.info({ options }, `🎙️ ADMIN: Options`);
    logger.info({ currentStreamer: streamService.getCurrentStreamer() }, `🎙️ ADMIN: Current active streamer`);
    logger.info({ streamType: streamService.getStreamType() }, `🎙️ ADMIN: Stream type`);
    
    const result = await transcriptionService.startTranscription(streamerId, options);
    
    logger.info({ result }, `🎙️ ADMIN: Transcription start result`);
    
    if (result.success) {
      // Forward to WebSocket clients
      io.emit('transcription-started', {
        sessionId: result.sessionId,
        streamerId: streamerId,
        startTime: result.startTime
      });
    }
    
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to start transcription');
    res.status(500).json({ error: 'Failed to start transcription' });
  }
});

app.post('/admin/transcription/stop/:sessionId', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.info(`🛑 ADMIN: Stopping transcription ${sessionId}`);
    const result = await transcriptionService.stopTranscription(sessionId);
    
    if (result.success) {
      // Forward to WebSocket clients
      io.emit('transcription-stopped', {
        sessionId: sessionId,
        duration: result.duration,
        wordCount: result.wordCount
      });
    }
    
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to stop transcription');
    res.status(500).json({ error: 'Failed to stop transcription' });
  }
});

app.post('/admin/transcription/timed', authenticateAdmin, async (req, res) => {
  try {
    const { streamerId, duration = 30, options } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'streamerId is required' });
    }
    
    logger.info(`⏱️ ADMIN: Timed transcription requested for ${streamerId} (${duration}s)`);
    
    // Verify stream is active
    const currentStreamer = mediasoupService.getCurrentStreamer();
    if (!currentStreamer || currentStreamer !== streamerId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Stream is not active or streamer mismatch' 
      });
    }
    
    // Start timed transcription (will auto-stop after duration)
    const result = await transcriptionService.startTimedTranscription(streamerId, duration, options);
    
    if (result.success) {
      logger.info(`✅ ADMIN: Timed transcription started: ${result.sessionId}`);
      
      // Emit to WebSocket clients
      io.emit('transcription-started', {
        sessionId: result.sessionId,
        streamerId: streamerId,
        startTime: result.startTime,
        duration: duration,
        timed: true
      });
    }
    
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to start timed transcription');
    res.status(500).json({ error: 'Failed to start timed transcription' });
  }
});

// Keep the instant endpoint for backward compatibility
app.post('/admin/transcription/instant', authenticateAdmin, async (req, res) => {
  // Redirect to timed endpoint
  req.body.duration = req.body.duration || 30;
  return app._router.handle(Object.assign(req, { 
    url: '/admin/transcription/timed',
    originalUrl: '/admin/transcription/timed' 
  }), res);
});

app.get('/api/transcription/:sessionId', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const transcription = await transcriptionService.getTranscription(sessionId);
    
    if (!transcription) {
      return res.status(404).json({ error: 'Transcription not found' });
    }
    
    res.json(transcription);
  } catch (error) {
    logger.error({ err: error }, '❌ API: Failed to get transcription');
    res.status(500).json({ error: 'Failed to get transcription' });
  }
});

app.get('/api/transcriptions/active', authenticateAdmin, async (req, res) => {
  try {
    const activeTranscriptions = await transcriptionService.getActiveTranscriptions();
    res.json({ 
      success: true, 
      transcriptions: activeTranscriptions 
    });
  } catch (error) {
    logger.error({ err: error }, '❌ API: Failed to get active transcriptions');
    res.status(500).json({ error: 'Failed to get active transcriptions' });
  }
});

app.post('/admin/transcription/config', authenticateAdmin, async (req, res) => {
  try {
    const { enable, autoStart, model, language, chunkDuration, bufferDuration } = req.body;
    
    // Update main enable/disable state
    if (enable !== undefined) {
      if (enable) {
        transcriptionService.enableTranscription();
      } else {
        transcriptionService.disableTranscription();
        // Stop all active transcriptions when disabling
        const activeSessions = await transcriptionService.getActiveTranscriptions();
        for (const session of activeSessions) {
          await transcriptionService.stopTranscription(session.id);
        }
      }
    }
    
    // Update auto-start setting
    if (autoStart !== undefined) {
      transcriptionService.config.autoStart = autoStart;
    }
    
    // Update model
    if (model) {
      transcriptionService.setModel(model);
    }
    
    // Update language
    if (language !== undefined) {
      transcriptionService.setLanguage(language);
    }
    
    // Update chunk duration (processing interval)
    if (chunkDuration !== undefined) {
      transcriptionService.config.chunkDuration = chunkDuration;
    }
    
    // Update buffer duration
    if (bufferDuration !== undefined && transcriptionService.audioBufferService) {
      transcriptionService.audioBufferService.config.bufferDuration = bufferDuration;
    }
    
    res.json({ 
      success: true, 
      config: transcriptionService.config 
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to update transcription config');
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

app.get('/admin/transcription/status', authenticateAdmin, async (req, res) => {
  try {
    const active = await transcriptionService.getActiveTranscriptions();
    const config = transcriptionService.config;
    
    // Get buffer status for active sessions
    const activeSessions = active.map(session => {
      const bufferInfo = transcriptionService.audioBufferService ? 
        transcriptionService.audioBufferService.getSessionInfo(session.id) : null;
      
      return {
        ...session,
        bufferStatus: bufferInfo ? {
          size: bufferInfo.bytesWritten,
          duration: bufferInfo.duration,
          isActive: bufferInfo.isActive
        } : null
      };
    });
    
    res.json({
      success: true,
      status: {
        enabled: config.enableTranscription,
        autoStart: config.autoStart || false,
        model: config.model,
        language: config.language,
        chunkDuration: config.chunkDuration,
        bufferDuration: transcriptionService.audioBufferService ? 
          transcriptionService.audioBufferService.config.bufferDuration : 60,
        activeCount: active.length,
        activeSessions: activeSessions
      }
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get transcription status');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.get('/api/transcriptions/history', authenticateAdmin, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status, streamerId, startDate, endDate } = req.query;
    
    const filters = {};
    if (status) filters.status = status;
    if (streamerId) filters.streamerId = streamerId;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    
    const result = await transcriptionService.getTranscriptionHistory(
      parseInt(limit),
      parseInt(offset),
      filters
    );
    
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error({ err: error }, '❌ API: Failed to get transcription history');
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// /api/stream/active moved to server/routes/media.js (PR-G3).

app.delete('/admin/transcriptions/old', authenticateAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const result = await transcriptionService.deleteOldTranscriptions(parseInt(days));
    
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to delete old transcriptions');
    res.status(500).json({ error: 'Failed to delete old transcriptions' });
  }
});

// MovieBot API endpoints
app.post('/admin/moviebot/enable', adminKeyAuth, async (req, res) => {
  try {
    let { streamerId } = req.body;
    
    if (!streamerId) {
      // Try to get current streamer
      const currentStreamer = mediasoupService.getCurrentStreamer();
      if (!currentStreamer) {
        return res.status(400).json({ error: 'No active stream to monitor' });
      }
      streamerId = currentStreamer;
    }
    
    const result = await movieBotService.enable(streamerId);
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to enable MovieBot');
    res.status(500).json({ error: 'Failed to enable MovieBot' });
  }
});

app.post('/admin/moviebot/disable', adminKeyAuth, async (req, res) => {
  try {
    const result = await movieBotService.disable();
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to disable MovieBot');
    res.status(500).json({ error: 'Failed to disable MovieBot' });
  }
});

app.get('/admin/moviebot/status', adminKeyAuth, async (req, res) => {
  try {
    const status = movieBotService.getStatus();
    res.json(status);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get MovieBot status');
    res.status(500).json({ error: 'Failed to get MovieBot status' });
  }
});

app.post('/admin/moviebot/config', adminKeyAuth, async (req, res) => {
  try {
    const result = movieBotService.updateConfig(req.body);
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to update MovieBot config');
    res.status(500).json({ error: 'Failed to update MovieBot config' });
  }
});

app.get('/admin/moviebot/logs', adminKeyAuth, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = movieBotService.getRecentLogs(parseInt(limit));
    res.json({ logs });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get MovieBot logs');
    res.status(500).json({ error: 'Failed to get MovieBot logs' });
  }
});

// VisionBot admin endpoints — sibling block to MovieBot above. Mirrors that
// shape: enable / disable / status / config / logs. Auth via adminKeyAuth
// to match the existing MovieBot client-side calls from BotsPanel.
app.post('/admin/visionbot/enable', adminKeyAuth, async (req, res) => {
  try {
    const svc = req.app.locals.services && req.app.locals.services.visionBotService;
    if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
    const streamerId = (req.body && req.body.streamerId)
      || (streamService.getCurrentStreamer && streamService.getCurrentStreamer());
    if (!streamerId) {
      return res.status(400).json({ success: false, error: 'No active streamer; pass streamerId.' });
    }
    const result = await svc.enable(streamerId);
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to enable VisionBot');
    res.status(500).json({ error: 'Failed to enable VisionBot' });
  }
});

app.post('/admin/visionbot/disable', adminKeyAuth, async (req, res) => {
  try {
    const svc = req.app.locals.services && req.app.locals.services.visionBotService;
    if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
    const result = await svc.disable();
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to disable VisionBot');
    res.status(500).json({ error: 'Failed to disable VisionBot' });
  }
});

app.get('/admin/visionbot/status', adminKeyAuth, async (req, res) => {
  try {
    const svc = req.app.locals.services && req.app.locals.services.visionBotService;
    if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
    res.json(svc.getStatus());
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get VisionBot status');
    res.status(500).json({ error: 'Failed to get VisionBot status' });
  }
});

app.post('/admin/visionbot/config', adminKeyAuth, async (req, res) => {
  try {
    const svc = req.app.locals.services && req.app.locals.services.visionBotService;
    if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
    const result = svc.updateConfig(req.body || {});
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to update VisionBot config');
    res.status(500).json({ error: 'Failed to update VisionBot config' });
  }
});

app.get('/admin/visionbot/logs', adminKeyAuth, async (req, res) => {
  try {
    const svc = req.app.locals.services && req.app.locals.services.visionBotService;
    if (!svc) return res.status(500).json({ success: false, error: 'visionBotService not wired' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    res.json({ logs: svc.getRecentLogs(limit) });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get VisionBot logs');
    res.status(500).json({ error: 'Failed to get VisionBot logs' });
  }
});

// Global Groq API endpoints for ALL chatbots
app.get('/admin/groq/status', adminKeyAuth, async (req, res) => {
  try {
    const status = chatBotService.llmService.getGroqStatus();
    res.json(status);
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get Groq status');
    res.status(500).json({ error: 'Failed to get Groq status' });
  }
});

app.post('/admin/groq/config', adminKeyAuth, async (req, res) => {
  try {
    const { enabled, apiKey, model } = req.body;

    // Update Groq settings in LLM service
    const result = chatBotService.llmService.updateGroqSettings(
      enabled,
      apiKey || null,
      model || null
    );

    logger.info({ result }, '🚀 ADMIN: Updated global Groq settings');
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to update Groq config');
    res.status(500).json({ error: 'Failed to update Groq config' });
  }
});

// PR-M8 (follow-up to ADR-0021): admin surface for the OpenAI moderation
// key. Symmetric with /admin/groq/{status,config}. Used by operators who
// store keys in DB rather than env. The boot-time resolver
// (server/index.js around the ModerationStage3 construction) reads this
// table when OPENAI_API_KEY env is unset.
//
// The status endpoint deliberately does NOT return the api_key value —
// only its presence + length + 8-char prefix for confirmation. Echoing
// the full key on a GET would defeat the point of storing it as a
// secret.
app.get('/admin/openai/status', adminKeyAuth, async (req, res) => {
  try {
    const row = await database.getAsync('SELECT enabled, api_key, updated_at, updated_by FROM openai_config WHERE id = 1');
    const hasKey = !!(row && row.api_key);
    res.json({
      enabled: !!(row && row.enabled === 1),
      hasKey,
      keyLength: hasKey ? row.api_key.length : 0,
      keyPrefix: hasKey ? row.api_key.slice(0, 8) : null,
      updated_at: row ? row.updated_at : null,
      updated_by: row ? row.updated_by : null,
      envKeyPresent: !!process.env.OPENAI_API_KEY,
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to get OpenAI status');
    res.status(500).json({ error: 'Failed to get OpenAI status' });
  }
});

app.post('/admin/openai/config', adminKeyAuth, async (req, res) => {
  try {
    const { enabled, apiKey } = req.body || {};
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string or null' });
    }
    // Build UPDATE dynamically so the caller can flip enabled without
    // re-sending the key (and vice versa). The seed row exists from the
    // schema apply so INSERT OR REPLACE isn't necessary.
    const fields = [];
    const params = [];
    if (enabled !== undefined) {
      fields.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    if (apiKey !== undefined) {
      fields.push('api_key = ?');
      params.push(apiKey);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: 'pass at least one of enabled, apiKey' });
    }
    fields.push("updated_at = datetime('now')");
    fields.push('updated_by = ?');
    params.push('admin');
    await database.runAsync(`UPDATE openai_config SET ${fields.join(', ')} WHERE id = 1`, params);

    logger.info(`🔑 ADMIN: Updated openai_config (enabled=${enabled !== undefined ? enabled : 'unchanged'}, apiKey=${apiKey === undefined ? 'unchanged' : (apiKey ? 'updated' : 'cleared')})`);
    // Return the same shape as /status so the admin UI can render the
    // post-write state without an extra round-trip.
    const row = await database.getAsync('SELECT enabled, api_key, updated_at, updated_by FROM openai_config WHERE id = 1');
    const hasKey = !!(row && row.api_key);
    res.json({
      success: true,
      enabled: !!(row && row.enabled === 1),
      hasKey,
      keyLength: hasKey ? row.api_key.length : 0,
      keyPrefix: hasKey ? row.api_key.slice(0, 8) : null,
      updated_at: row ? row.updated_at : null,
      updated_by: row ? row.updated_by : null,
      note: 'A server restart is required for the new key to take effect — the boot-time resolver reads this row once on startup.',
    });
  } catch (error) {
    logger.error({ err: error }, '❌ ADMIN: Failed to update OpenAI config');
    res.status(500).json({ error: 'Failed to update OpenAI config' });
  }
});

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
// (viewbotService / viewBotClientService / recordingService /
// transcriptionService) are passed via getter functions so they resolve
// at connection-callback time (always after startServer's lazy inits).
require('./bootstrap/register-socket-handlers')(io, {
  // Connection-level services
  IPBanService,
  authService,
  sessionService,

  // Per-handler register functions
  registerStreamHandler,
  registerMediaSoupHandler,
  registerViewBotHandler,
  registerBuffHandler,
  registerDrawingHandler,
  registerAdminHandler,
  registerGameHandler,
  registerDisconnectHandler,
  registerEffectHandler,

  // Connection-level service touches
  canvasFxService,
  visualFxService,

  // Eager per-handler service deps
  streamService,
  takeoverService,
  mediasoupService,
  testStreamService,
  timeTrackingService,
  buffDebuffService,
  streamingLogsService,
  SimpleViewBotRotation,
  plainTransportService,
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

  // Utility imports
  runAsync,
  database,
  axios,
  https,

  // Lazy-service getters (resolved at connection-callback time)
  getViewbotService: () => viewbotService,
  getViewBotClientService: () => viewBotClientService,
  getRecordingService: () => recordingService,
  getTranscriptionService: () => transcriptionService,
});


async function startServer() {
  redisClient = await bootInitializeRedis();
  
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
  
  // Initialize mediasoup worker (restored to original)
  try {
    await mediasoupService.initialize();
    logger.info('✅ MEDIASOUP: Initialization completed');
    
    // ── PR-I4: late ViewBot service construction ───────────────────────────
    // The four named ViewBot services (Viewbot, ViewBotWebRTC,
    // ViewBotLiveKit, ViewBotClient) are constructed by the
    // bootstrap/services factory. Everything else in this block is
    // orchestration (URL/Random services, SimpleViewBotRotation setters,
    // route mounts, autostarts) that stays inline — see the deferred-list
    // note in bootstrap/services.js for the rationale.
    let livekitService = null;
    if (usingAdapter && global.webrtcAdapter && global.webrtcAdapter.getBackendType() === 'livekit') {
      livekitService = global.webrtcAdapter._backend;
    }

    const { services: viewBotBag, stoppables: viewBotStoppables } = await createViewBotServices({
      mediasoupService,
      livekitService,
      streamService,
    });
    viewbotService = viewBotBag.viewbotService;
    viewBotWebRTCService = viewBotBag.viewBotWebRTCService;
    viewBotClientService = viewBotBag.viewBotClientService;
    const viewBotLiveKitService = viewBotBag.viewBotLiveKitService; // null on MediaSoup branch.

    // Push livekit BEFORE viewbot stoppables so reverse-iteration stops the
    // viewbot services (which consume livekit) before the livekit client
    // itself is torn down — avoids noisy "call against shut-down client"
    // errors on the way out.
    if (livekitService && typeof livekitService.stop === 'function') {
      stoppables.push(livekitService);
    }
    stoppables.push(...viewBotStoppables);
    logger.info('✅ VIEWBOT: ViewbotService initialized');
    if (viewBotWebRTCService) {
      logger.info('✅ VIEWBOT: ViewBotWebRTCService initialized for mobile 5G/TURN support');
    } else {
      logger.info('ℹ️ VIEWBOT: Skipping ViewBotWebRTCService (using LiveKit backend)');
    }
    if (viewBotLiveKitService) {
      logger.info('✅ VIEWBOT: ViewBotLiveKitService initialized for LiveKit RTMP ingress');
    }

    // Branch-shared orchestration: SimpleViewBotRotation always learns about
    // streamService (real-streamer protection). On the MediaSoup branch this
    // was previously inside the `if (!livekitService)` block; on the LiveKit
    // branch it lived in the `else`. Hoisting is behavior-preserving because
    // both branches called it unconditionally.
    SimpleViewBotRotation.setStreamService(streamService);

    // PR 3.1: LiveKitService is constructed inside WebRTCAdapter before the
    // bootstrap factory runs, so it can't take streamNotifier in its ctor.
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
    });

    // Make viewbotService available to routes
    app.locals.viewbotService = viewbotService;
    
    // Initialize recording system after MediaSoup is ready
    try {
      // Run database migration to ensure recording tables exist
      const { setupRecordingTables } = require('./migrations/setup-recording-tables');
      await setupRecordingTables();
      logger.info('✅ RECORDING: Database tables verified');

      // Recording service is ready to use
      logger.info('✅ RECORDING: Recording system initialized and ready');
    } catch (error) {
      logger.error({ err: error }, '❌ RECORDING: Failed to initialize recording system');
    }

    // Run clips table migration (separate try/catch so it runs even if recording fails)
    try {
      const setupClipsTables = require('./migrations/setup-clips-tables');
      await setupClipsTables(database.db);
      logger.info('✅ CLIPS: Database tables verified');
    } catch (error) {
      logger.error({ err: error }, '❌ CLIPS: Failed to initialize clips tables');
    }
    
    // Inject viewbotService into InventoryService for viewbot targeting
    inventoryService.setViewbotService(viewbotService);
    // Inject viewbot socket checker function
    inventoryService.setViewbotSocketChecker((socketId) => viewbotSocketIds.has(socketId));
    
    // ViewBotClientService construction + viewbotService.viewBotClientService
    // cross-wire are now handled by createViewBotServices (PR-I4). The
    // global, route hookup, and async initialize() that depend on it still
    // happen here because their error handling nulls out the local on
    // failure (and that pattern is too entangled to lift cleanly).
    logger.info('🚀 VIEWBOT CLIENT: ViewBotClientService constructed by factory');

    // Set global reference for ViewBotClientService (needed for GStreamer WebRTC)
    global.viewBotClientService = viewBotClientService;

    // CRITICAL: Wire ViewBotClientService to ViewBotURLService for real streamer protection
    if (global.viewBotURLService) {
      global.viewBotURLService.setViewBotClientService(viewBotClientService);
      logger.info('✅ VIEWBOT CLIENT: Linked to ViewBotURLService for real streamer protection');
    }

    // CRITICAL: Initialize the service to restore state from database
    try {
      logger.info('🚀 VIEWBOT CLIENT: Initializing ViewBotClientService...');
      await viewBotClientService.initialize();
      logger.info('✅ VIEWBOT CLIENT: ViewBotClientService initialized and state restored');
    } catch (error) {
      logger.error({ err: error }, '❌ VIEWBOT CLIENT: Failed to initialize ViewBotClientService');
      logger.info('⚠️ VIEWBOT CLIENT: Continuing without ViewBotClientService');
      viewBotClientService = null;
    }
    
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
    
    // Initialize NEW ViewBot Rotation System with Socket.IO clients
    logger.info('🚀 VIEWBOT ROTATION: Starting initialization...');
    try {
      const ViewBotRotationService = require('./services/ViewBotRotationService');
      logger.info('✅ VIEWBOT ROTATION: Service module loaded');
      
      const viewBotRotation = new ViewBotRotationService('https://127.0.0.1:8443');
      logger.info('✅ VIEWBOT ROTATION: Service instance created');

      // PR 3.1: stop-bot's `stream-ended` emit now goes through the chokepoint.
      viewBotRotation.setStreamNotifier(streamNotifier);

      // Register LiveKit service if available
      if (global.viewBotLiveKitService) {
        viewBotRotation.setLiveKitService(global.viewBotLiveKitService);
        logger.info('✅ VIEWBOT ROTATION: LiveKit service registered');
      } else {
        logger.info('⚠️ VIEWBOT ROTATION: LiveKit service not available, will use MediaSoup');
      }

      // Store globally for admin routes
      global.viewBotRotation = viewBotRotation;
      global.viewBotRotationService = viewBotRotation; // Also store with this name for PortMonitor

      // Initialize with media files
      await viewBotRotation.initialize();
      logger.info('✅ VIEWBOT ROTATION: Service initialized');
      
      // Initialize Unified ViewBot Rotation with WebRTC support
      logger.info('🌐 Initializing WebRTC ViewBot support...');
      try {
        const UnifiedViewBotRotation = require('./services/UnifiedViewBotRotation');
        const ViewBotManager = require('./services/ViewBotManager');
        const viewBotConfig = fs.existsSync(path.join(__dirname, 'config', 'viewbot-config.json')) 
          ? require('./config/viewbot-config.json') 
          : { viewbots: { useWebRTCViewBots: false } };
        
        // Create ViewBot Manager for WebRTC/Plain RTP toggle
        const viewBotManager = new ViewBotManager(viewBotConfig.viewbots);
        await viewBotManager.initialize();
        global.viewBotManager = viewBotManager;
        stoppables.push(viewBotManager);
        
        // Create Unified Rotation controller
        const unifiedRotation = new UnifiedViewBotRotation(io, streamService, mediasoupService, livekitService, streamNotifier);
        const videoFiles = await getVideoFiles();
        await unifiedRotation.initialize(videoFiles);
        global.unifiedViewBotRotation = unifiedRotation;
        
        // Set initial mode based on config
        if (viewBotConfig.viewbots.useWebRTCViewBots) {
          await unifiedRotation.setMode('webrtc');
          logger.info('✅ WebRTC ViewBot mode enabled (mobile compatible)');
        } else {
          // CRITICAL: Explicitly set mode to plainrtp - default is 'webrtc' which would cause failures
          await unifiedRotation.setMode('plainrtp');
          logger.info('ℹ️ Using Plain RTP ViewBot mode (desktop only)');
        }
        
        logger.info('✅ Unified ViewBot Rotation initialized');
      } catch (error) {
        logger.warn({ err: error }, '⚠️ WebRTC ViewBot support not available');
        logger.info('ℹ️ Continuing with Plain RTP viewbots only');
      }
      
      // Update settings to achieve ~3.5 minute average
      // Average = (min + max) / 2, so for 3.5 min avg: min + max = 7 min
      // Using 1 min minimum and 6 min maximum gives 3.5 min average
      viewBotRotation.updateSettings({
        minRotationInterval: 60000,   // 1 minute minimum
        maxRotationInterval: 360000,  // 6 minutes maximum (avg = 3.5 min)
        cooldownDuration: 600000      // 10 minutes
      });
      
      // Initialize Port Monitor Service
      const PortMonitorService = require('./services/PortMonitorService');
      const portMonitor = new PortMonitorService(mediasoupService);
      global.portMonitor = portMonitor;
      portMonitor.startMonitoring();
      stoppables.push(portMonitor);
      logger.info('✅ PORT MONITOR: Service started');
      
      // Enable rotation
      viewBotRotation.enabled = true;
      logger.info(`🔍 VIEWBOT ROTATION: Enabled set to ${viewBotRotation.enabled}`);

      // Delay rotation start to ensure server is fully ready.
      // PR 4.2: routed through LifecycleManager so SIGTERM during the 10 s
      // grace window cancels the rotation start against a torn-down
      // mediasoup / viewbot stack.
      logger.info('⏰ VIEWBOT ROTATION: Scheduling rotation start in 10 seconds...');
      lifecycleManager.schedule('viewbot-rotation-start', async () => {
        try {
          logger.info('🚀 VIEWBOT ROTATION: Starting rotation after delay...');
          await viewBotRotation.startRotation();
          logger.info('✅ VIEWBOT ROTATION: Rotation started successfully');
        } catch (error) {
          logger.error({ err: error }, '❌ VIEWBOT ROTATION: Failed to start rotation');
        }
      }, 10000);
      logger.info('✅ VIEWBOT ROTATION: schedule registered');
      
      logger.info('✅ VIEWBOT ROTATION: New Socket.IO-based rotation system initialized');

    } catch (error) {
      logger.error({ err: error }, '❌ VIEWBOT ROTATION: Failed to initialize');
      logger.error(error.stack);
    }
    
    // ViewBots are now persisted in database and restored automatically
    // No need to recreate from uploads on every startup
    // To add new viewbots from uploads, run: node /root/onestreamer/create-viewbots-from-uploads.js
    
    // Initialize ViewBot API routes with the service instance
    const viewbotApiRoutesFactory = require('./routes/viewbot-api');
    const viewbotVideoApi = require('./routes/viewbot-video-api');
    viewbotApiRoutes = viewbotApiRoutesFactory(viewBotClientService);
    app.use('/api', viewbotApiRoutes);
    
    // Add new video management API routes
    app.use('/admin/viewbot', viewbotVideoApi);
    logger.info('✅ VIEWBOT API: Routes initialized with service instance');
  } catch (error) {
    logger.error({ err: error }, '❌ MEDIASOUP: Initialization failed');
    logger.info('⚠️ Continuing without mediasoup and viewbot services...');
    viewbotService = null;
    viewBotClientService = null;
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
    
    // Set up periodic cleanup for expired temporary bots
    setInterval(async () => {
      try {
        const cleaned = await chatBotService.cleanupExpiredBots();
        if (cleaned > 0) {
          logger.info(`🧹 Cleaned up ${cleaned} expired temporary bots`);
        }
      } catch (error) {
        logger.error({ err: error }, '❌ Error during bot cleanup');
      }
    }, 5 * 60 * 1000); // Run every 5 minutes
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
      '/auth/restore-account',
      '/auth/admin/'
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

  httpServer.on('error', (err) => {
    logger.error({ err }, '❌ SERVER: Server error');
  });
}

startServer().catch((err) => logger.error({ err }, 'startServer failed'));

// Phase 15B.4 — shutdown sequence + signal handlers + cleanupMediaProcesses
// extracted to bootstrap/shutdown.js. Lazy services are passed via getters
// so the lookup happens at signal-time. The two `// console-allowed:
// uncaughtException fallback` markers ride along inside that module.
require('./bootstrap/shutdown')({
  stoppables,
  io,
  server,
  getRedisClient: () => redisClient,
  getMediasoupService: () => mediasoupService,
  getViewbotService: () => viewbotService,
  getViewBotClientService: () => viewBotClientService,
  getRecordingService: () => recordingService,
  getVisualFxService: () => visualFxService,
  getStreamInterceptorService: () => streamInterceptorService,
  getTimeTrackingService: () => timeTrackingService,
  getResourceMonitor: () => resourceMonitor,
  getSessionService: () => sessionService,
  getViewBotGStreamerService: () => (typeof viewBotGStreamerService !== 'undefined' ? viewBotGStreamerService : undefined),
  getSimpleMediaStreamService: () => (typeof simpleMediaStreamService !== 'undefined' ? simpleMediaStreamService : undefined),
});

// Pre-extraction body — the entire shutdown function + handlers + cleanup
// helper lived here before 15B.4. Kept temporarily during a search-and-
// destroy pass below; if you see live code below this marker, the extraction
// is incomplete.
