require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const ProfanityFilterService = require('../server/services/ProfanityFilterService');
const createClaimEventService = require('./claims/claimEventService');
const createModerationService = require('./moderation/moderationService');
const createSkipVote = require('./votes/skipVote');
const createSwapVote = require('./votes/swapVote');
const createExtendVote = require('./votes/extendVote');
const createReduceVote = require('./votes/reduceVote');
const createLockVote = require('./votes/lockVote');
const createUnlockVote = require('./votes/unlockVote');
const createCommandParser = require('./commands/commandParser');
const createApiRouter = require('./api/routes');
const createAdminCommands = require('./core/adminCommands');
const createSocketHandlers = require('./core/socketHandlers');

const app = express();

// Initialize profanity filter for chat messages
const profanityFilter = new ProfanityFilterService();

// Create both HTTP and HTTPS servers
const httpServer = createServer(app);

// HTTPS configuration
let httpsServer;
const HTTPS_PORT = process.env.CHAT_HTTPS_PORT || 8444;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

if (USE_HTTPS || fs.existsSync(path.join(__dirname, '..', 'certificates', 'cert.pem'))) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(path.join(__dirname, '..', 'certificates', 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, '..', 'certificates', 'cert.pem'))
    };
    httpsServer = https.createServer(httpsOptions, app);
    console.log('🔒 CHAT HTTPS: SSL certificates loaded successfully');
  } catch (err) {
    console.error('⚠️ CHAT HTTPS: Failed to load SSL certificates:', err.message);
  }
}

const server = httpsServer || httpServer;

// Enable CORS for all routes
app.use(cors({
  origin: [
    process.env.CLIENT_URL || 'https://onestreamer.live',
    process.env.MAIN_SERVER_URL || 'https://onestreamer.live:8443'
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

const io = new Server(server, {
  path: '/chat/socket.io',
  cors: {
    origin: [
      process.env.CLIENT_URL || 'https://onestreamer.live',
      process.env.MAIN_SERVER_URL || 'https://onestreamer.live:8443'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Animal-name + color palettes for username generation now live inside
// core/socketHandlers.js — they're consumed only by the connection handler
// and the username generator.

// Store connected users and their chat data
const connectedUsers = new Map();
const ipToUser = new Map(); // Store username assignments by IP
const chatMessages = [];
const MAX_CHAT_HISTORY = 3000; // Keep last 3000 messages (~1 hour of active chat)

// Vote system constants
// Shared cooldown constants used by the command parser to gate consecutive
// vote attempts. The per-vote services in ./votes/*Vote.js own their own
// duration/threshold/cooldown constants; only these cross-vote knobs stay
// at the entry point.
const VOTE_COOLDOWN_FAILED = 2 * 60 * 1000;  // 2 minutes after a failed vote
const VOTE_COOLDOWN_SUCCESS = 5 * 60 * 1000; // 5 minutes after a successful vote

// Single-viewer auto-action system (when only 1 viewer, skip voting and execute directly)
// The cooldown duration lives here as the canonical source; the bookkeeping
// (`lastSingleViewerActionTime`) lives inside the command parser closure
// where the solo auto-execute paths read/write it.
const SINGLE_VIEWER_ACTION_COOLDOWN = 60 * 1000; // 60 second cooldown to prevent spam

// Persistence paths
// MODERATION_STORE_PATH overrides the default. Useful for production
// deploys that keep state outside the repo, and for tests that need an
// isolated fixture path. Default is gitignored, see .gitignore.
const MODERATION_DATA_PATH = process.env.MODERATION_STORE_PATH
  ? path.resolve(process.env.MODERATION_STORE_PATH)
  : path.join(__dirname, 'moderation_data.json');

// Moderation service — owns bannedUsers/bannedUsersData/timeoutUsers state
// plus load/save/isBanned/isTimedOut helpers. See moderation/moderationService.js.
const moderationService = createModerationService({
  moderationDataPath: MODERATION_DATA_PATH
});
const { loadModerationData } = moderationService;

// JWT secret — must match the main server. No default fallback; chat-service
// refuses to boot rather than silently using a known value.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET environment variable is required. ' +
    'It must match the main server. Set it in your .env file.'
  );
}

// Main server URL for API calls
const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || 'https://onestreamer.live:8443';

// Create HTTPS agent for self-signed certificates
const httpsAgent = MAIN_SERVER_URL.startsWith('https') ? new https.Agent({
  rejectUnauthorized: false // Accept self-signed certificates
}) : undefined;

// Helper function to get axios config with HTTPS agent
function getAxiosConfig(additionalConfig = {}) {
  const config = { ...additionalConfig };
  if (httpsAgent) {
    config.httpsAgent = httpsAgent;
  }
  // Identify chat-service → main-server calls as a trusted service, so the
  // stream-control routes (/api/random-stream/*) can require auth without
  // breaking vote-driven rotation. Main server matches this against
  // INTERNAL_API_SECRET (see middleware/streamControlAuth.js).
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (internalSecret) {
    config.headers = { ...(config.headers || {}), 'X-Internal-Secret': internalSecret };
  }
  return config;
}

// Verify JWT token and extract user info
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Connection-only helpers (getUserStatus / getIpAddress / generateUsername /
// trackChatMessage / syncChatUsername) moved into core/socketHandlers.js
// since the socket layer is their sole consumer.

// Format timestamp for chat messages
function formatTime() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Send system message to chat
function sendSystemMessage(message, io) {
  const systemMessage = {
    id: `system_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#FF6B35',
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(systemMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', systemMessage);
  console.log(`🤖 ADMIN: System message sent: ${message}`);
}

// Send admin command response as a private chat message visible only to the admin
function sendAdminResponse(socket, message) {
  const adminMessage = {
    id: `admin_response_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#FF4444',
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true,
    isAdminOnly: true
  };

  socket.emit('new-message', adminMessage);
  console.log(`🤖 ADMIN RESPONSE: Sent to admin - ${message}`);
}

// Claim event helpers + state live in ./claims/claimEventService.js.
// Instantiated here so the service captures live refs to io, chatMessages,
// MAX_CHAT_HISTORY, formatTime, and getUniqueViewerCount.
const claimEventService = createClaimEventService({
  io,
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  // getUniqueViewerCount is declared just below; wrap in a thunk so the
  // service can call it lazily without depending on hoisting order.
  getUniqueViewerCount: () => getUniqueViewerCount()
});
const { scheduleNextClaimEvent } = claimEventService;

// ============================================
// Vote subsystems (skip / swap / extend / reduce / lock / unlock)
// ============================================
//
// Each vote subsystem lives in its own file under ./votes/ and is built on
// the common scaffold in ./votes/voteService.js. The state for each vote
// type (active vote, warning timers, last-end bookkeeping for cooldowns)
// is owned by the service; the command parser below reads it via the
// service's `state` object (e.g. `skipVote.state.active`) and writes the
// solo/auto-execute paths' `lastEndTime`/`lastPassed` updates through the
// same handle.

// Get current unique viewer count (excluding bots)
function getUniqueViewerCount() {
  const uniqueIps = new Set();
  connectedUsers.forEach(user => {
    // Don't count bots as viewers
    if (!user.isBot) {
      uniqueIps.add(user.ip);
    }
  });
  return uniqueIps.size;
}

const voteDeps = {
  io,
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  getUniqueViewerCount,
  axios,
  MAIN_SERVER_URL,
  getAxiosConfig
};

const skipVote = createSkipVote(voteDeps);
const swapVote = createSwapVote(voteDeps);
const extendVote = createExtendVote(voteDeps);
const reduceVote = createReduceVote(voteDeps);
const lockVote = createLockVote(voteDeps);
const unlockVote = createUnlockVote(voteDeps);

// Per-vote-type cooldown constants. The parser uses these to gate consecutive
// vote attempts; the services don't reference them (they only update the
// state.lastEndTime/lastPassed values that the parser reads).
const { EXTEND_VOTE_COOLDOWN } = extendVote.constants;
const { REDUCE_VOTE_COOLDOWN } = reduceVote.constants;
const { LOCK_VOTE_COOLDOWN } = lockVote.constants;
const { UNLOCK_VOTE_COOLDOWN } = unlockVote.constants;

// Public command parser (`!xxx` dispatch). Lives in ./commands/commandParser.js.
const commandParser = createCommandParser({
  io,
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  getUniqueViewerCount,
  axios,
  MAIN_SERVER_URL,
  getAxiosConfig,
  sendAdminResponse,
  claimEventService,
  voteServices: {
    skipVote,
    swapVote,
    extendVote,
    reduceVote,
    lockVote,
    unlockVote
  },
  voteCooldowns: {
    VOTE_COOLDOWN_FAILED,
    VOTE_COOLDOWN_SUCCESS,
    EXTEND_VOTE_COOLDOWN,
    REDUCE_VOTE_COOLDOWN,
    LOCK_VOTE_COOLDOWN,
    UNLOCK_VOTE_COOLDOWN,
    SINGLE_VIEWER_ACTION_COOLDOWN
  }
});

// Admin command dispatch table (`/`-prefixed commands). Lives in
// ./core/adminCommands.js. Captures live refs to the moderation service,
// chat history ring, vote services (for parseStreamUrl in /swap), claim
// service (for /claim), and the shared send* helpers above.
const adminCommands = createAdminCommands({
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  moderationService,
  connectedUsers,
  sendAdminResponse,
  sendSystemMessage,
  axios,
  MAIN_SERVER_URL,
  getAxiosConfig,
  claimEventService,
  voteServices: {
    skipVote,
    swapVote,
    extendVote,
    reduceVote,
    lockVote,
    unlockVote
  }
});

// Add middleware to parse JSON bodies
app.use(express.json());

// HTTP API routes — moved into ./api/routes.js (PR-K5).
// The router shares the same moderationService, chatMessages ring, and
// connectedUsers map instances that the socket layer and command parser
// mutate, so behavior is unchanged. No API route checks auth (chat-service
// trusts the main server reaching it over private networking).
app.use(createApiRouter({
  io,
  moderationService,
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  connectedUsers
}));

/*
 * Socket Events Emitted by Chat Service:
 * - 'new-message' - Regular chat messages and admin responses
 * - 'user-assigned' - Username and color assignment for new users
 * - 'user-count-update' - Number of unique connected users
 * - 'chat-history' - Recent chat messages for new connections
 * - 'banned' - User ban notification
 * - 'timeout' - User timeout notification
 * - 'chat-clear-ui' - Instruction to clear all messages from UI
 * - 'chat-cleared' - Legacy event (kept for compatibility)
 */

// Socket handlers — moved into ./core/socketHandlers.js (PR-K6).
// The handler module owns the throttle Maps (userLastMessage,
// userMessageHistory) and the rate-limit / duplicate-detection / profanity
// gates, plus all socket.on listeners for one connection. We hand it live
// refs to every shared dep (io, moderationService, the message ring, etc.)
// so behavior is unchanged. The graceful-shutdown handler below reaches
// back into the returned `userLastMessage` / `userMessageHistory` to clear
// them on SIGTERM/SIGINT.
const socketHandlers = createSocketHandlers({
  io,
  profanityFilter,
  moderationService,
  commandParser,
  adminCommands,
  connectedUsers,
  ipToUser,
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  verifyToken,
  sendAdminResponse,
  MAIN_SERVER_URL,
  axios,
  getAxiosConfig,
  uuidv4
});

io.on('connection', (socket) => {
  socketHandlers.register(socket);
});

const PORT = process.env.CHAT_PORT || 8081;

// Load moderation data on startup
loadModerationData();

// Start HTTP server
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`💬 CHAT HTTP: Running on port ${PORT}`);
  console.log(`💬 CHAT HTTP: Health check at http://onestreamer.live:${PORT}/health`);
});

// Start HTTPS server if configured
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`🔒 CHAT HTTPS: Running on port ${HTTPS_PORT}`);
    console.log(`🔒 CHAT HTTPS: Health check at https://onestreamer.live:${HTTPS_PORT}/health`);
    console.log('⚠️  Note: Using self-signed certificate. Browser will show security warning.');
  });
}

console.log(`💬 CHAT SERVICE: Ready to accept WebSocket connections`);

// Start the claim event timer
scheduleNextClaimEvent();
console.log(`🎉 CLAIM: Claim event system initialized`);

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`💬 CHAT SERVICE: Received ${signal}, shutting down gracefully...`);

  try {
    // 1. Disconnect all socket connections
    console.log('🔌 CHAT: Disconnecting all socket connections...');
    const sockets = await io.fetchSockets();
    for (const socket of sockets) {
      socket.disconnect(true);
    }

    // 2. Clear all user data
    console.log('📊 CHAT: Clearing user data...');
    connectedUsers.clear();
    ipToUser.clear();
    socketHandlers.userLastMessage.clear();
    socketHandlers.userMessageHistory.clear();

    // 3. Close the HTTP server
    console.log('🌐 CHAT: Closing HTTP server...');
    await new Promise((resolve) => {
      server.close(resolve);
    });

    console.log('✅ CHAT SERVICE: Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ CHAT SERVICE: Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
