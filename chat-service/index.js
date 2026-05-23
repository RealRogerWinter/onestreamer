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

// Animal names for random usernames
const ANIMALS = [
  'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
  'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
  'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
  'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
  'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
];

// Color palette for usernames
const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8E8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#A9DFBF', '#F9E79F',
  '#D7BDE2', '#A3E4D7', '#FAD7A0', '#D5A6BD', '#87CEEB', '#DEB887', '#F0E68C', '#FFB6C1'
];

// Store connected users and their chat data
const connectedUsers = new Map();
const ipToUser = new Map(); // Store username assignments by IP
const chatMessages = [];
const MAX_CHAT_HISTORY = 3000; // Keep last 3000 messages (~1 hour of active chat)

// Admin functionality — moderation state + helpers live in
// ./moderation/moderationService.js. The service is instantiated below
// (after MODERATION_DATA_PATH is resolved). Local aliases bind to the
// service's state so legacy call sites in the command parser and HTTP API
// (PR-K3/K4/K5) keep mutating the same instances without code churn.

// Chat throttling functionality
const userLastMessage = new Map(); // Store last message timestamp: username -> timestamp
const userMessageHistory = new Map(); // Store recent messages: username -> [{ message, timestamp }, ...]
const RATE_LIMIT_DELAY = 5000; // 5 seconds between messages
const DUPLICATE_MESSAGE_WINDOW = 30000; // 30 seconds for duplicate detection

// Claim event system — state, constants, and helpers live in ./claims/claimEventService.js
// (instantiated below once dependencies like formatTime and chatMessages are in scope).

// Vote system constants
// Shared cooldown constants used by the command parser to gate consecutive
// vote attempts. The per-vote services in ./votes/*Vote.js own their own
// duration/threshold/cooldown constants; only these cross-vote knobs stay
// at the entry point.
const VOTE_COOLDOWN_FAILED = 2 * 60 * 1000;  // 2 minutes after a failed vote
const VOTE_COOLDOWN_SUCCESS = 5 * 60 * 1000; // 5 minutes after a successful vote

// Per-vote subsystems are instantiated lower in the file (after io,
// chatMessages, formatTime, getUniqueViewerCount are in scope), alongside
// the claim service. See ./votes/voteService.js for the common scaffold.

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
const {
  loadModerationData,
  saveModerationData,
  isUserBanned,
  isUserTimedOut,
  bannedUsers,
  bannedUsersData,
  timeoutUsers
} = moderationService;

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

// Get user admin/moderator status from main server
async function getUserStatus(userId) {
  try {
    const response = await axios.get(
      `${MAIN_SERVER_URL}/api/admin/internal/user/${userId}/status`, 
      getAxiosConfig({ timeout: 5000 })
    );
    return {
      isAdmin: response.data.isAdmin || false,
      isModerator: response.data.isModerator || false,
      isBanned: response.data.isBanned || false
    };
  } catch (error) {
    console.error(`❌ CHAT: Failed to check user status for user ${userId}:`, error.message);
    return { isAdmin: false, isModerator: false, isBanned: false };
  }
}

// Legacy function for backward compatibility
async function getUserAdminStatus(userId) {
  const status = await getUserStatus(userId);
  return status.isAdmin;
}

// Get IP address from socket
function getIpAddress(socket) {
  let ip = socket.handshake.headers['x-forwarded-for'] || 
           socket.handshake.headers['x-real-ip'] ||
           socket.handshake.address ||
           socket.conn.remoteAddress ||
           socket.request.connection.remoteAddress ||
           '127.0.0.1';
  
  // Handle IPv6 localhost
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }
  
  // Extract IPv4 from IPv6 format if needed
  if (ip.includes('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  }
  
  // If multiple IPs (from proxy chain), take the first one
  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  
  return ip;
}

// Generate random username with color
function generateUsername() {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const number = Math.floor(Math.random() * 9999) + 1;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  
  return {
    name: `${animal}${number}`,
    color: color
  };
}

// Format timestamp for chat messages
function formatTime() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Check if user is admin
function isUserAdmin(userInfo) {
  return userInfo && userInfo.isAuthenticated && userInfo.isAdmin;
}

// isUserBanned + isUserTimedOut now provided by moderationService (above).

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

// Send throttle notification to user (private message)
function sendThrottleNotification(socket, message) {
  const throttleMessage = {
    id: `throttle_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '⏱️ Chat System',
    color: '#FFA500',
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true,
    isThrottleNotification: true
  };
  
  socket.emit('new-message', throttleMessage);
  console.log(`⏱️ THROTTLE: Notification sent - ${message}`);
}

// Check if user is rate limited (5 second cooldown)
function isRateLimited(username) {
  if (!userLastMessage.has(username)) {
    return false;
  }
  
  const lastMessageTime = userLastMessage.get(username);
  const timeSinceLastMessage = Date.now() - lastMessageTime;
  
  return timeSinceLastMessage < RATE_LIMIT_DELAY;
}

// Check if message is duplicate within time window
function isDuplicateMessage(username, message) {
  if (!userMessageHistory.has(username)) {
    userMessageHistory.set(username, []);
  }
  
  const messageHistory = userMessageHistory.get(username);
  const currentTime = Date.now();
  
  // Clean up old messages outside the window
  const recentMessages = messageHistory.filter(msg => 
    currentTime - msg.timestamp < DUPLICATE_MESSAGE_WINDOW
  );
  userMessageHistory.set(username, recentMessages);
  
  // Check if current message is duplicate
  return recentMessages.some(msg => msg.message === message);
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
const { startClaimEvent, scheduleNextClaimEvent, generateClaimCode } = claimEventService;

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
//
// The legacy function names (startSkipVote, registerSkipVote, etc.) are
// re-exported by destructuring so the parser keeps calling the same surface
// it did before extraction.

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

const { startSkipVote, registerSkipVote, clearSkipVoteTimers, sendSkipVoteMessage } = skipVote;
const { startSwapVote, registerSwapVote, clearSwapVoteTimers, sendSwapVoteMessage, parseStreamUrl } = swapVote;
const { startExtendVote, registerExtendVote, clearExtendVoteTimers, sendExtendVoteMessage } = extendVote;
const { startReduceVote, registerReduceVote, clearReduceVoteTimers, sendReduceVoteMessage } = reduceVote;
const { startLockVote, registerLockVote, clearLockVoteTimers, sendLockVoteMessage } = lockVote;
const { startUnlockVote, registerUnlockVote, clearUnlockVoteTimers, sendUnlockVoteMessage } = unlockVote;

// Per-vote-type cooldown constants. The parser uses these to gate consecutive
// vote attempts; the services don't reference them (they only update the
// state.lastEndTime/lastPassed values that the parser reads).
const { EXTEND_VOTE_COOLDOWN } = extendVote.constants;
const { REDUCE_VOTE_COOLDOWN } = reduceVote.constants;
const { LOCK_VOTE_COOLDOWN } = lockVote.constants;
const { UNLOCK_VOTE_COOLDOWN } = unlockVote.constants;

// Public command parser (`!xxx` dispatch). Lives in ./commands/commandParser.js.
// The parser captures live references to io/chatMessages/formatTime, the
// claim + vote services, and the cross-vote cooldown constants — same
// surface the inline switch relied on. The single-viewer cooldown timestamp
// (`lastSingleViewerActionTime`) is encapsulated inside the parser closure
// since only the solo auto-execute paths touch it.
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

// Update user's message history for throttling
function updateUserMessageHistory(username, message) {
  const currentTime = Date.now();
  
  // Update last message timestamp
  userLastMessage.set(username, currentTime);
  
  // Add to message history
  if (!userMessageHistory.has(username)) {
    userMessageHistory.set(username, []);
  }
  
  const messageHistory = userMessageHistory.get(username);
  messageHistory.push({ message, timestamp: currentTime });
  
  // Keep only recent messages (cleanup)
  const recentMessages = messageHistory.filter(msg => 
    currentTime - msg.timestamp < DUPLICATE_MESSAGE_WINDOW
  );
  userMessageHistory.set(username, recentMessages);
}

// Admin command handlers
const adminCommands = {
  help: (socket, args, userInfo, io) => {
    let helpMessage;
    
    if (userInfo.isAdmin) {
      // Full admin commands
      helpMessage = `Available admin commands:
/help - Show this help message
/ban [username] - Ban a user from chat
/unban [username] - Unban a user from chat
/timeout [username] [seconds] - Timeout a user for specified duration
/clear - Clear all chat messages
/tts [message] - Send a TTS message
/award [username] [amount] - Award points to a user (admin only)
/claim - Manually trigger a claim event
/take [username] [amount] - Take points from a user (admin only)
/announce [message] - Send a highlighted announcement
/next [kick|twitch] - Skip to next stream (no vote required)
/swap [url] - Swap to specific stream (no vote required)
/extend [minutes] - Extend rotation timer (default: 5 min)
/reduce [minutes] - Reduce rotation timer (default: 5 min)
/lock - Lock/toggle rotation timer (freeze countdown)
/unlock - Unlock rotation timer (resume countdown)`;
    } else if (userInfo.isModerator) {
      // Moderator commands only
      helpMessage = `Available moderator commands:
/help - Show this help message
/ban [username] - Ban a user from chat
/unban [username] - Unban a user from chat
/timeout [username] [seconds] - Timeout a user for specified duration
/clear - Clear all chat messages
/tts [message] - Send a TTS message
/announce [message] - Send a highlighted announcement
/next [kick|twitch] - Skip to next stream (no vote required)
/swap [url] - Swap to specific stream (no vote required)`;
    } else {
      helpMessage = 'You do not have permission to use admin commands.';
    }
    
    sendAdminResponse(socket, helpMessage);
  },
  
  announce: (socket, args, userInfo, io) => {
    if (args.length === 0) {
      sendAdminResponse(socket, 'Usage: /announce [message]');
      return;
    }
    
    const announcement = args.join(' ');
    
    // Send highlighted announcement
    const announcementMessage = {
      id: `announce_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: '📢 ANNOUNCEMENT',
      color: '#FFD700',
      message: announcement,
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true,
      isAnnouncement: true
    };
    
    // Add to message history
    chatMessages.push(announcementMessage);
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }
    
    // Broadcast to all users
    io.emit('new-message', announcementMessage);
    
    sendAdminResponse(socket, `✅ Announcement sent: "${announcement}"`);
    console.log(`📢 ADMIN: ${userInfo.username} sent announcement: ${announcement}`);
  },
  
  ban: (socket, args, userInfo, io) => {
    if (args.length === 0) {
      sendAdminResponse(socket, 'Usage: /ban [username]');
      return;
    }
    
    const targetUsername = args.join(' ');
    bannedUsers.add(targetUsername);
    bannedUsersData.set(targetUsername, {
      bannedAt: new Date().toISOString(),
      reason: 'Banned via admin command',
      bannedBy: userInfo.username
    });
    
    // Save to disk
    saveModerationData();
    
    console.log(`🔨 BAN: Adding "${targetUsername}" to ban list`);
    console.log(`🔨 BAN: Current banned users:`, Array.from(bannedUsers));
    
    // Delete all messages from the banned user
    const messagesToDelete = [];
    const lowerTargetUsername = targetUsername.toLowerCase();
    
    // Find all message IDs from the banned user
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].username && chatMessages[i].username.toLowerCase() === lowerTargetUsername) {
        messagesToDelete.push(chatMessages[i].id);
        chatMessages.splice(i, 1); // Remove from array
      }
    }
    
    // Emit event to delete messages from all clients
    if (messagesToDelete.length > 0) {
      io.emit('delete-messages', { messageIds: messagesToDelete, reason: 'user_banned' });
      console.log(`🔨 BAN: Deleted ${messagesToDelete.length} messages from ${targetUsername}`);
    }
    
    // Disconnect all sockets with this username (case-insensitive)
    let disconnectedCount = 0;
    connectedUsers.forEach((user, socketId) => {
      if (user.username.toLowerCase() === lowerTargetUsername) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          console.log(`🔨 BAN: Disconnecting socket ${socketId} for user ${user.username}`);
          targetSocket.emit('banned', { reason: 'You have been banned by an administrator' });
          targetSocket.disconnect(true);
          disconnectedCount++;
        }
      }
    });
    
    sendSystemMessage(`User ${targetUsername} has been banned and their messages have been removed`, io);
    sendAdminResponse(socket, `✅ Banned ${targetUsername}, deleted ${messagesToDelete.length} messages, and disconnected ${disconnectedCount} connection(s)`);
  },
  
  unban: (socket, args, userInfo, io) => {
    if (args.length === 0) {
      sendAdminResponse(socket, 'Usage: /unban [username]');
      return;
    }
    
    const targetUsername = args.join(' ');
    
    if (!bannedUsers.has(targetUsername)) {
      sendAdminResponse(socket, `❌ User ${targetUsername} is not currently banned`);
      return;
    }
    
    bannedUsers.delete(targetUsername);
    bannedUsersData.delete(targetUsername);
    
    // Save to disk
    saveModerationData();
    
    sendSystemMessage(`User ${targetUsername} has been unbanned`, io);
    sendAdminResponse(socket, `✅ Unbanned ${targetUsername} - they can now reconnect to chat`);
  },
  
  timeout: (socket, args, userInfo, io) => {
    if (args.length < 2) {
      sendAdminResponse(socket, 'Usage: /timeout [username] [seconds]');
      return;
    }
    
    const duration = parseInt(args[args.length - 1]);
    const targetUsername = args.slice(0, -1).join(' ');
    
    if (isNaN(duration) || duration <= 0) {
      sendAdminResponse(socket, 'Invalid duration. Please provide a positive number of seconds.');
      return;
    }
    
    const startTime = Date.now();
    const endTime = startTime + (duration * 1000);
    timeoutUsers.set(targetUsername, {
      endTime,
      reason: 'Timed out by administrator',
      startTime: startTime
    });
    
    // Save to disk
    saveModerationData();
    
    console.log(`⏱️ TIMEOUT: Adding "${targetUsername}" to timeout list for ${duration}s`);
    console.log(`⏱️ TIMEOUT: Current timed out users:`, Array.from(timeoutUsers.keys()));
    
    // Send timeout notification to affected users
    connectedUsers.forEach((user, socketId) => {
      if (user.username === targetUsername) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          targetSocket.emit('timeout', {
            duration: duration,
            endTime: endTime,
            reason: 'You have been timed out by an administrator'
          });
        }
      }
    });
    
    sendSystemMessage(`User ${targetUsername} has been timed out for ${duration} seconds`, io);
    sendAdminResponse(socket, `⏰ Timed out ${targetUsername} for ${duration} seconds`);
  },
  
  clear: (socket, args, userInfo, io) => {
    const clearedCount = chatMessages.length;
    chatMessages.length = 0; // Clear all messages from server memory
    
    // Send a special message that instructs frontend to clear UI
    const clearMessage = {
      id: `clear_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: '🧹 System',
      color: '#FF6B35',
      message: '**CLEAR_CHAT_UI**', // Special marker for frontend
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true,
      isClearCommand: true
    };
    
    // Broadcast the clear message to all users
    io.emit('new-message', clearMessage);
    
    // Also emit the legacy chat-cleared event for compatibility
    io.emit('chat-cleared', { 
      message: 'Chat has been cleared by an administrator',
      timestamp: new Date().toISOString()
    });
    
    // Send admin confirmation
    sendAdminResponse(socket, `🗑️ Cleared ${clearedCount} messages from chat`);
    
    // After a short delay, send confirmation message
    setTimeout(() => {
      sendSystemMessage('Chat has been cleared by an administrator', io);
    }, 200);
  },
  
  tts: async (socket, args, userInfo, io) => {
    if (args.length === 0) {
      sendAdminResponse(socket, 'Usage: /tts [message]');
      return;
    }
    
    const message = args.join(' ');
    
    try {
      // Make request to main server SoundFX service
      await axios.post(`${MAIN_SERVER_URL}/api/soundfx/tts`, {
        text: message,
        voiceId: 'alloy'
      }, getAxiosConfig({
        headers: {
          'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
        },
        timeout: 10000
      }));
      
      sendAdminResponse(socket, `📢 TTS message sent: "${message}"`);
    } catch (error) {
      console.error('❌ ADMIN: Failed to send TTS:', error.message);
      sendAdminResponse(socket, `❌ Failed to send TTS: ${error.message}`);
    }
  },
  
  claim: (socket, args, userInfo, io) => {
    // Admin only command
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }
    
    const result = startClaimEvent(true);
    if (result) {
      sendAdminResponse(socket, '✅ Claim event started manually!');
    } else {
      sendAdminResponse(socket, '❌ A claim event is already active!');
    }
  },
  
  award: async (socket, args, userInfo, io) => {
    // Admin only command
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }
    
    if (args.length < 2) {
      sendAdminResponse(socket, 'Usage: /award [username] [amount]');
      return;
    }
    
    const amount = parseInt(args[args.length - 1]);
    const targetUsername = args.slice(0, -1).join(' ');
    
    if (isNaN(amount) || amount <= 0) {
      sendAdminResponse(socket, 'Invalid amount. Please provide a positive number.');
      return;
    }
    
    try {
      // Make request to main server to award points (admin only)
      const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/admin/award-points`, {
        targetUsername,
        amount,
        adminUserId: userInfo.authenticatedUserId
      }, getAxiosConfig({
        headers: {
          'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
        },
        timeout: 10000
      }));
      
      if (response.data.success) {
        // Send StreamBot message to chat
        const streamerBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#00FF00',
          message: `🎁 ${targetUsername} has been awarded ${amount} points by an admin!`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };
        
        // Add to message history
        chatMessages.push(streamerBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }
        
        // Broadcast to all users
        io.emit('new-message', streamerBotMessage);
        
        sendAdminResponse(socket, `✅ Awarded ${amount} points to ${targetUsername}. New balance: ${response.data.newBalance}`);
      } else {
        sendAdminResponse(socket, `❌ Failed to award points: ${response.data.error}`);
      }
    } catch (error) {
      console.error('❌ ADMIN: Failed to award points:', error.message);
      sendAdminResponse(socket, `❌ Failed to award points: ${error.response?.data?.error || error.message}`);
    }
  },
  
  take: async (socket, args, userInfo, io) => {
    // Admin only command
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }
    
    if (args.length < 2) {
      sendAdminResponse(socket, 'Usage: /take [username] [amount]');
      return;
    }
    
    const amount = parseInt(args[args.length - 1]);
    const targetUsername = args.slice(0, -1).join(' ');
    
    if (isNaN(amount) || amount <= 0) {
      sendAdminResponse(socket, 'Invalid amount. Please provide a positive number.');
      return;
    }
    
    try {
      // Make request to main server to take points
      const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/admin/take-points`, {
        targetUsername,
        amount,
        adminUserId: userInfo.authenticatedUserId
      }, getAxiosConfig({
        headers: {
          'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
        },
        timeout: 10000
      }));
      
      if (response.data.success) {
        // Send StreamBot message to chat
        const streamerBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#00FF00',
          message: `💸 ${amount} points have been deducted from ${targetUsername} by an admin.`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };
        
        // Add to message history
        chatMessages.push(streamerBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }
        
        // Broadcast to all users
        io.emit('new-message', streamerBotMessage);
        
        sendAdminResponse(socket, `✅ Deducted ${amount} points from ${targetUsername}. New balance: ${response.data.newBalance}`);
      } else {
        sendAdminResponse(socket, `❌ Failed to take points: ${response.data.error}`);
      }
    } catch (error) {
      console.error('❌ ADMIN: Failed to take points:', error.message);
      sendAdminResponse(socket, `❌ Failed to take points: ${error.response?.data?.error || error.message}`);
    }
  },

  next: async (socket, args, userInfo, io) => {
    // Parse optional platform argument (kick or twitch)
    const platform = args[0]?.toLowerCase();
    const validPlatforms = ['kick', 'twitch'];

    if (platform && !validPlatforms.includes(platform)) {
      sendAdminResponse(socket, `❌ Invalid platform. Use: /next [kick|twitch]`);
      return;
    }

    const platformText = platform ? ` (${platform})` : '';
    sendAdminResponse(socket, `⏳ Skipping to next stream${platformText}...`);
    console.log(`🎬 ADMIN: ${userInfo.username} triggered stream skip via /next command${platformText}`);

    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/rotate`,
        { platform },  // Pass platform to API
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        // Send public message
        const skipMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#FF6B6B',
          message: platform
            ? `⏭️ ${userInfo.username} skipped to the next ${platform.charAt(0).toUpperCase() + platform.slice(1)} stream.`
            : `⏭️ ${userInfo.username} skipped to the next stream.`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(skipMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', skipMessage);
        // Emit event to update the streaming header
        io.emit('stream-info-update', { source: 'admin-skip', message: 'Stream skipped by admin' });
        // Unlock rotation timer if it was locked
        try {
          await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
          console.log('🎬 ADMIN: Rotation timer unlocked after /next');
        } catch (unlockErr) {
          console.log('🎬 ADMIN: Timer was not locked or unlock failed:', unlockErr.message);
        }
        sendAdminResponse(socket, `✅ Successfully skipped to next ${platform ? platform + ' ' : ''}stream`);
      } else {
        sendAdminResponse(socket, `❌ Failed to skip: ${response.data.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('❌ ADMIN: Failed to skip stream:', error.message);
      sendAdminResponse(socket, `❌ Failed to skip stream: ${error.response?.data?.error || error.message}`);
    }
  },

  swap: async (socket, args, userInfo, io) => {
    // Swap to specific stream without voting
    if (args.length === 0) {
      sendAdminResponse(socket, 'Usage: /swap [twitch.tv/channel or kick.com/channel]');
      return;
    }

    const targetUrl = args[0];
    const parsedUrl = parseStreamUrl(targetUrl);

    if (!parsedUrl) {
      sendAdminResponse(socket, '❌ Invalid URL. Please provide a valid Twitch or Kick channel URL (e.g., twitch.tv/channelname or kick.com/channelname)');
      return;
    }

    const platformIcon = parsedUrl.platform === 'twitch' ? '📺' : '🟢';
    const platformName = parsedUrl.platform === 'twitch' ? 'Twitch' : 'Kick';

    sendAdminResponse(socket, `⏳ Swapping to ${platformName} channel: ${parsedUrl.channel}...`);
    console.log(`🎬 ADMIN: ${userInfo.username} triggered stream swap to ${parsedUrl.url} via /swap command`);

    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/url-stream`,
        {
          url: parsedUrl.url,
          quality: 'best',
          displayName: `${parsedUrl.channel} (Admin)`,
          autoReconnect: true
        },
        getAxiosConfig({ timeout: 15000 })
      );

      if (response.data.success) {
        // Send public message
        const swapMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#9B59B6',
          message: `🔄 ${userInfo.username} swapped to ${platformIcon} ${platformName} channel: ${parsedUrl.channel}`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(swapMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', swapMessage);
        // Emit event to update the streaming header
        io.emit('stream-info-update', {
          source: 'admin-swap',
          channel: parsedUrl.channel,
          platform: parsedUrl.platform,
          message: `Swapped to ${parsedUrl.channel} by admin`
        });
        // Unlock rotation timer if it was locked
        try {
          await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
          console.log('🎬 ADMIN: Rotation timer unlocked after /swap');
        } catch (unlockErr) {
          console.log('🎬 ADMIN: Timer was not locked or unlock failed:', unlockErr.message);
        }
        sendAdminResponse(socket, `✅ Successfully swapped to ${platformName} channel: ${parsedUrl.channel}`);
      } else {
        sendAdminResponse(socket, `❌ Failed to swap: ${response.data.error || 'Unknown error'}. The stream may be offline.`);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      console.error('❌ ADMIN: Failed to swap stream:', error.message);
      sendAdminResponse(socket, `❌ Failed to swap stream: ${errorMsg}. The stream may be offline.`);
    }
  },

  extend: async (socket, args, userInfo, io) => {
    // Admin only - extend rotation timer by 5 minutes (no vote required)
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }

    const minutes = args.length > 0 ? parseInt(args[0]) : 5;
    if (isNaN(minutes) || minutes <= 0 || minutes > 60) {
      sendAdminResponse(socket, 'Invalid minutes. Please provide a number between 1 and 60.');
      return;
    }

    console.log(`⏰ ADMIN: ${userInfo.username} extending rotation by ${minutes} minutes via /extend command`);

    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/admin-extend`,
        { minutes },
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        // Send public message
        const extendMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#10B981',
          message: `⏰ ${userInfo.username} extended the stream by ${minutes} minutes!`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(extendMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', extendMessage);
        sendAdminResponse(socket, `✅ Extended rotation by ${minutes} minutes.`);
      } else {
        sendAdminResponse(socket, `❌ Failed to extend: ${response.data.error || 'Unknown error'}`);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      console.error('❌ ADMIN: Failed to extend rotation:', error.message);
      sendAdminResponse(socket, `❌ Failed to extend: ${errorMsg}`);
    }
  },

  reduce: async (socket, args, userInfo, io) => {
    // Admin only - reduce rotation timer by 5 minutes (no vote required)
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }

    const minutes = args.length > 0 ? parseInt(args[0]) : 5;
    if (isNaN(minutes) || minutes <= 0 || minutes > 60) {
      sendAdminResponse(socket, 'Invalid minutes. Please provide a number between 1 and 60.');
      return;
    }

    console.log(`⏰ ADMIN: ${userInfo.username} reducing rotation by ${minutes} minutes via /reduce command`);

    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/admin-reduce`,
        { minutes },
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        // Send public message
        const reduceMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#F59E0B',
          message: `⏰ ${userInfo.username} reduced the stream time by ${response.data.reducedByMinutes} minutes!`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(reduceMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', reduceMessage);
        sendAdminResponse(socket, `✅ Reduced rotation by ${response.data.reducedByMinutes} minutes.`);
      } else {
        sendAdminResponse(socket, `❌ Failed to reduce: ${response.data.error || 'Unknown error'}`);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      console.error('❌ ADMIN: Failed to reduce rotation:', error.message);
      sendAdminResponse(socket, `❌ Failed to reduce: ${errorMsg}`);
    }
  },

  lock: async (socket, args, userInfo, io) => {
    // Admin only - lock/unlock rotation timer
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }

    console.log(`🔒 ADMIN: ${userInfo.username} toggling rotation lock via /lock command`);

    try {
      // First check current lock status
      const statusResponse = await axios.get(
        `${MAIN_SERVER_URL}/api/random-stream/lock-status`,
        getAxiosConfig({ timeout: 5000 })
      );

      const isCurrentlyLocked = statusResponse.data.isLocked;

      // Toggle lock state
      const endpoint = isCurrentlyLocked ? 'unlock' : 'lock';
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/${endpoint}`,
        {},
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        const action = isCurrentlyLocked ? 'unlocked' : 'locked';
        const icon = isCurrentlyLocked ? '🔓' : '🔒';

        // Send public message
        const lockMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#F59E0B',
          message: `${icon} ${userInfo.username} ${action} the rotation timer!`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(lockMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', lockMessage);
        sendAdminResponse(socket, `✅ Rotation timer ${action}.`);
      } else {
        sendAdminResponse(socket, `❌ Failed to toggle lock: ${response.data.error || 'Unknown error'}`);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      console.error('❌ ADMIN: Failed to toggle rotation lock:', error.message);
      sendAdminResponse(socket, `❌ Failed to toggle lock: ${errorMsg}`);
    }
  },

  unlock: async (socket, args, userInfo, io) => {
    // Admin only - explicitly unlock rotation timer
    if (!userInfo.isAdmin) {
      sendAdminResponse(socket, 'This command is only available to administrators.');
      return;
    }

    console.log(`🔓 ADMIN: ${userInfo.username} unlocking rotation via /unlock command`);

    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/unlock`,
        {},
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        // Send public message
        const unlockMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#F59E0B',
          message: `🔓 ${userInfo.username} unlocked the rotation timer!`,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(unlockMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', unlockMessage);
        sendAdminResponse(socket, `✅ Rotation timer unlocked.`);
      } else {
        sendAdminResponse(socket, `❌ Failed to unlock: ${response.data.error || 'Unknown error'}`);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      console.error('❌ ADMIN: Failed to unlock rotation:', error.message);
      sendAdminResponse(socket, `❌ Failed to unlock: ${errorMsg}`);
    }
  }
};


// Track chat message with main server
async function trackChatMessage(userId, ip) {
  try {
    const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/track-chat-message`, {
      userId,
      ip
    }, getAxiosConfig({
      timeout: 5000
    }));
    
    console.log(`💬 CHAT: Message tracking result for user ${userId}:`, response.data);
  } catch (error) {
    console.error(`❌ CHAT: Failed to track message for user ${userId}:`, error.message);
  }
}

// Sync chat username with main server
async function syncChatUsername(ip, username, color) {
  try {
    const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/sync-chat-username`, {
      ip,
      username,
      color
    }, getAxiosConfig({
      timeout: 5000
    }));
    
    console.log(`💬 CHAT: Username sync result for IP ${ip}:`, response.data);
  } catch (error) {
    console.error(`❌ CHAT: Failed to sync username for IP ${ip}:`, error.message);
  }
}

// Add middleware to parse JSON bodies
app.use(express.json());

// HTTP API routes — moved into ./api/routes.js (PR-K5).
// The router shares the same moderationService, chatMessages ring, and
// connectedUsers map instances that the socket layer and command parser
// mutate, so behavior is unchanged. verifyToken + JWT_SECRET are passed
// through purely so /debug/test-token can keep reporting JWT validity;
// no other API route checks auth (chat-service trusts the main server
// reaching it over private networking).
app.use(createApiRouter({
  io,
  moderationService,
  chatMessages,
  MAX_CHAT_HISTORY,
  formatTime,
  connectedUsers,
  verifyToken,
  JWT_SECRET
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

// Socket.IO connection handling
io.on('connection', async (socket) => {
  const ip = getIpAddress(socket);
  console.log(`💬 CHAT: User connected: ${socket.id} from IP: ${ip}`);
  
  let userInfo;
  let authenticatedUser = null;
  
  // Check if this is a bot connection
  const isBot = socket.handshake.query?.isBot === 'true';
  const botId = socket.handshake.query?.botId;
  
  if (isBot) {
    console.log(`🤖 CHAT: Bot connection detected - Bot ID: ${botId}`);
  }
  
  // Check for authentication token in the handshake
  const token = socket.handshake.auth?.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
  console.log(`💬 CHAT: Token check - auth.token: ${!!socket.handshake.auth?.token}, headers.authorization: ${!!socket.handshake.headers.authorization}`);
  console.log(`💬 CHAT: Extracted token: ${token ? token.substring(0, 20) + '...' : 'null'}`);
  
  if (token) {
    authenticatedUser = verifyToken(token);
    if (authenticatedUser) {
      console.log(`💬 CHAT: Authenticated user connected: ${authenticatedUser.username} (ID: ${authenticatedUser.id})`);
    } else {
      console.log(`💬 CHAT: Invalid token provided for connection - token: ${token.substring(0, 20)}...`);
    }
  } else {
    console.log(`💬 CHAT: No authentication token provided for connection from IP: ${ip}`);
  }
  
  if (authenticatedUser) {
    // Use authenticated username with a consistent color
    const colorIndex = authenticatedUser.id % COLORS.length;
    let userColor = COLORS[colorIndex]; // Default color
    
    // Check user status (admin/moderator)
    let isAdmin = false;
    let isModerator = false;
    try {
      const userStatus = await getUserStatus(authenticatedUser.id);
      isAdmin = userStatus.isAdmin;
      isModerator = userStatus.isModerator;
    } catch (error) {
      console.error(`💬 CHAT: Failed to get user status for user ${authenticatedUser.id}:`, error);
    }
    
    // Try to load saved color preference
    try {
      const response = await axios.get(
        `${MAIN_SERVER_URL}/api/user/${authenticatedUser.id}/chat-color`,
        getAxiosConfig({ timeout: 5000 })
      );
      if (response.data && response.data.color) {
        userColor = response.data.color;
        console.log(`💬 CHAT: Loaded saved color ${userColor} for user ${authenticatedUser.username}`);
      }
    } catch (error) {
      console.log(`💬 CHAT: Could not load saved color for user ${authenticatedUser.id}, using default`);
    }
    
    userInfo = {
      name: authenticatedUser.username,
      color: userColor,
      isAuthenticated: true,
      isAdmin: isAdmin,
      isModerator: isModerator,
      userId: authenticatedUser.id
    };
    console.log(`💬 CHAT: Using authenticated username: ${userInfo.name} with color ${userInfo.color} (Admin: ${isAdmin}, Moderator: ${isModerator}, UserId: ${authenticatedUser.id})`);
    
    // For authenticated users, remove any previous IP-based assignment to prevent conflicts
    if (ipToUser.has(ip)) {
      console.log(`💬 CHAT: Removing IP-based username assignment for authenticated user`);
      ipToUser.delete(ip);
    }
  } else {
    // If this is a bot, we'll wait for the join-chat event to get the assigned name
    if (isBot) {
      console.log(`🤖 CHAT: Bot ${botId} connected, waiting for join-chat event for name assignment`);
      // Don't assign a username yet for bots
      userInfo = null;
    } else {
      // Check if this IP already has a username assigned
      if (ipToUser.has(ip)) {
        // Use existing username for this IP
        userInfo = ipToUser.get(ip);
        console.log(`💬 CHAT: Reusing existing username for IP ${ip}: ${userInfo.name}`);
      } else {
        // Generate new username for new IP
        userInfo = generateUsername();
        userInfo.isAuthenticated = false;
        ipToUser.set(ip, userInfo);
        console.log(`💬 CHAT: Assigned NEW username for IP ${ip}: ${userInfo.name} with color ${userInfo.color}`);
      }
      
      // Always sync username with main server for anonymous users
      console.log(`💬 CHAT: Syncing username for IP ${ip}: ${userInfo.name}`);
      syncChatUsername(ip, userInfo.name, userInfo.color).catch(err => {
        console.error('💬 CHAT: Error syncing username:', err);
      });
    }
  }
  
  // Store user info for this socket (if not a bot waiting for join-chat)
  if (userInfo) {
    connectedUsers.set(socket.id, {
      id: socket.id,
      ip: ip,
      username: userInfo.name,
      color: userInfo.color,
      isAuthenticated: userInfo.isAuthenticated || false,
      isAdmin: userInfo.isAdmin || false,
      isModerator: userInfo.isModerator || false,
      authenticatedUserId: userInfo.userId || null,
      joinedAt: new Date().toISOString()
    });
    
    // Check if user is banned or timed out
    if (isUserBanned(userInfo.name)) {
      console.log(`💬 CHAT: Banned user ${userInfo.name} attempted to connect`);
      socket.emit('banned', { reason: 'You are banned from chat' });
      socket.disconnect(true);
      return;
    }
    
    if (isUserTimedOut(userInfo.name)) {
      const timeout = timeoutUsers.get(userInfo.name);
      const remainingTime = Math.ceil((timeout.endTime - Date.now()) / 1000);
      console.log(`💬 CHAT: Timed out user ${userInfo.name} attempted to connect`);
      socket.emit('timeout', { 
        duration: remainingTime,
        endTime: timeout.endTime,
        reason: timeout.reason 
      });
      socket.disconnect(true);
      return;
    }
    
    // Send user their assigned username and color
    socket.emit('user-assigned', {
      username: userInfo.name,
      color: userInfo.color,
      userId: socket.id
    });
  } else if (isBot) {
    // For bots, we'll handle this in join-chat event
    console.log(`🤖 CHAT: Bot ${botId} connection established, awaiting join-chat event`);
  }
  
  // Send recent chat history to new user
  if (chatMessages.length > 0) {
    socket.emit('chat-history', chatMessages.slice(-20)); // Send last 20 messages
  }
  
  // Count unique IPs for accurate viewer count
  const uniqueIps = new Set();
  connectedUsers.forEach(user => uniqueIps.add(user.ip));
  
  // Broadcast user count update (unique IPs only)
  io.emit('user-count-update', {
    count: uniqueIps.size,
    timestamp: new Date().toISOString()
  });
  
  // Handle incoming chat messages
  socket.on('send-message', async (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) {
      console.log(`💬 CHAT: Unknown user ${socket.id} tried to send message`);
      return;
    }
    
    const { message } = data;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      console.log(`💬 CHAT: Invalid message from ${user.username}`);
      return;
    }
    
    // Just trim the message - client handles HTML escaping
    // We only need to validate it's a valid string and limit length
    const trimmedMessage = message.trim().substring(0, 2000); // Max 2000 characters
    
    // Profanity filter - silently block messages containing slurs/hate speech
    if (!profanityFilter.isClean(trimmedMessage)) {
      console.log(`🚫 PROFANITY: Blocked message from ${user.username} containing hate speech/slurs`);
      // Silently return without sending the message
      return;
    }
    
    const sanitizedMessage = trimmedMessage;
    
    // Extract @ mentions from the message
    const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(sanitizedMessage)) !== null) {
      mentions.push(match[1].toLowerCase());
    }
    
    // Check if user is banned
    console.log(`🔍 BAN CHECK: Checking if user "${user.username}" is banned`);
    if (isUserBanned(user.username)) {
      console.log(`💬 CHAT: Banned user ${user.username} tried to send message`);
      socket.emit('banned', { reason: 'You are banned from chat' });
      return;
    }
    
    // Check if user is timed out
    if (isUserTimedOut(user.username)) {
      const timeout = timeoutUsers.get(user.username);
      const remainingTime = Math.ceil((timeout.endTime - Date.now()) / 1000);
      console.log(`💬 CHAT: Timed out user ${user.username} tried to send message`);
      socket.emit('timeout', { 
        duration: remainingTime,
        endTime: timeout.endTime,
        reason: timeout.reason 
      });
      return;
    }
    
    // Debug: Log user admin status
    console.log(`💬 CHAT: Message from ${user.username} - isAdmin: ${user.isAdmin}, isAuthenticated: ${user.isAuthenticated}`);
    
    // Check for rate limiting (5 second cooldown) - Skip for admins
    if (!user.isAdmin && isRateLimited(user.username)) {
      const lastMessageTime = userLastMessage.get(user.username);
      const remainingTime = Math.ceil((RATE_LIMIT_DELAY - (Date.now() - lastMessageTime)) / 1000);
      console.log(`⏱️ CHAT: Rate limited user ${user.username} tried to send message`);
      sendThrottleNotification(socket, `⏱️ Please wait ${remainingTime} more second${remainingTime !== 1 ? 's' : ''} before sending another message.`);
      return;
    }
    
    // Check for duplicate message (30 second window) - Skip for admins
    if (!user.isAdmin && isDuplicateMessage(user.username, sanitizedMessage)) {
      console.log(`🔁 CHAT: User ${user.username} tried to send duplicate message: "${sanitizedMessage}"`);
      sendThrottleNotification(socket, `🔁 You recently sent this exact message. Please wait 30 seconds before sending the same message again.`);
      return;
    }
    
    // Check for ! commands (public commands that show in chat)
    if (sanitizedMessage.startsWith('!')) {
      const parts = sanitizedMessage.substring(1).split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);
      
      // First, show the command in chat
      const commandMessage = {
        id: uuidv4(),
        username: user.username,
        color: user.color,
        message: sanitizedMessage,
        timestamp: formatTime(),
        fullTimestamp: new Date().toISOString(),
        userId: socket.id,
        isAdmin: user.isAdmin || false,
        isModerator: user.isModerator || false
      };
      
      chatMessages.push(commandMessage);
      if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
      }
      io.emit('new-message', commandMessage);
      
      // Then handle the command
      await commandParser.parse(command, args, user, socket);
      return;
    }
    
    // Check for / commands (admin/private commands)
    if (sanitizedMessage.startsWith('/')) {
      const parts = sanitizedMessage.substring(1).split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);
      
      // Check for admin/moderator commands
      if (!user.isAuthenticated || (!user.isAdmin && !user.isModerator)) {
        sendAdminResponse(socket, 'Admin or Moderator access required to use this command');
        console.log(`💬 CHAT: Non-admin/moderator user ${user.username} (isAdmin: ${user.isAdmin}, isModerator: ${user.isModerator}) tried to use command: ${command}`);
        return;
      }
      
      // Execute admin command
      if (adminCommands[command]) {
        try {
          console.log(`💬 ADMIN: User ${user.username} executing command: ${command} with args: [${args.join(', ')}]`);
          await adminCommands[command](socket, args, user, io);
        } catch (error) {
          console.error(`❌ ADMIN: Error executing command ${command}:`, error);
          sendAdminResponse(socket, `❌ Command failed: ${error.message}`);
        }
      } else {
        sendAdminResponse(socket, `❓ Unknown command: ${command}. Type /help for available commands.`);
        console.log(`💬 ADMIN: User ${user.username} tried unknown command: ${command}`);
      }
      
      // Don't process command messages as regular chat messages
      return;
    }
    
    const chatMessage = {
      id: uuidv4(),
      username: user.username,
      color: user.color,
      message: sanitizedMessage,
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      userId: socket.id,
      isAdmin: user.isAdmin || false,
      isModerator: user.isModerator || false,
      mentions: mentions // Add mentions array to message
    };
    
    console.log(`💬 CHAT: Message from ${user.username} (authenticated: ${user.isAuthenticated}): ${sanitizedMessage.substring(0, 50)}${sanitizedMessage.length > 50 ? '...' : ''}`);
    
    // Update user's message history for throttling
    updateUserMessageHistory(user.username, sanitizedMessage);
    
    // Track message for authenticated users
    if (user.isAuthenticated && user.authenticatedUserId) {
      console.log(`💬 CHAT: Tracking message for authenticated user ${user.authenticatedUserId} at IP ${user.ip}`);
      trackChatMessage(user.authenticatedUserId, user.ip).catch(err => {
        console.error('💬 CHAT: Error tracking message:', err);
      });
    } else {
      console.log(`💬 CHAT: Not tracking message - authenticated: ${user.isAuthenticated}, userId: ${user.authenticatedUserId}`);
    }
    
    // Add to message history
    chatMessages.push(chatMessage);
    
    // Trim history if too long
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }
    
    // Broadcast message to all connected users
    io.emit('new-message', chatMessage);
    
    // Send confirmation back to sender (for bots/delivery verification)
    if (data.messageId) {
      socket.emit('message-sent', { 
        messageId: data.messageId, 
        chatMessageId: chatMessage.id,
        timestamp: chatMessage.fullTimestamp 
      });
    }
  });
  
  // Handle bot join-chat event
  socket.on('join-chat', (data) => {
    const isBot = socket.handshake.query?.isBot === 'true';
    const botId = socket.handshake.query?.botId;
    
    if (isBot && data.username && data.color) {
      console.log(`🤖 CHAT: Bot ${botId} joining chat with username: ${data.username}, color: ${data.color}`);
      
      // Store bot info for this socket
      connectedUsers.set(socket.id, {
        id: socket.id,
        ip: ip,
        username: data.username,
        color: data.color,
        isAuthenticated: false,
        isAdmin: false,
        isModerator: false,
        isBot: true,
        botId: botId,
        authenticatedUserId: null,
        joinedAt: new Date().toISOString()
      });
      
      // Send bot their assigned username and color
      socket.emit('user-assigned', {
        username: data.username,
        color: data.color,
        userId: socket.id
      });
      
      // Count unique IPs for accurate viewer count
      const uniqueIps = new Set();
      connectedUsers.forEach(user => uniqueIps.add(user.ip));
      
      // Broadcast user count update
      io.emit('user-count-update', {
        count: uniqueIps.size,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Handle user disconnect
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    console.log(`💬 CHAT: User disconnected: ${socket.id}${user ? ` (${user.username} from IP: ${user.ip})` : ''}`);
    
    connectedUsers.delete(socket.id);
    
    // Count unique IPs for accurate viewer count
    const uniqueIps = new Set();
    connectedUsers.forEach(u => uniqueIps.add(u.ip));
    
    // Broadcast user count update (unique IPs only)
    io.emit('user-count-update', {
      count: uniqueIps.size,
      timestamp: new Date().toISOString()
    });
  });

  // Handle user color updates
  socket.on('update-user-color', async (data) => {
    const userInfo = connectedUsers.get(socket.id);
    if (!userInfo) {
      console.log('❌ CHAT: User not found for color update');
      return;
    }

    const { color } = data;
    
    // Validate hex color
    if (!/^#[0-9A-F]{6}$/i.test(color)) {
      console.log('❌ CHAT: Invalid color format:', color);
      return;
    }

    // Update user's color in memory
    userInfo.color = color;
    connectedUsers.set(socket.id, userInfo);
    
    console.log(`🎨 CHAT: Updated color for ${userInfo.username} to ${color}`);
    
    // Save to database if user is authenticated
    if (userInfo.isAuthenticated && userInfo.authenticatedUserId) {
      try {
        const response = await axios.post(
          `${MAIN_SERVER_URL}/api/user/chat-color`,
          {
            userId: userInfo.authenticatedUserId,
            color: color
          },
          getAxiosConfig({
            headers: {
              'Content-Type': 'application/json'
            },
            timeout: 5000
          })
        );
        
        console.log(`🎨 CHAT: Saved color ${color} to database for user ${userInfo.authenticatedUserId}`);
      } catch (error) {
        console.error('❌ CHAT: Failed to save color to database:', error.message || error);
      }
    }
    
    // Emit confirmation back to the user
    socket.emit('color-updated', { color });
  });
  
  // Handle ping for connection testing
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: new Date().toISOString() });
  });
});

const PORT = process.env.CHAT_PORT || 8081;

// Initialize StreamBot integration
const StreamBotService = require('../server/services/StreamBotService');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '..', 'server', 'database.db');
const database = new sqlite3.Database(dbPath);
const streamBotService = new StreamBotService(database);

// Listen for StreamBot messages
streamBotService.on('sendMessage', (message) => {
  console.log('🤖 STREAMBOT: Sending periodic message:', message);
  
  // Send the message as a system message
  const systemMessage = {
    id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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
});

// Initialize StreamBot service
streamBotService.initialize().catch(err => {
  console.error('❌ Failed to initialize StreamBot service:', err);
});

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
    userLastMessage.clear();
    userMessageHistory.clear();
    
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