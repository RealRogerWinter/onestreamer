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

// Log environment variables on startup for debugging
console.log('🔧 Environment Check on Server Start:');
console.log('  SMTP_HOST:', process.env.SMTP_HOST ? 'configured' : 'NOT SET');
console.log('  SMTP_USER:', process.env.SMTP_USER ? 'configured' : 'NOT SET');
console.log('  FROM_EMAIL:', process.env.FROM_EMAIL || 'NOT SET');

const StreamService = require('./services/StreamService');
const TakeoverService = require('./services/TakeoverService');
const TestStreamService = require('./services/TestStreamService');
const ViewbotService = require('./services/ViewbotService');
const ViewBotClientService = require('./services/ViewBotClientService');
const ViewBotWebRTCService = require('./services/ViewBotWebRTCService');
const ViewBotLiveKitService = require('./services/ViewBotLiveKitService');
const SimpleViewBotRotation = require('./services/SimpleViewBotRotation');
const ViewBotURLService = require('./services/ViewBotURLService');
const URLStreamHealthService = require('./services/URLStreamHealthService');
const RandomStreamRotationService = require('./services/RandomStreamRotationService');
const SimpleMediaStreamService = require('./services/SimpleMediaStreamService');
const MediasoupService = require('./services/MediasoupService');
const AudioOptimizationService = require('./services/AudioOptimizationService');
const ResourceMonitor = require('./services/ResourceMonitor');
const SessionService = require('./services/SessionService');
const AuthService = require('./services/AuthService');
const AccountService = require('./services/AccountService');
const TimeTrackingService = require('./services/TimeTrackingService');
const ItemService = require('./services/ItemService');
const InventoryService = require('./services/InventoryService');
const ShopService = require('./services/ShopService');
const BuffDebuffService = require('./services/BuffDebuffService');
const CanvasFxService = require('./services/CanvasFxService');
const SoundFxService = require('./services/SoundFxService');
const VisualFxService = require('./services/VisualFxService');
const MediasoupPlainTransportService = require('./services/MediasoupPlainTransportService');
const StreamInterceptorService = require('./services/StreamInterceptorService');
const ChatBotService = require('./services/ChatBotService');
const StreamBotService = require('./services/StreamBotService');
const RecordingService = require('./services/RecordingService');
const FileCompressionService = require('./services/FileCompressionService');
const RecordingStorageService = require('./services/RecordingStorageService');
const ClipStorageService = require('./services/ClipStorageService');
const ClipProcessorService = require('./services/ClipProcessorService');
const ClipService = require('./services/ClipService');
const ContinuousRecordingService = require('./services/ContinuousRecordingService');
const TranscriptionService = require('./services/TranscriptionService');
const IPBanService = require('./services/IPBanService');
const { GameService, GameStreamService } = require('./services/game');
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
const database = require('./database/database');
const { runAsync, getAsync, allAsync } = database;

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
    console.log('🔒 HTTPS: SSL certificates loaded successfully');
  } catch (err) {
    console.error('⚠️ HTTPS: Failed to load SSL certificates:', err.message);
  }
}

// TURN credential generation for coturn with static-auth-secret
// Coturn uses HMAC-SHA1 for time-limited credentials
const TURN_SECRET = process.env.TURN_SECRET || '***REMOVED-TURN-SECRET***';
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

// Serve stream reducer debug page
app.get('/debug-stream-reducer', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'debug-stream-reducer-real.html'));
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

// Serve VisualFX debug test page
app.get('/visualfx-test', (req, res) => {
  res.sendFile(path.join(__dirname, '../visualfx-debug-test.html'));
});

// Serve simple VisualFX debug panel
app.get('/visualfx-debug-simple', (req, res) => {
  res.sendFile(path.join(__dirname, '../visualfx-debug-simple.html'));
});

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'REDACTED-SESSION-SECRET',
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
app.use('/auth', authRoutes);

// Moderation routes
app.use('/api/moderation', moderationRoutes);

// Debug middleware to log all requests
app.use('/api', (req, res, next) => {
  console.log(`🌐 HTTP: ${req.method} ${req.url} from ${req.get('origin') || 'unknown'}`);
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

// Tutorial API endpoints
app.get('/api/tutorial', (req, res) => {
  try {
    const dataDir = path.join(__dirname, 'data');
    
    // Try to load new tabbed format first
    const tabsPath = path.join(dataDir, 'tutorial-tabs.json');
    if (fs.existsSync(tabsPath)) {
      const tabsContent = fs.readFileSync(tabsPath, 'utf8');
      const tabs = JSON.parse(tabsContent);
      res.json({ tabs });
    } else {
      // Fallback to old single content format
      const tutorialPath = path.join(dataDir, 'tutorial.txt');
      if (fs.existsSync(tutorialPath)) {
        const content = fs.readFileSync(tutorialPath, 'utf8');
        res.json({ content });
      } else {
        res.json({ content: '' });
      }
    }
  } catch (error) {
    console.error('Failed to load tutorial:', error);
    res.status(500).json({ error: 'Failed to load tutorial content' });
  }
});

app.post('/api/tutorial', async (req, res) => {
  try {
    // Check if user is admin
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Fetch the actual user record to check admin status
    const AccountService = require('./services/AccountService');
    const accountService = new AccountService();
    const user = await accountService.getUserById(decoded.id);
    
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { content, tabs } = req.body;
    
    // Ensure data directory exists
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (tabs) {
      // New tabbed format - privacy is optional for backward compatibility
      if (typeof tabs !== 'object' || !tabs.about || !tabs.support || !tabs.tutorial || !tabs.terms) {
        return res.status(400).json({ error: 'Tabs must contain about, support, tutorial, and terms sections' });
      }
      
      // Save tabbed content
      const tabsPath = path.join(dataDir, 'tutorial-tabs.json');
      fs.writeFileSync(tabsPath, JSON.stringify(tabs, null, 2), 'utf8');
      
      // Also save the tutorial tab content to the old file for backward compatibility
      const tutorialPath = path.join(dataDir, 'tutorial.txt');
      fs.writeFileSync(tutorialPath, tabs.tutorial, 'utf8');
    } else if (content) {
      // Old single content format
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'Content must be a string' });
      }
      
      // Save tutorial content
      const tutorialPath = path.join(dataDir, 'tutorial.txt');
      fs.writeFileSync(tutorialPath, content, 'utf8');
    } else {
      return res.status(400).json({ error: 'Either content or tabs must be provided' });
    }

    res.json({ success: true, message: 'Tutorial content saved successfully' });
  } catch (error) {
    console.error('Failed to save tutorial:', error);
    res.status(500).json({ error: 'Failed to save tutorial content' });
  }
});

// Audio Optimization API endpoints
app.get('/api/audio/optimization-settings', (req, res) => {
  res.json({
    constraints: audioOptimizationService.getOptimizedConstraints('streaming'),
    rtpParameters: audioOptimizationService.getOptimizedRtpParameters(),
    config: audioOptimizationService.config
  });
});

app.get('/api/audio/profile/:profile', (req, res) => {
  const profile = req.params.profile;
  const constraints = audioOptimizationService.getOptimizedConstraints(profile);
  res.json({ profile, constraints });
});

app.post('/api/audio/monitor/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { producerId } = req.body;
  const session = audioOptimizationService.monitorSession(sessionId, producerId);
  res.json({ success: true, session });
});

app.post('/api/audio/stats/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const stats = req.body;
  audioOptimizationService.updateSessionStats(sessionId, stats);
  res.json({ success: true });
});

app.get('/api/audio/report/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const report = audioOptimizationService.getSessionReport(sessionId);
  if (report) {
    res.json(report);
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/api/audio/global-stats', (req, res) => {
  res.json(audioOptimizationService.stats.globalStats);
});

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

let redisClient;

async function initializeRedis() {
  if (process.env.REDIS_URL) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    try {
      await redisClient.connect();
      console.log('Connected to Redis');
    } catch (error) {
      console.warn('Redis connection failed, using in-memory storage:', error.message);
      redisClient = null;
    }
  } else {
    console.log('No Redis URL provided, using in-memory storage');
    redisClient = null;
  }
}

const streamService = new StreamService();
global.streamService = streamService;  // Make it globally accessible for SimpleViewBotMediaSoup
const sessionService = new SessionService();
const takeoverService = new TakeoverService(redisClient, sessionService);
const testStreamService = new TestStreamService();
const mediaStreamService = new SimpleMediaStreamService();
// WebRTC service initialization - with optional adapter support
let mediasoupService;
let usingAdapter = false;

if (process.env.USE_WEBRTC_ADAPTER === 'true') {
  // Use adapter for backend switching capability
  console.log('🔄 WebRTC Adapter enabled - backend switching available');
  const WebRTCAdapterV2 = require('./services/WebRTCAdapterV2');
  mediasoupService = new WebRTCAdapterV2();
  usingAdapter = true;
  global.webrtcAdapter = mediasoupService; // Make adapter available globally
} else {
  // Use standard MediaSoup (default for compatibility)
  console.log('📡 Using standard MediaSoup service');
  mediasoupService = new MediasoupService();
}

// Store service type for debugging
global.mediasoupServiceType = usingAdapter ? 'adapter' : 'direct';
const audioOptimizationService = new AudioOptimizationService();
const resourceMonitor = new ResourceMonitor();
const accountService = new AccountService();
// authService already initialized earlier for passport strategies
const timeTrackingService = new TimeTrackingService();
const itemService = new ItemService();
const inventoryService = new InventoryService(itemService);
const shopService = new ShopService(itemService, inventoryService, accountService, io);
const buffDebuffService = new BuffDebuffService(io, streamService, timeTrackingService, sessionService);
const canvasFxService = new CanvasFxService(io, itemService, buffDebuffService);
const soundFxService = new SoundFxService();
const plainTransportService = new MediasoupPlainTransportService(mediasoupService);

// Visual Effects Synchronization System
// Get all active visual effects that should be applied to the stream
async function getActiveVisualEffects() {
  try {
    // Get ALL active buffs with visual effects
    const visualEffectBuffs = await database.allAsync(`
      SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data,
             ab.user_id, ab.remaining_seconds, ab.item_id, ab.buff_type
      FROM active_buffs ab
      JOIN items i ON ab.item_id = i.id
      WHERE ab.is_active = 1 
        AND ab.remaining_seconds > 0
        AND i.name IN (
          'smoke_bomb', 'pixelate', 'emboss', 'thermal_vision', 'rotate_90',
          'potato', 'upside_down', 'mirror', 'invert_colors', 'darkness',
          'overexposed', 'glitch_bomb', 'motion_blur', 'freeze_frame',
          'spotlight', 'disco_ball', 'confetti_cannon', 'rainbow_effect',
          'stream_reducer'
        )
      ORDER BY ab.applied_at DESC
    `);
    
    return visualEffectBuffs || [];
  } catch (error) {
    console.error('❌ Error getting active visual effects:', error);
    return [];
  }
}

// Periodically sync visual effects with active buffs
let visualEffectSyncInterval = null;

function startVisualEffectSync() {
  if (visualEffectSyncInterval) {
    clearInterval(visualEffectSyncInterval);
  }
  
  visualEffectSyncInterval = setInterval(async () => {
    try {
      const currentStreamer = streamService.getCurrentStreamer();
      if (!currentStreamer) return;
      
      const activeVisualEffects = await getActiveVisualEffects();
      if (activeVisualEffects.length > 0) {
        // Only log periodically to avoid spam
        if (Math.random() < 0.1) { // 10% chance to log
          console.log(`🔄 VISUAL FX SYNC: ${activeVisualEffects.length} active effects in sync`);
        }
        
        // Broadcast current visual effects state
        io.emit('visual-effects-sync-pulse', {
          effects: activeVisualEffects.map(buff => ({
            effectId: buff.item_name,
            itemName: buff.item_name,
            displayName: buff.display_name,
            remainingSeconds: buff.remaining_seconds,
            effectData: buff.effect_data
          })),
          streamId: currentStreamer,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('❌ VISUAL FX SYNC: Error in periodic sync:', error);
    }
  }, 5000); // Sync every 5 seconds
  
  console.log('🔄 VISUAL FX SYNC: Started periodic synchronization');
}

// Sync will be started after server initialization

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
      console.log(`🎨 VISUAL FX: Buff ${buffData.item_name} applied, ensuring visual sync`);
      
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
    console.error('❌ VISUAL FX: Error syncing buff-applied visual effect:', error);
  }
});
const streamInterceptorService = new StreamInterceptorService(mediasoupService, plainTransportService);
const visualFxService = new VisualFxService(mediasoupService, buffDebuffService, streamInterceptorService);
const chatBotService = new ChatBotService();
const streamBotService = new StreamBotService(database);

// Set up stream interceptor event handlers
streamInterceptorService.on('stream-intercepted', async (data) => {
    const { streamId, processedProducerId } = data;
    console.log(`🎬 SERVER: Stream intercepted for ${streamId}, switching viewers...`);
    
    // DON'T notify the streamer - they should keep producing to the original transport
    // Only notify viewers so they can switch to the processed stream
    // For now, we'll skip the client notification entirely since the client doesn't handle it
    // In a full implementation, viewers would reconnect to consume from the processed producers
    
    // TODO: Implement viewer switching logic
    // This would involve:
    // 1. Finding all viewers consuming from the original stream
    // 2. Having them create new consumers for the processed producers
    // 3. Switching their video/audio to the new consumers
    
    console.log(`🎬 SERVER: Stream interception complete - GStreamer is processing the stream`);
});

streamInterceptorService.on('stream-restored', (data) => {
    const { streamId } = data;
    console.log(`🎬 SERVER: Stream restored for ${streamId}`);
    
    // Notify all clients about restoration
    io.emit('stream-restored', {
        streamId,
        timestamp: Date.now()
    });
});

// Initialize recording services
const recordingStorageService = new RecordingStorageService(database);
const fileCompressionService = new FileCompressionService(database);
const recordingService = new RecordingService(database, mediasoupService, recordingStorageService);

// Initialize clip services
const clipStorageService = new ClipStorageService();
const clipProcessorService = new ClipProcessorService(clipStorageService);

// Initialize continuous recording service for LiveKit Egress
const continuousRecordingService = new ContinuousRecordingService({
  livekitHost: process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882',
  apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
  apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
  roomName: process.env.LIVEKIT_ROOM_NAME || 'onestreamer-main',
  outputDir: '/root/onestreamer/egress-recordings',
  retentionMinutes: 10 // Keep last 10 minutes for clipping
});

const clipService = new ClipService(database, clipStorageService, clipProcessorService, continuousRecordingService);

// Connect clip processor to clip service for status updates
clipProcessorService.setProcessedCallback(async (clipId, result) => {
  await clipService.updateClipProcessingResult(clipId, result);
});

// Initialize transcription service with recording service dependency
const transcriptionService = new TranscriptionService(database, mediasoupService, recordingService);

// Initialize MovieBot service
const MovieBotService = require('./services/MovieBotService');
// Create a simple chat service wrapper for getting recent messages
const chatServiceWrapper = {
    getRecentMessages: async (limit) => {
        try {
            const messages = await database.allAsync(
                `SELECT username, message, created_at 
                 FROM messages 
                 ORDER BY created_at DESC 
                 LIMIT ?`,
                [limit]
            );
            return messages.reverse(); // Return in chronological order
        } catch (error) {
            console.error('Error getting recent messages:', error);
            return [];
        }
    }
};
const movieBotService = new MovieBotService(
    transcriptionService,
    chatBotService,
    chatServiceWrapper,
    database
);

// Recording service is initialized, no need to load state separately
console.log('📼 RECORDING: Recording service initialized');
console.log('🎙️ TRANSCRIPTION: Transcription service initialized');
console.log('🎬 MOVIEBOT: MovieBot service initialized');

// Set Socket.IO for sound effects broadcasting
soundFxService.setSocketIO(io);

// Set Socket.IO instance for ChatBot service to manage connections
chatBotService.setIoInstance(io);

// Connect MovieBotService to ChatBotService for chat history
chatBotService.setMovieBotService(movieBotService);

// Set the buff-debuff service dependency on inventory service after creation
inventoryService.setBuffDebuffService(buffDebuffService);
// Set stream and session services for proper buff targeting
inventoryService.setStreamAndSessionServices(streamService, sessionService);

// Set dependencies for canvas fx service
canvasFxService.setDependencies(io, itemService, buffDebuffService, streamService, sessionService);

// Set dependencies for visual fx service
visualFxService.setDependencies(mediasoupService, buffDebuffService, streamService, io, sessionService, streamInterceptorService);

// Set dependencies for StreamBot auto-summon feature
streamBotService.setChatBotService(chatBotService);
streamBotService.setChatBotLLMService(chatBotService.llmService);

// Make services available to routes
app.set('sessionService', sessionService);
app.set('timeTrackingService', timeTrackingService);
app.set('streamService', streamService);
app.set('takeoverService', takeoverService);
app.set('itemService', itemService);
app.set('inventoryService', inventoryService);
app.set('shopService', shopService);
app.set('buffDebuffService', buffDebuffService);
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
const gameService = new GameService(io, database);
const gameStreamService = new GameStreamService(io, gameService, takeoverService);

// Connect game stream service to takeover service for game mode blocking
takeoverService.setGameStreamService(gameStreamService);

// Initialize game service (loads world data)
gameService.initialize().catch(err => {
  console.error('Failed to initialize game service:', err);
});

// Make game services available to routes
app.set('gameService', gameService);
app.set('gameStreamService', gameStreamService);
app.locals.gameService = gameService;
app.locals.gameStreamService = gameStreamService;

console.log('🎮 Game system initialized');
// ============================================

// Give clip processor access to Socket.IO for real-time updates
clipProcessorService.setSocketIO(io);

// API endpoint for chat service to track messages
app.post('/api/internal/track-chat-message', express.json(), async (req, res) => {
  try {
    const { userId, ip } = req.body;
    console.log(`💬 API: Received chat message tracking request - userId: ${userId}, ip: ${ip}`);
    
    if (!userId && !ip) {
      console.log(`❌ API: No userId or ip provided`);
      return res.status(400).json({ error: 'userId or ip required' });
    }
    
    // If only IP is provided, try to find the user ID
    let actualUserId = userId;
    if (!actualUserId && ip) {
      const session = sessionService.getSessionByIp(ip);
      actualUserId = session?.userId;
      console.log(`💬 API: Looking up user by IP ${ip} - found session:`, !!session, 'userId:', actualUserId);
    }
    
    if (actualUserId) {
      console.log(`✅ API: Tracking chat message for user ${actualUserId}`);
      await timeTrackingService.trackChatMessage(actualUserId);
      res.json({ success: true, userId: actualUserId });
    } else {
      console.log(`❌ API: User not found - userId: ${userId}, ip: ${ip}, session: ${sessionService.getSessionByIp(ip) ? 'exists but no userId' : 'not found'}`);
      res.json({ success: false, message: 'User not authenticated' });
    }
  } catch (error) {
    console.error('❌ API: Error tracking chat message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint for chat service to sync usernames
app.post('/api/internal/sync-chat-username', express.json(), async (req, res) => {
  try {
    const { ip, username, color } = req.body;
    console.log(`💬 API: Received chat username sync request - ip: ${ip}, username: ${username}, color: ${color}`);
    
    if (!ip || !username) {
      console.log(`❌ API: Missing required fields - ip: ${ip}, username: ${username}`);
      return res.status(400).json({ error: 'ip and username required' });
    }
    
    // Update the session service with the chat username
    sessionService.setChatUsername(ip, username, color);
    console.log(`✅ API: Synced chat username for IP ${ip}: ${username} (${color})`);
    
    res.json({ success: true, ip, username, color });
  } catch (error) {
    console.error('❌ API: Error syncing chat username:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test endpoint to verify viewbot username generation
app.post('/api/internal/test-viewbot-username', express.json(), async (req, res) => {
  const { streamerId } = req.body;
  
  if (!streamerId) {
    return res.status(400).json({ error: 'streamerId is required' });
  }
  
  console.log(`🧪 TEST API: Testing viewbot username generation for ${streamerId}`);
  
  try {
    const displayName = await getStreamerDisplayName(streamerId);
    
    res.json({
      success: true,
      streamerId,
      displayName,
      isViewbot: viewbotService ? viewbotService.isViewbotStream(streamerId) : false,
      isViewbotSocket: viewbotSocketIds.has(streamerId),
      usedCache: viewbotUsernameCache.has(streamerId),
      cacheSize: viewbotUsernameCache.size,
      viewbotSocketCount: viewbotSocketIds.size
    });
  } catch (error) {
    console.error('❌ TEST API: Error testing viewbot username:', error);
    res.status(500).json({ 
      error: error.message,
      streamerId 
    });
  }
});

// API endpoint to get leaderboard
app.get('/api/internal/leaderboard', async (req, res) => {
  try {
    const accountService = new AccountService();
    const db = require('./database/database');
    
    const leaderboard = await db.allAsync(
      `SELECT u.username, MAX(us.points_balance) as points_balance 
       FROM user_stats us 
       JOIN users u ON us.user_id = u.id 
       WHERE us.points_balance > 0
       GROUP BY u.id, u.username
       ORDER BY points_balance DESC 
       LIMIT 10`
    );
    
    res.json({
      success: true,
      leaderboard
    });
  } catch (error) {
    console.error('❌ LEADERBOARD: Error fetching leaderboard:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch leaderboard' 
    });
  }
});

// API endpoint to get stream uptime
app.get('/api/internal/stream-uptime', async (req, res) => {
  try {
    // Check if any stream is live
    const streamingSockets = io.sockets.sockets;
    let isLive = false;
    let streamerUsername = null;
    let streamStartTime = null;
    
    // Find active streamer
    for (const [socketId, socket] of streamingSockets) {
      if (socket.data?.isStreaming) {
        isLive = true;
        streamerUsername = socket.data.username || 'Unknown';
        streamStartTime = socket.data.streamStartTime || Date.now();
        break;
      }
    }
    
    if (isLive && streamStartTime) {
      const uptime = Math.floor((Date.now() - streamStartTime) / 1000);
      res.json({
        success: true,
        isLive: true,
        uptime,
        streamer: streamerUsername
      });
    } else {
      res.json({
        success: true,
        isLive: false,
        uptime: 0
      });
    }
  } catch (error) {
    console.error('❌ UPTIME: Error fetching stream uptime:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch stream uptime' 
    });
  }
});

// API endpoint for awarding points (claim events, etc)
app.post('/api/internal/award-points', express.json(), async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const accountService = new AccountService();
    
    // Award points
    await accountService.addPoints(userId, amount, 'award', reason || 'Claim event reward');
    const newBalance = await accountService.getPointsBalance(userId);
    
    res.json({ 
      success: true, 
      newBalance: newBalance,
      awarded: amount
    });
  } catch (error) {
    console.error('❌ MAIN SERVER: Failed to award points:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to award points' 
    });
  }
});

// API endpoint for gambling
app.post('/api/internal/gamble', express.json(), async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const accountService = new AccountService();
    
    // Check balance
    const currentBalance = await accountService.getPointsBalance(userId);
    
    if (currentBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient points. You have ${currentBalance} points` 
      });
    }
    
    // 50/50 chance
    const won = Math.random() < 0.5;
    let newBalance;
    
    if (won) {
      // Win - double the amount
      newBalance = await accountService.addPoints(
        userId,
        amount,
        'gamble_win',
        `Won ${amount} points gambling`,
        { amount, result: 'win' }
      );
    } else {
      // Lose
      newBalance = await accountService.subtractPoints(
        userId,
        amount,
        'gamble_loss',
        `Lost ${amount} points gambling`,
        { amount, result: 'loss' }
      );
    }
    
    console.log(`🎲 GAMBLE: User ${userId} ${won ? 'won' : 'lost'} ${amount} points. New balance: ${newBalance}`);
    
    res.json({
      success: true,
      won,
      amount,
      newBalance
    });
  } catch (error) {
    console.error('❌ GAMBLE: Error processing gamble:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process gamble' 
    });
  }
});

// API endpoint for slots
app.post('/api/internal/slots', express.json(), async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const accountService = new AccountService();
    
    // Check balance
    const currentBalance = await accountService.getPointsBalance(userId);
    
    if (currentBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient points. You have ${currentBalance} points` 
      });
    }
    
    // Slot symbols
    const slotSymbols = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣'];
    const symbols = [
      slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
      slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
      slotSymbols[Math.floor(Math.random() * slotSymbols.length)]
    ];
    
    // Calculate winnings
    let winAmount = 0;
    if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
      // All three match
      if (symbols[0] === '7️⃣') {
        winAmount = amount * 10; // Jackpot!
      } else if (symbols[0] === '💎') {
        winAmount = amount * 5;
      } else {
        winAmount = amount * 3;
      }
    } else if (symbols[0] === symbols[1] || symbols[1] === symbols[2] || symbols[0] === symbols[2]) {
      // Two match
      winAmount = amount; // Return bet
    }
    
    // Process the result
    let newBalance;
    if (winAmount > amount) {
      // Won more than bet
      const profit = winAmount - amount;
      newBalance = await accountService.addPoints(
        userId,
        profit,
        'slots_win',
        `Won ${profit} points on slots`,
        { bet: amount, symbols: symbols.join(''), winAmount }
      );
    } else if (winAmount === amount) {
      // Broke even
      newBalance = currentBalance;
    } else {
      // Lost
      newBalance = await accountService.subtractPoints(
        userId,
        amount,
        'slots_loss',
        `Lost ${amount} points on slots`,
        { bet: amount, symbols: symbols.join(''), winAmount }
      );
    }
    
    console.log(`🎰 SLOTS: User ${userId} bet ${amount}, got [${symbols.join(' ')}], won ${winAmount}. New balance: ${newBalance}`);
    
    res.json({
      success: true,
      symbols,
      winAmount,
      newBalance
    });
  } catch (error) {
    console.error('❌ SLOTS: Error processing slots:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process slots' 
    });
  }
});

// Store last bonus claim times for users (in memory - could move to DB for persistence)
const userBonusCooldowns = new Map();

// Endpoint for authenticated users to claim chat bonus
app.post('/api/internal/claim-chat-bonus', express.json(), async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'User ID is required' 
      });
    }
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    // Check cooldown for this user
    const now = Date.now();
    const lastClaim = userBonusCooldowns.get(userId);
    
    if (lastClaim) {
      const timeSinceLastClaim = now - lastClaim;
      const minimumCooldown = 2 * 60 * 1000; // 2 minutes in milliseconds
      
      if (timeSinceLastClaim < minimumCooldown) {
        const remainingTime = Math.ceil((minimumCooldown - timeSinceLastClaim) / 1000);
        console.log(`⏰ BONUS: User ${userId} tried to claim too soon. ${remainingTime}s remaining`);
        return res.status(429).json({ 
          success: false, 
          error: 'Bonus on cooldown',
          remainingSeconds: remainingTime,
          nextAvailable: new Date(lastClaim + minimumCooldown).toISOString()
        });
      }
    }
    
    const accountService = new AccountService();
    
    // Award 100 bonus points
    const newBalance = await accountService.addPoints(
      userId,
      100,
      'chat_bonus',
      'Chat activity bonus',
      { source: 'chat_bonus_icon' }
    );
    
    // Update last claim time for this user
    userBonusCooldowns.set(userId, now);
    
    // Calculate next bonus time (random 2-6 minutes from now)
    const nextBonusDelay = Math.floor(Math.random() * 240000) + 120000; // 2-6 minutes
    const nextBonusTime = new Date(now + nextBonusDelay);
    
    console.log(`🎁 BONUS: User ${userId} claimed 100 chat bonus points. New balance: ${newBalance}. Next available: ${nextBonusTime.toISOString()}`);
    
    res.json({
      success: true,
      pointsAwarded: 100,
      newBalance,
      nextBonusDelay, // Send delay to client for timer
      nextBonusTime: nextBonusTime.toISOString()
    });
  } catch (error) {
    console.error('❌ BONUS: Error claiming chat bonus:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to claim bonus' 
    });
  }
});

// Endpoint to gift an item to another user
app.post('/api/internal/gift-item', express.json(), async (req, res) => {
  try {
    const { fromUserId, toUsername, itemName, quantity = 1 } = req.body;
    
    if (!fromUserId || !toUsername || !itemName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== fromUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const accountService = new AccountService();
    const itemService = new ItemService();
    const inventoryService = new InventoryService(itemService);
    
    // Find the recipient user
    const toUser = await accountService.getUserByUsername(toUsername);
    if (!toUser) {
      return res.status(404).json({ 
        success: false, 
        error: `User '${toUsername}' not found` 
      });
    }
    
    // Check if trying to gift to self
    if (toUser.id === fromUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot gift items to yourself' 
      });
    }
    
    // Find the item by name (case insensitive)
    const items = await itemService.getAllItems();
    const item = items.find(i => 
      i.name.toLowerCase() === itemName.toLowerCase() || 
      i.display_name.toLowerCase() === itemName.toLowerCase()
    );
    
    if (!item) {
      return res.status(404).json({ 
        success: false, 
        error: `Item '${itemName}' not found` 
      });
    }
    
    // Check if the item is giftable
    if (!item.is_tradeable) {
      return res.status(400).json({ 
        success: false, 
        error: `${item.display_name} cannot be gifted` 
      });
    }
    
    // Check sender's inventory
    const senderInventory = await inventoryService.getInventoryItem(fromUserId, item.id);
    if (!senderInventory || senderInventory.quantity < quantity) {
      return res.status(400).json({ 
        success: false, 
        error: `You don't have enough ${item.display_name} to gift (have: ${senderInventory?.quantity || 0}, need: ${quantity})` 
      });
    }
    
    // Get sender info for logging
    const fromUser = await accountService.getUserById(fromUserId);
    
    // Perform the transfer
    await inventoryService.removeItemFromInventory(fromUserId, item.id, quantity);
    await inventoryService.addItemToInventory(toUser.id, item.id, quantity);
    
    // Log the gift transaction
    const db = require('./database/database');
    await db.runAsync(
      `INSERT INTO gift_transactions (from_user_id, to_user_id, item_id, quantity, timestamp)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [fromUserId, toUser.id, item.id, quantity]
    );
    
    console.log(`🎁 GIFT: ${fromUser.username} gifted ${quantity}x ${item.display_name} to ${toUsername}`);
    
    res.json({
      success: true,
      item: {
        id: item.id,
        name: item.display_name,
        emoji: item.emoji
      },
      quantity,
      from: fromUser.username,
      to: toUsername
    });
  } catch (error) {
    console.error('❌ GIFT: Error processing gift:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to process gift' 
    });
  }
});

// Endpoint to get user's giftable items
app.get('/api/internal/giftable-items/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== parseInt(userId)) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const itemService = new ItemService();
    const inventoryService = new InventoryService(itemService);
    
    // Get user's inventory
    const inventory = await inventoryService.getUserInventory(parseInt(userId));
    
    // Filter for giftable items
    const giftableItems = [];
    for (const invItem of inventory) {
      const item = await itemService.getItemById(invItem.item_id);
      if (item && item.is_tradeable && invItem.quantity > 0) {
        giftableItems.push({
          id: item.id,
          name: item.name,
          display_name: item.display_name,
          emoji: item.emoji,
          quantity: invItem.quantity,
          rarity: item.rarity
        });
      }
    }
    
    res.json({
      success: true,
      items: giftableItems
    });
  } catch (error) {
    console.error('❌ GIFT: Error fetching giftable items:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch giftable items' 
    });
  }
});

// Endpoint to check bonus availability for a user
app.get('/api/internal/bonus-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== parseInt(userId)) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const now = Date.now();
    const lastClaim = userBonusCooldowns.get(parseInt(userId));
    const minimumCooldown = 2 * 60 * 1000; // 2 minutes
    
    if (!lastClaim || (now - lastClaim) >= minimumCooldown) {
      // Bonus is available
      res.json({
        success: true,
        available: true
      });
    } else {
      // Still on cooldown
      const remainingTime = Math.ceil((minimumCooldown - (now - lastClaim)) / 1000);
      res.json({
        success: true,
        available: false,
        remainingSeconds: remainingTime,
        nextAvailable: new Date(lastClaim + minimumCooldown).toISOString()
      });
    }
  } catch (error) {
    console.error('❌ BONUS: Error checking bonus status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check bonus status' 
    });
  }
});

// Auth endpoint to get current user info - properly authenticate and get real data
app.get('/api/auth/me', async (req, res) => {
  try {
    // Get authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No authorization token provided' });
    }

    const token = authHeader.substring(7);
    
    // Verify JWT token and get user data
    try {
      const decoded = authService.verifyToken(token);
      const user = await authService.accountService.getUserById(decoded.id);
      const stats = await authService.accountService.getUserStats(decoded.id);
      
      // Use points_balance from stats
      const points = stats?.points_balance || 0;
      
      res.json({
        user: {
          ...user,
          isModerator: user.is_moderator === 1,
          isAdmin: user.is_admin === 1
        },
        stats: {
          ...stats,
          points  // Include points for backward compatibility
        }
      });
    } catch (tokenError) {
      console.error('Token verification error:', tokenError);
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  } catch (error) {
    console.error('Error in /api/auth/me:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Endpoint to get user stats by username
app.get('/api/internal/user-stats/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username is required' 
      });
    }
    
    const accountService = new AccountService();
    
    // Find the user by username
    const user = await accountService.getUserByUsername(username);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: `User '${username}' not found` 
      });
    }
    
    // Get user stats
    const stats = await accountService.getUserStats(user.id);
    
    if (!stats) {
      // Return default stats if none exist
      return res.json({
        success: true,
        stats: {
          points_balance: 0,
          total_view_time: 0,
          total_stream_time: 0,
          chat_message_count: 0,
          stream_count: 0
        }
      });
    }
    
    res.json({
      success: true,
      stats: {
        points_balance: stats.points_balance || 0,
        total_view_time: stats.total_view_time || 0,
        total_stream_time: stats.total_stream_time || 0,
        chat_message_count: stats.chat_message_count || 0,
        stream_count: stats.stream_count || 0
      }
    });
  } catch (error) {
    console.error('❌ STATS: Error fetching user stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch user stats' 
    });
  }
});

// Endpoint for users to transfer points to another user
app.post('/api/internal/transfer-points', express.json(), async (req, res) => {
  try {
    const { fromUserId, toUsername, amount, senderUsername } = req.body;
    
    if (!fromUserId || !toUsername || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== fromUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    const accountService = new AccountService();
    
    // Get sender info
    const senderUser = await accountService.getUserById(fromUserId);
    if (!senderUser) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sender not found' 
      });
    }
    
    // Find the target user by username
    const targetUser = await accountService.getUserByUsername(toUsername);
    
    if (!targetUser) {
      return res.status(404).json({ 
        success: false, 
        error: `User '${toUsername}' not found` 
      });
    }
    
    // Check if trying to send to self
    if (targetUser.id === fromUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot send points to yourself' 
      });
    }
    
    // Check sender's balance
    const senderBalance = await accountService.getPointsBalance(fromUserId);
    
    if (senderBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient points. You have ${senderBalance} points but tried to send ${amount}` 
      });
    }
    
    // Perform the transfer
    const senderNewBalance = await accountService.subtractPoints(
      fromUserId,
      amount,
      'transfer_out',
      `Sent ${amount} points to ${toUsername}`,
      { recipientId: targetUser.id, recipientUsername: toUsername }
    );
    
    const recipientNewBalance = await accountService.addPoints(
      targetUser.id,
      amount,
      'transfer_in',
      `Received ${amount} points from ${senderUsername || senderUser.username}`,
      { senderId: fromUserId, senderUsername: senderUsername || senderUser.username }
    );
    
    console.log(`💸 TRANSFER: ${senderUsername || senderUser.username} sent ${amount} points to ${toUsername}. Sender balance: ${senderNewBalance}, Recipient balance: ${recipientNewBalance}`);
    
    res.json({
      success: true,
      senderNewBalance,
      recipientNewBalance,
      recipientUserId: targetUser.id,
      recipientUsername: targetUser.username
    });
  } catch (error) {
    console.error('❌ TRANSFER: Error transferring points:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to transfer points' 
    });
  }
});

// Admin endpoint to award points to a user (creates new points)
app.post('/api/internal/admin/award-points', express.json(), async (req, res) => {
  try {
    const { targetUsername, amount, adminUserId } = req.body;
    
    if (!targetUsername || !amount || !adminUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify admin authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== adminUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid admin credentials' 
      });
    }
    
    // Check if the user is actually an admin
    const accountService = new AccountService();
    const adminUser = await accountService.getUserById(adminUserId);
    
    if (!adminUser || !adminUser.is_admin) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required' 
      });
    }
    
    // Find the target user by username
    const targetUser = await accountService.getUserByUsername(targetUsername);
    
    if (!targetUser) {
      return res.status(404).json({ 
        success: false, 
        error: `User '${targetUsername}' not found` 
      });
    }
    
    // Award points to the user (creates new points)
    const newBalance = await accountService.addPoints(
      targetUser.id,
      amount,
      'admin_award',
      `Admin award by ${adminUser.username}`,
      { adminId: adminUserId }
    );
    
    console.log(`💰 ADMIN: ${adminUser.username} awarded ${amount} points to ${targetUsername}. New balance: ${newBalance}`);
    
    res.json({
      success: true,
      newBalance,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username
    });
  } catch (error) {
    console.error('❌ ADMIN: Error giving points:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to give points' 
    });
  }
});

// Admin endpoint to take points from a user
app.post('/api/internal/admin/take-points', express.json(), async (req, res) => {
  try {
    const { targetUsername, amount, adminUserId } = req.body;
    
    if (!targetUsername || !amount || !adminUserId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters' 
      });
    }
    
    // Verify admin authorization
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        error: 'Unauthorized' 
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    
    if (!decoded || decoded.id !== adminUserId) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid admin credentials' 
      });
    }
    
    // Check if the user is actually an admin
    const accountService = new AccountService();
    const adminUser = await accountService.getUserById(adminUserId);
    
    if (!adminUser || !adminUser.is_admin) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin access required' 
      });
    }
    
    // Find the target user by username
    const targetUser = await accountService.getUserByUsername(targetUsername);
    
    if (!targetUser) {
      return res.status(404).json({ 
        success: false, 
        error: `User '${targetUsername}' not found` 
      });
    }
    
    // Check if user has enough points
    const currentBalance = await accountService.getPointsBalance(targetUser.id);
    
    if (currentBalance < amount) {
      return res.status(400).json({ 
        success: false, 
        error: `User only has ${currentBalance} points (cannot deduct ${amount})` 
      });
    }
    
    // Take points from the user
    const newBalance = await accountService.subtractPoints(
      targetUser.id,
      amount,
      'admin_deduction',
      `Admin deduction by ${adminUser.username}`,
      { adminId: adminUserId }
    );
    
    console.log(`💸 ADMIN: ${adminUser.username} deducted ${amount} points from ${targetUsername}. New balance: ${newBalance}`);
    
    res.json({
      success: true,
      newBalance,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username
    });
  } catch (error) {
    console.error('❌ ADMIN: Error taking points:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to take points' 
    });
  }
});

// API endpoint to verify admin status for debug panel
app.get('/api/internal/verify-admin', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ isAdmin: false, error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    
    try {
      const decoded = authService.verifyToken(token);
      const accountService = new AccountService();
      const user = await accountService.getUserById(decoded.id);
      
      const isAdmin = !!(user && user.is_admin);
      
      res.json({ 
        isAdmin: isAdmin,
        userId: decoded.id,
        username: user?.username 
      });
    } catch (tokenError) {
      res.status(401).json({ isAdmin: false, error: 'Invalid token' });
    }
  } catch (error) {
    console.error('❌ API: Error verifying admin status:', error);
    res.status(500).json({ isAdmin: false, error: 'Internal server error' });
  }
});

// API endpoint for chat service to get user admin status
app.get('/api/internal/user/:userId/admin-status', express.json(), async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`💬 API: Received admin status request for user ${userId}`);
    
    if (!userId) {
      console.log(`❌ API: No userId provided`);
      return res.status(400).json({ error: 'userId required' });
    }
    
    const accountService = new AccountService();
    const user = await accountService.getUserById(userId);
    
    if (!user) {
      console.log(`❌ API: User ${userId} not found`);
      return res.status(404).json({ error: 'User not found' });
    }
    
    const isAdmin = !!user.is_admin;
    console.log(`✅ API: User ${userId} admin status: ${isAdmin}`);
    
    res.json({ 
      success: true, 
      userId, 
      isAdmin,
      username: user.username 
    });
  } catch (error) {
    console.error('❌ API: Error checking admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize ViewbotService after MediasoupService
let viewbotService;
let viewBotWebRTCService;
let viewBotClientService;

// Track which streamers have already been notified to prevent duplicates
const notifiedStreamers = new Set();

/**
 * Creates a synthetic MediaSoup producer for ViewBot content
 */
const createViewBotProducer = async (streamerId, kind, config) => {
  console.log(`🤖 MEDIASOUP: Creating ViewBot ${kind} producer for ${streamerId}`);
  
  try {
    // For ViewBots, we need to create producers on the server side differently
    // since they don't have real WebRTC connections
    
    // Create a transport for the ViewBot if it doesn't exist
    let transport = mediasoupService.transports.get(streamerId);
    if (!transport) {
      console.log(`🚛 MEDIASOUP: Creating transport for ViewBot ${streamerId}`);
      const transportOptions = await mediasoupService.createWebRtcTransport(streamerId);
      transport = mediasoupService.transports.get(streamerId);
    }
    
    if (!transport) {
      throw new Error('Failed to create transport for ViewBot');
    }
    
    // Generate appropriate RTP parameters for the content type
    const rtpParameters = generateViewBotRtpParameters(kind, config);
    
    console.log(`📡 MEDIASOUP: Creating ${kind} producer with RTP params for ViewBot`);
    
    // Create the producer directly on the router for ViewBot
    const producer = await transport.produce({
      kind: kind,
      rtpParameters: rtpParameters,
      paused: false
    });
    
    console.log(`✅ MEDIASOUP: ViewBot ${kind} producer created: ${producer.id}`);
    
    // Store the producer in the MediaSoup service
    let producerMap = mediasoupService.producers.get(streamerId);
    if (!producerMap) {
      producerMap = new Map();
      mediasoupService.producers.set(streamerId, producerMap);
    }
    producerMap.set(kind, producer);
    
    // Set as current streamer if not already set
    if (!mediasoupService.currentStreamer) {
      mediasoupService.currentStreamer = streamerId;
    }
    
    // Start generating synthetic media for this producer
    await startSyntheticMediaGeneration(streamerId, producer, kind, config);
    
    return producer.id;
    
  } catch (error) {
    console.error(`❌ MEDIASOUP: Failed to create ViewBot ${kind} producer:`, error);
    throw error;
  }
};

/**
 * Starts generating synthetic media data for a ViewBot producer
 */
const startSyntheticMediaGeneration = async (streamerId, producer, kind, config) => {
  console.log(`🎨 MEDIASOUP: Starting synthetic ${kind} generation for ViewBot ${streamerId}`);
  
  // For now, we'll create placeholder producers that MediaSoup can work with
  // The actual media generation would require more complex RTP packet creation
  
  if (kind === 'video') {
    // Start video frame generation
    const frameInterval = 1000 / (config.frameRate || 30);
    
    console.log(`📹 MEDIASOUP: Starting video frame generation at ${frameInterval}ms intervals`);
    
    // Store interval for cleanup later
    if (!global.viewBotIntervals) {
      global.viewBotIntervals = new Map();
    }
    
    const interval = setInterval(() => {
      // Generate synthetic video frame data
      // Note: In a real implementation, this would create actual RTP packets
      console.log(`🎬 MEDIASOUP: Generated video frame for ViewBot ${streamerId}`);
    }, frameInterval);
    
    global.viewBotIntervals.set(`${streamerId}-video`, interval);
    
  } else if (kind === 'audio') {
    // Start audio sample generation
    console.log(`🎤 MEDIASOUP: Starting audio sample generation`);
    
    const audioInterval = setInterval(() => {
      // Generate synthetic audio data
      console.log(`🔊 MEDIASOUP: Generated audio sample for ViewBot ${streamerId}`);
    }, 100); // 10 samples per second
    
    if (!global.viewBotIntervals) {
      global.viewBotIntervals = new Map();
    }
    global.viewBotIntervals.set(`${streamerId}-audio`, audioInterval);
  }
};

/**
 * Generates RTP parameters for ViewBot synthetic media
 */
const generateViewBotRtpParameters = (kind, config) => {
  const timestamp = Date.now();
  
  if (kind === 'video') {
    return {
      mid: '1000',  // Use high MID value to avoid conflicts with real users
      codecs: [
        {
          mimeType: 'video/VP8',
          payloadType: 96,
          clockRate: 90000,
          parameters: {},
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'goog-remb' }
          ]
        }
      ],
      headerExtensions: [
        {
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          id: 1
        },
        {
          uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          id: 4
        },
        {
          uri: 'urn:3gpp:video-orientation',
          id: 11
        }
      ],
      encodings: [
        {
          ssrc: Math.floor(Math.random() * 1000000000),
          maxBitrate: 1000000,
          minBitrate: 100000,
          maxFramerate: config.frameRate || 30
        }
      ],
      rtcp: {
        cname: `viewbot-video-${timestamp}`,
        ssrc: Math.floor(Math.random() * 1000000000)
      }
    };
  } else if (kind === 'audio') {
    return {
      mid: '1001',  // Use high MID value to avoid conflicts with real users
      codecs: [
        {
          mimeType: 'audio/opus',
          payloadType: 111,
          clockRate: 48000,
          channels: 2,
          parameters: {
            'minptime': '10',
            'useinbandfec': '1'
          },
          rtcpFeedback: []
        }
      ],
      headerExtensions: [
        {
          uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
          id: 1
        },
        {
          uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
          id: 10
        }
      ],
      encodings: [
        {
          ssrc: Math.floor(Math.random() * 1000000000),
          maxBitrate: 128000
        }
      ],
      rtcp: {
        cname: `viewbot-audio-${timestamp}`,
        ssrc: Math.floor(Math.random() * 1000000000)
      }
    };
  } else {
    throw new Error(`Unsupported ViewBot media kind: ${kind}`);
  }
};

// Helper function to broadcast global cooldown to all users except current streamer
const broadcastGlobalCooldown = async (currentStreamerId) => {
  try {
    // Calculate remaining global cooldown for all users
    const globalCooldownSeconds = takeoverService.globalCooldownSeconds;
    
    console.log(`📡 COOLDOWN: Broadcasting global cooldown of ${globalCooldownSeconds}s to all users except ${currentStreamerId}`);
    
    // Broadcast to ALL connected sockets except the current streamer
    io.sockets.sockets.forEach((socket) => {
      if (socket.id !== currentStreamerId) {
        socket.emit('global-cooldown', { 
          cooldownRemaining: globalCooldownSeconds,
          reason: 'global_cooldown'
        });
      }
    });
  } catch (error) {
    console.error('❌ Failed to broadcast global cooldown:', error);
  }
};

// Animal names for random viewbot usernames (same as chat service)
const VIEWBOT_ANIMALS = [
  'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
  'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
  'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
  'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
  'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
];

// Cache for viewbot usernames (so they persist during stream)
const viewbotUsernameCache = new Map();
// Track which socket IDs belong to ViewBots
const viewbotSocketIds = new Set();

// Clean up viewbot username from cache
const cleanupViewbotUsername = (streamerId) => {
  if (viewbotUsernameCache.has(streamerId)) {
    const username = viewbotUsernameCache.get(streamerId);
    viewbotUsernameCache.delete(streamerId);
    console.log(`🧹 VIEWBOT: Cleaned up username "${username}" for viewbot stream ${streamerId}`);
  }
  // Also clean up socket ID tracking
  if (viewbotSocketIds.has(streamerId)) {
    viewbotSocketIds.delete(streamerId);
    console.log(`🧹 VIEWBOT: Removed socket ID ${streamerId} from ViewBot tracking`);
  }
};

// Generate random username for viewbot streams
const generateViewbotUsername = (streamerId) => {
  // Check if we already have a cached username for this exact streamer ID
  if (viewbotUsernameCache.has(streamerId)) {
    const cachedUsername = viewbotUsernameCache.get(streamerId);
    console.log(`🤖 VIEWBOT: Using cached username "${cachedUsername}" for viewbot stream ${streamerId}`);
    return cachedUsername;
  }
  
  // Generate a new random username
  const animal = VIEWBOT_ANIMALS[Math.floor(Math.random() * VIEWBOT_ANIMALS.length)];
  const number = Math.floor(Math.random() * 9999) + 1;
  const username = `${animal}${number}`;
  
  // Cache the username for this specific streamer ID
  viewbotUsernameCache.set(streamerId, username);
  
  const isSocketTracked = viewbotSocketIds.has(streamerId);
  console.log(`🤖 VIEWBOT: Generated fresh username "${username}" for ${isSocketTracked ? 'ViewBot socket' : 'viewbot stream'} ${streamerId}`);
  
  return username;
};

// Helper function to get streamer display name
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
          console.log(`🎲 STREAMER: Using random rotation display name "${currentStream.displayName}" for ${streamerId}`);
          return currentStream.displayName;
        }
      }

      // Fallback: Check ViewBotURLService for the display name
      if (global.viewBotURLService && global.viewBotURLService.activeStreams) {
        const streamEntry = global.viewBotURLService.activeStreams.get(streamerId);
        if (streamEntry && streamEntry.displayName) {
          console.log(`📺 STREAMER: Using URL stream display name "${streamEntry.displayName}" for ${streamerId}`);
          return streamEntry.displayName;
        }
      }

      // No display name found, use a generic fallback
      console.log(`⚠️ STREAMER: No display name found for URL stream ${streamerId}, using generic`);
      return 'Random Stream';
    }

    // Check if this is a viewbot stream (either by ViewbotService or by socket ID tracking)
    const isViewbotByService = viewbotService && viewbotService.isViewbotStream(streamerId);
    const isViewbotBySocketId = viewbotSocketIds.has(streamerId);

    if (isViewbotByService || isViewbotBySocketId) {
      console.log(`🤖 VIEWBOT: Detected viewbot stream ${streamerId} (service: ${isViewbotByService}, socketId: ${isViewbotBySocketId}), generating random username`);
      return generateViewbotUsername(streamerId);
    }

    const session = sessionService.getSessionBySocketId(streamerId);
    if (session) {
      if (session.userId) {
        // For authenticated users, try to get their username from the database
        try {
          console.log(`🔍 STREAMER: Looking up user ${session.userId} in database for streamer ${streamerId}`);
          console.log(`🔍 STREAMER: authService available:`, !!authService);
          console.log(`🔍 STREAMER: authService.accountService available:`, !!authService?.accountService);
          
          if (authService && authService.accountService) {
            const user = await authService.accountService.getUserById(session.userId);
            if (user && user.username) {
              console.log(`✅ STREAMER: Using authenticated username "${user.username}" for streamer ${streamerId}`);
              return user.username;
            } else {
              console.log(`❌ STREAMER: No user or username found in database for user ID ${session.userId}`);
            }
          } else {
            console.log(`❌ STREAMER: authService or accountService not available`);
          }
        } catch (dbError) {
          console.log('❌ STREAMER: Could not fetch user from database:', dbError.message);
        }
        // Fallback to chat username if available
        console.log(`📝 STREAMER: Using fallback for user ${session.userId}: ${session.chatUsername || `User-${streamerId.substring(0, 8)}`}`);
        return session.chatUsername || `User-${streamerId.substring(0, 8)}`;
      } else {
        // For anonymous users, check for chat username by IP
        const ip = session.ip;
        console.log(`🔍 STREAMER: Checking for chat username for anonymous streamer ${streamerId} (IP: ${ip})`);
        
        const chatInfo = sessionService.getChatUsername(ip);
        console.log(`🔍 STREAMER: Chat info from sessionService:`, chatInfo);
        
        if (chatInfo && chatInfo.username) {
          console.log(`👤 STREAMER: Using chat username "${chatInfo.username}" for anonymous streamer ${streamerId} (IP: ${ip})`);
          return chatInfo.username;
        }
        
        // Also check the session's chatUsername as fallback
        if (session.chatUsername) {
          console.log(`👤 STREAMER: Using session chat username "${session.chatUsername}" for anonymous streamer ${streamerId}`);
          return session.chatUsername;
        }
        
        console.log(`⚠️ STREAMER: No chat username found for anonymous streamer ${streamerId} (IP: ${ip})`);
      }
    }
    
    // Fallback to abbreviated socket ID
    console.log(`🔤 STREAMER: Using socket ID fallback for streamer ${streamerId}`);
    return `User-${streamerId.substring(0, 8)}`;
  } catch (error) {
    console.error('❌ STREAMER: Failed to get streamer display name:', error);
    return `User-${streamerId.substring(0, 8)}`;
  }
};

// Helper function to enrich stream status with streamer info
const enrichStreamStatus = async (status) => {
  const enriched = { ...status };
  console.log('🔍 ENRICH: Enriching stream status with streamerId:', status.streamerId);
  if (status.streamerId) {
    console.log('🔍 ENRICH: Getting streamer display name for:', status.streamerId);
    enriched.streamerDisplayName = await getStreamerDisplayName(status.streamerId);
    console.log('🔍 ENRICH: Got streamer display name:', enriched.streamerDisplayName);
  }
  return enriched;
};

// DEDUP: Track last emitted stream-ready to prevent duplicate emissions
let lastEmittedStreamReady = { streamerId: null, timestamp: 0 };

/**
 * Helper function to verify tracks and emit stream-ready
 * This ensures viewers don't try to consume streams before tracks are publishing
 * CRITICAL FIX: Prevents "black square" issues during stream switches
 */
const verifyAndEmitStreamReady = async (streamerId, streamData = {}) => {
  // DEDUP: Prevent duplicate stream-ready emissions within 2 seconds
  const now = Date.now();
  if (lastEmittedStreamReady.streamerId === streamerId &&
      (now - lastEmittedStreamReady.timestamp) < 2000) {
    console.log(`⏭️ STREAM-READY: Skipping duplicate emission for ${streamerId} (${now - lastEmittedStreamReady.timestamp}ms since last)`);
    return true; // Return true as if successful since we already emitted for this stream
  }
  console.log(`🔍 STREAM-READY: Verifying tracks for ${streamerId} before emitting...`);

  // Check if we're using LiveKit backend
  const isLiveKit = mediasoupService.isLiveKit && mediasoupService.isLiveKit();

  if (isLiveKit && mediasoupService.verifyParticipantTracks) {
    // For LiveKit, verify tracks are actually publishing
    try {
      const verification = await mediasoupService.verifyParticipantTracks(streamerId, {
        requireVideo: true,
        requireAudio: false,
        maxAttempts: 10,
        retryDelay: 500
      });

      if (!verification.verified) {
        console.error(`❌ STREAM-READY: Track verification failed for ${streamerId} after ${verification.attempt} attempts`);
        // Don't emit stream-ready - tracks aren't ready
        return false;
      }

      console.log(`✅ STREAM-READY: Tracks verified for ${streamerId} (video: ${verification.hasVideo}, audio: ${verification.hasAudio}) after ${verification.attempt} attempts`);

      // Emit stream-ready with verified track info
      const streamerDisplayName = await getStreamerDisplayName(streamerId);
      const emitTimestamp = Date.now();
      io.emit('stream-ready', {
        streamerId,
        newStreamId: streamerId,
        isWebRTC: true,
        hasVideo: verification.hasVideo,
        hasAudio: verification.hasAudio,
        producerVerified: true,
        trackCount: verification.trackCount,
        timestamp: emitTimestamp,
        streamerDisplayName,
        ...streamData
      });

      // DEDUP: Track this emission
      lastEmittedStreamReady = { streamerId, timestamp: emitTimestamp };
      console.log(`📡 STREAM-READY: Emitted verified stream-ready for ${streamerId}`);
      return true;

    } catch (error) {
      console.error(`❌ STREAM-READY: Error verifying tracks for ${streamerId}:`, error);
      // Don't emit stream-ready on error
      return false;
    }
  } else {
    // For MediaSoup or when verification isn't available, emit immediately
    // MediaSoup producers are synchronous, so they're ready when created
    const streamerDisplayName = await getStreamerDisplayName(streamerId);
    const emitTimestamp = Date.now();
    io.emit('stream-ready', {
      streamerId,
      newStreamId: streamerId,
      isWebRTC: true,
      producerVerified: true,
      timestamp: emitTimestamp,
      streamerDisplayName,
      ...streamData
    });

    // DEDUP: Track this emission
    lastEmittedStreamReady = { streamerId, timestamp: emitTimestamp };
    console.log(`📡 STREAM-READY: Emitted stream-ready for ${streamerId} (MediaSoup/no verification needed)`);
    return true;
  }
};

app.get('/', (req, res) => {
  res.json({ 
    message: 'OneStreamer API Server', 
    version: '1.0.0',
    endpoints: {
      health: '/health',
      streamStatus: '/api/stream/status',
      frontend: process.env.CLIENT_URL || 'https://onestreamer.live:3443'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/stream/status', (req, res) => {
  const status = streamService.getStreamStatus();
  const mediaInfo = mediaStreamService.getStreamInfo();
  
  // Add MediaSoup producer info if available
  let producerInfo = null;
  if (mediasoupService.currentStreamer) {
    const producers = mediasoupService.producers.get(mediasoupService.currentStreamer);
    if (producers) {
      producerInfo = {
        videoProducerId: producers.get('video')?.id || null,
        audioProducerId: producers.get('audio')?.id || null
      };
    }
  }
  
  res.json({
    ...status,
    mediaStream: mediaInfo,
    producers: producerInfo
  });
});

// Simple Media Ingestion API (temporary mock)
app.post('/api/media/start-ingestion', async (req, res) => {
  const { streamerId } = req.body;
  
  if (!streamerId) {
    return res.status(400).json({ error: 'streamerId is required' });
  }
  
  try {
    const result = await mediaStreamService.startIngestion(streamerId);
    res.json(result);
  } catch (error) {
    console.error('Media ingestion start failed:', error);
    res.status(500).json({ error: 'Failed to start media ingestion' });
  }
});

app.post('/api/media/stop-ingestion', (req, res) => {
  mediaStreamService.stopIngestion();
  res.json({ success: true });
});

app.get('/api/media/info', (req, res) => {
  const info = mediaStreamService.getStreamInfo();
  res.json(info);
});

// Mediasoup API routes
app.get('/api/mediasoup/router-capabilities', async (req, res) => {
  try {
    // CRITICAL iOS FIX: Use optimized method that handles iOS-specific codec filtering
    const preferH264 = req.query.preferH264 === 'true';
    const rtpCapabilities = await mediasoupService.getRouterRtpCapabilities(preferH264);

    if (preferH264) {
      console.log('📱 MEDIASOUP: Sent iOS-optimized RTP capabilities (H264 Baseline only)');
    }

    res.json({ rtpCapabilities });
  } catch (error) {
    console.error('❌ Failed to get router capabilities:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mediasoup/create-transport', async (req, res) => {
  try {
    const { socketId, isMobile } = req.body;
    console.log(`📡 API: Creating transport for ${socketId} (mobile: ${isMobile}) (current streamer: ${mediasoupService.getCurrentStreamer()})`);
    const transportOptions = await mediasoupService.createWebRtcTransport(socketId, isMobile);
    console.log(`✅ API: Transport created successfully for ${socketId}`);
    res.json(transportOptions);
  } catch (error) {
    console.error(`❌ API: Failed to create transport for ${socketId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mediasoup/connect-transport', async (req, res) => {
  try {
    const { socketId, dtlsParameters } = req.body;
    await mediasoupService.connectTransport(socketId, dtlsParameters);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Failed to connect transport:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mediasoup/produce', async (req, res) => {
  try {
    const { socketId, kind, rtpParameters, appData } = req.body;
    
    // Comprehensive logging for debugging MID issues
    console.log('=== PRODUCE REQUEST DEBUG ===');
    console.log(`📡 MEDIASOUP: Produce request from ${socketId} for ${kind}`);
    console.log('RTP Parameters MID:', rtpParameters?.mid);
    console.log('RTP Codecs:', JSON.stringify(rtpParameters?.codecs?.map(c => ({ mimeType: c.mimeType, payloadType: c.payloadType })), null, 2));
    console.log('Socket ID:', socketId);
    console.log('Kind:', kind);
    console.log('App Data:', JSON.stringify(appData, null, 2));
    
    // Log current router state
    try {
      const router = mediasoupService.getRouter();
      if (router && router._producers) {
        console.log('ROUTER - Active producers:', router._producers.size);
        let midConflict = false;
        router._producers.forEach((producer, id) => {
          const producerMid = producer.rtpParameters?.mid;
          console.log(`  Producer ${id}: MID=${producerMid}, kind=${producer.kind}, closed=${producer.closed}`);
          if (producerMid === rtpParameters?.mid && !producer.closed) {
            console.error(`⚠️ MID CONFLICT DETECTED! MID ${producerMid} already taken by producer ${id}`);
            midConflict = true;
          }
        });
        
        // Emergency MID override for real users if conflict detected
        if (midConflict && rtpParameters?.mid === '0') {
          const newMid = '100';  // Use different range for real users
          console.log(`🔄 OVERRIDING MID from ${rtpParameters.mid} to ${newMid} to avoid conflict`);
          rtpParameters.mid = newMid;
        }
      }
    } catch (routerError) {
      console.error('Could not inspect router state:', routerError.message);
    }
    
    if (!socketId || !kind || !rtpParameters) {
      console.error('Missing required parameters:', { socketId: !!socketId, kind: !!kind, rtpParameters: !!rtpParameters });
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    console.log('Calling mediasoupService.produce with MID:', rtpParameters.mid);
    const producerId = await mediasoupService.produce(socketId, kind, rtpParameters, appData);
    console.log(`✅ MEDIASOUP: Producer created for ${socketId}: ${producerId} with MID ${rtpParameters.mid}`);
    
    res.json({ success: true, producerId });
  } catch (error) {
    console.error('❌ MEDIASOUP: Failed to produce:', error);
    console.error('Full error stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mediasoup/consume', async (req, res) => {
  try {
    const { socketId, producerId, rtpCapabilities } = req.body;
    console.log(`📡 MEDIASOUP: Consume request from ${socketId} for producer ${producerId}`);
    
    if (!socketId || !producerId || !rtpCapabilities) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const consumer = await mediasoupService.consume(socketId, producerId, rtpCapabilities);
    
    if (!consumer) {
      return res.status(404).json({ error: 'Producer not found or cannot consume' });
    }
    
    console.log(`✅ MEDIASOUP: Consumer created for ${socketId}: ${consumer.id}`);
    
    res.json({ 
      success: true,
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    });
  } catch (error) {
    console.error('❌ MEDIASOUP: Failed to consume:', error);
    res.status(500).json({ error: error.message });
  }
});

// ICE restart endpoint for handling network changes (WiFi to 5G, etc)
app.post('/api/mediasoup/restart-ice', async (req, res) => {
  try {
    const { socketId, transportId } = req.body;
    
    if (!socketId || !transportId) {
      return res.status(400).json({ error: 'Socket ID and Transport ID required' });
    }
    
    const iceParameters = await mediasoupService.restartTransportIce(socketId, transportId);
    console.log(`🔄 ICE restart for ${socketId}`);
    res.json({ success: true, iceParameters });
  } catch (error) {
    console.error('❌ ICE restart failed:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mediasoup/stats', (req, res) => {
  const stats = mediasoupService.getStats();
  res.json(stats);
});

// WebRTC Backend Management Endpoints (only when adapter is enabled)
app.get('/api/webrtc/backend', (req, res) => {
  if (!usingAdapter) {
    return res.json({
      backend: 'mediasoup',
      adapterEnabled: false,
      message: 'Backend switching not available. Set USE_WEBRTC_ADAPTER=true to enable.'
    });
  }
  
  const adapter = global.webrtcAdapter;
  res.json({
    backend: adapter.getBackendType(),
    adapterEnabled: true,
    info: adapter.getBackendInfo(),
    stats: mediasoupService.getStats()
  });
});

// Admin endpoint to check backend configuration
app.get('/api/admin/webrtc/config', (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const correctKey = process.env.ADMIN_KEY || '***REMOVED-ADMIN-KEY***';
  
  if (adminKey !== correctKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    adapterEnabled: usingAdapter,
    currentBackend: usingAdapter ? global.webrtcAdapter.getBackendType() : 'mediasoup',
    availableBackends: ['mediasoup', 'livekit'],
    environmentVariables: {
      USE_WEBRTC_ADAPTER: process.env.USE_WEBRTC_ADAPTER || 'false',
      WEBRTC_BACKEND: process.env.WEBRTC_BACKEND || 'mediasoup'
    }
  });
});

// LiveKit Token endpoint (for testing)
app.get('/api/livekit/token', async (req, res) => {
  if (!usingAdapter || !global.webrtcAdapter || global.webrtcAdapter.getBackendType() !== 'livekit') {
    return res.status(400).json({ 
      error: 'LiveKit backend not active',
      hint: 'Enable with: USE_WEBRTC_ADAPTER=true WEBRTC_BACKEND=livekit'
    });
  }
  
  const identity = req.query.identity || `user-${Date.now()}`;
  const roomName = req.query.room || 'onestreamer-main';
  
  try {
    // Get the LiveKit service through the adapter's backend
    const livekitService = global.webrtcAdapter._backend;
    const token = await livekitService.generateToken(identity, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });
    
    // Generate TURN credentials for clients behind NAT (especially iOS Safari)
    const turnCreds = generateTurnCredentials(identity);

    res.json({
      token: token,
      url: livekitService.config.wsUrl,
      roomName: roomName,
      identity: identity,
      turnServers: {
        // CRITICAL: Use direct IP to bypass Cloudflare proxy (doesn't forward TURN/UDP)
        urls: [
          'stun:<SERVER_IP>:3478',
          'turn:<SERVER_IP>:3478?transport=udp',
          'turn:<SERVER_IP>:3478?transport=tcp',
          'turns:<SERVER_IP>:5349?transport=tcp'
        ],
        username: turnCreds.username,
        credential: turnCreds.credential,
        ttl: turnCreds.ttl
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import JWT admin authentication middleware
const { authenticateAdmin, authenticateModerator } = require('./middleware/auth');
// AuthService already imported at the top of the file

// Simple admin auth middleware (kept for legacy endpoints that might need admin key)
const adminKeyAuth = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const correctKey = process.env.ADMIN_KEY || '***REMOVED-ADMIN-KEY***';
  
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
        console.error('Error fetching emojis:', error);
        res.status(500).json({ error: 'Failed to fetch emojis' });
    }
});

// Chat Moderation API endpoints
app.get('/api/admin/moderation', authenticateModerator, async (req, res) => {
    try {
        // Send a request to the chat service to get moderation data
        const chatServiceUrl = `${process.env.CHAT_SERVICE_URL || 'https://onestreamer.live:8444'}/api/moderation`;
        console.log(`📊 MAIN SERVER: Fetching moderation data from ${chatServiceUrl}`);
        
        const response = await axios.get(chatServiceUrl, { timeout: 5000 });
        
        console.log(`📊 MAIN SERVER: Received moderation data:`, response.data);
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching moderation data:', error.message);
        console.error('Full error:', error);
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
        console.error('Error banning user:', error);
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
        console.error('Error unbanning user:', error);
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
        console.error('Error timing out user:', error);
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
        console.error('Error removing timeout:', error);
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
        console.error('Error fetching admin emojis:', error);
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
                console.log('Re-encoding AVIF file for Safari compatibility:', req.file.filename);
                
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
                    console.log('Successfully re-encoded AVIF for Safari compatibility');
                }
                
                // Clean up temp files
                if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng);
                if (fs.existsSync(tempAvif)) fs.unlinkSync(tempAvif);
            } else {
                // Convert PNG/JPG/GIF/WebP to Safari-compatible AVIF
                console.log('Converting', fileExt, 'to Safari-compatible AVIF:', req.file.filename);
                
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
                    console.log('Successfully converted to Safari-compatible AVIF');
                } else {
                    // Clean up temp PNG if it was created for GIF
                    if (fileExt === '.gif' && sourceFile !== req.file.path) {
                        fs.unlinkSync(sourceFile);
                    }
                    console.log('Warning: AVIF conversion failed, using original file');
                }
            }
        } catch (conversionError) {
            console.error('Warning: Image conversion failed, using original file:', conversionError.message);
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
        console.error('Error uploading emoji:', error);
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
        console.error('Error updating emoji:', error);
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
        console.error('Error deleting emoji:', error);
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
        console.error('Error tracking emoji usage:', error);
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
        
        console.log(`🎨 Saved chat color ${color} for user ${userId}`);
        res.json({ success: true, color });
    } catch (error) {
        console.error('Error saving chat color:', error);
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
        console.error('Error fetching chat color:', error);
        res.status(500).json({ error: 'Failed to fetch chat color' });
    }
});

// Fallback auth middleware for ViewBot endpoints - try JWT first, then admin key
const viewBotAuth = (req, res, next) => {
  console.log('🔐 ViewBot Auth - Request path:', req.path);
  console.log('🔐 ViewBot Auth - Headers:', {
    'x-admin-key': req.headers['x-admin-key'],
    'authorization': req.headers['authorization'],
    'admin_key_query': req.query.admin_key
  });
  
  // Check for admin key first (simpler auth for ViewBot operations)
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  const correctKey = process.env.ADMIN_KEY || '***REMOVED-ADMIN-KEY***';
  
  console.log('🔐 ViewBot Auth - Admin key check:', { 
    provided: adminKey, 
    expected: correctKey,
    matches: adminKey === correctKey 
  });
  
  if (adminKey === correctKey) {
    console.log('✅ ViewBot: Using admin key authentication');
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
      console.log('✅ ViewBot: Using JWT authentication');
      req.user = decoded;
      return next();
    }
  }
  
  console.log('❌ ViewBot: Authentication failed - no valid JWT or admin key');
  return res.status(401).json({ 
    error: 'Authentication required for ViewBot operations',
    details: 'Provide either x-admin-key header or valid JWT token'
  });
};

// Admin API Routes
app.get('/admin/dashboard', authenticateAdmin, async (req, res) => {
  try {
    console.log('🔍 Dashboard request received');
    console.log('🔍 viewBotClientService exists:', !!viewBotClientService);
    
    // Get ViewBot system data with error handling
    let viewBotData = null;
    let viewBotHealth = null;
    
    try {
      if (viewBotClientService) {
        console.log('🔍 Getting ViewBot data...');
        viewBotData = await viewBotClientService.getAllBotsStatus();
        viewBotHealth = viewBotClientService.getHealthStatus();
        console.log('🔍 ViewBot data retrieved:', { totalBots: viewBotData?.totalBots, rotationEnabled: viewBotHealth?.rotationEnabled });
      } else {
        console.log('⚠️ ViewBotClientService not initialized');
      }
    } catch (error) {
      console.error('❌ ViewBot service error:', error);
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
    console.error('❌ ADMIN: Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

app.post('/admin/viewbot/start', adminKeyAuth, async (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const result = await viewbotService.startViewbot(req.body);
  
  if (result.success) {
    // Set viewbot as the active streamer
    streamService.setStreamer(result.streamId, 'viewbot');
    
    // Create synthetic user ID for viewbot to enable buff/debuff support
    const syntheticUserId = -Math.abs(result.streamId.hashCode ? result.streamId.hashCode() : result.streamId.split('-')[1].slice(0, 8).split('').reduce((a, b) => (a * 31 + b.charCodeAt(0)) & 0x7fffffff, 0));
    console.log(`🎭 BUFF: Created synthetic user ID ${syntheticUserId} for viewbot ${result.streamId}`);
    
    // Link synthetic user ID to viewbot socket ID for buff system compatibility
    sessionService.linkUserToSocket(result.streamId, syntheticUserId);
    console.log(`🎭 BUFF: Linked viewbot ${result.streamId} to synthetic user ${syntheticUserId} for buff system`);
    
    io.emit('new-streamer', { 
      streamerId: result.streamId, 
      newStreamId: result.streamId,
      isViewbot: true, 
      hasRealStream: result.hasRealStream,
      streamType: 'viewbot' 
    });
    io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
    
    // Broadcast global cooldown to all users
    await broadcastGlobalCooldown(result.streamId);
  }
  
  res.json(result);
});

// Test stream endpoint - client-side pattern generation approach
app.post('/admin/test-stream/start', adminKeyAuth, async (req, res) => {
  console.log('🧪 TEST: Starting client-side test pattern stream');
  
  const result = testStreamService.startTestStream(req.body);
  
  if (result.success) {
    // Set test stream as the active streamer
    streamService.setStreamer(result.streamId, 'test');
    
    console.log('🧪 TEST: Test stream started, notifying viewers to generate client-side pattern');
    
    // Instead of creating fake MediaSoup producers, signal viewers to generate test pattern
    io.emit('test-pattern-stream', { 
      streamerId: result.streamId, 
      newStreamId: result.streamId,
      isTestStream: true, 
      hasRealStream: false, // No real MediaSoup stream
      streamType: 'test-pattern',
      testConfig: {
        pattern: req.body.content || 'color-bars',
        resolution: `${req.body.width || 1280}x${req.body.height || 720}`,
        frameRate: req.body.frameRate || 30
      }
    });
    io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
    
    // Broadcast global cooldown to all users
    await broadcastGlobalCooldown(result.streamId);
  }
  
  res.json({
    success: result.success,
    message: result.success ? 'Test pattern stream started (client-side generation)' : result.message,
    streamId: result.streamId,
    isTestStream: true,
    hasRealStream: false, // Indicate this is a client-generated pattern
    streamType: 'test-pattern'
  });
});

app.post('/admin/viewbot/stop', adminKeyAuth, async (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const result = await viewbotService.stopViewbot();
  
  if (result.success) {
    // Clean up viewbot username cache
    cleanupViewbotUsername(result.streamId);
    
    // Clean up synthetic user mapping for viewbot
    sessionService.linkUserToSocket(result.streamId, null);
    console.log(`🎭 BUFF: Cleaned up synthetic user mapping for stopped viewbot ${result.streamId}`);
    
    // Clear the viewbot from active streamer
    if (streamService.getCurrentStreamer() === result.streamId) {
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;
      console.log(`🧹 VIEWBOT STOP: Cleared ${result.streamId} from both services`);
      
      // Clear streamer buff display when viewbot streaming ends
      console.log(`🎭 BUFF: Clearing streamer buffs display (viewbot ended)`);
      io.emit('streamer-buffs-update', { buffs: [] });
      
      io.emit('stream-ended', { reason: 'viewbot_stopped' });
      notifyViewersStreamEnded();
      notifyViewersStreamEnded();
      io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
    }
  }

  res.json(result);
});

app.post('/admin/test-stream/stop', adminKeyAuth, async (req, res) => {
  console.log('🧪 LEGACY TEST: Stopping test stream');
  
  // Try to stop ViewbotService first (if it was used for the test stream)
  if (viewbotService) {
    const currentStreamer = streamService.getCurrentStreamer();
    if (currentStreamer && viewbotService.isViewbotStream(currentStreamer)) {
      console.log('🧪 LEGACY TEST: Stopping ViewbotService test stream');
      const viewbotResult = await viewbotService.stopViewbot();
      
      if (viewbotResult.success) {
        // Clean up viewbot username cache
        cleanupViewbotUsername(viewbotResult.streamId);
        
        // Clean up synthetic user mapping for viewbot
        sessionService.linkUserToSocket(viewbotResult.streamId, null);
        console.log(`🎭 BUFF: Cleaned up synthetic user mapping for legacy stopped viewbot ${viewbotResult.streamId}`);
        
        if (streamService.getCurrentStreamer() === viewbotResult.streamId) {
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
          console.log(`🧹 VIEWBOT LEGACY STOP: Cleared ${viewbotResult.streamId} from both services`);
          
          // Clear streamer buff display when viewbot streaming ends
          console.log(`🎭 BUFF: Clearing streamer buffs display (viewbot legacy ended)`);
          io.emit('streamer-buffs-update', { buffs: [] });
          
          io.emit('stream-ended', { reason: 'viewbot_legacy_stopped' });
      notifyViewersStreamEnded();
          io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
        }
      }

      return res.json({
        success: viewbotResult.success,
        message: 'Test stream (ViewbotService) stopped',
        streamId: viewbotResult.streamId
      });
    }
  }

  // Fallback to legacy test stream service
  const result = testStreamService.stopTestStream();

  if (result.success) {
    // Clear the test stream from active streamer
    if (streamService.getCurrentStreamer() === result.streamId) {
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;
      console.log(`🧹 TEST STREAM STOP: Cleared ${result.streamId} from both services`);

      // Also stop media ingestion
      mediaStreamService.stopIngestion();

      io.emit('stream-ended', { reason: 'test_stream_stopped' });
      notifyViewersStreamEnded();
      notifyViewersStreamEnded();
      io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
    }
  }
  
  res.json(result);
});

app.get('/admin/viewbot/status', adminKeyAuth, (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const status = viewbotService.getViewbotStatus();
  const metrics = viewbotService.getViewbotMetrics();
  const health = viewbotService.isHealthy();
  res.json({ status, metrics, health });
});

app.get('/admin/test-stream/status', adminKeyAuth, (req, res) => {
  const status = testStreamService.getTestStreamStatus();
  const metrics = testStreamService.getTestStreamMetrics();
  res.json({ status, metrics });
});

app.post('/admin/viewbot/config', adminKeyAuth, (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const result = viewbotService.updateViewbotConfig(req.body);
  res.json(result);
});

app.post('/admin/test-stream/config', adminKeyAuth, (req, res) => {
  const result = testStreamService.updateTestStreamConfig(req.body);
  res.json(result);
});

// Additional viewbot management endpoints
app.post('/admin/viewbot/spawn', adminKeyAuth, async (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const result = await viewbotService.spawnAdditionalViewbot(req.body);
  res.json(result);
});

app.delete('/admin/viewbot/:viewbotId', adminKeyAuth, async (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const { viewbotId } = req.params;
  const result = await viewbotService.removeViewbot(viewbotId);
  res.json(result);
});

app.get('/admin/viewbot/health', adminKeyAuth, (req, res) => {
  if (!viewbotService) {
    return res.status(503).json({ error: 'ViewbotService not initialized' });
  }
  
  const health = viewbotService.isHealthy();
  res.json(health);
});

// ViewBotWebRTCService endpoints (for mobile 5G/TURN support)
// ViewBotManager mode toggle endpoint
app.post('/admin/viewbot-manager/toggle-mode', viewBotAuth, async (req, res) => {
  if (!global.viewBotManager) {
    return res.status(503).json({ error: 'ViewBot Manager not initialized' });
  }
  
  try {
    const { useWebRTC } = req.body;
    const result = await global.viewBotManager.toggleMode(useWebRTC);
    res.json(result);
  } catch (error) {
    console.error('Error toggling viewbot mode:', error);
    res.status(500).json({ error: 'Failed to toggle mode' });
  }
});

app.post('/admin/viewbot-webrtc/create', viewBotAuth, async (req, res) => {
  if (!viewBotWebRTCService) {
    return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
  }
  
  const config = req.body.config || req.body;
  config.useWebRTC = true; // Force WebRTC for TURN support
  
  const result = await viewBotWebRTCService.createViewBot(config);
  res.json(result);
});

app.post('/admin/viewbot-webrtc/:botId/start', viewBotAuth, async (req, res) => {
  if (!viewBotWebRTCService) {
    return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
  }
  
  const { botId } = req.params;
  const result = await viewBotWebRTCService.startViewBot(botId);
  res.json(result);
});

app.post('/admin/viewbot-webrtc/:botId/stop', viewBotAuth, async (req, res) => {
  if (!viewBotWebRTCService) {
    return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
  }
  
  const { botId } = req.params;
  const result = await viewBotWebRTCService.stopViewBot(botId);
  res.json(result);
});

app.get('/admin/viewbot-webrtc/status', viewBotAuth, async (req, res) => {
  if (!viewBotWebRTCService) {
    return res.status(503).json({ error: 'ViewBotWebRTCService not initialized' });
  }
  
  const status = viewBotWebRTCService.listViewBots();
  res.json({ viewbots: status });
});

// ViewBotClientService endpoints
app.post('/admin/viewbot-client/create', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  // Handle both config formats:
  // 1. { config: { contentType: 'videoFile', ... } } - nested format  
  // 2. { contentType: 'videoFile', autoStart: true, ... } - flat format from UI
  const config = req.body.config || req.body;
  
  const result = await viewBotClientService.createBot(config);
  res.json(result);
});

app.post('/admin/viewbot-client/create-streamer', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  // Handle both config formats:
  // 1. { config: { contentType: 'videoFile', ... } } - nested format
  // 2. { contentType: 'videoFile', autoStart: true, ... } - flat format from UI
  const config = req.body.config || req.body;
  
  console.log('📋 SERVER: Creating ViewBot with config:', JSON.stringify(config, null, 2));
  
  const result = await viewBotClientService.createStreamerBot(config);
  res.json(result);
});

app.post('/admin/viewbot-client/:botId/start', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { botId } = req.params;
  console.log(`📡 API: Starting ViewBot ${botId} via HTTP endpoint`);
  const result = await viewBotClientService.startBotStreaming(botId);
  console.log(`📡 API: ViewBot ${botId} start result:`, result);
  res.json(result);
});

app.post('/admin/viewbot-client/:botId/stop', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { botId } = req.params;
  const result = await viewBotClientService.stopBotStreaming(botId);
  res.json(result);
});

// Destroy all ViewBots (must come before /:botId route)
app.delete('/admin/viewbot-client/all', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const result = await viewBotClientService.destroyAllBots();
  res.json(result);
});

// Destroy specific ViewBot
app.delete('/admin/viewbot-client/:botId', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { botId } = req.params;
  const result = await viewBotClientService.destroyBot(botId);
  res.json(result);
});

app.get('/admin/viewbot-client/status', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  try {
    const status = await viewBotClientService.getAllBotsStatus();
    res.json(status);
  } catch (error) {
    console.error('Failed to get ViewBot status:', error);
    res.status(500).json({ error: 'Failed to get ViewBot status' });
  }
});

app.get('/admin/viewbot-client/:botId/status', authenticateAdmin, (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { botId } = req.params;
  const status = viewBotClientService.getBotStatus(botId);
  res.json(status);
});

app.put('/admin/viewbot-client/:botId/config', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { botId } = req.params;
  const result = await viewBotClientService.updateBotConfig(botId, req.body);
  res.json(result);
});

app.put('/admin/viewbot-client/:botId/name', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { botId } = req.params;
  const { name } = req.body;
  
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Valid name is required' });
  }
  
  try {
    const result = await viewBotClientService.updateBotName(botId, name.trim());
    res.json(result);
  } catch (error) {
    console.error(`Failed to update ViewBot name for ${botId}:`, error);
    res.status(500).json({ error: 'Failed to update ViewBot name' });
  }
});

// Video upload endpoint for ViewBot
app.post('/admin/viewbot-client/upload-video', viewBotAuth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    // Return the absolute file path where the file is actually stored
    const filePath = path.join(uploadsDir, req.file.filename);
    
    console.log('ViewBot video uploaded:', {
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      path: filePath,
      absolutePath: filePath
    });

    res.json({ 
      success: true, 
      filePath: filePath,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    console.error('Error uploading ViewBot video:', error);
    res.status(500).json({ error: 'Failed to upload video file' });
  }
});

app.get('/admin/viewbot-client/health', viewBotAuth, (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  // Validate real streamer status before returning health data
  viewBotClientService.validateRealStreamerStatus();
  
  const health = viewBotClientService.getHealthStatus();
  res.json(health);
});

// ViewBot Diagnostics Routes (mounted on specific path to avoid conflicts)
const viewBotDiagnostics = require('./routes/viewbot-diagnostics');
app.use('/admin/viewbot-diagnostics', viewBotDiagnostics);

// ViewBot Rotation System Endpoints
app.post('/admin/viewbot-client/rotation/toggle', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  
  try {
    const result = await viewBotClientService.toggleRotation(enabled);
    res.json(result);
  } catch (error) {
    console.error('Error toggling ViewBot rotation:', error);
    res.status(500).json({ error: 'Failed to toggle rotation system' });
  }
});

app.post('/admin/viewbot-client/real-streamer-status', viewBotAuth, (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'isActive must be a boolean' });
  }
  
  // Run validation before setting status to ensure consistency
  viewBotClientService.validateRealStreamerStatus();
  
  const result = viewBotClientService.setRealStreamerStatus(isActive);
  res.json(result);
});

// Temporary debug endpoint without auth
app.get('/debug/rotation-status', (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const status = viewBotClientService.getRotationStatus();
  
  // Add debug info
  if (status.currentLiveBot && viewBotClientService.activeBots) {
    const currentBot = viewBotClientService.activeBots.get(status.currentLiveBot);
    if (currentBot) {
      status.debug = {
        botExists: true,
        streaming: currentBot.streaming,
        timeAllotment: currentBot.timeAllotment,
        timeRemaining: currentBot.timeRemaining,
        hasTimer: !!currentBot.allotmentTimer
      };
    } else {
      status.debug = { botExists: false, currentLiveBot: status.currentLiveBot };
    }
  }
  
  res.json(status);
});

// Test endpoint with simple auth check
app.get('/admin/test-rotation-auth', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  console.log('🔍 Test rotation auth - admin key:', adminKey);
  if (adminKey === '***REMOVED-ADMIN-KEY***') {
    if (!viewBotClientService) {
      return res.status(503).json({ error: 'ViewBotClientService not initialized' });
    }
    const status = viewBotClientService.getRotationStatus();
    return res.json({ success: true, status });
  }
  return res.status(401).json({ error: 'Admin key required' });
});

app.get('/admin/viewbot-client/rotation/status', viewBotAuth, (req, res) => {
  console.log('📊 Rotation status endpoint hit');
  
  if (!viewBotClientService) {
    console.log('❌ ViewBotClientService not initialized');
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const status = viewBotClientService.getRotationStatus();
  console.log('📊 Rotation status:', JSON.stringify(status));
  
  // Add debug info to help diagnose the issue
  if (status.currentLiveBot && viewBotClientService.activeBots) {
    const currentBot = viewBotClientService.activeBots.get(status.currentLiveBot);
    if (currentBot) {
      status.debug = {
        botExists: true,
        streaming: currentBot.streaming,
        timeAllotment: currentBot.timeAllotment,
        timeRemaining: currentBot.timeRemaining,
        hasTimer: !!currentBot.allotmentTimer
      };
    } else {
      status.debug = { botExists: false, currentLiveBot: status.currentLiveBot };
    }
  }
  
  res.json(status);
});

app.post('/admin/viewbot-client/rotation/probability', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { probability } = req.body;
  const result = viewBotClientService.updateRotationProbability(probability);
  res.json(result);
});

app.post('/admin/viewbot-client/rotation/interval', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { minInterval, maxInterval } = req.body;
  const result = viewBotClientService.updateRotationInterval(minInterval, maxInterval);
  res.json(result);
});

app.post('/admin/viewbot-client/rotation/force', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  // Use the new forceRotation method
  const result = await viewBotClientService.forceRotation();
  res.json(result);
});

// ViewBot Rotation endpoints (new Socket.IO-based system)
app.get('/admin/simple-rotation/status', viewBotAuth, (req, res) => {
  // Use new rotation service
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  res.json(global.viewBotRotation.getStatus());
});

app.post('/admin/simple-rotation/start', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  await global.viewBotRotation.startRotation();
  res.json({ success: true, message: 'ViewBot rotation started' });
});

app.post('/admin/simple-rotation/stop', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  await global.viewBotRotation.stopRotation();
  res.json({ success: true, message: 'ViewBot rotation stopped' });
});

app.post('/admin/simple-rotation/force', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  await global.viewBotRotation.forceRotation();
  res.json({ success: true, message: 'Rotation forced' });
});

app.post('/admin/simple-rotation/settings', viewBotAuth, (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  global.viewBotRotation.updateSettings(req.body);
  res.json({ success: true, settings: global.viewBotRotation.settings });
});

// Modern ViewBot rotation endpoints (used by UI)
app.get('/admin/viewbot/rotation/status', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  const status = global.viewBotRotation.getStatus();
  
  // Add port monitor status if available
  let portStatus = null;
  if (global.portMonitor) {
    portStatus = await global.portMonitor.getStatus();
  }
  
  res.json({ 
    success: true, 
    status: {
      ...status,
      totalVideos: global.viewBotRotation.bots.length,
      nextRotationIn: 60000, // Placeholder
      portMonitor: portStatus
    }
  });
});

app.post('/admin/viewbot/rotation/force', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  await global.viewBotRotation.forceRotation();
  res.json({ success: true, message: 'Forced rotation to next video' });
});

app.post('/admin/viewbot/rotation/enable', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  await global.viewBotRotation.startRotation();
  res.json({ success: true, message: 'ViewBot rotation enabled' });
});

app.post('/admin/viewbot/rotation/disable', viewBotAuth, async (req, res) => {
  if (!global.viewBotRotation) {
    return res.status(503).json({ error: 'ViewBot rotation not initialized' });
  }
  await global.viewBotRotation.stopRotation();
  res.json({ success: true, message: 'ViewBot rotation disabled' });
});

app.post('/admin/viewbot-client/rotation/manual-takeover', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  // Manually trigger a ViewBot takeover (useful when automatic takeover fails)
  const result = await viewBotClientService.manualTriggerTakeover();
  res.json(result);
});

// Debug endpoint to simulate real streamer connect/disconnect
app.post('/admin/viewbot-client/debug/simulate-streamer', viewBotAuth, (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { action } = req.body; // 'connect' or 'disconnect'
  
  if (action === 'connect') {
    console.log('🔧 DEBUG: Simulating real streamer connect');
    viewBotClientService.setRealStreamerStatus(true);
    res.json({ success: true, message: 'Simulated real streamer connect', realStreamerActive: true });
  } else if (action === 'disconnect') {
    console.log('🔧 DEBUG: Simulating real streamer disconnect');
    viewBotClientService.setRealStreamerStatus(false);
    res.json({ success: true, message: 'Simulated real streamer disconnect', realStreamerActive: false });
  } else {
    res.status(400).json({ error: 'Invalid action. Use "connect" or "disconnect"' });
  }
});

// Debug endpoint to manually trigger presence maintenance
app.post('/admin/viewbot-client/debug/check-presence', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  console.log('🔧 DEBUG: Manually triggering presence check');
  await viewBotClientService.maintainViewBotPresence();
  
  const status = viewBotClientService.getRotationStatus();
  res.json({ 
    success: true, 
    message: 'Presence check completed',
    currentStatus: status
  });
});

// Debug endpoint to clear stuck real streamer status
app.post('/admin/viewbot-client/debug/clear-real-streamer', viewBotAuth, (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  try {
    // Force clear real streamer status and validate
    console.log('🔧 DEBUG: Manually clearing real streamer status');
    viewBotClientService.setRealStreamerStatus(false);
    viewBotClientService.validateRealStreamerStatus();
    
    const currentStreamer = streamService.getCurrentStreamer();
    console.log(`🔧 DEBUG: Current streamer: ${currentStreamer || 'None'}`);
    
    if (currentStreamer) {
      // Enhanced ViewBot detection for debug
      const isOldViewBot = viewbotService && viewbotService.isViewbotStream(currentStreamer);
      const userId = sessionService.getUserIdBySocketId(currentStreamer);
      const isNewViewBot = userId && userId < 0;
      const isViewbot = isOldViewBot || isNewViewBot;
      
      console.log(`🔧 DEBUG: Current streamer analysis:`);
      console.log(`   Socket: ${currentStreamer}`);
      console.log(`   User ID: ${userId}`);
      console.log(`   Old ViewBot: ${isOldViewBot}`);
      console.log(`   New ViewBot: ${isNewViewBot}`);
      console.log(`   Is ViewBot: ${isViewbot}`);
    }
    
    res.json({ 
      success: true, 
      message: 'Real streamer status cleared and validated',
      currentStreamer: currentStreamer,
      realStreamerActive: viewBotClientService.realStreamerActive
    });
  } catch (error) {
    console.error('Error clearing real streamer status:', error);
    res.status(500).json({ error: 'Failed to clear real streamer status' });
  }
});

// Streaming Method endpoints for ViewBot
app.get('/admin/viewbot-client/streaming-method', viewBotAuth, (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  try {
    const result = viewBotClientService.getStreamingMethod();
    res.json(result);
  } catch (error) {
    console.error('Error getting streaming method:', error);
    res.status(500).json({ error: 'Failed to get streaming method' });
  }
});

app.post('/admin/viewbot-client/streaming-method', viewBotAuth, async (req, res) => {
  if (!viewBotClientService) {
    return res.status(503).json({ error: 'ViewBotClientService not initialized' });
  }
  
  const { method } = req.body;
  
  if (!method || (method !== 'ffmpeg' && method !== 'gstreamer')) {
    return res.status(400).json({ 
      error: 'Invalid streaming method. Must be "ffmpeg" or "gstreamer"' 
    });
  }
  
  try {
    const result = await viewBotClientService.setStreamingMethod(method);
    res.json(result);
  } catch (error) {
    console.error('Error setting streaming method:', error);
    res.status(500).json({ error: error.message || 'Failed to set streaming method' });
  }
});

app.get('/admin/test-stream/frame', adminKeyAuth, (req, res) => {
  if (!testStreamService.getTestStreamStatus().isActive) {
    return res.status(400).json({ error: 'Test stream is not active' });
  }
  
  const frame = testStreamService.generateTestFrame();
  res.json(frame);
});

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
  console.log(`🧹 ADMIN CLEAR: Cleared ${clearedStreamer} from both services`);

  io.emit('stream-ended', { reason: 'admin_clear', previousStreamer: clearedStreamer });
  io.emit('viewer-count-update', sessionService.getUniqueViewerCount());

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
  
  // Create AccountService instance for fetching user details
  const accountService = new AccountService();
  
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
        console.log(`Could not fetch user details for ${session.userId}:`, err.message);
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
      console.log(`🔥 ADMIN: Cooldown removed for ${socketId}`);
      res.json({ success: true, message: `Cooldown removed for ${socketId}` });
    } else {
      res.status(404).json({ error: 'No cooldown found for this socket' });
    }
  } catch (error) {
    console.error('❌ ADMIN: Failed to remove cooldown:', error);
    res.status(500).json({ error: 'Failed to remove cooldown' });
  }
});

app.post('/admin/reset-cooldowns', authenticateAdmin, async (req, res) => {
  try {
    // Reset TakeoverService cooldowns (global system cooldowns)
    const takeoverCount = await takeoverService.resetAllCooldowns();
    console.log(`🔥 ADMIN: Reset ${takeoverCount} takeover cooldowns`);
    
    // Reset ItemService cooldowns (item usage cooldowns)
    const itemCount = await itemService.resetAllItemCooldowns();
    console.log(`🔥 ADMIN: Reset ${itemCount} item usage cooldowns`);
    
    const totalCount = takeoverCount + itemCount;
    console.log(`🔥 ADMIN: Total cooldowns reset: ${totalCount}`);
    
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
    console.error('❌ ADMIN: Failed to reset cooldowns:', error);
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
    console.error('❌ ADMIN: Failed to get cooldowns:', error);
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
    console.error('❌ ADMIN: Failed to get system metrics:', error);
    res.status(500).json({ error: 'Failed to get system metrics' });
  }
});

app.get('/admin/system-health', authenticateAdmin, (req, res) => {
  try {
    const healthSummary = resourceMonitor.getHealthSummary();
    res.json(healthSummary);
  } catch (error) {
    console.error('❌ ADMIN: Failed to get system health:', error);
    res.status(500).json({ error: 'Failed to get system health' });
  }
});

app.post('/admin/clear-alerts', authenticateAdmin, (req, res) => {
  try {
    resourceMonitor.clearAlerts();
    res.json({ success: true, message: 'System alerts cleared' });
  } catch (error) {
    console.error('❌ ADMIN: Failed to clear alerts:', error);
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
    console.error('❌ ADMIN: Failed to get performance stats:', error);
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
    console.error('❌ ADMIN: Failed to get stream details:', error);
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
      console.log(`🔨 MODERATION: Admin triggering viewbot rotation for stream ${streamerId}`);
      
      // Try different rotation methods based on what's available
      let rotationResult = { success: false, message: 'No rotation service available' };
      
      if (viewBotClientService) {
        // Use ViewBotClientService for rotation
        rotationResult = await viewBotClientService.forceRotation();
        console.log(`🤖 ROTATION: Triggered via ViewBotClientService:`, rotationResult);
      } else if (global.viewBotRotation) {
        // Use simple rotation service
        await global.viewBotRotation.forceRotation();
        rotationResult = { success: true, message: 'Rotation triggered via simple rotation service' };
        console.log(`🤖 ROTATION: Triggered via simple rotation service`);
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
      console.log(`🔨 MODERATION: Admin disconnecting regular stream ${streamerId}`);
      
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
      io.emit('stream-ended', { reason: 'admin_disconnect' });
      
      // After disconnecting a regular user, ensure viewbot rotation is enabled
      if (global.viewBotRotation) {
        console.log(`🤖 ROTATION: Enabling rotation after user disconnect`);
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
    console.error('❌ MODERATION: Failed to disconnect/rotate stream:', error);
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
    
    console.log(`🚫 MODERATION: IP ${ipToBan} banned by ${req.userRecord.username}`);
    
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
      
      io.emit('stream-ended', { reason: 'streamer_banned' });
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
    console.error('❌ MODERATION: Failed to ban IP:', error);
    res.status(500).json({ error: 'Failed to ban IP' });
  }
});

app.get('/api/admin/banned-ips', authenticateModerator, async (req, res) => {
  try {
    const bannedIPs = await IPBanService.getBannedIPs();
    res.json({ success: true, bannedIPs });
  } catch (error) {
    console.error('❌ ADMIN: Failed to get banned IPs:', error);
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
    
    console.log(`✅ MODERATION: IP ${ip} unbanned by ${req.userRecord.username}`);
    
    res.json({ 
      success: true, 
      message: 'IP unbanned successfully',
      ip 
    });
  } catch (error) {
    console.error('❌ MODERATION: Failed to unban IP:', error);
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
    
    console.log(`🚫 MODERATION: IP ${ip} manually banned by ${req.userRecord.username} - Reason: ${reason}`);
    
    res.json({ 
      success: true, 
      message: 'IP banned successfully',
      ip,
      reason 
    });
  } catch (error) {
    console.error('❌ MODERATION: Failed to manually ban IP:', error);
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
    console.error('❌ ADMIN: Failed to get streamer connections:', error);
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
    console.error('❌ ADMIN: Failed to get streaming logs:', error);
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
    console.error('❌ ADMIN: Failed to get streaming stats:', error);
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
    
    console.log(`🚫 STREAMING LOGS: IP ${ip} banned by ${req.userRecord.username} from logs`);
    
    res.json({ 
      success: true, 
      message: 'IP banned successfully',
      ip
    });
  } catch (error) {
    console.error('❌ ADMIN: Failed to ban IP from logs:', error);
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

    console.log(`📁 ADMIN: Video uploaded - ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

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
    console.error('❌ ADMIN: Video upload error:', error);
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
    console.error('❌ ADMIN: Failed to list uploaded videos:', error);
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
    console.log(`🗑️ ADMIN: Deleted uploaded video - ${filename}`);
    
    res.json({ 
      success: true, 
      message: `Video ${filename} deleted successfully` 
    });
    
  } catch (error) {
    console.error('❌ ADMIN: Failed to delete video:', error);
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
    
    console.log(`🎬 ADMIN: Starting recording for streamer ${streamerId} with quality ${quality}`);
    
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
    console.error('❌ ADMIN: Failed to start recording:', error);
    res.status(500).json({ error: 'Failed to start recording' });
  }
});

// Stop recording
app.post('/admin/recordings/stop/:recordingId', authenticateAdmin, async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userId = req.user?.id || 'admin';
    
    console.log(`🛑 ADMIN: Stopping recording ${recordingId}`);
    
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
    console.error('❌ ADMIN: Failed to stop recording:', error);
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
    console.error('❌ ADMIN: Failed to get recordings status:', error);
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
    console.error('❌ ADMIN: Failed to get recording status:', error);
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
          const userQuery = 'SELECT username FROM users WHERE id = ?';
          const user = await database.get(userQuery, [recording.streamer_id]);
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
    console.error('❌ ADMIN: Failed to list recordings:', error);
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
    console.error('❌ ADMIN: Error streaming recording:', error);
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
              const userQuery = 'SELECT username FROM users WHERE id = ?';
              const user = await database.get(userQuery, [streamerId]);
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
    console.error('❌ ADMIN: Error fetching recordings:', error);
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
    
    console.log(`📥 ADMIN: Downloading recording ${recordingId} - ${fileName}`);
    
    // Stream the file
    const fileStream = fs.createReadStream(recording.file_path);
    fileStream.pipe(res);
    
  } catch (error) {
    console.error('❌ ADMIN: Failed to download recording:', error);
    res.status(500).json({ error: 'Failed to download recording' });
  }
});

// Delete recording (supports both recordingId and filename)
app.delete('/admin/recordings/:recordingId', authenticateAdmin, async (req, res) => {
  try {
    const { recordingId } = req.params;
    const userId = req.user?.id || 'admin';
    
    console.log(`🗑️ ADMIN: Deleting recording ${recordingId}`);
    
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
          console.log(`🗑️ ADMIN: Deleted file: ${filePath}`);
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
          console.log(`🗑️ ADMIN: Deleted database record for file: ${filename}`);
        }
      } catch (dbError) {
        console.log('Note: Could not delete database record for file:', dbError.message);
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
    console.error('❌ ADMIN: Failed to delete recording:', error);
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
    console.error('❌ ADMIN: Failed to get active recordings:', error);
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
    console.error('❌ ADMIN: Failed to get system status:', error);
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

// Manual cleanup
app.post('/admin/recordings/cleanup', authenticateAdmin, async (req, res) => {
  try {
    console.log('🧹 ADMIN: Starting manual cleanup');
    
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
    console.error('❌ ADMIN: Failed to run cleanup:', error);
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
    console.error('❌ ADMIN: Failed to update settings:', error);
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
    
    console.log(`🗜️ ADMIN: Adding recording ${recordingId} to compression queue`);
    
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
    console.error('❌ ADMIN: Failed to queue compression:', error);
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
    
    console.log(`🔄 ADMIN: Enabling continuous recording (${quality || '720p'})`);
    
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
    console.error('❌ ADMIN: Failed to enable continuous recording:', error);
    res.status(500).json({ error: 'Failed to enable continuous recording' });
  }
});

// Disable continuous recording
app.post('/admin/recordings/continuous/disable', authenticateAdmin, async (req, res) => {
  try {
    console.log('🛑 ADMIN: Disabling continuous recording');
    
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
    console.error('❌ ADMIN: Failed to disable continuous recording:', error);
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
    console.error('❌ ADMIN: Failed to get continuous recording status:', error);
    res.status(500).json({ error: 'Failed to get continuous recording status' });
  }
});

// Manually check and start continuous recording if stream is active
app.post('/admin/recordings/continuous/check-and-start', authenticateAdmin, async (req, res) => {
  try {
    console.log('🔍 ADMIN: Manually checking for active streams to start continuous recording');
    
    const result = await recordingService.checkAndStartContinuousRecording();
    
    res.json({
      success: result.success,
      message: result.success ? 'Recording started or already active' : result.error,
      recordingId: result.recordingId
    });
    
  } catch (error) {
    console.error('❌ ADMIN: Failed to check and start continuous recording:', error);
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
    console.error('❌ ADMIN: Failed to get continuous recording history:', error);
    res.status(500).json({ error: 'Failed to get continuous recording history' });
  }
});

// Helper functions for stream state changes
function notifyViewersStreamStarted() {
  console.log('📊 TIME: Stream started - notifying viewers to start earning view time');

  // Start continuous recording for clips
  if (continuousRecordingService) {
    continuousRecordingService.startRecording().catch(err => {
      console.error('Failed to start continuous recording:', err);
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
          console.log(`📊 TIME: Started view tracking for existing viewer ${session.userId}`);
        }
      }
    }
  }
}

function notifyViewersStreamEnded() {
  console.log('📊 TIME: Stream ended - stopping view time tracking for all viewers');
  
  // Emit to all viewers
  io.to('viewers').emit('stream-ended-for-viewing');
  
  // Also manually stop existing viewing sessions
  for (const [socketId, session] of timeTrackingService.viewingSessions.entries()) {
    timeTrackingService.endViewingSessionBySocket(socketId);
    console.log(`📊 TIME: Stopped view tracking for viewer socket ${socketId}`);
  }
  
  // Trigger ViewBot rotation after a delay when stream ends
  const triggerTime = Date.now();
  console.log(`🔍 ROTATION TRIGGER: Stream ended at ${new Date(triggerTime).toISOString()}`);
  console.log(`🔍 ROTATION TRIGGER: Checking conditions - viewBotRotation exists: ${!!global.viewBotRotation}, enabled: ${global.viewBotRotation?.enabled}`);
  if (global.viewBotRotation && global.viewBotRotation.enabled) {
    console.log('✅ ROTATION TRIGGER: Conditions met, scheduling rotation in 5s');
    setTimeout(async () => {
      const currentStreamer = streamService.getCurrentStreamer();
      console.log(`🔍 ROTATION TRIGGER: After 5s delay (${Date.now() - triggerTime}ms elapsed) - currentStreamer: ${currentStreamer}`);
      if (!currentStreamer && global.viewBotRotation && global.viewBotRotation.enabled) {
        console.log('✅ ROTATION TRIGGER: No streamer, triggering rotation...');
        const rotateStartTime = Date.now();
        try {
          await global.viewBotRotation.rotateToNextBot();
          console.log(`⏱️ ROTATION TRIGGER: Total time from stream end to rotation complete: ${Date.now() - triggerTime}ms`);
        } catch (error) {
          console.error('❌ Failed to start rotation after stream end:', error);
        }
      } else {
        console.log(`⏭️  ROTATION TRIGGER: Skipped - currentStreamer: ${currentStreamer}`);
      }
    }, 5000);
  } else {
    console.log('❌ ROTATION TRIGGER: Conditions not met, rotation will not trigger');
  }
}

// Transcription API endpoints
app.post('/admin/transcription/start', authenticateAdmin, async (req, res) => {
  try {
    const { streamerId, options } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'streamerId is required' });
    }
    
    console.log(`🎙️ ADMIN: Starting transcription for ${streamerId}`);
    console.log(`🎙️ ADMIN: Options:`, options);
    console.log(`🎙️ ADMIN: Current active streamer:`, streamService.getCurrentStreamer());
    console.log(`🎙️ ADMIN: Stream type:`, streamService.getStreamType());
    
    const result = await transcriptionService.startTranscription(streamerId, options);
    
    console.log(`🎙️ ADMIN: Transcription start result:`, result);
    
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
    console.error('❌ ADMIN: Failed to start transcription:', error);
    res.status(500).json({ error: 'Failed to start transcription' });
  }
});

app.post('/admin/transcription/stop/:sessionId', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    console.log(`🛑 ADMIN: Stopping transcription ${sessionId}`);
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
    console.error('❌ ADMIN: Failed to stop transcription:', error);
    res.status(500).json({ error: 'Failed to stop transcription' });
  }
});

app.post('/admin/transcription/timed', authenticateAdmin, async (req, res) => {
  try {
    const { streamerId, duration = 30, options } = req.body;
    
    if (!streamerId) {
      return res.status(400).json({ error: 'streamerId is required' });
    }
    
    console.log(`⏱️ ADMIN: Timed transcription requested for ${streamerId} (${duration}s)`);
    
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
      console.log(`✅ ADMIN: Timed transcription started: ${result.sessionId}`);
      
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
    console.error('❌ ADMIN: Failed to start timed transcription:', error);
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
    console.error('❌ API: Failed to get transcription:', error);
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
    console.error('❌ API: Failed to get active transcriptions:', error);
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
    console.error('❌ ADMIN: Failed to update transcription config:', error);
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
    console.error('❌ ADMIN: Failed to get transcription status:', error);
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
    console.error('❌ API: Failed to get transcription history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Get active stream information
app.get('/api/stream/active', authenticateAdmin, async (req, res) => {
  try {
    const currentStreamer = streamService.getCurrentStreamer();
    const streamType = streamService.getStreamType();
    
    if (currentStreamer) {
      // Get user info if available
      let streamerInfo = null;
      if (sessionService) {
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        if (userId && userId > 0) {
          // Only try to get username for real users (positive IDs)
          try {
            const userQuery = `SELECT username FROM users WHERE id = ?`;
            streamerInfo = await new Promise((resolve, reject) => {
              database.all(userQuery, [userId], (err, rows) => {
                if (err || !rows || rows.length === 0) resolve(null);
                else resolve(rows[0].username);
              });
            });
          } catch (dbError) {
            console.log('Could not fetch username from database:', dbError.message);
          }
        }
      }
      
      res.json({ 
        currentStreamer: streamerInfo || currentStreamer,
        streamerId: currentStreamer,
        streamType: streamType,
        isActive: true
      });
    } else {
      res.json({ 
        currentStreamer: null,
        streamerId: null,
        streamType: null,
        isActive: false
      });
    }
  } catch (error) {
    console.error('Error fetching active stream:', error);
    res.status(500).json({ error: 'Failed to fetch active stream' });
  }
});

app.delete('/admin/transcriptions/old', authenticateAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const result = await transcriptionService.deleteOldTranscriptions(parseInt(days));
    
    res.json(result);
  } catch (error) {
    console.error('❌ ADMIN: Failed to delete old transcriptions:', error);
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
    console.error('❌ ADMIN: Failed to enable MovieBot:', error);
    res.status(500).json({ error: 'Failed to enable MovieBot' });
  }
});

app.post('/admin/moviebot/disable', adminKeyAuth, async (req, res) => {
  try {
    const result = await movieBotService.disable();
    res.json(result);
  } catch (error) {
    console.error('❌ ADMIN: Failed to disable MovieBot:', error);
    res.status(500).json({ error: 'Failed to disable MovieBot' });
  }
});

app.get('/admin/moviebot/status', adminKeyAuth, async (req, res) => {
  try {
    const status = movieBotService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('❌ ADMIN: Failed to get MovieBot status:', error);
    res.status(500).json({ error: 'Failed to get MovieBot status' });
  }
});

app.post('/admin/moviebot/config', adminKeyAuth, async (req, res) => {
  try {
    const result = movieBotService.updateConfig(req.body);
    res.json(result);
  } catch (error) {
    console.error('❌ ADMIN: Failed to update MovieBot config:', error);
    res.status(500).json({ error: 'Failed to update MovieBot config' });
  }
});

app.get('/admin/moviebot/logs', adminKeyAuth, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const logs = movieBotService.getRecentLogs(parseInt(limit));
    res.json({ logs });
  } catch (error) {
    console.error('❌ ADMIN: Failed to get MovieBot logs:', error);
    res.status(500).json({ error: 'Failed to get MovieBot logs' });
  }
});

// Global Groq API endpoints for ALL chatbots
app.get('/admin/groq/status', adminKeyAuth, async (req, res) => {
  try {
    const status = chatBotService.llmService.getGroqStatus();
    res.json(status);
  } catch (error) {
    console.error('❌ ADMIN: Failed to get Groq status:', error);
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
    
    console.log('🚀 ADMIN: Updated global Groq settings:', result);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ ADMIN: Failed to update Groq config:', error);
    res.status(500).json({ error: 'Failed to update Groq config' });
  }
});

// Forward transcription events to clients
transcriptionService.on('transcription-chunk', (data) => {
  io.emit('transcription-update', data);
  console.log(`📝 TRANSCRIPTION: Broadcasting chunk ${data.chunkNumber} for session ${data.sessionId}`);
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
  console.log(`🎬 MOVIEBOT: Broadcasting enabled event`);
});

movieBotService.on('moviebot-disabled', (data) => {
  io.emit('moviebot-disabled', data);
  console.log(`🎬 MOVIEBOT: Broadcasting disabled event`);
});

movieBotService.on('moviebot-comment', (data) => {
  io.emit('moviebot-comment', data);
  console.log(`🎬 MOVIEBOT: Broadcasting comment from ${data.bot}`);
});

movieBotService.on('prompt-logged', (data) => {
  io.emit('moviebot-prompt-logged', data);
  console.log(`📋 MOVIEBOT: Prompt logged for ${data.bot}`);
});

io.on('connection', async (socket) => {
  console.log(`🆕 NEW CONNECTION: Socket ${socket.id} connected at ${new Date().toISOString()}`);
  
  // Check if IP is banned
  const clientIP = IPBanService.getIPFromSocket(socket);
  const isBanned = await IPBanService.isIPBanned(clientIP);
  
  if (isBanned) {
    console.log(`🚫 CONNECTION: Banned IP attempted to connect: ${clientIP}`);
    socket.emit('banned', { 
      reason: 'Your IP address has been banned from this service',
      timestamp: new Date().toISOString()
    });
    socket.disconnect(true);
    return;
  }
  
  // Handle authentication if token is provided
  const token = socket.handshake.auth?.token;
  console.log(`🔑 SOCKET AUTH: Token provided for ${socket.id}:`, !!token);
  
  let authenticatedUserId = null;
  if (token) {
    try {
      const decoded = authService.verifyToken(token);
      authenticatedUserId = decoded.id;
      console.log(`✅ SOCKET AUTH: User authenticated: ${socket.id} -> User ID ${authenticatedUserId}`);
    } catch (error) {
      console.log(`❌ SOCKET AUTH: Invalid token for ${socket.id}:`, error.message);
    }
  }

  // Register session for this socket
  const session = sessionService.registerSocket(socket);
  const ip = sessionService.getIpAddress(socket);
  
  // Associate authenticated user with session if available, or clear if anonymous
  if (authenticatedUserId) {
    sessionService.linkUserToSession(ip, authenticatedUserId);
    sessionService.linkUserToSocket(socket.id, authenticatedUserId);
    console.log(`🔗 SOCKET AUTH: Associated user ${authenticatedUserId} with session for IP ${ip}`);
  } else {
    // Clear any existing user ID from the session for anonymous users
    sessionService.linkUserToSession(ip, null);
    sessionService.linkUserToSocket(socket.id, null);
    console.log(`🔗 SOCKET AUTH: Cleared user ID for anonymous connection from IP ${ip}`);
  }
  
  console.log(`📡 SOCKET: User connected: ${socket.id} from IP: ${ip}, session: ${JSON.stringify(session)}`);

  // Debug: Log all events for ViewBot connections
  socket.onAny((eventName, ...args) => {
    console.log(`🔴 DEBUG: Socket ${socket.id} received event '${eventName}'`);
    if (eventName === 'request-to-stream') {
      console.log(`🔴 DEBUG: request-to-stream args:`, args);
    }
  });

  socket.on('join-as-viewer', async () => {
    streamService.addViewer(socket.id);
    socket.join('viewers');
    
    // Get stream status with duration
    const status = streamService.getStreamStatus();
    // Override viewer count with IP-based count
    status.viewerCount = sessionService.getUniqueViewerCount();
    // Enrich with streamer display name
    const enrichedStatus = await enrichStreamStatus(status);
    socket.emit('stream-status', enrichedStatus);

    // Send random rotation status if active
    if (global.randomStreamRotationService) {
      const rotationStatus = global.randomStreamRotationService.getStatus();
      if (rotationStatus.enabled && rotationStatus.currentStream) {
        socket.emit('random-rotation-status', {
          enabled: true,
          currentStream: rotationStatus.currentStream
        });
      }
    }

    // Visual effects sync temporarily disabled to debug rotate_90 issue
    // try {
    //   const activeVisualEffects = await getActiveVisualEffects();
    //   if (activeVisualEffects.length > 0) {
    //     console.log(`🎨 VISUAL FX: Sending ${activeVisualEffects.length} active effects to new viewer ${socket.id}`);
    //     
    //     // Send each effect to the viewer with a small delay to prevent overwhelming
    //     activeVisualEffects.forEach((buff, index) => {
    //       setTimeout(() => {
    //         socket.emit('visual-effect-sync', {
    //           effectId: buff.item_name,
    //           itemName: buff.item_name,
    //           displayName: buff.display_name,
    //           duration: buff.remaining_seconds * 1000,
    //           remainingSeconds: buff.remaining_seconds,
    //           effectData: buff.effect_data,
    //           isSyncEvent: true
    //         });
    //       }, index * 100); // 100ms between each effect
    //     });
    //   }
    // } catch (error) {
    //   console.error(`❌ VISUAL FX: Error sending effects to viewer ${socket.id}:`, error);
    // }
    
    // Emit unique viewer count based on IPs
    io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
    
    // Start time tracking for viewing session if user is authenticated
    const ip = sessionService.getIpAddress(socket);
    const session = sessionService.getSessionByIp(ip);
    console.log(`📊 TIME DEBUG: join-as-viewer - IP: ${ip}, session: ${JSON.stringify(session)}, hasActiveStream: ${status.hasActiveStream}`);
    if (session && session.userId) {
      const hasActiveStream = status.hasActiveStream;
      timeTrackingService.startViewingSession(session.userId, socket.id, hasActiveStream);
      console.log(`📊 TIME: Started viewing time tracking for user ${session.userId}, active stream: ${hasActiveStream}`);
    } else {
      console.log(`📊 TIME DEBUG: No authenticated user found for socket ${socket.id} (IP: ${ip})`);
    }
    
    // Check if user has an active cooldown and send it to them
    const canTakeOver = await takeoverService.canTakeOver(socket.id);
    if (!canTakeOver.allowed) {
      console.log(`🔒 COOLDOWN: New viewer ${socket.id} has active cooldown (${canTakeOver.reason}: ${canTakeOver.cooldownRemaining}s)`);
      socket.emit('global-cooldown', { 
        cooldownRemaining: canTakeOver.cooldownRemaining,
        reason: canTakeOver.reason 
      });
    }
  });

  socket.on('request-to-stream', async (data, callback) => {
    console.log(`📥 STREAMING: Received request-to-stream from socket ${socket.id} at ${new Date().toISOString()}`);
    console.log(`📥 STREAMING: Request data:`, JSON.stringify(data));
    console.log(`📥 STREAMING: Callback type:`, typeof callback);
    console.log(`📥 STREAMING: Current streamer:`, streamService.getCurrentStreamer());
    console.log(`📥 STREAMING: Server state - hasStreamer:`, !!streamService.getCurrentStreamer());
    
    // CRITICAL: Check for permission confirmation (new in permission system)
    const isViewBot = data.isViewBot || data.streamType === 'viewbot';
    if (!isViewBot && data.streamType === 'webcam') {
      // For real users streaming from webcam, require permission confirmation
      if (!data.permissionsGranted) {
        console.log(`🚫 STREAMING: Request denied - no permission confirmation from ${socket.id}`);
        socket.emit('stream-denied', { 
          reason: 'Camera and microphone permissions are required to stream',
          requiresPermissions: true,
          timestamp: new Date().toISOString()
        });
        if (callback && typeof callback === 'function') {
          callback(false);
        }
        return;
      }
      
      // Validate permission status if provided
      if (data.permissionStatus) {
        const { camera, microphone } = data.permissionStatus;
        if (camera !== 'granted' || microphone !== 'granted') {
          console.log(`🚫 STREAMING: Insufficient permissions - camera: ${camera}, mic: ${microphone}`);
          socket.emit('stream-denied', { 
            reason: 'Both camera and microphone permissions must be granted',
            permissionStatus: data.permissionStatus,
            timestamp: new Date().toISOString()
          });
          if (callback && typeof callback === 'function') {
            callback(false);
          }
          return;
        }
      }
      console.log(`✅ STREAMING: Permissions verified for ${socket.id}`);
    }
    
    // Check if IP is banned before allowing streaming
    const clientIP = IPBanService.getIPFromSocket(socket);
    const isBanned = await IPBanService.isIPBanned(clientIP);
    
    if (isBanned) {
      console.log(`🚫 STREAMING: Banned IP ${clientIP} attempted to stream`);
      socket.emit('stream-denied', { 
        reason: 'Your IP address has been banned from streaming',
        timestamp: new Date().toISOString()
      });
      if (callback && typeof callback === 'function') {
        callback(false);
      }
      return;
    }
    
    // Send acknowledgment if callback provided
    if (callback && typeof callback === 'function') {
      callback(true);
      console.log(`✅ STREAMING: Sent acknowledgment for request-to-stream`);
    }
    
    try {
      // Check if this is a viewbot or real user (already checked above for permissions)
      const isRealUser = !isViewBot;
      
      // CRITICAL: Check if current streamer is a real user
      const currentStreamer = streamService.getCurrentStreamer();
      
      // Enhanced ViewBot detection - check both old viewbotService and new ViewBotClientService
      let currentIsViewbot = false;
      if (currentStreamer) {
        // Check old ViewBot system
        const isOldViewBot = viewbotService && viewbotService.isViewbotStream(currentStreamer);
        
        // Check new ViewBotClientService system - negative user IDs indicate ViewBots
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        const isNewViewBot = userId && userId < 0;
        
        currentIsViewbot = isOldViewBot || isNewViewBot;
        
        console.log(`🔍 VIEWBOT CHECK: Socket ${currentStreamer.substring(0, 12)}...`);
        console.log(`   Old ViewBot: ${isOldViewBot}`);
        console.log(`   New ViewBot: ${isNewViewBot} (userID: ${userId})`);
        console.log(`   Is ViewBot: ${currentIsViewbot}`);
      }
      
      const currentIsRealUser = currentStreamer && !currentIsViewbot;
      
      // PRIORITY RULE: Viewbots can NEVER take over from real users
      if (isViewBot && currentIsRealUser) {
        console.log(`🚫 PRIORITY: ViewBot ${socket.id} denied - cannot take over real streamer ${currentStreamer}`);
        socket.emit('takeover-denied', { 
          reason: 'Real streamer has priority. ViewBots cannot interrupt real streams.',
          cooldownRemaining: 0 
        });
        return;
      }
      
      // CRITICAL FIX: ViewBots should completely bypass cooldown checks
      // Only check cooldowns for real users
      if (!isViewBot) {
        console.log(`🔍 COOLDOWN: Checking cooldown for real user ${socket.id}`);
        const canTakeOver = await takeoverService.canTakeOver(socket.id);
        
        if (!canTakeOver.allowed) {
          socket.emit('takeover-denied', { 
            reason: canTakeOver.reason,
            cooldownRemaining: canTakeOver.cooldownRemaining 
          });
          return;
        }
      } else {
        console.log(`🤖 COOLDOWN: Skipping cooldown check for viewbot ${socket.id} - viewbots bypass all cooldowns`);
      }

      // If real user is taking over, set the realStreamerActive flag
      if (isRealUser && viewBotClientService) {
        console.log(`✅ PRIORITY: Real user ${socket.id} starting stream - protecting from viewbot interruption`);
        viewBotClientService.setRealStreamerStatus(true);
      }

      if (currentStreamer) {
        console.log(`📢 TAKEOVER: Notifying current streamer ${currentStreamer} of takeover by ${socket.id}`);

        // CRITICAL FIX: Comprehensive viewbot detection including LiveKit viewbots
        const isOldViewBot = viewbotService && viewbotService.isViewbotStream(currentStreamer);
        const userId = sessionService.getUserIdBySocketId(currentStreamer);
        const isNewViewBot = userId && userId < 0;
        const isLiveKitViewBot = currentStreamer.startsWith('viewbot-'); // LiveKit viewbots have this prefix
        const currentIsViewbot = isOldViewBot || isNewViewBot || isLiveKitViewBot;

        console.log(`🔍 TAKEOVER: Viewbot detection - old: ${isOldViewBot}, new: ${isNewViewBot}, livekit: ${isLiveKitViewBot}`);

        // Handle viewbot takeover - must stop the viewbot properly
        if (currentIsViewbot) {
          console.log(`🤖 TAKEOVER: Current streamer ${currentStreamer} is a viewbot, stopping it`);

          // Stop OLD viewbot system
          if (isOldViewBot && viewbotService) {
            console.log('🤖 TAKEOVER: Stopping old viewbot service');
            await viewbotService.handleTakeover(socket.id);
          }

          // CRITICAL: Stop LiveKit/SimpleViewBotRotation viewbot
          if (isLiveKitViewBot || isNewViewBot) {
            console.log('🤖 TAKEOVER: Stopping LiveKit viewbot rotation');
            try {
              // Stop via SimpleViewBotRotation (main rotation system)
              if (SimpleViewBotRotation && SimpleViewBotRotation.stopRotation) {
                await SimpleViewBotRotation.stopRotation();
                console.log('✅ TAKEOVER: SimpleViewBotRotation stopped');
              }

              // Also stop via ViewBotClientService if available
              if (viewBotClientService && viewBotClientService.stopViewBotRotation) {
                viewBotClientService.stopViewBotRotation();
                console.log('✅ TAKEOVER: ViewBotClientService rotation stopped');
              }

              // Stop via global viewBotRotation if available
              if (global.viewBotRotation && global.viewBotRotation.stopRotation) {
                await global.viewBotRotation.stopRotation();
                console.log('✅ TAKEOVER: global.viewBotRotation stopped');
              }

              // Stop via unified rotation if available
              if (global.unifiedViewBotRotation && global.unifiedViewBotRotation.stopRotation) {
                await global.unifiedViewBotRotation.stopRotation();
                console.log('✅ TAKEOVER: unifiedViewBotRotation stopped');
              }
            } catch (viewbotStopError) {
              console.error('❌ TAKEOVER: Error stopping viewbot:', viewbotStopError);
            }
          }

          // Set protection for real user taking over from viewbot
          if (isRealUser && viewBotClientService) {
            viewBotClientService.setRealStreamerStatus(true);
            console.log('✅ TAKEOVER: Set real streamer status to protect from viewbot interruption');
          }
        } else {
          // Current streamer is a real user (not a viewbot)
          console.log(`👤 TAKEOVER: Current streamer ${currentStreamer} is a real user`);

          // Set cooldown for real user being taken over
          let cooldownInfo = null;
          console.log(`🔒 TAKEOVER: Setting cooldown for real user ${currentStreamer} being taken over`);
          await takeoverService.setSocketCooldown(currentStreamer, 'stream_taken_over');
          cooldownInfo = await takeoverService.getSocketCooldown(currentStreamer);

          // Emit takeover event with cooldown information and new streamer display name
          const newStreamerDisplayNameForTakeover = await getStreamerDisplayName(socket.id);
          io.to(currentStreamer).emit('stream-takeover', {
            newStreamerId: socket.id,
            newStreamerDisplayName: newStreamerDisplayNameForTakeover,
            cooldownRemaining: cooldownInfo ? cooldownInfo.remaining : takeoverService.getCooldownSeconds()
          });
          console.log(`📢 TAKEOVER: Notified ${currentStreamer} of takeover by ${socket.id} (${newStreamerDisplayNameForTakeover})`);

          // Remove from streamer room but DON'T disconnect the socket
          // The cooldown already prevents them from streaming again
          // Disconnecting the socket causes race conditions with viewer initialization
          const previousStreamerSocket = io.sockets.sockets.get(currentStreamer);
          if (previousStreamerSocket) {
            console.log(`🔌 TAKEOVER: Removing previous streamer ${currentStreamer} from streamer room (keeping socket connected for viewer transition)`);
            previousStreamerSocket.leave('streamer');

            // Send force-disconnect event to signal transition (but don't actually disconnect socket)
            previousStreamerSocket.emit('force-disconnect', {
              reason: 'stream_takeover',
              message: 'Your stream has been taken over by another user',
              shouldReconnect: false
            });
            console.log(`✅ TAKEOVER: Previous streamer ${currentStreamer} notified - socket remains connected for viewer mode`);
          }
        }
        
        // Emit stream-ended to notify viewers before cleanup, but not to the new streamer
        // Include new streamer's display name so UI can update immediately
        const newStreamerDisplayName = await getStreamerDisplayName(socket.id);
        console.log(`📢 TAKEOVER: Notifying viewers of stream end before cleanup (excluding new streamer ${socket.id}, display: ${newStreamerDisplayName})`);
        socket.broadcast.emit('stream-ended', {
          reason: 'takeover',
          previousStreamer: currentStreamer,
          newStreamer: socket.id,
          newStreamerDisplayName: newStreamerDisplayName
        });
        
        // Give viewers time to cleanup their consumers before we close producers
        console.log(`⏳ TAKEOVER: Waiting 200ms for viewer cleanup before producer cleanup`);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        console.log(`🧹 TAKEOVER: Cleaning up resources for previous streamer ${currentStreamer}`);
        mediasoupService.cleanup(currentStreamer);
        
        // Clear from notified streamers to allow fresh notifications
        notifiedStreamers.delete(currentStreamer);
      } else {
        // CRITICAL FIX: No current streamer - this is a fresh start (e.g., after server restart)
        console.log(`🚀 STREAMING: No current streamer - ${socket.id} starting fresh stream (isViewBot: ${isViewBot})`);
      }

      streamService.setStreamer(socket.id, data.streamType);
      // CRITICAL FIX: Sync MediasoupService currentStreamer with StreamService immediately
      mediasoupService.currentStreamer = socket.id;
      
      // Ensure the new streamer is also cleared from notifiedStreamers to allow fresh notifications
      notifiedStreamers.delete(socket.id);
      console.log(`🎯 TAKEOVER: Set ${socket.id} as current streamer in both services, cleared from notified set`);
      
      // Send StreamBot announcement about the stream takeover or new stream
      if (!isViewBot) {
        try {
          // Get username for the new streamer
          let streamerName = 'Anonymous';
          const userId = sessionService.getUserIdBySocketId(socket.id);
          
          if (userId && userId > 0) {
            // Real authenticated user
            try {
              const userQuery = `SELECT username FROM users WHERE id = ?`;
              const rows = await database.allAsync(userQuery, [userId]);
              if (rows && rows.length > 0 && rows[0].username) {
                streamerName = rows[0].username;
              }
            } catch (err) {
              console.error('Error fetching username:', err);
            }
          } else {
            // Anonymous user - get chat username from session
            const session = sessionService.getSessionBySocketId(socket.id);
            if (session && session.chatUsername) {
              streamerName = session.chatUsername;
            } else {
              // Fallback to "Anonymous" if no username set yet
              streamerName = 'Anonymous';
            }
          }
          
          // Determine the appropriate message based on whether this is a takeover or fresh start
          let announcementMessage;
          if (currentStreamer) {
            announcementMessage = `🎬 ${streamerName} took over the stream! They're going live!`;
          } else {
            announcementMessage = `🎬 ${streamerName} is going live!`;
          }
          
          // Send announcement to chat service
          const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
          
          axios.post(`${chatServiceUrl}/api/system-message`, {
            message: announcementMessage,
            type: currentStreamer ? 'stream_takeover' : 'stream_start'
          }, {
            httpsAgent: new https.Agent({
              rejectUnauthorized: false
            }),
            timeout: 5000
          }).then(response => {
            console.log(`📢 STREAM: Sent StreamBot announcement for ${streamerName}`);
          }).catch(error => {
            console.error('❌ STREAM: Failed to send StreamBot announcement:', error.message);
          });
        } catch (error) {
          console.error('❌ STREAM: Error sending stream announcement:', error);
        }
      }
      
      // Recording will be handled when stream-ready is emitted (after producers are created)
      
      // Emit streamer buff updates when user becomes current streamer
      try {
        const streamerBuffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
        console.log(`🎭 BUFF: Emitting streamer buffs for new streamer ${socket.id}: ${streamerBuffs.length} buffs`);
        io.emit('streamer-buffs-update', { buffs: streamerBuffs });
        
        // NOTE: Visual effects re-application moved to stream-ready event for better timing
      } catch (error) {
        console.error('❌ BUFF: Error emitting streamer buffs on stream start:', error);
      }
      
      // Broadcast updated stream status to all viewers so "Current Streamer" updates in real-time
      const updatedStatus = streamService.getStreamStatus();
      updatedStatus.viewerCount = sessionService.getUniqueViewerCount();
      const enrichedStatus = await enrichStreamStatus(updatedStatus);
      io.emit('stream-status', enrichedStatus);
      console.log(`📡 TAKEOVER: Broadcasted updated stream status with streamer: ${enrichedStatus.streamerDisplayName}`);
      
      // Only record takeover (and trigger global cooldown) for real users, not viewbots
      console.log(`🔍 CRITICAL: Checking if we should record takeover - isViewBot: ${isViewBot}, data: ${JSON.stringify(data)}`);
      if (!isViewBot) {
        console.log(`🔒 TAKEOVER: Recording takeover for real user ${socket.id} - global cooldown will be triggered`);
        await takeoverService.recordTakeover();
      } else {
        console.log(`🤖 TAKEOVER: Viewbot ${socket.id} starting - NOT triggering any cooldown`);
      }
      
      socket.join('streamer');
      socket.leave('viewers');
      
      console.log(`✅ STREAMING: Sending streaming-approved to socket ${socket.id} (isViewBot: ${isViewBot})`);
      console.log(`📡 STREAMING: Socket state - connected: ${socket.connected}, transport: ${socket.conn?.transport?.name}`);
      console.log(`📡 STREAMING: Socket rooms:`, Array.from(socket.rooms));
      
      // CRITICAL: Emit the streaming-approved event with multiple attempts
      socket.emit('streaming-approved');
      
      // Try volatile emit as well
      socket.volatile.emit('streaming-approved');
      
      // For ViewBots, also directly call their handler if they have one
      if (isViewBot) {
        console.log(`🔄 STREAMING: Attempting direct ViewBot notification for ${socket.id}`);
        // Send a different event that ViewBots might be listening to
        socket.emit('viewbot-stream-approved', { approved: true });
        
        // Try with timeout to ensure event is delivered
        setTimeout(() => {
          socket.emit('streaming-approved');
          socket.emit('viewbot-stream-approved', { approved: true });
        }, 100);
      }
      
      // Also try sending with acknowledgment to verify delivery
      socket.emit('streaming-approved-ack', {}, (ack) => {
        if (ack) {
          console.log(`✅ STREAMING: ViewBot acknowledged streaming-approved`);
        } else {
          console.log(`⚠️ STREAMING: No acknowledgment from ViewBot for streaming-approved`);
        }
      });
      
      // Track streamer connection in database for IP ban management
      const clientIP = IPBanService.getIPFromSocket(socket);
      const userAgent = socket.handshake.headers['user-agent'] || 'Unknown';
      const streamerName = enrichedStatus.streamerDisplayName || socket.id;
      
      try {
        await runAsync(`
          INSERT INTO streamer_connections 
          (streamer_id, streamer_name, ip_address, connection_type, user_agent)
          VALUES (?, ?, ?, ?, ?)
        `, [socket.id, streamerName, clientIP, 'websocket', userAgent]);
        console.log(`📝 IP TRACKING: Recorded streamer connection for ${streamerName} from IP ${clientIP}`);
      } catch (error) {
        console.error('❌ IP TRACKING: Failed to record streamer connection:', error);
      }
      
      // Start streaming log session
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      const userId = session?.userId || null;
      
      // Start streaming log session for real streamers
      if (!isViewBot) {
        // CRITICAL: Pause random rotation when a real streamer starts
        // It will auto-restart when the real streamer ends
        if (global.randomStreamRotationService && global.randomStreamRotationService.isEnabled) {
          console.log('⏸️ RANDOM ROTATION: Pausing - real streamer taking over');
          try {
            await global.randomStreamRotationService.pause();
          } catch (err) {
            console.error('❌ RANDOM ROTATION: Failed to pause:', err.message);
          }
        }

        await streamingLogsService.startSession(
          socket.id,
          streamerName,
          userId,
          clientIP,
          userAgent,
          data.streamType || 'standard',
          false // not a viewbot
        );
        console.log(`📝 STREAMING LOGS: Started session for ${streamerName} (${clientIP})`);
      }
      
      // Start time tracking for streaming session if user is authenticated
      console.log(`📊 TIME DEBUG: request-to-stream approved - IP: ${ip}, session: ${JSON.stringify(session)}`);
      if (session && session.userId) {
        // End any viewing session first
        await timeTrackingService.endViewingSession(session.userId, socket.id);
        // Start streaming session
        timeTrackingService.startStreamingSession(session.userId, socket.id);
        console.log(`📊 TIME: Started streaming time tracking for user ${session.userId}`);
      } else {
        console.log(`📊 TIME DEBUG: No authenticated user found for streaming socket ${socket.id} (IP: ${ip})`);
      }
      
      // Send stream status to the streamer so they can see duration
      const streamerStatus = streamService.getStreamStatus();
      streamerStatus.viewerCount = sessionService.getUniqueViewerCount();
      // Enrich with streamer display name
      const enrichedStreamerStatus = await enrichStreamStatus(streamerStatus);
      socket.emit('stream-status', enrichedStreamerStatus);
      
      // For ViewBots, send stream-ready notification immediately since producers are already created
      if (data.isViewBot || data.streamType === 'viewbot') {
        // Track this socket ID as a ViewBot
        viewbotSocketIds.add(socket.id);
        console.log(`🤖 VIEWBOT: Added socket ID ${socket.id} to ViewBot tracking`);
        
        // Register synthetic negative user ID for viewbot
        // Create a simple hash from socket ID to generate consistent negative user ID
        let hash = 0;
        for (let i = 0; i < socket.id.length; i++) {
          hash = ((hash << 5) - hash) + socket.id.charCodeAt(i);
          hash = hash & hash; // Convert to 32bit integer
        }
        const syntheticUserId = -Math.abs(hash);
        sessionService.linkUserToSocket(socket.id, syntheticUserId);
        console.log(`🎭 VIEWBOT: Registered synthetic user ID ${syntheticUserId} for socket ${socket.id}`);
        
        // CRITICAL FIX: Update ViewbotService configuration with ViewBot's streamConfig
        if (data.streamConfig && viewbotService) {
          console.log(`🎨 VIEWBOT CONFIG: Updating ViewbotService with config from ${socket.id}:`, data.streamConfig);
          viewbotService.updateViewbotConfig(data.streamConfig);
        }
        
        // Check if ViewBot has producers ready
        // CRITICAL FIX: ViewBots use GStreamer, not MediaSoup producers
        // Always treat ViewBot producers as ready since they stream via RTP/FFmpeg
        const producerMap = mediasoupService.producers.get(socket.id);
        const hasVideo = data.isViewBot ? true : (producerMap && producerMap.has('video'));
        const hasAudio = data.isViewBot ? true : (producerMap && producerMap.has('audio'));
        
        // For ViewBots, immediately mark as ready since they handle their own media pipeline
        if ((data.isViewBot || (hasVideo && hasAudio)) && !notifiedStreamers.has(socket.id)) {
          notifiedStreamers.add(socket.id);
          
          console.log(`🎬 TAKEOVER: ViewBot ${socket.id} ready - notifying viewers immediately (GStreamer mode)`);
          const streamerDisplayName = await getStreamerDisplayName(socket.id);
          const emitTimestamp = Date.now();

          // DEDUP: Check if we already emitted for this stream recently
          if (lastEmittedStreamReady.streamerId === socket.id &&
              (emitTimestamp - lastEmittedStreamReady.timestamp) < 2000) {
            console.log(`⏭️ STREAM-READY: Skipping duplicate ViewBot emission for ${socket.id}`);
          } else {
            io.emit('stream-ready', {
              streamerId: socket.id,
              newStreamId: socket.id,
              isWebRTC: true,
              streamType: 'viewbot',
              isViewBot: true,
              hasVideo: true,  // ViewBots always have video via GStreamer
              hasAudio: true,  // ViewBots always have audio via GStreamer
              producerVerified: true,
              streamStartTime: emitTimestamp,
              timestamp: emitTimestamp,
              streamerDisplayName: streamerDisplayName
            });
            lastEmittedStreamReady = { streamerId: socket.id, timestamp: emitTimestamp };
            console.log(`📡 STREAM-READY: ViewBot ${socket.id} ready with display name: ${streamerDisplayName}`);
          }
          
          // Notify existing viewers to start tracking view time
          notifyViewersStreamStarted();
        } else {
          console.log(`📢 TAKEOVER: ViewBot ${socket.id} approved to stream, waiting for producers (video: ${hasVideo}, audio: ${hasAudio})`);
        }
      } else {
        // Note: Regular streamers will be notified via 'stream-ready' event after producers are created and verified
        console.log(`📢 TAKEOVER: ${socket.id} approved to stream, waiting for producers to be created`);
      }
      
      io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
      
      // Only broadcast global cooldown for real users, not viewbots
      if (!isViewBot) {
        await broadcastGlobalCooldown(socket.id);
      } else {
        console.log(`🤖 COOLDOWN: Skipping global cooldown broadcast for viewbot ${socket.id}`);
      }
      
      console.log(`Stream taken over by: ${socket.id}`);
    } catch (error) {
      console.error('Error handling takeover request:', error);
      socket.emit('takeover-error', { message: 'Server error occurred' });
    }
  });

  // Handle viewer requesting stream from streamer
  socket.on('request-stream', (data) => {
    const { streamerId } = data;
    console.log(`Viewer ${socket.id} requesting stream from ${streamerId}`);
    
    // Tell the streamer to send offer to this viewer
    io.to(streamerId).emit('viewer-requesting-stream', { viewerId: socket.id });
  });

  // Handle ViewBot Plain RTP bridge creation (for FFmpeg/GStreamer to WebRTC producer)
  socket.on('viewbot-create-plain-bridge', async (data, callback) => {
    const { botId, producerId, kind, rtpParameters } = data;
    console.log(`🤖 SERVER: ViewBot ${botId} creating Plain RTP bridge for ${kind} producer ${producerId}`);
    
    try {
      // Generate a fixed SSRC for this producer
      const ssrc = kind === 'video' ? 11111111 : 22222222;
      
      // Create Plain RTP transport for FFmpeg/GStreamer to send to
      const plainTransport = await mediasoupService.router.createPlainTransport({
        listenIp: { 
          ip: '0.0.0.0', 
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // Public IP
        },
        rtcpMux: false,
        comedia: true,
        enableSrtp: false
      });
      
      const listenPort = plainTransport.tuple.localPort;
      console.log(`✅ SERVER: Plain RTP bridge created on port ${listenPort} for ${kind}`);
      
      // Store the Plain transport
      if (!mediasoupService.plainBridges) {
        mediasoupService.plainBridges = new Map();
      }
      mediasoupService.plainBridges.set(`${botId}-${kind}`, plainTransport);
      
      // When RTP arrives, forward it to the WebRTC producer
      // This is handled automatically by MediaSoup's transport routing
      
      callback({
        success: true,
        rtpPort: listenPort,
        ssrc: ssrc
      });
      
    } catch (error) {
      console.error(`❌ SERVER: Failed to create Plain RTP bridge:`, error);
      callback({
        success: false,
        error: error.message
      });
    }
  });
  
  // Handle ViewBot WebRTC transport creation for mobile 5G/TURN support (legacy - kept for compatibility)
  socket.on('viewbot-create-webrtc-transport', async (data) => {
    const { botId, kind, rtpParameters } = data;
    console.log(`🤖 SERVER: ViewBot ${botId} creating WebRTC transport for ${kind} (LEGACY METHOD)`);
    
    try {
      // Create WebRTC transport like regular users for TURN support
      const transportOptions = await mediasoupService.createWebRtcTransport(`viewbot-${botId}-${kind}`);
      
      // Store transport for later use
      if (!mediasoupService.viewbotTransports) {
        mediasoupService.viewbotTransports = new Map();
      }
      mediasoupService.viewbotTransports.set(`${botId}-${kind}`, transportOptions);
      
      // Create producer on the transport
      const transport = mediasoupService.transports.get(`viewbot-${botId}-${kind}`);
      if (!transport) {
        throw new Error('Transport not found after creation');
      }
      
      // Create producer with appropriate RTP parameters
      const producer = await transport.produce({
        kind: kind,
        rtpParameters: rtpParameters,
        paused: false,
        appData: {
          isViewBot: true,
          botId: botId
        }
      });
      
      console.log(`✅ SERVER: ViewBot ${botId} WebRTC ${kind} producer created: ${producer.id}`);
      
      // Store producer
      if (!mediasoupService.producers) {
        mediasoupService.producers = new Map();
      }
      const producerKey = `viewbot-${botId}-${kind}`;
      const producerMap = mediasoupService.producers.get(producerKey) || new Map();
      producerMap.set(kind, producer);
      mediasoupService.producers.set(producerKey, producerMap);
      
      // Send success response
      socket.emit('viewbot-producer-created', {
        botId: botId,
        kind: kind,
        producerId: producer.id,
        transportId: transportOptions.id,
        iceParameters: transportOptions.iceParameters,
        iceCandidates: transportOptions.iceCandidates,
        dtlsParameters: transportOptions.dtlsParameters,
        rtpPort: 0 // Not used for WebRTC
      });
      
    } catch (error) {
      console.error(`❌ SERVER: Failed to create WebRTC transport for ViewBot ${botId}:`, error);
      socket.emit('viewbot-producer-error', {
        botId: botId,
        kind: kind,
        error: error.message
      });
    }
  });
  
  // Handle ViewBot plain RTP transport creation
  socket.on('viewbot-create-plain-transport', async (data) => {
    const { botId, kind, rtpParameters } = data;
    console.log(`🤖 SERVER: ViewBot ${botId} creating plain RTP transport for ${kind}`);
    
    try {
      // Generate a fixed SSRC for this producer
      const ssrc = kind === 'video' ? 11111111 : 22222222; // Fixed SSRCs for debugging
      
      // Create plain RTP transport - MediaSoup will listen on a port for FFmpeg RTP
      const plainTransport = await mediasoupService.router.createPlainTransport({
        listenIp: { 
          ip: '0.0.0.0', 
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // Public IP
        },
        rtcpMux: false, // Separate ports for RTP and RTCP
        comedia: true, // Auto-detect source IP and port from first RTP packet
        enableSrtp: false,
        srtpCryptoSuite: undefined
      });
      
      const listenPort = plainTransport.tuple.localPort;
      const rtcpPort = plainTransport.rtcpTuple ? plainTransport.rtcpTuple.localPort : null;
      console.log(`📡 SERVER: Plain RTP transport created for ViewBot ${botId} ${kind}`);
      console.log(`📡 SERVER: Transport listening for RTP on port ${listenPort}, RTCP on port ${rtcpPort}`);
      console.log(`📡 SERVER: Using SSRC ${ssrc} for ${kind}`);
      
      // For comedia mode, don't pre-connect - let it auto-detect from first packet
      
      // For PlainTransport, we need to specify the exact RTP parameters
      // including SSRC that FFmpeg will use
      const producerRtpParameters = {
        codecs: kind === 'video' ? [
          {
            mimeType: 'video/VP8',
            clockRate: 90000,
            payloadType: 96,
            parameters: {},
            rtcpFeedback: [
              { type: 'nack' },
              { type: 'nack', parameter: 'pli' },
              { type: 'ccm', parameter: 'fir' },
              { type: 'goog-remb' }
            ]
          }
        ] : [
          {
            mimeType: 'audio/opus', 
            clockRate: 48000,
            payloadType: 111,
            channels: 2,
            parameters: {
              'minptime': '10',
              'useinbandfec': '1'
            },
            rtcpFeedback: []
          }
        ],
        encodings: [
          {
            ssrc: ssrc,
            rtx: kind === 'video' ? { ssrc: ssrc + 1 } : undefined
          }
        ]
      };
      
      // Create producer on the plain transport with the correct RTP parameters
      const producer = await plainTransport.produce({
        kind: kind,
        rtpParameters: producerRtpParameters,
        paused: false,
        appData: { 
          isViewBot: true,
          botId: botId
        }
      });
      
      console.log(`✅ SERVER: ViewBot ${botId} ${kind} producer created: ${producer.id}`);
      
      // Monitor producer and transport for debugging
      producer.on('score', (score) => {
        console.log(`📊 SERVER: ViewBot ${botId} ${kind} producer score:`, score);
      });
      
      producer.on('videoorientationchange', (videoOrientation) => {
        console.log(`📐 SERVER: ViewBot ${botId} video orientation changed:`, videoOrientation);
      });
      
      producer.on('trace', (trace) => {
        console.log(`🔍 SERVER: ViewBot ${botId} ${kind} producer trace:`, trace.type, trace.info);
      });
      
      // Monitor the plain transport tuple for incoming RTP
      plainTransport.on('tuple', (tuple) => {
        console.log(`🔌 SERVER: ViewBot ${botId} ${kind} transport tuple updated:`, tuple);
      });
      
      plainTransport.on('rtcp', (rtcp) => {
        console.log(`📡 SERVER: ViewBot ${botId} ${kind} received RTCP:`, rtcp);
      });
      
      // Get producer stats periodically
      const statsInterval = setInterval(async () => {
        try {
          const stats = await producer.getStats();
          const hasData = stats && stats.length > 0 && stats[0].bytesCount > 0;
          if (hasData) {
            console.log(`📈 SERVER: ViewBot ${botId} ${kind} producer stats:`, stats[0]);
            clearInterval(statsInterval); // Stop once we see data flowing
          }
        } catch (error) {
          clearInterval(statsInterval);
        }
      }, 2000);
      
      // Store producer in MediaSoup service (same as regular users)
      let producerMap = mediasoupService.producers.get(socket.id);
      if (!producerMap) {
        producerMap = new Map();
        mediasoupService.producers.set(socket.id, producerMap);
      }
      producerMap.set(kind, producer);
      
      // Also store the plain transport for cleanup later
      if (!mediasoupService.transports.has(socket.id)) {
        mediasoupService.transports.set(socket.id, plainTransport);
      }
      
      // Check if we have both video and audio producers ready
      const updatedProducerMap = mediasoupService.producers.get(socket.id);
      const hasVideo = updatedProducerMap && updatedProducerMap.has('video');
      const hasAudio = updatedProducerMap && updatedProducerMap.has('audio');
      
      // Only proceed with stream ready notification if both are ready
      // The actual takeover and streamer setting will be handled by request-to-stream event
      if ((hasVideo && kind === 'audio') || (hasAudio && kind === 'video')) {
        console.log(`🎯 SERVER: ViewBot ${botId} has both video and audio producers ready`);
        console.log(`📡 SERVER: ViewBot producers ready - waiting for takeover via request-to-stream`);
      }
      
      // Return the port that FFmpeg should use
      socket.emit('viewbot-producer-created', {
        botId: botId,
        kind: kind,
        producerId: producer.id,
        rtpPort: listenPort, // Tell ViewBot which port to send RTP to
        rtcpPort: rtcpPort
      });
      
    } catch (error) {
      console.error(`❌ SERVER: ViewBot ${kind} plain transport creation failed:`, error);
      
      socket.emit('viewbot-producer-error', {
        botId: botId,
        kind: kind,
        error: error.message
      });
    }
  });

  // Handle graceful degradation viewbot stream request
  socket.on('request-test-stream', async () => {
    console.log(`🧪 GRACEFUL DEGRADATION: Viewbot stream requested by ${socket.id}`);
    
    if (!viewbotService) {
      console.log('⚠️ GRACEFUL DEGRADATION: ViewbotService not available, falling back to test stream');
      
      // Fallback to legacy test stream
      const testStreamStatus = testStreamService.getTestStreamStatus();
      
      if (!testStreamStatus.isActive) {
        const result = testStreamService.startTestStream({ 
          autoGenerated: true, 
          reason: 'graceful_degradation_fallback' 
        });
        
        if (result.success) {
          streamService.setStreamer(result.streamId, 'test');
          console.log('🧪 GRACEFUL DEGRADATION: Auto-started test stream for fallback');
          io.emit('test-stream-available', { streamId: result.streamId });
        }
      } else {
        socket.emit('test-stream-available', { streamId: testStreamStatus.streamId });
      }
      return;
    }
    
    // Check if viewbot is available or start one
    const viewbotStatus = viewbotService.getViewbotStatus();
    
    if (!viewbotStatus.isActive) {
      // Start viewbot automatically for fallback
      const result = await viewbotService.startViewbot({ 
        config: {
          content: 'clock',
          type: 'viewbot'
        },
        autoGenerated: true, 
        reason: 'graceful_degradation_fallback' 
      });
      
      if (result.success) {
        streamService.setStreamer(result.streamId, 'viewbot');
        console.log('🤖 GRACEFUL DEGRADATION: Auto-started viewbot for fallback');
        
        // Create synthetic user ID for viewbot to enable buff/debuff support
        const syntheticUserId = -Math.abs(result.streamId.hashCode ? result.streamId.hashCode() : result.streamId.split('-')[1].slice(0, 8).split('').reduce((a, b) => (a * 31 + b.charCodeAt(0)) & 0x7fffffff, 0));
        console.log(`🎭 BUFF: Created synthetic user ID ${syntheticUserId} for auto-started viewbot ${result.streamId}`);
        
        // Link synthetic user ID to viewbot socket ID for buff system compatibility
        sessionService.linkUserToSocket(result.streamId, syntheticUserId);
        console.log(`🎭 BUFF: Linked auto-started viewbot ${result.streamId} to synthetic user ${syntheticUserId} for buff system`);
        
        // Broadcast global cooldown to all users
        await broadcastGlobalCooldown(result.streamId);
        
        // Notify all viewers about viewbot availability
        io.emit('new-streamer', { 
          streamerId: result.streamId, 
          newStreamId: result.streamId,
          isViewbot: true, 
          hasRealStream: true,
          streamType: 'viewbot' 
        });
        io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
      }
    } else {
      // Viewbot already active, just notify
      socket.emit('viewbot-available', { streamId: viewbotStatus.streamId });
    }
  });

  // Handle streamer sending offer to specific viewer
  socket.on('stream-offer', (data) => {
    const { offer, toViewerId } = data;
    console.log(`Streamer ${socket.id} sending offer to viewer ${toViewerId}`);
    
    io.to(toViewerId).emit('stream-offer', { 
      offer, 
      fromStreamerId: socket.id 
    });
  });

  // Handle viewer sending answer back to streamer
  socket.on('stream-answer', (data) => {
    const { answer, toStreamerId } = data;
    console.log(`Viewer ${socket.id} sending answer to streamer ${toStreamerId}`);
    
    io.to(toStreamerId).emit('stream-answer', { 
      answer, 
      fromViewerId: socket.id 
    });
  });

  // Handle ICE candidates between peers
  socket.on('ice-candidate', (data) => {
    const { candidate, toSocketId, fromSocketId } = data;
    
    if (toSocketId && toSocketId !== 'viewers') {
      // Send to specific socket
      io.to(toSocketId).emit('ice-candidate', { 
        candidate, 
        fromSocketId: socket.id 
      });
    } else {
      // Broadcast to appropriate room
      const currentStreamer = streamService.getCurrentStreamer();
      if (socket.id === currentStreamer) {
        // Streamer sending to all viewers
        socket.to('viewers').emit('ice-candidate', { 
          candidate, 
          fromSocketId: socket.id 
        });
      } else {
        // Viewer sending to streamer
        if (currentStreamer) {
          io.to(currentStreamer).emit('ice-candidate', { 
            candidate, 
            fromSocketId: socket.id 
          });
        }
      }
    }
  });

  socket.on('stop-streaming', async () => {
    if (streamService.getCurrentStreamer() === socket.id) {
      // Update streamer connection disconnect time
      try {
        const clientIP = IPBanService.getIPFromSocket(socket);
        const result = await runAsync(`
          UPDATE streamer_connections 
          SET disconnected_at = datetime('now'),
              stream_duration = (strftime('%s', 'now') - strftime('%s', connected_at)),
              disconnect_reason = 'voluntary_stop'
          WHERE streamer_id = ? AND disconnected_at IS NULL
        `, [socket.id]);
        console.log(`📝 IP TRACKING: Updated disconnect for streamer ${socket.id}`);
      } catch (error) {
        console.error('❌ IP TRACKING: Failed to update disconnect:', error);
      }
      
      // End streaming log session
      await streamingLogsService.endSession(socket.id, 'voluntary_stop');
      
      // End streaming time tracking if user is authenticated
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (session && session.userId) {
        await timeTrackingService.endStreamingSession(session.userId);
        console.log(`📊 TIME: Ended streaming time tracking for user ${session.userId}`);
      }
      
      // Apply individual cooldown when streamer voluntarily stops
      await takeoverService.setSocketCooldown(socket.id, 'voluntary_stream_end');
      console.log(`🔒 COOLDOWN: Applied individual cooldown to ${socket.id} for voluntary stream end`);
      
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;
      
      // Handle continuous recording for stream end
      if (recordingService) {
        recordingService.handleStreamEnd(socket.id).catch(error => {
          console.error('❌ RECORDING: Error handling stream end:', error);
        });
      }
      
      // Clear streamer buff display when streaming ends
      console.log(`🎭 BUFF: Clearing streamer buffs display (streaming ended)`);
      io.emit('streamer-buffs-update', { buffs: [] });
      console.log(`🧹 VOLUNTARY STOP: Cleared ${socket.id} from both services`);
      
      socket.leave('streamer');
      socket.join('viewers');

      io.emit('stream-ended', { reason: 'user_stopped_streaming', previousStreamer: socket.id });
      notifyViewersStreamEnded();
      notifyViewersStreamEnded();
      io.emit('viewer-count-update', sessionService.getUniqueViewerCount());

      console.log(`Stream ended by: ${socket.id}`);

      // CRITICAL: Restart viewbot rotation after real user stops streaming
      // Check if this was a real user (not a viewbot)
      const userId = sessionService.getUserIdBySocketId(socket.id);
      const isViewbot = userId && userId < 0;
      const isLiveKitViewBot = socket.id.startsWith('viewbot-');

      if (!isViewbot && !isLiveKitViewBot && viewBotClientService) {
        console.log(`🔓 VOLUNTARY STOP: Real user ${socket.id} stopped streaming - clearing viewbot protection`);
        viewBotClientService.setRealStreamerStatus(false);

        // Restart viewbot rotation after real user voluntarily stops
        setTimeout(async () => {
          console.log(`🔄 RESTART: Attempting to restart viewbot rotation after voluntary stop`);

          if (global.viewBotRotation && global.viewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting global.viewBotRotation`);
              await global.viewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart global.viewBotRotation:`, e);
            }
          }

          if (SimpleViewBotRotation && SimpleViewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting SimpleViewBotRotation`);
              await SimpleViewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart SimpleViewBotRotation:`, e);
            }
          }
        }, 3000);
      }
    }
  });

  // Handle stop-stream event (used by ViewBots during rotation)
  socket.on('stop-stream', async (data) => {
    console.log(`🛑 STOP-STREAM: Received from ${socket.id} (ViewBot: ${data?.isViewBot}, BotId: ${data?.botId})`);
    
    // Clean up MediaSoup resources immediately
    if (mediasoupService) {
      console.log(`🧹 MEDIASOUP: Cleaning up resources for ${socket.id} on stop-stream`);
      await mediasoupService.cleanupSocketResources(socket.id);
    }
    
    // Clean up Plain Transport resources for ViewBots
    if (data?.isViewBot && data?.botId && plainTransportService) {
      console.log(`🧹 PLAIN TRANSPORT: Cleaning up resources for ViewBot ${data.botId}`);
      await plainTransportService.cleanup(data.botId);
    }
    
    // If this is the current streamer, clear it
    if (streamService.getCurrentStreamer() === socket.id) {
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;

      // Only emit stream-ended if it's not a ViewBot rotation
      if (!data?.isViewBot) {
        io.emit('stream-ended', { reason: 'stop_stream_request', previousStreamer: socket.id });
        notifyViewersStreamEnded();
      }

      console.log(`📺 STOP-STREAM: Cleared streamer ${socket.id} from services`);
    }
  });

  // ViewBot request to create WebRTC transport (mobile-compatible)
  socket.on('viewbot-create-webrtc-transport', async (data, callback) => {
    console.log(`🚀 SERVER: ViewBot ${data.botId} requesting WebRTC transport (mobile-compatible)`);
    
    try {
      // Create WebRTC transport exactly like normal users
      const transportOptions = await mediasoupService.createWebRtcTransport(socket.id, false);
      
      console.log(`✅ SERVER: Created WebRTC transport for ViewBot ${data.botId}`);
      console.log(`   Transport ID: ${transportOptions.id}`);
      console.log(`   ICE candidates: ${transportOptions.iceCandidates?.length || 0}`);
      
      callback({
        success: true,
        transportOptions
      });
      
    } catch (error) {
      console.error(`❌ SERVER: Failed to create WebRTC transport for ViewBot:`, error);
      callback({ success: false, error: error.message });
    }
  });
  
  // ViewBot request to create Plain RTP transport (legacy, not mobile-compatible)
  socket.on('viewbot-create-transport', async (data, callback) => {
    console.log(`🚚 SERVER: ViewBot ${data.botId} requesting Plain RTP transports (LEGACY - not mobile compatible)`);
    
    try {
      // Check if we're using LiveKit backend
      const useAdapter = process.env.USE_WEBRTC_ADAPTER === 'true';
      const backend = process.env.WEBRTC_BACKEND || 'mediasoup';
      const isLiveKit = useAdapter && backend === 'livekit';
      
      if (isLiveKit) {
        // For LiveKit, ViewBots should use GStreamer with whipsink
        // Return special response indicating LiveKit mode
        console.log(`🎮 SERVER: ViewBot ${data.botId} should use LiveKit GStreamer pipeline`);
        
        // Get LiveKit service from adapter
        const livekitService = global.webrtcAdapter._backend;
        
        // Get LiveKit token for the ViewBot
        const token = await livekitService.generateToken(data.botId, {
          canPublish: true,
          canSubscribe: false,
          canPublishData: false
        });
        // Use the nginx-proxied WHIP endpoint for proper SSL handling
        const whipUrl = 'https://onestreamer.live/livekit/rtc';
        
        callback({
          useLiveKit: true,
          token: token,
          whipUrl: whipUrl,
          message: 'Use LiveKit GStreamer pipeline with whipsink'
        });
        return;
      }
      
      // MediaSoup path - create Plain RTP transports
      if (!mediasoupService.router) {
        throw new Error('MediaSoup router not available');
      }
      
      // Create TWO Plain RTP transports - one for video, one for audio
      const videoTransport = await mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',  // Listen on all interfaces
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // CRITICAL: Announce public IP for mobile/TURN
        },
        rtcpMux: false,
        comedia: true  // Auto-detect source
      });
      
      const audioTransport = await mediasoupService.router.createPlainTransport({
        listenIp: {
          ip: '0.0.0.0',  // Listen on all interfaces
          announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>'  // CRITICAL: Announce public IP for mobile/TURN
        },
        rtcpMux: false,
        comedia: true  // Auto-detect source
      });
      
      console.log(`✅ SERVER: Created Plain RTP transports for ViewBot ${data.botId}`);
      console.log(`📡 SERVER: Video RTP port: ${videoTransport.tuple.localPort}`);
      console.log(`📡 SERVER: Audio RTP port: ${audioTransport.tuple.localPort}`);
      
      // Store both transports for this socket
      if (!mediasoupService.transports) {
        mediasoupService.transports = new Map();
      }
      mediasoupService.transports.set(socket.id, {
        video: videoTransport,
        audio: audioTransport,
        botId: data.botId  // Store bot ID for debugging
      });
      console.log(`📦 SERVER: Stored transports for socket ${socket.id} (ViewBot ${data.botId})`);
      
      callback({
        videoTransportId: videoTransport.id,
        audioTransportId: audioTransport.id,
        videoPort: videoTransport.tuple.localPort,
        audioPort: audioTransport.tuple.localPort
      });
    } catch (error) {
      console.error(`❌ SERVER: Failed to create Plain RTP transports:`, error);
      callback({ error: error.message });
    }
  });
  
  // ViewBot request to produce to WebRTC transport (mobile-compatible)
  socket.on('viewbot-webrtc-produce', async (data, callback) => {
    console.log(`🎬 SERVER: ViewBot ${data.botId} producing to WebRTC transport`);

    try {
      // CRITICAL: Check if a real user is currently streaming
      // Viewbots should NEVER override a real streamer
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        console.log(`⛔ SERVER: Blocking viewbot ${data.botId} - real streamer is active`);
        callback({
          success: false,
          error: 'Real streamer is active - viewbot creation blocked'
        });
        return;
      }

      // Check if another streamer (viewbot or URL stream) is already active
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id) {
        // Check if current streamer is a URL stream (they have priority)
        if (currentStreamer.startsWith('url-stream-')) {
          console.log(`⛔ SERVER: Blocking viewbot ${data.botId} - URL stream ${currentStreamer} is active`);
          callback({
            success: false,
            error: 'URL stream is active - viewbot creation blocked'
          });
          return;
        }

        // Check if current streamer has active producers (is actually streaming)
        const currentProducers = mediasoupService.producers?.get(currentStreamer);
        if (currentProducers && currentProducers.size > 0) {
          console.log(`⛔ SERVER: Blocking viewbot ${data.botId} - another streamer ${currentStreamer} has active producers`);
          callback({
            success: false,
            error: 'Another streamer is active - viewbot creation blocked'
          });
          return;
        }
      }

      const transport = mediasoupService.transports.get(socket.id);
      if (!transport) {
        throw new Error('WebRTC transport not found');
      }
      
      // Create producers with predefined RTP parameters for viewbots
      // These match what GStreamer will send
      const videoRtpParameters = {
        codecs: [{
          mimeType: 'video/h264',
          payloadType: 102,
          clockRate: 90000,
          parameters: {
            'level-asymmetry-allowed': 1,
            'packetization-mode': 1,
            'profile-level-id': '42e01f'
          }
        }],
        encodings: [{
          ssrc: 11111111,
          dtx: false
        }]
      };
      
      const audioRtpParameters = {
        codecs: [{
          mimeType: 'audio/opus',
          payloadType: 101,
          clockRate: 48000,
          channels: 2,
          parameters: {
            'sprop-stereo': 1,
            'useinbandfec': 1
          }
        }],
        encodings: [{
          ssrc: 22222222,
          dtx: false
        }]
      };
      
      // Create producers
      const videoProducer = await mediasoupService.createProducer(socket.id, videoRtpParameters, 'video');
      const audioProducer = await mediasoupService.createProducer(socket.id, audioRtpParameters, 'audio');
      
      console.log(`✅ SERVER: Created WebRTC producers for ViewBot ${data.botId}`);
      
      // Mark as viewbot producers
      if (videoProducer && videoProducer.producer) {
        videoProducer.producer.appData = { ...videoProducer.producer.appData, isViewBot: true };
      }
      if (audioProducer && audioProducer.producer) {
        audioProducer.producer.appData = { ...audioProducer.producer.appData, isViewBot: true };
      }
      
      callback({
        success: true,
        videoProducerId: videoProducer?.producer?.id,
        audioProducerId: audioProducer?.producer?.id
      });
      
    } catch (error) {
      console.error(`❌ SERVER: Failed to create WebRTC producers for ViewBot:`, error);
      callback({ success: false, error: error.message });
    }
  });
  
  // ViewBot request to create producers
  socket.on('viewbot-create-producers', async (data, callback) => {
    console.log(`🎤 SERVER: ViewBot ${data.botId} requesting to create producers`);
    console.log(`🔍 SERVER: Looking for transports for socket ${socket.id}`);
    console.log(`🔍 SERVER: Available transports: ${mediasoupService.transports ? mediasoupService.transports.size : 0}`);

    try {
      // CRITICAL: Check if a real user is currently streaming
      // Viewbots should NEVER override a real streamer
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        console.log(`⛔ SERVER: Blocking viewbot ${data.botId} producer creation - real streamer is active`);
        callback({
          success: false,
          error: 'Real streamer is active - viewbot creation blocked'
        });
        return;
      }

      // Check if another streamer (viewbot or URL stream) is already active
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id) {
        // Check if current streamer is a URL stream (they have priority)
        if (currentStreamer.startsWith('url-stream-')) {
          console.log(`⛔ SERVER: Blocking viewbot ${data.botId} producer creation - URL stream ${currentStreamer} is active`);
          callback({
            success: false,
            error: 'URL stream is active - viewbot creation blocked'
          });
          return;
        }

        // Check if current streamer has active producers (is actually streaming)
        const currentProducers = mediasoupService.producers?.get(currentStreamer);
        if (currentProducers && currentProducers.size > 0) {
          console.log(`⛔ SERVER: Blocking viewbot ${data.botId} producer creation - another streamer ${currentStreamer} has active producers`);
          callback({
            success: false,
            error: 'Another streamer is active - viewbot creation blocked'
          });
          return;
        }
      }

      const transports = mediasoupService.transports?.get(socket.id);
      if (!transports || !transports.video || !transports.audio) {
        console.error(`❌ SERVER: Transports not found for socket ${socket.id}`);
        console.error(`   Available sockets: ${mediasoupService.transports ? Array.from(mediasoupService.transports.keys()).join(', ') : 'none'}`);
        throw new Error('Transports not found');
      }
      
      // Create video producer on video transport (Plain RTP doesn't use MID)
      const videoProducer = await transports.video.produce({
        kind: 'video',
        rtpParameters: {
          codecs: [{
            mimeType: 'video/h264',
            payloadType: 102,
            clockRate: 90000,
            parameters: {
              'level-asymmetry-allowed': 1,
              'packetization-mode': 1,
              'profile-level-id': '42e01f'
            }
          }],
          encodings: [{ ssrc: 11111111 }]
        }
      });
      
      // Create audio producer on audio transport (Plain RTP doesn't use MID)
      const audioProducer = await transports.audio.produce({
        kind: 'audio',
        rtpParameters: {
          codecs: [{
            mimeType: 'audio/opus',
            payloadType: 101,
            clockRate: 48000,
            channels: 2,
            parameters: {
              'sprop-stereo': 1,
              'useinbandfec': 1
            }
          }],
          encodings: [{ ssrc: 22222222 }]
        }
      });
      
      // Store producers for this socket
      if (!mediasoupService.producers.has(socket.id)) {
        mediasoupService.producers.set(socket.id, new Map());
      }
      const producerMap = mediasoupService.producers.get(socket.id);
      producerMap.set('video', videoProducer);
      producerMap.set('audio', audioProducer);
      
      console.log(`✅ SERVER: Created producers for ViewBot ${data.botId}`);
      console.log(`   Video Producer ID: ${videoProducer.id}`);
      console.log(`   Audio Producer ID: ${audioProducer.id}`);
      
      callback({
        success: true,
        videoProducerId: videoProducer.id,
        audioProducerId: audioProducer.id
      });
    } catch (error) {
      console.error(`❌ SERVER: Failed to create producers:`, error);
      callback({ error: error.message });
    }
  });
  
  // ViewBot stream ready notification
  socket.on('viewbot-stream-ready', async (data) => {
    console.log(`📺 SERVER: ViewBot ${data.botId} reports stream ready, triggering stream switch`);

    try {
      // CRITICAL: Check if a real user is currently streaming
      // Don't emit stream-ready for viewbots if real streamer is active
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        console.log(`⛔ STREAM-READY: Blocking viewbot ${data.botId} stream-ready - real streamer is active`);
        return;
      }

      // Check if another non-viewbot streamer is active (e.g., URL stream)
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id && currentStreamer.startsWith('url-stream-')) {
        console.log(`⛔ STREAM-READY: Blocking viewbot ${data.botId} stream-ready - URL stream ${currentStreamer} is active`);
        return;
      }

      const emitTimestamp = Date.now();

      // DEDUP: Check if we already emitted for this stream recently
      if (lastEmittedStreamReady.streamerId === socket.id &&
          (emitTimestamp - lastEmittedStreamReady.timestamp) < 2000) {
        console.log(`⏭️ STREAM-READY: Skipping duplicate viewbot-stream-ready emission for ${socket.id}`);
        return;
      }

      // Emit stream-ready to trigger viewer consumption
      io.emit('stream-ready', {
        streamerId: socket.id,
        isViewBot: true,
        streamType: 'viewbot',
        botId: data.botId,
        timestamp: emitTimestamp
      });

      lastEmittedStreamReady = { streamerId: socket.id, timestamp: emitTimestamp };
      console.log(`✅ SERVER: Stream-ready notification sent for ViewBot ${data.botId}`);
      
    } catch (error) {
      console.error(`❌ SERVER: Failed to handle ViewBot stream ready for ${data.botId}:`, error);
    }
  });

  // ViewBot rotation request handler
  socket.on('viewbot-rotation-request', async (data) => {
    console.log(`🔄 SERVER: ViewBot rotation request from ${data.botId} (reason: ${data.reason})`);
    
    if (!viewBotClientService) {
      console.error(`❌ SERVER: ViewBotClientService not available for rotation request`);
      return;
    }
    
    // CRITICAL FIX: Check if rotation is enabled before processing request
    if (!viewBotClientService.rotationEnabled) {
      console.log(`🚫 SERVER: ViewBot rotation request ignored - rotation system disabled`);
      return;
    }
    
    try {
      const result = await viewBotClientService.handleRotationRequest(data.botId, data.reason);
      
      if (result.success) {
        console.log(`✅ SERVER: ViewBot rotation completed: ${result.previousBot} → ${result.newBot}`);
        
        // Notify all admins about the rotation
        io.emit('viewbot-rotation-completed', {
          previousBot: result.previousBot,
          newBot: result.newBot,
          reason: data.reason,
          timestamp: Date.now()
        });
      } else {
        console.log(`⚠️ SERVER: ViewBot rotation failed: ${result.message}`);
      }
      
    } catch (error) {
      console.error(`❌ SERVER: Failed to handle ViewBot rotation request from ${data.botId}:`, error);
    }
  });

  // Handle when a ViewBot video file ends naturally
  socket.on('viewbot-video-ended', async (data) => {
    console.log(`🎬 SERVER: ViewBot ${data.botId} video file ended: ${data.videoFile}`);
    
    // Use the global viewBotRotation service
    if (!global.viewBotRotation) {
      console.error(`❌ SERVER: ViewBotRotation service not available for video-ended event`);
      return;
    }
    
    // Only trigger rotation if rotation is enabled
    if (!global.viewBotRotation.enabled) {
      console.log(`🚫 SERVER: ViewBot video ended but rotation is disabled`);
      return;
    }
    
    try {
      // Force a rotation to the next video
      console.log(`🔄 SERVER: Triggering rotation after video ended for ViewBot ${data.botId}`);
      await global.viewBotRotation.rotateToNextBot();
      
      console.log(`✅ SERVER: Rotation triggered successfully after video end`);
      
      // Notify admins
      io.emit('viewbot-rotation-after-video-end', {
        previousBot: data.botId,
        previousVideo: data.videoFile,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error(`❌ SERVER: Error handling video-ended event:`, error);
    }
  });

  // Mediasoup WebRTC events
  // Handle MediaSoup RTP capabilities request (for ViewBots and regular clients)
  socket.on('mediasoup:get-rtp-capabilities', async (data, callback) => {
    try {
      const rtpCapabilities = await mediasoupService.getRouterRtpCapabilities();
      console.log(`📊 MEDIASOUP: Sent RTP capabilities to ${socket.id}`);
      callback({ success: true, rtpCapabilities });
    } catch (error) {
      console.error(`❌ MEDIASOUP: Failed to get RTP capabilities for ${socket.id}:`, error);
      callback({ success: false, error: error.message });
    }
  });

  // Handle MediaSoup send transport creation (for ViewBots and regular clients)
  socket.on('mediasoup:create-send-transport', async (data, callback) => {
    try {
      const transport = await mediasoupService.createWebRtcTransport(socket.id);
      console.log(`📡 MEDIASOUP: Send transport created for ${socket.id}`);
      callback({ success: true, ...transport });
    } catch (error) {
      console.error(`❌ MEDIASOUP: Failed to create send transport for ${socket.id}:`, error);
      callback({ success: false, error: error.message });
    }
  });

  // Handle MediaSoup transport connection (for ViewBots and regular clients) 
  socket.on('mediasoup:connect-transport', async (data, callback) => {
    try {
      const { dtlsParameters, transportId } = data;
      
      // All clients including viewbots use the same connection flow
      await mediasoupService.connectTransport(socket.id, dtlsParameters);
      console.log(`🔗 MEDIASOUP: Transport connected for ${socket.id}`);
      callback({ success: true });
    } catch (error) {
      console.error(`❌ MEDIASOUP: Failed to connect transport for ${socket.id}:`, error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('mediasoup:produce', async (data, callback) => {
    try {
      const { kind, rtpParameters, transportId } = data;
      
      // Get user info for debugging
      const session = sessionService.getSessionBySocketId(socket.id);
      const username = session?.username || 'unknown';
      const userAgent = socket.handshake?.headers?.['user-agent'] || 'unknown';
      const ip = socket.handshake?.address || 'unknown';
      
      console.log(`🎬 MEDIASOUP PRODUCE: Request from ${username} (${socket.id})`);
      console.log(`📱 User Agent: ${userAgent}`);
      console.log(`🌐 IP: ${ip}`);
      console.log(`🎥 Track kind: ${kind}, Transport ID: ${transportId}`);
      
      // Check if there's already an active streamer
      const currentStreamer = streamService.getCurrentStreamer();
      const wasNewStreamer = currentStreamer !== socket.id;
      
      // Check if current user is a real user (positive user ID or no session)
      const isRealUser = !session?.userId || session.userId > 0;
      
      // Check if current streamer is a viewbot (negative user ID)
      let currentStreamerIsViewbot = false;
      if (currentStreamer) {
        const currentStreamerSession = sessionService.getSessionBySocketId(currentStreamer);
        currentStreamerIsViewbot = currentStreamerSession?.userId && currentStreamerSession.userId < 0;
      }
      
      // Allow real users to override viewbots, but prevent viewbots from overriding real users
      if (currentStreamer && wasNewStreamer) {
        if (isRealUser && currentStreamerIsViewbot) {
          console.log(`✅ MEDIASOUP: Real user ${socket.id} (${username}) overriding viewbot streamer ${currentStreamer}`);
          // Clear the viewbot streamer
          streamService.clearStreamer();
          mediasoupService.currentStreamer = null;
        } else if (!isRealUser && !currentStreamerIsViewbot) {
          console.log(`⚠️ MEDIASOUP: Blocking viewbot ${socket.id} - real user ${currentStreamer} is streaming`);
          callback({ 
            success: false, 
            error: 'A real user is currently streaming.' 
          });
          return;
        } else if (!isRealUser && currentStreamerIsViewbot) {
          console.log(`⚠️ MEDIASOUP: Blocking viewbot ${socket.id} - another viewbot ${currentStreamer} is streaming`);
          callback({ 
            success: false, 
            error: 'Another viewbot is currently streaming.' 
          });
          return;
        } else {
          console.log(`⚠️ MEDIASOUP: Blocking produce attempt from ${socket.id} - active streamer is ${currentStreamer}`);
          callback({ 
            success: false, 
            error: 'Another user is currently streaming. Please request takeover first.' 
          });
          return;
        }
      }
      
      console.log(`🔍 MEDIASOUP: Before producer creation - current streamer: ${currentStreamer}, this socket: ${socket.id}, wasNewStreamer: ${wasNewStreamer}`);
      
      // ViewBots now use the same producer creation as regular users
      const result = await mediasoupService.createProducer(socket.id, rtpParameters, kind);
      console.log(`✅ Producer created: ${result.id} for ${username} (${kind})`)
      
      // Only update stream service if this is the first producer or the current streamer
      if (!currentStreamer || socket.id === currentStreamer) {
        streamService.setStreamer(socket.id, 'webrtc');
        socket.join('streamer');
        socket.leave('viewers');
      }
      
      // Enhanced producer readiness checking with better race condition handling
      const producerMap = mediasoupService.producers.get(socket.id);
      const hasVideo = producerMap && producerMap.has('video');
      const hasAudio = producerMap && producerMap.has('audio');
      const hasBothTracks = hasVideo && hasAudio;
      
      console.log(`🎬 MEDIASOUP: Producer created - streamer: ${socket.id}, kind: ${kind}, wasNewStreamer: ${wasNewStreamer}, notified: ${notifiedStreamers.has(socket.id)}`);
      
      // console.log(`🔍 MEDIASOUP DEBUG: Checking notification conditions for ${socket.id}:`);
      // console.log(`🔍   wasNewStreamer: ${wasNewStreamer}`);
      // console.log(`🔍   notifiedStreamers.has(${socket.id}): ${notifiedStreamers.has(socket.id)}`);
      // console.log(`🔍   Current streamer: ${mediasoupService.getCurrentStreamer()}`);
      // console.log(`🔍   notifiedStreamers Set:`, Array.from(notifiedStreamers));
      
      // Notify viewers if this is a new streamer OR if we haven't notified about this streamer yet
      // This handles both fresh streams and takeover scenarios where the streamer changes
      if ((wasNewStreamer || !notifiedStreamers.has(socket.id)) && mediasoupService.getCurrentStreamer() === socket.id) {
        console.log(`🎬 MEDIASOUP: Processing new streamer ${socket.id} with ${kind} track (video: ${hasVideo}, audio: ${hasAudio})`);
        
        // Emit stream-ready for any functional producers (don't wait for both tracks)
        let emitReady = false;
        let readyHasVideo = false;
        let readyHasAudio = false;
        
        if (hasVideo) {
          const videoProducer = producerMap.get('video');
          if (videoProducer && !videoProducer.closed) {
            readyHasVideo = true;
            emitReady = true;
          }
        }
        
        if (hasAudio) {
          const audioProducer = producerMap.get('audio');
          if (audioProducer && !audioProducer.closed) {
            readyHasAudio = true;
            emitReady = true;
          }
        }
        
        if (emitReady) {
          console.log(`✅ MEDIASOUP: Producer(s) verified for ${socket.id} (video: ${readyHasVideo}, audio: ${readyHasAudio}), notifying viewers`);
          
          // Immediately mark as notified to prevent race conditions between video/audio producers
          if (!notifiedStreamers.has(socket.id)) {
            notifiedStreamers.add(socket.id);
            
            // Add a small delay to ensure MediaSoup internal state is consistent
            setTimeout(async () => {
              // Double-check that we're still the current streamer
              if (mediasoupService.getCurrentStreamer() === socket.id) {
                const streamerDisplayName = await getStreamerDisplayName(socket.id);
                
                // Emit producer-verified event for clients waiting specifically for producer readiness
                io.emit('producer-verified', {
                  streamerId: socket.id,
                  hasVideo: readyHasVideo,
                  hasAudio: readyHasAudio,
                  timestamp: Date.now()
                });
                console.log(`✅ MEDIASOUP: Producer verified for ${socket.id} (video: ${readyHasVideo}, audio: ${readyHasAudio})`);

                // Use verified emission helper for LiveKit backend track verification
                await verifyAndEmitStreamReady(socket.id, {
                  streamType: 'webrtc',
                  hasVideo: readyHasVideo,
                  hasAudio: readyHasAudio,
                  streamStartTime: streamService.streamStartTime
                });
                console.log(`📡 STREAM-READY: Regular streamer ${socket.id} ready emission completed`);
              
              // Visual effects sync temporarily disabled to debug rotate_90 issue
              // try {
              //   const activeVisualEffects = await getActiveVisualEffects();
              //   if (activeVisualEffects.length > 0) {
              //     console.log(`🎨 VISUAL FX: Broadcasting ${activeVisualEffects.length} active effects with stream-ready`);
              //     
              //     // Broadcast visual effects state to all clients
              //     io.emit('visual-effects-state', {
              //       effects: activeVisualEffects.map(buff => ({
              //         effectId: buff.item_name,
              //         itemName: buff.item_name,
              //         displayName: buff.display_name,
              //         remainingSeconds: buff.remaining_seconds,
              //         effectData: buff.effect_data
              //       })),
              //       streamId: socket.id
              //     });
              //   }
              // } catch (error) {
              //   console.error('❌ VISUAL FX: Error broadcasting effects with stream-ready:', error);
              // }
              
              // Handle continuous recording now that producers are ready
              if (recordingService) {
                recordingService.handleStreamStart(socket.id).catch(error => {
                  console.error('❌ RECORDING: Error handling stream start:', error);
                });
              }
              
              // Handle auto-start transcription if enabled
              if (transcriptionService && 
                  transcriptionService.config.enableTranscription && 
                  transcriptionService.config.autoStart) {
                console.log('🎙️ AUTO-START: Starting transcription automatically for stream');
                transcriptionService.startTranscription(socket.id).then(result => {
                  if (result.success) {
                    console.log(`✅ AUTO-START: Transcription started: ${result.sessionId}`);
                    io.emit('transcription-started', {
                      sessionId: result.sessionId,
                      streamerId: socket.id,
                      startTime: result.startTime,
                      autoStarted: true
                    });
                  } else {
                    console.error(`❌ AUTO-START: Failed to start transcription: ${result.error}`);
                  }
                }).catch(error => {
                  console.error('❌ AUTO-START: Error starting transcription:', error);
                });
              }
              
              io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
              
              // Start view time tracking for existing viewers
              notifyViewersStreamStarted();
              
              await broadcastGlobalCooldown(socket.id);
            }
          }, 250); // Small delay for MediaSoup stability
          }
        } else {
          console.log(`⚠️ MEDIASOUP: ${socket.id} already notified or not ready to emit (video: ${readyHasVideo}, audio: ${readyHasAudio})`);
        }
        
        // Always set up fallback notification for reliability
        setTimeout(async () => {
          if (mediasoupService.getCurrentStreamer() === socket.id && !notifiedStreamers.has(socket.id)) {
            const currentProducerMap = mediasoupService.producers.get(socket.id);
            const currentHasVideo = currentProducerMap && currentProducerMap.has('video') && !currentProducerMap.get('video')?.closed;
            const currentHasAudio = currentProducerMap && currentProducerMap.has('audio') && !currentProducerMap.get('audio')?.closed;
            
            console.log(`🎬 MEDIASOUP: Fallback notification for ${socket.id} (video: ${currentHasVideo}, audio: ${currentHasAudio})`);
            notifiedStreamers.add(socket.id);

            // Use verified emission helper for LiveKit backend track verification
            await verifyAndEmitStreamReady(socket.id, {
              streamType: 'webrtc',
              hasVideo: currentHasVideo,
              hasAudio: currentHasAudio,
              streamStartTime: streamService.streamStartTime
            });
            io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
            
            // Start view time tracking for existing viewers
            notifyViewersStreamStarted();
            
            await broadcastGlobalCooldown(socket.id);
          }
        }, 4000); // Extended timeout for better reliability
      } else {
        console.log(`🎬 MEDIASOUP: Existing streamer ${socket.id} producing additional ${kind} track`);
      }
      
      callback({ success: true, producerId: result.id });
      console.log(`🎬 MEDIASOUP: ${socket.id} started producing ${kind}`);
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to create producer:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('mediasoup:consume', async (data, callback) => {
    try {
      const { rtpCapabilities, kind } = data;
      const currentStreamer = mediasoupService.getCurrentStreamer();
      
      // console.log(`📺 MEDIASOUP: ${socket.id} requesting to consume ${kind || 'any'} from streamer ${currentStreamer}`);
      // console.log(`🔍 MEDIASOUP DEBUG: StreamService current streamer: ${streamService.getCurrentStreamer()}`);
      // console.log(`🔍 MEDIASOUP DEBUG: MediasoupService current streamer: ${mediasoupService.getCurrentStreamer()}`);
      
      if (!currentStreamer) {
        // console.log(`❌ MEDIASOUP: ${socket.id} tried to consume but no active streamer`);
        callback({ success: false, error: 'No active streamer available' });
        return;
      }

      // Verify producer exists and is functional before attempting consumption
      const producerMap = mediasoupService.producers.get(currentStreamer);
      if (!producerMap || producerMap.size === 0) {
        console.log(`⚠️ MEDIASOUP: ${socket.id} tried to consume from ${currentStreamer} but no producers found yet`);
        console.log(`📺 MEDIASOUP: Streamer ${currentStreamer} is registered but may still be setting up media stream`);
        callback({ success: false, error: `Streamer ${currentStreamer} is preparing stream - please wait` });
        return;
      }

      // If specific kind requested, check if that producer exists and is functional
      if (kind) {
        const specificProducer = producerMap.get(kind);
        if (!specificProducer || specificProducer.closed) {
          console.log(`❌ MEDIASOUP: ${socket.id} requested ${kind} from ${currentStreamer} but producer not available or closed`);
          callback({ success: false, error: `No ${kind} producer available from streamer ${currentStreamer}` });
          return;
        }
      }

      console.log(`📺 MEDIASOUP: ${socket.id} attempting to consume ${kind || 'any'} from ${currentStreamer} (producers: ${producerMap.size})`);

      const result = await mediasoupService.createConsumer(
        socket.id, 
        currentStreamer, 
        rtpCapabilities,
        kind // Pass the requested track kind
      );
      
      if (result) {
        // Check if the producer is a viewbot (Plain RTP)
        const isViewbotProducer = currentStreamer.includes('viewbot') || 
                                 currentStreamer.includes('bot-') ||
                                 // Check producer metadata
                                 producerMap?.values()?.next()?.value?.appData?.isViewBot;
        
        callback({ 
          success: true, 
          consumer: result, 
          streamerId: currentStreamer,
          isViewbotStream: isViewbotProducer 
        });
        console.log(`✅ MEDIASOUP: ${socket.id} successfully consuming ${kind || 'media'} from ${currentStreamer} (viewbot: ${isViewbotProducer})`);
      } else {
        callback({ success: false, error: `Cannot create consumer for ${kind || 'media'}` });
      }
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to create consumer:', error);
      callback({ success: false, error: error.message });
    }
  });

  socket.on('mediasoup:resume-consumer', async (data, callback) => {
    try {
      const { consumerId } = data;
      await mediasoupService.resumeConsumer(socket.id, consumerId);
      callback({ success: true });
      console.log(`▶️ MEDIASOUP: ${socket.id} resumed consumer ${consumerId}`);
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to resume consumer:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Handle keyframe requests for iOS video decoder issues
  socket.on('mediasoup:request-keyframe', async (data, callback) => {
    try {
      const { consumerId } = data;
      const consumer = mediasoupService.getConsumer(socket.id, consumerId);
      
      if (!consumer) {
        throw new Error('Consumer not found');
      }
      
      // Request keyframe from the producer
      if (consumer.kind === 'video') {
        console.log(`📱 iOS: Requesting keyframe for consumer ${consumerId}`);
        await consumer.requestKeyFrame();
      }
      
      callback({ success: true });
    } catch (error) {
      console.error('❌ MEDIASOUP: Failed to request keyframe:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Buff/Debuff related socket events
  socket.on('apply-buff-item', async (data) => {
    try {
      let { targetUserId, itemId } = data;
      
      // Get the authenticated user ID
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (!session || !session.userId) {
        socket.emit('buff-error', { error: 'Authentication required' });
        return;
      }

      const appliedByUserId = session.userId;

      // Handle viewbot target - convert socket ID to synthetic user ID
      if (viewbotService && viewbotService.isViewbotStream(targetUserId)) {
        const syntheticUserId = sessionService.getUserIdBySocketId(targetUserId);
        if (syntheticUserId) {
          console.log(`🎭 BUFF SOCKET: Translating viewbot ${targetUserId} to synthetic user ${syntheticUserId}`);
          targetUserId = syntheticUserId;
        } else {
          socket.emit('buff-error', { error: 'Viewbot target not properly initialized for buff system' });
          return;
        }
      } else if (viewbotService && sessionService && streamService) {
        // Additional check: If client sent current streamer's user ID and current streamer is a viewbot
        const currentStreamer = streamService.getCurrentStreamer();
        
        if (currentStreamer && viewbotService.isViewbotStream(currentStreamer)) {
          // Check if the targetUserId might be the current streamer's user ID
          const currentStreamerUserId = sessionService.getUserIdBySocketId(currentStreamer);
          
          // Convert targetUserId to number for comparison if it's a string
          const targetUserIdNum = typeof targetUserId === 'string' ? parseInt(targetUserId, 10) : targetUserId;
          
          if (currentStreamerUserId && (targetUserIdNum === Math.abs(currentStreamerUserId))) {
            console.log(`🎯 BUFF SOCKET: Client sent current streamer user ID, translating to viewbot`);
            console.log(`🎭 BUFF SOCKET: Converting user ID ${targetUserId} to viewbot synthetic user ${currentStreamerUserId}`);
            targetUserId = currentStreamerUserId; // This should be the negative synthetic user ID
          }
        }
      }

      console.log(`🎯 BUFF SOCKET: Final targetUserId after all processing: ${targetUserId} (type: ${typeof targetUserId})`);

      // Apply the buff/debuff
      const result = await itemService.applyBuffDebuffItem(
        targetUserId,
        itemId,
        appliedByUserId,
        buffDebuffService
      );

      // Consume the item from inventory
      await inventoryService.removeItemFromInventory(appliedByUserId, itemId, 1);

      socket.emit('buff-applied-success', { buff: result });
      
      // Only broadcast if target is not a viewbot (viewbots have synthetic negative user IDs)
      if (targetUserId >= 0) {
        // Also broadcast to the target user if they're online (only for human users)
        io.emit('user-buff-update', { 
          userId: targetUserId, 
          buffs: await buffDebuffService.getActiveBuffsForUser(targetUserId) 
        });
      } else {
        console.log(`🎭 BUFF: Skipping broadcast for viewbot user ${targetUserId} - buffs applied silently`);
      }

    } catch (error) {
      console.error('Socket buff application error:', error);
      socket.emit('buff-error', { error: error.message });
    }
  });

  socket.on('get-my-buffs', async () => {
    try {
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (!session || !session.userId) {
        socket.emit('buff-error', { error: 'Authentication required' });
        return;
      }

      const buffs = await buffDebuffService.getActiveBuffsForUser(session.userId);
      socket.emit('my-buffs-update', { buffs });

    } catch (error) {
      console.error('Socket get buffs error:', error);
      socket.emit('buff-error', { error: error.message });
    }
  });

  socket.on('get-streamer-buffs', async () => {
    try {
      const buffs = await buffDebuffService.getActiveBuffsForCurrentStreamer();
      socket.emit('streamer-buffs-update', { buffs });

    } catch (error) {
      console.error('Socket get streamer buffs error:', error);
      socket.emit('buff-error', { error: error.message });
    }
  });

  socket.on('remove-my-buff', async (data) => {
    try {
      const { buffId } = data;
      
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (!session || !session.userId) {
        socket.emit('buff-error', { error: 'Authentication required' });
        return;
      }

      // Get buff to verify ownership
      const buff = await buffDebuffService.getBuffById(buffId);
      if (!buff || buff.user_id != session.userId) {
        socket.emit('buff-error', { error: 'Buff not found or not owned by you' });
        return;
      }

      const success = await buffDebuffService.removeBuff(buffId, 'user_removed');
      if (success) {
        socket.emit('buff-removed-success', { buffId });
        
        // Update user's buff list
        const updatedBuffs = await buffDebuffService.getActiveBuffsForUser(session.userId);
        socket.emit('my-buffs-update', { buffs: updatedBuffs });
      } else {
        socket.emit('buff-error', { error: 'Failed to remove buff' });
      }

    } catch (error) {
      console.error('Socket remove buff error:', error);
      socket.emit('buff-error', { error: error.message });
    }
  });

  // Canvas effects handlers
  canvasFxService.handleClientConnection(socket);
  
  // Visual effects handlers - sync active visual effects to new clients
  visualFxService.handleClientConnection(socket);
  
  // Drawing path broadcast handler
  socket.on('drawing-path-complete', (data) => {
    console.log('✏️ DRAWING: Received drawing path from client', socket.id);
    // Broadcast to all other clients (not back to sender)
    socket.broadcast.emit('drawing-path-broadcast', data);
  });
  
  // Real-time drawing start broadcast handler  
  socket.on('drawing-path-start', (data) => {
    // Broadcast to all other clients (not back to sender) for real-time updates
    socket.broadcast.emit('drawing-start-broadcast', data);
  });
  
  // Real-time drawing segment broadcast handler
  socket.on('drawing-path-update', (data) => {
    // Broadcast to all other clients (not back to sender) for real-time updates
    socket.broadcast.emit('drawing-segment-broadcast', data);
  });
  
  // Admin connection management handlers
  socket.on('admin-message', async (data) => {
    const { targetSocketId, message, adminKey } = data;
    
    // Verify admin key
    if (adminKey !== process.env.ADMIN_KEY) {
      console.log('❌ ADMIN: Invalid admin key for message');
      return;
    }
    
    // Find target socket and send message
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('admin-notification', {
        message: message,
        timestamp: Date.now(),
        type: 'info'
      });
      console.log(`💬 ADMIN: Message sent to ${targetSocketId}`);
    }
  });
  
  socket.on('admin-kick', async (data) => {
    const { targetSocketId, adminKey } = data;
    
    // Verify admin key
    if (adminKey !== process.env.ADMIN_KEY) {
      console.log('❌ ADMIN: Invalid admin key for kick');
      return;
    }
    
    // Find target socket and disconnect
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('admin-notification', {
        message: 'You have been disconnected by an administrator',
        timestamp: Date.now(),
        type: 'error'
      });
      
      setTimeout(() => {
        targetSocket.disconnect(true);
        console.log(`🚫 ADMIN: Kicked connection ${targetSocketId}`);
      }, 1000);
    }
  });

  // ============================================
  // Game System Socket Handlers
  // ============================================

  // Admin: Start game
  socket.on('admin:start-game', async (data, callback) => {
    try {
      // Check if user is admin
      const session = sessionService.getSessionBySocketId(socket.id);
      const userId = session?.userId;

      if (!userId) {
        console.log('🎮 GAME: Unauthenticated user tried to start game');
        if (callback) callback({ success: false, error: 'Authentication required' });
        return;
      }

      // Get user from database to check admin status
      const user = await accountService.getUserById(userId);
      if (!user || !user.is_admin) {
        console.log('🎮 GAME: Non-admin tried to start game');
        if (callback) callback({ success: false, error: 'Admin privileges required' });
        return;
      }

      console.log(`🎮 GAME: Admin ${userId} starting game`);

      const result = await gameStreamService.startGameStream(userId);

      if (callback) callback(result);
    } catch (error) {
      console.error('🎮 GAME: Error starting game:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Admin: Stop game
  socket.on('admin:stop-game', async (data, callback) => {
    try {
      // Check if user is admin
      const session = sessionService.getSessionBySocketId(socket.id);
      const userId = session?.userId;

      if (!userId) {
        console.log('🎮 GAME: Unauthenticated user tried to stop game');
        if (callback) callback({ success: false, error: 'Authentication required' });
        return;
      }

      // Get user from database to check admin status
      const user = await accountService.getUserById(userId);
      if (!user || !user.is_admin) {
        console.log('🎮 GAME: Non-admin tried to stop game');
        if (callback) callback({ success: false, error: 'Admin privileges required' });
        return;
      }

      console.log(`🎮 GAME: Admin ${userId} stopping game`);

      const result = await gameStreamService.stopGameStream(userId);

      if (callback) callback(result);
    } catch (error) {
      console.error('🎮 GAME: Error stopping game:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Admin: Get game status
  socket.on('admin:game-status', async (data, callback) => {
    try {
      const status = gameStreamService.getStatus();
      if (callback) callback({ success: true, status });
    } catch (error) {
      console.error('🎮 GAME: Error getting status:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Player: Join game
  socket.on('game:join', async (data) => {
    try {
      if (!gameService.isActive) {
        socket.emit('game:error', { message: 'Game not active', code: 'GAME_NOT_ACTIVE' });
        return;
      }

      // Get user from session
      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session || !session.userId) {
        socket.emit('game:error', { message: 'Must be logged in to play', code: 'NOT_AUTHENTICATED' });
        return;
      }

      const userId = session.userId;
      const userData = session.userData || {};

      console.log(`🎮 GAME: Player ${userData.username || userId} joining game`);

      const player = await gameService.handlePlayerJoin(socket, userId, {
        username: userData.username || `Player${userId}`,
        chatColor: userData.chat_color
      });

      if (player) {
        socket.emit('game:joined', {
          playerId: player.id,
          player: gameService.playerManager.getPlayerFullState(player)
        });
      }
    } catch (error) {
      console.error('🎮 GAME: Error joining game:', error);
      socket.emit('game:error', { message: 'Failed to join game', code: 'JOIN_ERROR' });
    }
  });

  // Player: Leave game
  socket.on('game:leave', async () => {
    try {
      const session = sessionService.getSessionBySocketId(socket.id);
      if (session?.userId) {
        await gameService.handlePlayerLeave(session.userId, socket.id);
        console.log(`🎮 GAME: Player ${session.userId} left game`);
      }
    } catch (error) {
      console.error('🎮 GAME: Error leaving game:', error);
    }
  });

  // Player: Send input (movement/actions)
  socket.on('game:input', (data) => {
    try {
      if (!gameService.isActive) return;

      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session?.userId) return;

      gameService.handlePlayerInput(session.userId, data);
    } catch (error) {
      console.error('🎮 GAME: Error processing input:', error);
    }
  });

  // Player: Use item
  socket.on('game:use-item', (data) => {
    try {
      if (!gameService.isActive) return;

      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session?.userId) return;

      gameService.handlePlayerInput(session.userId, {
        type: 'action',
        action: { type: 'use-item', itemId: data.itemId }
      });
    } catch (error) {
      console.error('🎮 GAME: Error using item:', error);
    }
  });

  // Player: Interact with world
  socket.on('game:interact', () => {
    try {
      if (!gameService.isActive) return;

      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session?.userId) return;

      gameService.handlePlayerInput(session.userId, {
        type: 'action',
        action: { type: 'interact' }
      });
    } catch (error) {
      console.error('🎮 GAME: Error interacting:', error);
    }
  });

  // Handle game player disconnect on socket disconnect
  socket.on('disconnect', () => {
    // Check if this socket was in the game
    const session = sessionService.getSessionBySocketId(socket.id);
    if (session?.userId && gameService.isActive) {
      const player = gameService.playerManager.getPlayer(session.userId);
      if (player && player.socketId === socket.id) {
        gameService.handlePlayerLeave(session.userId, socket.id).catch(err => {
          console.error('🎮 GAME: Error handling disconnect:', err);
        });
      }
    }
  });

  // ============================================
  // End Game System Socket Handlers
  // ============================================

  // ViewBot explicit transport cleanup request
  socket.on('viewbot-cleanup-transports', (data) => {
    console.log(`🧹 SERVER: ViewBot ${data.botId} requesting transport cleanup for socket ${data.socketId}`);
    
    // Use the socketId from data, not socket.id (they're different!)
    const targetSocketId = data.socketId || socket.id;
    
    console.log(`🔍 DEBUG: Cleanup requested by socket ${socket.id} for target ${targetSocketId}`);
    console.log(`🔍 DEBUG: Current transport keys:`, Array.from(mediasoupService.transports?.keys() || []));
    
    // Try to find transports by socket ID or by bot ID
    let transportEntry = null;
    let transportKey = null;
    
    if (mediasoupService.transports?.has(targetSocketId)) {
      transportEntry = mediasoupService.transports.get(targetSocketId);
      transportKey = targetSocketId;
    } else {
      // If not found by socket ID, search by bot ID
      for (const [key, value] of mediasoupService.transports?.entries() || []) {
        if (value.botId === data.botId) {
          console.log(`🔍 DEBUG: Found transport by botId ${data.botId} under socket ${key}`);
          transportEntry = value;
          transportKey = key;
          break;
        }
      }
    }
    
    // Clean up transports immediately
    if (transportEntry) {
      try {
        if (transportEntry.video && transportEntry.audio) {
          // Close both video and audio transports
          if (!transportEntry.video.closed) {
            transportEntry.video.close();
            console.log(`✅ Closed video transport for ViewBot ${data.botId}`);
          }
          if (!transportEntry.audio.closed) {
            transportEntry.audio.close();
            console.log(`✅ Closed audio transport for ViewBot ${data.botId}`);
          }
        } else if (typeof transportEntry.close === 'function' && !transportEntry.closed) {
          transportEntry.close();
          console.log(`✅ Closed transport for ViewBot ${data.botId}`);
        }
      } catch (e) {
        console.error(`❌ Error closing transports for ViewBot ${data.botId}:`, e);
      }
      mediasoupService.transports.delete(transportKey);
      console.log(`✅ SERVER: Cleaned up transports for ViewBot ${data.botId}`);
    } else {
      console.log(`⚠️ SERVER: No transports found for socket ${targetSocketId}`);
    }
    
    // Also clean up producers if they exist
    if (mediasoupService.producers?.has(transportKey || targetSocketId)) {
      const producers = mediasoupService.producers.get(transportKey || targetSocketId);
      if (producers) {
        for (const [kind, producer] of producers) {
          if (!producer.closed) {
            producer.close();
            console.log(`✅ Closed ${kind} producer for ViewBot ${data.botId}`);
          }
        }
      }
      mediasoupService.producers.delete(transportKey || targetSocketId);
    }
  });
  
  socket.on('disconnect', async () => {
    // Clean up ViewBot Plain RTP transports if exist (in case cleanup wasn't called)
    if (mediasoupService.transports?.has(socket.id)) {
      const transports = mediasoupService.transports.get(socket.id);
      try {
        // Handle both single transport and dual transport cases
        if (transports.video && transports.audio) {
          // Dual transport case (ViewBots)
          if (!transports.video.closed) transports.video.close();
          if (!transports.audio.closed) transports.audio.close();
          console.log(`🧹 SERVER: Closed Plain RTP transports (video & audio) for socket ${socket.id}`);
        } else if (typeof transports.close === 'function' && !transports.closed) {
          // Single transport case
          transports.close();
          console.log(`🧹 SERVER: Closed Plain RTP transport for socket ${socket.id}`);
        }
      } catch (e) {
        console.error('Error closing transports:', e);
      }
      mediasoupService.transports.delete(socket.id);
    }
    
    // Handle time tracking cleanup for authenticated users
    const ip = sessionService.getIpAddress(socket);
    const session = sessionService.getSessionByIp(ip);
    if (session && session.userId) {
      await timeTrackingService.handleUserDisconnect(session.userId, socket.id);
      console.log(`📊 TIME: Cleaned up time tracking for disconnected user ${session.userId}`);
    }
    
    // Unregister session for this socket
    const actualIp = sessionService.unregisterSocket(socket.id);
    console.log(`User disconnected: ${socket.id} from IP: ${actualIp}`);
    
    // Clean up notified streamers tracking
    notifiedStreamers.delete(socket.id);
    
    // Clean up ViewBot tracking and username cache if this was a ViewBot
    if (viewbotSocketIds.has(socket.id)) {
      cleanupViewbotUsername(socket.id);
      
      // Clean up Plain Transport resources for disconnected ViewBot
      if (viewBotClientService && plainTransportService) {
        const botId = viewBotClientService.getBotIdBySocketId(socket.id);
        if (botId) {
          console.log(`🧹 DISCONNECT: Cleaning up Plain Transport for ViewBot ${botId}`);
          await plainTransportService.cleanup(botId);
        }
      }
    }
    
    // Clean up mediasoup resources
    mediasoupService.cleanup(socket.id);
    
    if (streamService.getCurrentStreamer() === socket.id) {
      // Check if disconnecting streamer was a real user (not viewbot)
      // Enhanced ViewBot detection for disconnect handling
      const isOldViewBot = viewbotService && viewbotService.isViewbotStream(socket.id);
      const userId = sessionService.getUserIdBySocketId(socket.id);
      const isNewViewBot = userId && userId < 0;
      const isViewbot = isOldViewBot || isNewViewBot;
      const isRealUser = !isViewbot;
      
      console.log(`🔍 DISCONNECT CHECK: Socket ${socket.id.substring(0, 12)}...`);
      console.log(`   Old ViewBot: ${isOldViewBot}`);
      console.log(`   New ViewBot: ${isNewViewBot} (userID: ${userId})`);
      console.log(`   Is ViewBot: ${isViewbot}, Is Real User: ${isRealUser}`);
      
      // End streaming log session for real streamers
      if (isRealUser) {
        await streamingLogsService.endSession(socket.id, 'disconnect');
      }
      
      // If real user is disconnecting, clear the protection flag and restart viewbot rotation
      if (isRealUser && viewBotClientService) {
        console.log(`🔓 PRIORITY: Real user ${socket.id} disconnected - clearing viewbot protection`);
        viewBotClientService.setRealStreamerStatus(false);

        // CRITICAL: Restart viewbot rotation after real user disconnects
        // This is needed because stopRotation() disables the rotation service
        setTimeout(async () => {
          console.log(`🔄 RESTART: Attempting to restart viewbot rotation after real user disconnect`);

          // Restart ViewBotRotationService (global.viewBotRotation)
          if (global.viewBotRotation && global.viewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting global.viewBotRotation`);
              await global.viewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart global.viewBotRotation:`, e);
            }
          }

          // Also restart SimpleViewBotRotation if it was stopped
          if (SimpleViewBotRotation && SimpleViewBotRotation.startRotation) {
            try {
              console.log(`🚀 RESTART: Restarting SimpleViewBotRotation`);
              await SimpleViewBotRotation.startRotation();
            } catch (e) {
              console.error(`❌ RESTART: Failed to restart SimpleViewBotRotation:`, e);
            }
          }
        }, 3000); // 3 second delay to allow cleanup
      }
      
      // Only apply individual cooldown for real users, not viewbots
      if (!isViewbot) {
        await takeoverService.setSocketCooldown(socket.id, 'streamer_disconnect');
        console.log(`🔒 COOLDOWN: Applied individual cooldown to real user ${socket.id} for streamer disconnect`);
      } else {
        console.log(`🤖 COOLDOWN: Skipping individual cooldown for viewbot ${socket.id} disconnect`);
      }
      
      streamService.clearStreamer();
      // CRITICAL FIX: Also clear MediasoupService currentStreamer
      mediasoupService.currentStreamer = null;
      console.log(`🧹 DISCONNECT: Cleared ${socket.id} from both services`);
      
      // Additional validation: Ensure real streamer status is accurate after disconnect
      if (viewBotClientService) {
        setTimeout(() => {
          viewBotClientService.validateRealStreamerStatus();
        }, 1000); // Small delay to ensure all services are updated
      }

      io.emit('stream-ended', { reason: 'streamer_disconnected', previousStreamer: socket.id });
      notifyViewersStreamEnded();
    } else {
      streamService.removeViewer(socket.id);
    }
    
    // Emit unique viewer count based on IPs
    io.emit('viewer-count-update', sessionService.getUniqueViewerCount());
  });

  // VisualFX Event Handlers - MOVED INSIDE CONNECTION HANDLER
  socket.on('apply-visual-effect', async (data) => {
    console.log(`🎬🎬🎬 VISUALFX HANDLER CALLED: ${socket.id} requesting effect`);
    console.log(`🎬 VISUALFX: Data received:`, data);
    
    try {
      const { effectId, options } = data;
      
      // Check if user is authenticated (optional requirement)
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      
      console.log(`🎬 VISUALFX: Effect request from ${socket.id}: ${effectId}`);
      
      // Get current streamer
      const currentStreamer = streamService.getCurrentStreamer();
      if (!currentStreamer) {
        socket.emit('visual-effect-error', { error: 'No active stream' });
        return;
      }
      
      // Apply the effect
      const effect = await visualFxService.applyEffect(currentStreamer, effectId, {
        ...options,
        requestedBy: socket.id,
        userId: session?.userId
      });
      
      if (effect) {
        // Broadcast effect to all viewers
        io.emit('visual-effect-applied', {
          effectId: effectId,
          effectName: effect.config.name,
          duration: effect.duration,
          streamId: currentStreamer,
          applyToStreamer: true // New flag to indicate this should also affect streamer
        });
        
        // Also send directly to the streamer for view switching
        // Effects that require MediaSoup server-side stream processing (NOT client-side CSS)
        const effectsRequiringStreamProcessing = new Set([
          'resolution_240p', 'resolution_360p', 'resolution_480p',
          'bitrate_potato', 'bitrate_low', 'bitrate_throttle',
          'framerate_slideshow', 'framerate_choppy', 'framerate_cinematic',
          'packet_loss_mild', 'packet_loss_severe', 'jitter',
          'pixelate', 'static_noise', 'glitch',
          'audio_pitch_high', 'audio_pitch_low', 'audio_echo',
          'freeze_frame', 'stutter'
          // NOTE: The following are handled client-side with CSS filters:
          // blur, grayscale, sepia, invert, brightness_dark, brightness_bright,
          // contrast_low, contrast_high, saturate, desaturate, hue_rotate,
          // mirror, flip_vertical, rotate_90, vintage, thermal, vignette,
          // edge_detect, emboss, wave, wobble
        ]);
        
        io.to(currentStreamer).emit('visual-effect-applied', {
          effectId: effectId,
          effectName: effect.config.name,
          duration: effect.duration,
          streamId: currentStreamer,
          applyToStreamer: true,
          isStreamerPreview: true,
          requiresViewSwitch: effectsRequiringStreamProcessing.has(effectId)
        });
        
        socket.emit('visual-effect-success', { effect });
        console.log(`✅ VISUALFX: Applied effect ${effectId} to stream ${currentStreamer} (including streamer preview)`);
      } else {
        socket.emit('visual-effect-error', { error: 'Effect could not be applied (resource limits)' });
      }
      
    } catch (error) {
      console.error('❌ VISUALFX: Error applying effect:', error);
      socket.emit('visual-effect-error', { error: error.message });
    }
  });
  
  socket.on('remove-visual-effect', async (data) => {
    try {
      const { effectInstanceId } = data;
      
      // Check if user has permission (could add admin check here)
      const currentStreamer = streamService.getCurrentStreamer();
      if (!currentStreamer) {
        socket.emit('visual-effect-error', { error: 'No active stream' });
        return;
      }
      
      await visualFxService.removeEffect(currentStreamer, effectInstanceId);
      
      io.emit('visual-effect-removed', {
        effectInstanceId,
        streamId: currentStreamer
      });
      
      socket.emit('visual-effect-success', { 
        message: 'Effect removed successfully' 
      });
      
    } catch (error) {
      console.error('❌ VISUALFX: Error removing effect:', error);
      socket.emit('visual-effect-error', { error: error.message });
    }
  });
  
  socket.on('get-visual-effects', async () => {
    try {
      const effects = visualFxService.getEffectRegistry();
      const currentStreamer = streamService.getCurrentStreamer();
      const activeEffects = currentStreamer ? 
        visualFxService.getActiveEffects(currentStreamer) : [];
      
      socket.emit('visual-effects-list', {
        availableEffects: effects,
        activeEffects: activeEffects,
        stats: visualFxService.getStats()
      });
      
    } catch (error) {
      console.error('❌ VISUALFX: Error getting effects:', error);
      socket.emit('visual-effect-error', { error: error.message });
    }
  });
  
  socket.on('get-visual-fx-stats', async () => {
    try {
      const stats = visualFxService.getStats();
      const currentStreamer = streamService.getCurrentStreamer();
      const activeEffects = currentStreamer ? 
        visualFxService.getActiveEffects(currentStreamer) : [];
      
      socket.emit('visual-fx-stats', {
        stats,
        activeEffects,
        streamId: currentStreamer
      });
      
    } catch (error) {
      console.error('❌ VISUALFX: Error getting stats:', error);
      socket.emit('visual-effect-error', { error: error.message });
    }
  });

});

async function startServer() {
  await initializeRedis();
  
  // Initialize resource monitoring
  resourceMonitor.setCallbacks({
    onAlert: (alert) => {
      console.warn(`🚨 RESOURCE ALERT: ${alert.message} (${alert.value})`);
      // Could emit to admin clients here
    },
    onMetricsUpdate: (metrics) => {
      // Could emit real-time metrics to admin clients
      if (metrics.system.cpuUsage > 90 || metrics.system.memoryUsage > 95) {
        console.error('🔴 CRITICAL: System resources critically high!');
      }
    }
  });
  
  resourceMonitor.startMonitoring(10000); // Update every 10 seconds
  
  // Start time tracking cleanup
  timeTrackingService.startPeriodicCleanup();
  timeTrackingService.setSocketIO(io); // Pass Socket.IO instance to time tracking service
  console.log('✅ TIME: Started periodic cleanup for time tracking service');
  
  // Initialize mediasoup worker (restored to original)
  try {
    await mediasoupService.initialize();
    console.log('✅ MEDIASOUP: Initialization completed');
    
    // Initialize ViewbotService after MediasoupService is ready
    // Pass both services so ViewbotService can choose based on backend
    let livekitService = null;
    if (usingAdapter && global.webrtcAdapter && global.webrtcAdapter.getBackendType() === 'livekit') {
      livekitService = global.webrtcAdapter._backend;
    }
    viewbotService = new ViewbotService(mediasoupService, livekitService);
    console.log('✅ VIEWBOT: ViewbotService initialized');

    // Initialize ViewBotWebRTCService for proper WebRTC connections (TURN support)
    // Only initialize if we're using MediaSoup backend (not LiveKit)
    if (!livekitService) {
      viewBotWebRTCService = new ViewBotWebRTCService(mediasoupService);
      console.log('✅ VIEWBOT: ViewBotWebRTCService initialized for mobile 5G/TURN support');

      // Initialize URL Stream ViewBot Service for MediaSoup backend
      const viewBotURLService = new ViewBotURLService();
      viewBotURLService.setStreamService(streamService);
      viewBotURLService.setViewBotRotation(SimpleViewBotRotation); // For stopping/resuming viewbots
      // No LiveKit service for MediaSoup backend
      const urlStreamHealthService = new URLStreamHealthService(viewBotURLService);
      urlStreamHealthService.start();

      // Handle health service events for automatic recovery
      urlStreamHealthService.on('source-offline', async ({ urlId, sourceUrl }) => {
        console.log(`🏥 HEALTH: Source offline detected for ${urlId}, triggering reconnect...`);
        const stream = viewBotURLService.activeStreams.get(urlId);
        if (stream) {
          viewBotURLService._handleStreamError(urlId, 'health-check', new Error('Source stream went offline'));
        }
      });

      urlStreamHealthService.on('stream-stale', async ({ urlId }) => {
        console.log(`🏥 HEALTH: Stale stream detected for ${urlId}, triggering reconnect...`);
        const stream = viewBotURLService.activeStreams.get(urlId);
        if (stream) {
          viewBotURLService._handleStreamError(urlId, 'health-check', new Error('Stream became stale - no progress'));
        }
      });

      console.log('✅ URL STREAM: ViewBotURLService initialized (MediaSoup backend)');

      // Register URL ViewBot service with rotation for protection
      SimpleViewBotRotation.setURLViewBotService(viewBotURLService);
      SimpleViewBotRotation.setStreamService(streamService);
      console.log('✅ URL STREAM: Registered with SimpleViewBotRotation for URL stream protection');

      // Store globally for API routes
      global.viewBotURLService = viewBotURLService;
      global.urlStreamHealthService = urlStreamHealthService;

      // Initialize URL Stream API routes
      const urlStreamRoutes = require('./routes/url-stream');
      app.use('/api/url-stream', urlStreamRoutes(viewBotURLService, urlStreamHealthService));
      console.log('✅ URL STREAM: API routes initialized at /api/url-stream (MediaSoup backend)');

      // Initialize Random Stream Rotation Service (MediaSoup backend)
      const randomStreamRotationService = new RandomStreamRotationService();
      randomStreamRotationService.setViewBotURLService(viewBotURLService);
      randomStreamRotationService.setViewBotRotation(SimpleViewBotRotation);
      randomStreamRotationService.setSocketIO(io);
      global.randomStreamRotationService = randomStreamRotationService;
      console.log('✅ RANDOM STREAM: RandomStreamRotationService initialized (MediaSoup backend)');

      // Initialize Random Stream API routes
      const randomStreamRoutes = require('./routes/random-stream');
      app.use('/api/random-stream', randomStreamRoutes(randomStreamRotationService));
      console.log('✅ RANDOM STREAM: API routes initialized at /api/random-stream (MediaSoup backend)');

      // Auto-start random rotation if it was enabled before restart
      setTimeout(async () => {
        try {
          await randomStreamRotationService.autoStartIfEnabled();
        } catch (error) {
          console.error('❌ RANDOM STREAM: Auto-start failed:', error.message);
        }
      }, 5000); // Wait 5 seconds for all services to be ready
    } else {
      console.log('ℹ️ VIEWBOT: Skipping ViewBotWebRTCService (using LiveKit backend)');

      // Initialize ViewBotLiveKitService for LiveKit RTMP ingress viewbots
      const viewBotLiveKitService = new ViewBotLiveKitService(livekitService);
      await viewBotLiveKitService.initialize();
      // CRITICAL: Register StreamService for real streamer protection
      viewBotLiveKitService.setStreamService(streamService);
      console.log('✅ VIEWBOT: ViewBotLiveKitService initialized for LiveKit RTMP ingress');

      // Register with rotation systems so they can use RTMP viewbots
      SimpleViewBotRotation.setLiveKitService(viewBotLiveKitService);
      console.log('✅ VIEWBOT: Registered LiveKit service with SimpleViewBotRotation');

      // CRITICAL: Register StreamService for real streamer protection
      SimpleViewBotRotation.setStreamService(streamService);
      console.log('✅ VIEWBOT: Registered StreamService with SimpleViewBotRotation for real streamer protection');

      // Initialize URL Stream ViewBot Service
      const viewBotURLService = new ViewBotURLService();
      viewBotURLService.setStreamService(streamService);
      viewBotURLService.setLiveKitService(viewBotLiveKitService);
      viewBotURLService.setViewBotRotation(SimpleViewBotRotation); // For stopping/resuming viewbots
      viewBotURLService.setSocketIO(io); // For notifying viewers when URL stream starts
      const urlStreamHealthService = new URLStreamHealthService(viewBotURLService);
      urlStreamHealthService.start();

      // Handle health service events for automatic recovery
      urlStreamHealthService.on('source-offline', async ({ urlId, sourceUrl }) => {
        console.log(`🏥 HEALTH: Source offline detected for ${urlId}, triggering reconnect...`);
        const stream = viewBotURLService.activeStreams.get(urlId);
        if (stream) {
          viewBotURLService._handleStreamError(urlId, 'health-check', new Error('Source stream went offline'));
        }
      });

      urlStreamHealthService.on('stream-stale', async ({ urlId }) => {
        console.log(`🏥 HEALTH: Stale stream detected for ${urlId}, triggering reconnect...`);
        const stream = viewBotURLService.activeStreams.get(urlId);
        if (stream) {
          viewBotURLService._handleStreamError(urlId, 'health-check', new Error('Stream became stale - no progress'));
        }
      });

      console.log('✅ URL STREAM: ViewBotURLService initialized');

      // Register URL ViewBot service with rotation for protection
      SimpleViewBotRotation.setURLViewBotService(viewBotURLService);
      console.log('✅ URL STREAM: Registered with SimpleViewBotRotation for URL stream protection');

      // CRITICAL: Register URL ViewBot service with LiveKit ViewBot service for protection
      // This prevents viewbot creation when URL stream is active
      viewBotLiveKitService.setURLViewBotService(viewBotURLService);
      console.log('✅ URL STREAM: Registered with ViewBotLiveKitService for URL stream protection');

      // Store globally for API routes
      global.viewBotURLService = viewBotURLService;
      global.urlStreamHealthService = urlStreamHealthService;

      // Initialize URL Stream API routes
      const urlStreamRoutes = require('./routes/url-stream');
      app.use('/api/url-stream', urlStreamRoutes(viewBotURLService, urlStreamHealthService));
      console.log('✅ URL STREAM: API routes initialized at /api/url-stream');

      // Initialize Random Stream Rotation Service
      const randomStreamRotationService = new RandomStreamRotationService();
      randomStreamRotationService.setViewBotURLService(viewBotURLService);
      randomStreamRotationService.setViewBotRotation(SimpleViewBotRotation);
      randomStreamRotationService.setSocketIO(io);
      global.randomStreamRotationService = randomStreamRotationService;
      console.log('✅ RANDOM STREAM: RandomStreamRotationService initialized');

      // Initialize Random Stream API routes
      const randomStreamRoutes = require('./routes/random-stream');
      app.use('/api/random-stream', randomStreamRoutes(randomStreamRotationService));
      console.log('✅ RANDOM STREAM: API routes initialized at /api/random-stream');

      // Auto-start random rotation if it was enabled before restart
      setTimeout(async () => {
        try {
          await randomStreamRotationService.autoStartIfEnabled();
        } catch (error) {
          console.error('❌ RANDOM STREAM: Auto-start failed:', error.message);
        }
      }, 5000); // Wait 5 seconds for all services to be ready

      // Store for later registration with ViewBotRotationService
      global.viewBotLiveKitService = viewBotLiveKitService;

      // Start LiveKit streamer health check to detect stale streamers (WebRTC dropped but socket alive)
      livekitService.startStreamerHealthCheck(streamService, io, 10000); // Check every 10 seconds
      console.log('✅ LIVEKIT: Started streamer health check for stale connection detection');
    }
    
    // Make viewbotService available to routes
    app.locals.viewbotService = viewbotService;
    
    // Initialize recording system after MediaSoup is ready
    try {
      // Run database migration to ensure recording tables exist
      const { setupRecordingTables } = require('./migrations/setup-recording-tables');
      await setupRecordingTables();
      console.log('✅ RECORDING: Database tables verified');

      // Recording service is ready to use
      console.log('✅ RECORDING: Recording system initialized and ready');
    } catch (error) {
      console.error('❌ RECORDING: Failed to initialize recording system:', error);
    }

    // Run clips table migration (separate try/catch so it runs even if recording fails)
    try {
      const setupClipsTables = require('./migrations/setup-clips-tables');
      await setupClipsTables(database.db);
      console.log('✅ CLIPS: Database tables verified');
    } catch (error) {
      console.error('❌ CLIPS: Failed to initialize clips tables:', error);
    }
    
    // Inject viewbotService into InventoryService for viewbot targeting
    inventoryService.setViewbotService(viewbotService);
    // Inject viewbot socket checker function
    inventoryService.setViewbotSocketChecker((socketId) => viewbotSocketIds.has(socketId));
    
    // Initialize ViewBotClientService with environment-aware URL
    // Pass null as serverUrl to let ViewBotClientService use environment variables
    console.log('🚀 VIEWBOT CLIENT: Creating ViewBotClientService...');
    viewBotClientService = new ViewBotClientService(null, mediasoupService, streamService, viewbotService);
    
    // CRITICAL: Give ViewbotService a reference to ViewBotClientService for rotation handling
    viewbotService.viewBotClientService = viewBotClientService;
    
    // Set global reference for ViewBotClientService (needed for GStreamer WebRTC)
    global.viewBotClientService = viewBotClientService;

    // CRITICAL: Wire ViewBotClientService to ViewBotURLService for real streamer protection
    if (global.viewBotURLService) {
      global.viewBotURLService.setViewBotClientService(viewBotClientService);
      console.log('✅ VIEWBOT CLIENT: Linked to ViewBotURLService for real streamer protection');
    }

    // CRITICAL: Initialize the service to restore state from database
    try {
      console.log('🚀 VIEWBOT CLIENT: Initializing ViewBotClientService...');
      await viewBotClientService.initialize();
      console.log('✅ VIEWBOT CLIENT: ViewBotClientService initialized and state restored');
    } catch (error) {
      console.error('❌ VIEWBOT CLIENT: Failed to initialize ViewBotClientService:', error);
      console.log('⚠️ VIEWBOT CLIENT: Continuing without ViewBotClientService');
      viewBotClientService = null;
    }
    
    // CRITICAL FIX: Set global objects so SimpleViewBotMediaSoup can emit events and manage streams
    global.io = io;
    global.streamService = streamService;
    global.streamManager = streamService;  // streamManager and streamService are same
    console.log('✅ GLOBAL OBJECTS: Set global.io and global.streamService for event emission');
    console.log('🔍 DEBUG: global.io test:', typeof global.io);
    console.log('🔍 DEBUG: io.emit test:', typeof io.emit);
    
    // Test emit
    setTimeout(() => {
      if (global.io) {
        console.log('🔍 DEBUG: Testing global.io.emit after 5 seconds');
        global.io.emit('test-event', { test: true });
      }
    }, 5000);
    
    // Helper function to get video files
    async function getVideoFiles() {
      const uploadsDir = path.join(__dirname, 'uploads');
      try {
        const files = await fs.promises.readdir(uploadsDir);
        return files
          .filter(file => ['.mp4', '.webm', '.mkv', '.avi', '.mov'].includes(path.extname(file).toLowerCase()))
          .map(file => path.join(uploadsDir, file));
      } catch (error) {
        console.error('Failed to read video files:', error);
        return [];
      }
    }
    
    // Initialize NEW ViewBot Rotation System with Socket.IO clients
    console.log('🚀 VIEWBOT ROTATION: Starting initialization...');
    try {
      const ViewBotRotationService = require('./services/ViewBotRotationService');
      console.log('✅ VIEWBOT ROTATION: Service module loaded');
      
      const viewBotRotation = new ViewBotRotationService('https://127.0.0.1:8443');
      console.log('✅ VIEWBOT ROTATION: Service instance created');

      // Register LiveKit service if available
      if (global.viewBotLiveKitService) {
        viewBotRotation.setLiveKitService(global.viewBotLiveKitService);
        console.log('✅ VIEWBOT ROTATION: LiveKit service registered');
      } else {
        console.log('⚠️ VIEWBOT ROTATION: LiveKit service not available, will use MediaSoup');
      }

      // Store globally for admin routes
      global.viewBotRotation = viewBotRotation;
      global.viewBotRotationService = viewBotRotation; // Also store with this name for PortMonitor

      // Initialize with media files
      await viewBotRotation.initialize();
      console.log('✅ VIEWBOT ROTATION: Service initialized');
      
      // Initialize Unified ViewBot Rotation with WebRTC support
      console.log('🌐 Initializing WebRTC ViewBot support...');
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
        
        // Create Unified Rotation controller
        const unifiedRotation = new UnifiedViewBotRotation(io, streamService, mediasoupService, livekitService);
        const videoFiles = await getVideoFiles();
        await unifiedRotation.initialize(videoFiles);
        global.unifiedViewBotRotation = unifiedRotation;
        
        // Set initial mode based on config
        if (viewBotConfig.viewbots.useWebRTCViewBots) {
          await unifiedRotation.setMode('webrtc');
          console.log('✅ WebRTC ViewBot mode enabled (mobile compatible)');
        } else {
          // CRITICAL: Explicitly set mode to plainrtp - default is 'webrtc' which would cause failures
          await unifiedRotation.setMode('plainrtp');
          console.log('ℹ️ Using Plain RTP ViewBot mode (desktop only)');
        }
        
        console.log('✅ Unified ViewBot Rotation initialized');
      } catch (error) {
        console.warn('⚠️ WebRTC ViewBot support not available:', error.message);
        console.log('ℹ️ Continuing with Plain RTP viewbots only');
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
      console.log('✅ PORT MONITOR: Service started');
      
      // Enable rotation
      viewBotRotation.enabled = true;
      console.log(`🔍 VIEWBOT ROTATION: Enabled set to ${viewBotRotation.enabled}`);

      // Delay rotation start to ensure server is fully ready
      console.log('⏰ VIEWBOT ROTATION: Scheduling rotation start in 10 seconds...');
      setTimeout(async () => {
        try {
          console.log('🚀 VIEWBOT ROTATION: Starting rotation after delay...');
          await viewBotRotation.startRotation();
          console.log('✅ VIEWBOT ROTATION: Rotation started successfully');
        } catch (error) {
          console.error('❌ VIEWBOT ROTATION: Failed to start rotation:', error);
        }
      }, 10000); // 10 second delay
      console.log('✅ VIEWBOT ROTATION: setTimeout scheduled');
      
      console.log('✅ VIEWBOT ROTATION: New Socket.IO-based rotation system initialized');
      
      // Keep SimpleViewBotMediaSoup disabled but available for fallback
      global.simpleMediaSoupRotation = null;
      
    } catch (error) {
      console.error('❌ VIEWBOT ROTATION: Failed to initialize:', error);
      console.error(error.stack);
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
    console.log('✅ VIEWBOT API: Routes initialized with service instance');
  } catch (error) {
    console.error('❌ MEDIASOUP: Initialization failed:', error);
    console.log('⚠️ Continuing without mediasoup and viewbot services...');
    viewbotService = null;
    viewBotClientService = null;
  }
  
  // Initialize ChatBot service
  try {
    console.log('🤖 SERVER: Initializing ChatBot service...');
    initializeChatBotRoutes(chatBotService);
    console.log('🤖 SERVER: ChatBot routes initialized');
    
    await chatBotService.initialize();
    console.log('🤖 SERVER: ChatBot service initialization completed');
    
    // Initialize StreamBot service
    await streamBotService.initialize();
    console.log('📢 SERVER: StreamBot service initialized');
    
    // Set up periodic cleanup for expired temporary bots
    setInterval(async () => {
      try {
        const cleaned = await chatBotService.cleanupExpiredBots();
        if (cleaned > 0) {
          console.log(`🧹 Cleaned up ${cleaned} expired temporary bots`);
        }
      } catch (error) {
        console.error('❌ Error during bot cleanup:', error);
      }
    }, 5 * 60 * 1000); // Run every 5 minutes
    console.log('⏰ Scheduled periodic cleanup for expired bots');
  } catch (error) {
    console.error('❌ SERVER: ChatBot service initialization failed:', error);
    console.error('❌ SERVER: ChatBot service stack trace:', error.stack);
    // Continue without ChatBot service rather than crashing
    console.log('⚠️ SERVER: Continuing without ChatBot service...');
  }

  // ============================================================================
  // SOCIAL MEDIA EMBED SUPPORT - Dynamic Open Graph meta tags for blog posts
  // ============================================================================
  // This middleware serves custom HTML with proper meta tags for social crawlers
  // so that blog links display rich previews in Discord, Twitter, Facebook, etc.
  // ============================================================================

  app.get('/blog/:slug', async (req, res, next) => {
    const { slug } = req.params;

    // Skip static files and index.html
    if (slug === 'index.html' || slug.includes('.')) {
      return next();
    }

    try {
      // Fetch article from Strapi
      const https = require('https');
      const strapiUrl = `http://127.0.0.1:1337/api/articles?filters[slug][$eq]=${encodeURIComponent(slug)}&populate=*`;

      const fetchArticle = () => new Promise((resolve, reject) => {
        require('http').get(strapiUrl, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.data?.[0] || null);
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      });

      const article = await fetchArticle();

      if (!article) {
        // Article not found - serve normal blog page
        return res.sendFile(path.join('/var/www/html/blog', 'index.html'));
      }

      // Escape HTML entities for security
      const escapeHtml = (str) => {
        if (!str) return '';
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const title = escapeHtml(article.title) || 'Blog Post';
      const rawDescription = article.excerpt || article.content?.trim().substring(0, 160).replace(/[#*_`\n\r]/g, ' ').replace(/\s+/g, ' ').trim() + '...';
      const description = escapeHtml(rawDescription);
      const author = escapeHtml(article.author || 'OneStreamer Team');

      // Build URLs
      const baseUrl = 'https://onestreamer.live';
      const articleUrl = `${baseUrl}/blog/${slug}`;

      // Cover image URL
      let imageUrl = `${baseUrl}/og-blog.png`; // Default blog OG image
      if (article.cover?.url || article.coverImage?.url) {
        const coverUrl = article.cover?.url || article.coverImage?.url;
        if (coverUrl.startsWith('http')) {
          imageUrl = coverUrl;
        } else if (coverUrl.startsWith('/uploads')) {
          // Strapi uploads need to go through /strapi path
          imageUrl = `${baseUrl}/strapi${coverUrl}`;
        } else {
          imageUrl = `${baseUrl}${coverUrl}`;
        }
      }

      // Format date
      const publishedDate = article.publishedAt ? new Date(article.publishedAt).toISOString() : '';
      const modifiedDate = article.updatedAt ? new Date(article.updatedAt).toISOString() : '';

      // Read the blog index.html template
      const fs = require('fs');
      const blogIndexPath = path.join('/var/www/html/blog', 'index.html');
      let html = fs.readFileSync(blogIndexPath, 'utf8');

      // Update the title tag
      html = html.replace(
        /<title[^>]*>.*?<\/title>/,
        `<title>${title} | OneStreamer Blog</title>`
      );

      // Update meta tags with article-specific content
      html = html.replace(/id="page-title">.*?<\/title>/, `id="page-title">${title} | OneStreamer Blog</title>`);
      html = html.replace(/id="meta-title" content="[^"]*"/, `id="meta-title" content="${title} | OneStreamer Blog"`);
      html = html.replace(/id="page-description"[^>]*content="[^"]*"/, `id="page-description" name="description" content="${description}"`);
      html = html.replace(/id="canonical-url" href="[^"]*"/, `id="canonical-url" href="${articleUrl}"`);

      // Open Graph - match id, any attributes, then content
      html = html.replace(/id="og-type"[^>]*content="[^"]*"/, `id="og-type" property="og:type" content="article"`);
      html = html.replace(/id="og-url"[^>]*content="[^"]*"/, `id="og-url" property="og:url" content="${articleUrl}"`);
      html = html.replace(/id="og-title"[^>]*content="[^"]*"/, `id="og-title" property="og:title" content="${title}"`);
      html = html.replace(/id="og-description"[^>]*content="[^"]*"/, `id="og-description" property="og:description" content="${description}"`);
      html = html.replace(/id="og-image"[^>]*content="[^"]*"/, `id="og-image" property="og:image" content="${imageUrl}"`);

      // Twitter - match id, any attributes, then content
      html = html.replace(/id="twitter-url"[^>]*content="[^"]*"/, `id="twitter-url" name="twitter:url" content="${articleUrl}"`);
      html = html.replace(/id="twitter-title"[^>]*content="[^"]*"/, `id="twitter-title" name="twitter:title" content="${title}"`);
      html = html.replace(/id="twitter-description"[^>]*content="[^"]*"/, `id="twitter-description" name="twitter:description" content="${description}"`);
      html = html.replace(/id="twitter-image"[^>]*content="[^"]*"/, `id="twitter-image" name="twitter:image" content="${imageUrl}"`);

      // Article meta - match id, any attributes, then content
      html = html.replace(/id="article-author"[^>]*content="[^"]*"/, `id="article-author" property="article:author" content="${author}"`);
      html = html.replace(/id="article-published"[^>]*content="[^"]*"/, `id="article-published" property="article:published_time" content="${publishedDate}"`);
      html = html.replace(/id="article-modified"[^>]*content="[^"]*"/, `id="article-modified" property="article:modified_time" content="${modifiedDate}"`);

      // Update JSON-LD structured data
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": title,
        "description": description,
        "image": imageUrl,
        "url": articleUrl,
        "datePublished": publishedDate,
        "dateModified": modifiedDate,
        "author": {
          "@type": "Person",
          "name": author
        },
        "publisher": {
          "@type": "Organization",
          "name": "OneStreamer",
          "url": "https://onestreamer.live",
          "logo": {
            "@type": "ImageObject",
            "url": "https://onestreamer.live/logo.png"
          }
        }
      };
      html = html.replace(
        /<script type="application\/ld\+json" id="schema-data">[\s\S]*?<\/script>/,
        `<script type="application/ld+json" id="schema-data">${JSON.stringify(jsonLd, null, 2)}</script>`
      );

      res.setHeader('Content-Type', 'text/html');
      res.send(html);

    } catch (error) {
      console.error(`❌ Error generating blog meta tags for ${slug}:`, error);
      // On error, fall back to serving the normal blog page
      res.sendFile(path.join('/var/www/html/blog', 'index.html'));
    }
  });

  // ============================================================================
  // SOCIAL MEDIA EMBED SUPPORT - Dynamic Open Graph meta tags for clip pages
  // ============================================================================
  // This middleware serves custom HTML with proper meta tags for social crawlers
  // so that clip links display rich previews in Discord, Twitter, Facebook, etc.
  // ============================================================================

  app.get('/clips/:clipId', async (req, res, next) => {
    const { clipId } = req.params;

    // Validate clipId format (UUID)
    const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!uuidRegex.test(clipId)) {
      // Not a valid clip URL, let React handle it
      return next();
    }

    try {
      // Fetch clip data
      const clip = await clipService.getClip(clipId);

      if (!clip || clip.status !== 'ready' || !clip.is_public) {
        // Clip not found or not ready/public - serve normal React app
        return res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html'));
      }

      // Format duration for display (e.g., "0:45" or "1:30")
      const durationSec = Math.round((clip.duration_ms || 0) / 1000);
      const minutes = Math.floor(durationSec / 60);
      const seconds = durationSec % 60;
      const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

      // Escape HTML entities for security
      const escapeHtml = (str) => {
        if (!str) return '';
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      const title = escapeHtml(clip.title) || 'Clip';
      const description = escapeHtml(clip.description) || `A ${durationStr} clip by ${escapeHtml(clip.creator_username || 'Anonymous')}`;
      const creatorName = escapeHtml(clip.creator_username || 'Anonymous');

      // Build URLs
      const baseUrl = 'https://onestreamer.live';
      const clipUrl = `${baseUrl}/clips/${clipId}`;
      const thumbnailUrl = `${baseUrl}/api/clips/${clipId}/thumbnail`;
      const videoUrl = `${baseUrl}/api/clips/${clipId}/stream`;

      // Read the base index.html template
      const fs = require('fs');
      const indexPath = path.join(__dirname, '..', 'client', 'build', 'index.html');
      let html = fs.readFileSync(indexPath, 'utf8');

      // Google Analytics script
      const gaScript = `
    <!-- Google Analytics -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-XN4PGT5J9W"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-XN4PGT5J9W', {
            page_path: window.location.pathname
        });
    </script>
`;

      // Build the Open Graph and Twitter Card meta tags
      const metaTags = `
    <!-- Open Graph Meta Tags for Social Media Sharing -->
    <meta property="og:site_name" content="OneStreamer">
    <meta property="og:url" content="${clipUrl}">
    <meta property="og:type" content="video.other">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${thumbnailUrl}">
    <meta property="og:image:width" content="1280">
    <meta property="og:image:height" content="720">
    <meta property="og:image:alt" content="${title}">
    <meta property="og:video" content="${videoUrl}">
    <meta property="og:video:secure_url" content="${videoUrl}">
    <meta property="og:video:type" content="video/mp4">
    <meta property="og:video:width" content="1280">
    <meta property="og:video:height" content="720">

    <!-- Twitter Card Meta Tags -->
    <meta name="twitter:card" content="player">
    <meta name="twitter:site" content="@onestreamer">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${thumbnailUrl}">
    <meta name="twitter:player" content="${clipUrl}?embed=true">
    <meta name="twitter:player:width" content="1280">
    <meta name="twitter:player:height" content="720">

    <!-- Additional metadata -->
    <meta property="video:duration" content="${durationSec}">
    <meta name="author" content="${creatorName}">
`;

      // Update the title tag
      html = html.replace(
        /<title>.*?<\/title>/,
        `<title>${title} - OneStreamer Clip</title>`
      );

      // Update the description meta tag
      html = html.replace(
        /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
        `<meta name="description" content="${description}">`
      );

      // Insert Open Graph tags after the description meta tag
      html = html.replace(
        /(<meta\s+name="description"\s+content="[^"]*"\s*\/?>)/,
        `$1${metaTags}`
      );

      // Insert Google Analytics script before closing </head> tag
      html = html.replace(
        /<\/head>/,
        `${gaScript}</head>`
      );

      res.setHeader('Content-Type', 'text/html');
      res.send(html);

    } catch (error) {
      console.error(`❌ Error generating clip meta tags for ${clipId}:`, error);
      // On error, fall back to serving the normal React app
      res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html'));
    }
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
    res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html'));
  });

  // Start account deletion scheduler after a delay to ensure database is ready
  setTimeout(() => {
    const AccountDeletionScheduler = require('./services/AccountDeletionScheduler');
    const deletionScheduler = new AccountDeletionScheduler();
    deletionScheduler.start();
    console.log('🗑️ Account deletion scheduler started');
  }, 5000); // Wait 5 seconds for database to initialize

  // Start HTTP server
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('🔍 HTTP Server accessible on:');
    console.log('  - http://localhost:' + PORT);
    console.log('  - http://onestreamer.live:' + PORT);
  });

  // Start HTTPS server if configured
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`🔒 HTTPS server running on port ${HTTPS_PORT}`);
      console.log('🔍 HTTPS Server accessible on:');
      console.log('  - https://localhost:' + HTTPS_PORT);
      console.log('  - https://onestreamer.live:' + HTTPS_PORT);
      console.log('⚠️  Note: Using self-signed certificate. Browser will show security warning.');
    });
  }

  // Visual effects sync temporarily disabled to debug rotate_90 issue
  // setTimeout(() => {
  //   console.log('🔄 VISUAL FX SYNC: Starting visual effects synchronization...');
  //   try {
  //     startVisualEffectSync();
  //     console.log('🔄 VISUAL FX SYNC: Successfully started!');
  //   } catch (error) {
  //     console.error('❌ VISUAL FX SYNC: Failed to start:', error);
  //   }
  // }, 2000);

  // Test the getStreamerDisplayName function when server starts
    setTimeout(async () => {
      console.log('🧪 TESTING: getStreamerDisplayName function with current sessions...');
      const allSessions = sessionService.getAllSessions();
      for (const [ip, session] of Object.entries(allSessions)) {
        if (session.userId) {
          console.log(`🧪 TESTING: Found authenticated session for IP ${ip}, User ${session.userId}`);
          // Test with all socket IDs for this session
          const sockets = sessionService.getSocketsByIp(ip);
          for (const socketId of sockets) {
            console.log(`🧪 TESTING: Testing with socket ${socketId}...`);
            const displayName = await getStreamerDisplayName(socketId);
            console.log(`🧪 TESTING: getStreamerDisplayName(${socketId}) = "${displayName}"`);
          }
        }
      }
    }, 3000);

  httpServer.on('error', (err) => {
    console.error('❌ SERVER: Server error:', err);
  });

  // Keep the process alive and log periodically
  setInterval(() => {
    // console.log('💓 SERVER: Still alive, connections:', io.sockets.sockets.size);
  }, 5000);
}

startServer().catch(console.error);

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down server gracefully...');
  
  try {
    // 1. Disconnect all socket connections
    console.log('🔌 Disconnecting all socket connections...');
    const sockets = await io.fetchSockets();
    for (const socket of sockets) {
      socket.disconnect(true);
    }
    
    // 2. Stop all media streams (GStreamer and FFmpeg)
    console.log('🎬 Stopping all media streams...');
    
    // Stop ViewBot GStreamer streams (check if service exists first)
    if (typeof viewBotGStreamerService !== 'undefined' && viewBotGStreamerService) {
      console.log('   Stopping ViewBot GStreamer streams...');
      if (viewBotGStreamerService.stopAll) {
        await viewBotGStreamerService.stopAll();
      } else if (viewBotGStreamerService.activeStreams) {
        // Fallback if stopAll method doesn't exist
        for (const [botId, stream] of viewBotGStreamerService.activeStreams) {
          if (stream.process && !stream.process.killed) {
            console.log(`   - Killing GStreamer for bot ${botId}`);
            stream.process.kill('SIGTERM');
          }
        }
        viewBotGStreamerService.activeStreams.clear();
      }
    }
    
    // Stop ViewBot FFmpeg streams (service removed - handled by ViewBotClientService)
    // viewBotFFmpegService was removed - FFmpeg/GStreamer streams are now handled by ViewBotClientService
    
    // Stop ViewBot Client Service streams
    if (viewBotClientService) {
      console.log('   Cleaning up ViewBot Client Service...');
      await viewBotClientService.cleanup();
    }
    
    // Stop ViewBot Muxed streams (service removed - handled by ViewBotClientService)
    // viewBotMuxedStreamService was removed - muxed streams are now handled by ViewBotClientService
    
    // Stop Stream Interceptor Service GStreamer processes
    if (streamInterceptorService && streamInterceptorService.activeIntercepts) {
      console.log('   Stopping Stream Interceptor GStreamer processes...');
      for (const [streamId, intercept] of streamInterceptorService.activeIntercepts) {
        if (intercept.processor && !intercept.processor.killed) {
          console.log(`   - Killing GStreamer interceptor for stream ${streamId}`);
          intercept.processor.kill('SIGTERM');
        }
      }
      streamInterceptorService.activeIntercepts.clear();
    }
    
    // Stop main Viewbot service
    if (viewbotService) {
      console.log('   Stopping main Viewbot service...');
      if (viewbotService.viewbotProcess && !viewbotService.viewbotProcess.killed) {
        console.log('   - Killing Viewbot FFmpeg process');
        viewbotService.viewbotProcess.kill('SIGTERM');
      }
      // Always cleanup to ensure WebRTC service is stopped
      await viewbotService.cleanup();
    }

    // Stop URL Stream ViewBot service (critical for cleanup of FFmpeg processes)
    if (global.viewBotURLService) {
      console.log('   Stopping URL Stream ViewBot service...');
      await global.viewBotURLService.stopAllURLStreams();
    }
    
    // Stop Simple Media Stream Service
    if (typeof simpleMediaStreamService !== 'undefined' && simpleMediaStreamService && simpleMediaStreamService.ffmpegProcess) {
      console.log('   Stopping Simple Media Stream FFmpeg...');
      if (!simpleMediaStreamService.ffmpegProcess.killed) {
        simpleMediaStreamService.ffmpegProcess.kill('SIGTERM');
      }
    }
    
    // Stop Recording Service streams
    if (recordingService && recordingService.activeRecordings) {
      console.log('   Stopping Recording Service FFmpeg processes...');
      for (const [id, recording] of recordingService.activeRecordings) {
        if (recording.ffmpegProcess && !recording.ffmpegProcess.killed) {
          console.log(`   - Stopping recording ${id}`);
          recording.ffmpegProcess.kill('SIGTERM');
        }
      }
    }
    
    // Stop Visual FX Service pipelines
    if (visualFxService && visualFxService.activePipelines) {
      console.log('   Stopping Visual FX pipelines...');
      for (const [id, pipeline] of visualFxService.activePipelines) {
        if (pipeline.ffmpegProcess && !pipeline.ffmpegProcess.killed) {
          console.log(`   - Stopping visual FX pipeline ${id}`);
          pipeline.ffmpegProcess.kill('SIGTERM');
        }
      }
    }
    
    // Kill any remaining FFmpeg/GStreamer/Puppeteer processes as a safety measure
    console.log('🔍 Checking for any remaining media processes...');
    const { exec } = require('child_process');
    
    // Windows-specific process cleanup
    if (process.platform === 'win32') {
      // Kill all ffmpeg processes
      exec('taskkill /F /IM ffmpeg.exe 2>nul', (err) => {
        if (!err) console.log('   - Killed remaining FFmpeg processes');
      });
      
      // Kill all gst-launch processes (multiple possible names)
      exec('taskkill /F /IM gst-launch-1.0.exe 2>nul', (err) => {
        if (!err) console.log('   - Killed remaining GStreamer (gst-launch-1.0) processes');
      });
      
      // Also check for gst-launch without version
      exec('taskkill /F /IM gst-launch.exe 2>nul', (err) => {
        if (!err) console.log('   - Killed remaining GStreamer (gst-launch) processes');
      });
      
      // Kill any other GStreamer-related processes
      exec('taskkill /F /IM gst-play-1.0.exe 2>nul', () => {});
      exec('taskkill /F /IM gst-inspect-1.0.exe 2>nul', () => {});
      
      // Use WMI to find and kill processes by command line pattern
      exec('wmic process where "CommandLine like \'%gstreamer%\'" delete 2>nul', (err) => {
        if (!err) console.log('   - Killed processes with gstreamer in command line');
      });
      
      // Kill Puppeteer Chrome processes
      exec('taskkill /F /IM chrome.exe /FI "COMMANDLINE like *puppeteer*" 2>nul', (err) => {
        if (!err) console.log('   - Killed Puppeteer Chrome processes');
      });
      exec('taskkill /F /IM chromium.exe /FI "COMMANDLINE like *puppeteer*" 2>nul', () => {});
    } else {
      // Unix-like systems
      exec('pkill -TERM ffmpeg 2>/dev/null', (err) => {
        if (!err) console.log('   - Killed remaining FFmpeg processes');
      });
      
      exec('pkill -TERM gst-launch 2>/dev/null', (err) => {
        if (!err) console.log('   - Killed remaining GStreamer processes');
      });
      
      // Also kill by full name pattern
      exec('pkill -f "gst-launch-1.0" 2>/dev/null', () => {});
      exec('pkill -f "gstreamer" 2>/dev/null', () => {});
      
      // Kill Puppeteer Chrome/Chromium processes
      exec('pkill -f "puppeteer.*chrome" 2>/dev/null', (err) => {
        if (!err) console.log('   - Killed Puppeteer Chrome processes');
      });
      exec('pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox" 2>/dev/null', () => {});
    }
    
    // Wait a bit for processes to terminate cleanly
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 3. Clean up MediaSoup resources
    console.log('🧹 Cleaning up MediaSoup resources...');
    if (mediasoupService) {
      mediasoupService.cleanupAll();
    }
    
    // 3.5. Clean up WebRTC ViewBot systems
    console.log('🧹 Cleaning up ViewBot systems...');
    if (global.unifiedViewBotRotation) {
      await global.unifiedViewBotRotation.shutdown();
    }
    if (global.viewBotManager) {
      await global.viewBotManager.cleanup();
    }
    
    // 4. Clear all sessions
    console.log('📊 Clearing session data...');
    if (sessionService) {
      sessionService.clearAllSessions();
    }
    
    // 5. Stop resource monitoring
    console.log('📈 Stopping resource monitor...');
    resourceMonitor.stopMonitoring();
    
    // 6. Stop time tracking
    console.log('⏱️ Stopping time tracking...');
    if (timeTrackingService) {
      timeTrackingService.stopPeriodicCleanup();
    }
    
    // 7. Close Redis connection
    if (redisClient) {
      console.log('🔴 Closing Redis connection...');
      await redisClient.quit();
    }
    
    // 8. Close the HTTP server
    console.log('🌐 Closing HTTP server...');
    await new Promise((resolve) => {
      server.close(resolve);
    });
    
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

// Also handle SIGTERM
process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.emit('SIGINT');
});

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  // Attempt cleanup before exit
  cleanupMediaProcesses();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection, but log it
});

// Quick cleanup function for emergency exits
function cleanupMediaProcesses() {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /F /IM ffmpeg.exe 2>nul', { stdio: 'ignore' });
      execSync('taskkill /F /IM gst-launch-1.0.exe 2>nul', { stdio: 'ignore' });
      execSync('taskkill /F /IM gst-launch.exe 2>nul', { stdio: 'ignore' });
    } else {
      execSync('pkill -9 ffmpeg 2>/dev/null', { stdio: 'ignore' });
      execSync('pkill -9 gst-launch 2>/dev/null', { stdio: 'ignore' });
    }
  } catch (e) {
    // Ignore errors in emergency cleanup
  }
}
