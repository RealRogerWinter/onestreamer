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

// Admin functionality
const bannedUsers = new Set(); // Store banned usernames (either authenticated or anonymous)
const timeoutUsers = new Map(); // Store timeout data: username -> { endTime, reason }
const bannedUsersData = new Map(); // Store additional ban data: username -> { bannedAt, reason, bannedBy }

// Chat throttling functionality
const userLastMessage = new Map(); // Store last message timestamp: username -> timestamp
const userMessageHistory = new Map(); // Store recent messages: username -> [{ message, timestamp }, ...]
const RATE_LIMIT_DELAY = 5000; // 5 seconds between messages
const DUPLICATE_MESSAGE_WINDOW = 30000; // 30 seconds for duplicate detection

// Claim event system — state, constants, and helpers live in ./claims/claimEventService.js
// (instantiated below once dependencies like formatTime and chatMessages are in scope).

// Vote system constants
const SKIP_VOTE_DURATION = 2 * 60 * 1000; // 2 minutes voting window
const SKIP_VOTE_THRESHOLD = 0.75; // 75% of viewers needed
const VOTE_COOLDOWN_FAILED = 2 * 60 * 1000; // 2 minute cooldown after failed vote
const VOTE_COOLDOWN_SUCCESS = 5 * 60 * 1000; // 5 minute cooldown after successful vote

// Skip vote system (for !next command)
let activeSkipVote = null; // { startTime, voters: Set, requiredVotes, totalViewers, initiator }
let skipVoteTimers = []; // Array of timer IDs for warnings
let lastSkipVoteEndTime = 0; // Track when last vote ended for cooldown
let lastSkipVotePassed = false; // Track if last vote passed (for cooldown duration)

// Swap vote system (for !swap command)
let activeSwapVote = null; // { startTime, voters: Set, requiredVotes, totalViewers, initiator, targetUrl, platform }
let swapVoteTimers = []; // Array of timer IDs for warnings
let lastSwapVoteEndTime = 0; // Track when last swap vote ended for cooldown
let lastSwapVotePassed = false; // Track if last vote passed (for cooldown duration)

// Extend vote system (for !extend command)
const EXTEND_VOTE_DURATION = 2 * 60 * 1000; // 2 minutes voting window
const EXTEND_VOTE_THRESHOLD = 0.33; // 33% of viewers needed (lower threshold for extend)
const EXTEND_VOTE_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown between extend votes
let activeExtendVote = null; // { startTime, voters: Set, requiredVotes, totalViewers, initiator }
let extendVoteTimers = []; // Array of timer IDs for warnings
let lastExtendVoteEndTime = 0; // Track when last extend vote ended for cooldown

// Reduce vote system (for !reduce command)
const REDUCE_VOTE_DURATION = 2 * 60 * 1000; // 2 minutes voting window
const REDUCE_VOTE_THRESHOLD = 0.33; // 33% of viewers needed (same as extend)
const REDUCE_VOTE_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown between reduce votes
let activeReduceVote = null; // { startTime, voters: Set, requiredVotes, totalViewers, initiator }
let reduceVoteTimers = []; // Array of timer IDs for warnings
let lastReduceVoteEndTime = 0; // Track when last reduce vote ended for cooldown

// Lock vote system (for !lock command)
const LOCK_VOTE_DURATION = 2 * 60 * 1000; // 2 minutes voting window
const LOCK_VOTE_THRESHOLD = 1.0; // 100% of viewers needed for lock
const LOCK_VOTE_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown between lock votes
let activeLockVote = null; // { startTime, voters: Set, requiredVotes, totalViewers, initiator }
let lockVoteTimers = []; // Array of timer IDs for warnings
let lastLockVoteEndTime = 0; // Track when last lock vote ended for cooldown
let lastLockVotePassed = false; // Track if last vote passed (for cooldown duration)

// Unlock vote system (for !unlock command)
const UNLOCK_VOTE_DURATION = 2 * 60 * 1000; // 2 minutes voting window
const UNLOCK_VOTE_THRESHOLD = 0.5; // 50% of viewers needed for unlock
const UNLOCK_VOTE_COOLDOWN = 5 * 60 * 1000; // 5 minute cooldown between unlock votes
let activeUnlockVote = null; // { startTime, voters: Set, requiredVotes, totalViewers, initiator }
let unlockVoteTimers = []; // Array of timer IDs for warnings
let lastUnlockVoteEndTime = 0; // Track when last unlock vote ended for cooldown
let lastUnlockVotePassed = false; // Track if last vote passed (for cooldown duration)

// Single-viewer auto-action system (when only 1 viewer, skip voting and execute directly)
const SINGLE_VIEWER_ACTION_COOLDOWN = 60 * 1000; // 60 second cooldown to prevent spam
let lastSingleViewerActionTime = 0; // Track last single-viewer action for cooldown

// Persistence paths
// MODERATION_STORE_PATH overrides the default. Useful for production
// deploys that keep state outside the repo, and for tests that need an
// isolated fixture path. Default is gitignored, see .gitignore.
const MODERATION_DATA_PATH = process.env.MODERATION_STORE_PATH
  ? path.resolve(process.env.MODERATION_STORE_PATH)
  : path.join(__dirname, 'moderation_data.json');

// Load moderation data from disk
function loadModerationData() {
  try {
    if (fs.existsSync(MODERATION_DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(MODERATION_DATA_PATH, 'utf8'));
      
      // Load banned users
      if (data.bannedUsers && Array.isArray(data.bannedUsers)) {
        bannedUsers.clear();
        bannedUsersData.clear();
        data.bannedUsers.forEach(user => {
          bannedUsers.add(user.username);
          bannedUsersData.set(user.username, {
            bannedAt: user.bannedAt,
            reason: user.reason || 'No reason recorded',
            bannedBy: user.bannedBy
          });
        });
        console.log(`📂 MODERATION: Loaded ${bannedUsers.size} banned users from disk`);
      }
      
      // Load timeout users (only active ones)
      if (data.timedOutUsers && Array.isArray(data.timedOutUsers)) {
        const currentTime = Date.now();
        timeoutUsers.clear();
        data.timedOutUsers.forEach(user => {
          if (user.endTime > currentTime) {
            timeoutUsers.set(user.username, {
              endTime: user.endTime,
              reason: user.reason || 'No reason recorded',
              startTime: user.startTime || currentTime
            });
          }
        });
        console.log(`📂 MODERATION: Loaded ${timeoutUsers.size} active timeouts from disk`);
      }
    }
  } catch (error) {
    console.error('❌ MODERATION: Failed to load moderation data:', error);
  }
}

// Save moderation data to disk
function saveModerationData() {
  try {
    const bannedUsersList = Array.from(bannedUsers).map(username => ({
      username,
      ...(bannedUsersData.get(username) || {
        bannedAt: new Date().toISOString(),
        reason: 'No reason recorded'
      })
    }));
    
    const timedOutUsersList = Array.from(timeoutUsers.entries()).map(([username, data]) => ({
      username,
      endTime: data.endTime,
      reason: data.reason,
      startTime: data.startTime
    }));
    
    const data = {
      bannedUsers: bannedUsersList,
      timedOutUsers: timedOutUsersList,
      lastUpdated: new Date().toISOString()
    };
    
    fs.writeFileSync(MODERATION_DATA_PATH, JSON.stringify(data, null, 2));
    console.log(`💾 MODERATION: Saved moderation data to disk (${bannedUsersList.length} bans, ${timedOutUsersList.length} timeouts)`);
  } catch (error) {
    console.error('❌ MODERATION: Failed to save moderation data:', error);
  }
}

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

// Check if username is banned (case-insensitive)
function isUserBanned(username) {
  // Convert to lowercase for comparison
  const lowerUsername = username.toLowerCase();
  for (const bannedUser of bannedUsers) {
    if (bannedUser.toLowerCase() === lowerUsername) {
      console.log(`🔨 BAN CHECK: User "${username}" matches banned user "${bannedUser}"`);
      return true;
    }
  }
  return false;
}

// Check if username is timed out (case-insensitive)
function isUserTimedOut(username) {
  const lowerUsername = username.toLowerCase();
  
  for (const [timedOutUser, timeoutData] of timeoutUsers.entries()) {
    if (timedOutUser.toLowerCase() === lowerUsername) {
      if (Date.now() >= timeoutData.endTime) {
        console.log(`⏱️ TIMEOUT: Expired timeout for "${timedOutUser}"`);
        timeoutUsers.delete(timedOutUser);
        return false;
      }
      console.log(`⏱️ TIMEOUT CHECK: User "${username}" matches timed out user "${timedOutUser}"`);
      return true;
    }
  }
  return false;
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
// Skip Vote System (!next command)
// ============================================

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

// Send StreamBot message for skip vote
function sendSkipVoteMessage(message, io) {
  const botMessage = {
    id: `streambot_skip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#FF6B6B',
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(botMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', botMessage);
}

// Clear all skip vote timers
function clearSkipVoteTimers() {
  skipVoteTimers.forEach(timerId => clearTimeout(timerId));
  skipVoteTimers = [];
}

// End the skip vote and tally results
async function endSkipVote(io) {
  if (!activeSkipVote) return;

  const vote = activeSkipVote;
  const voteCount = vote.voters.size;
  const requiredVotes = vote.requiredVotes;
  const passed = voteCount >= requiredVotes;
  const platform = vote.platform;  // Get platform preference from vote

  // Clear timers and vote state
  clearSkipVoteTimers();
  activeSkipVote = null;
  lastSkipVoteEndTime = Date.now();
  lastSkipVotePassed = passed; // Track for cooldown duration

  const platformText = platform ? ` ${platform.charAt(0).toUpperCase() + platform.slice(1)}` : '';

  if (passed) {
    sendSkipVoteMessage(`🗳️ VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). Skipping to the next${platformText} stream...`, io);
    console.log(`🗳️ SKIP VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Triggering stream rotation${platform ? ` (${platform})` : ''}.`);

    // Trigger the stream rotation via API (with optional platform)
    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/rotate`,
        { platform },  // Pass platform preference to API
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        console.log(`🗳️ SKIP VOTE: Stream rotation triggered successfully${platform ? ` (${platform})` : ''}`);
        // Emit event to update the streaming header
        io.emit('stream-info-update', { source: 'skip-vote', message: 'Stream skipped by chat vote' });
        // Unlock rotation timer if it was locked
        try {
          await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
          console.log('🗳️ SKIP VOTE: Rotation timer unlocked after skip');
        } catch (unlockErr) {
          console.log('🗳️ SKIP VOTE: Timer was not locked or unlock failed:', unlockErr.message);
        }
      } else {
        sendSkipVoteMessage('⚠️ Vote passed but failed to skip stream. Try again later.', io);
        console.error('🗳️ SKIP VOTE: Stream rotation failed:', response.data.error);
      }
    } catch (error) {
      sendSkipVoteMessage('⚠️ Vote passed but failed to skip stream. Try again later.', io);
      console.error('🗳️ SKIP VOTE: Error triggering stream rotation:', error.message);
    }
  } else {
    sendSkipVoteMessage(`🗳️ VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). The stream continues!`, io);
    sendSkipVoteMessage(`⏳ Next !next vote available in 2 minutes.`, io);
    console.log(`🗳️ SKIP VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
  }
}

// Start a new skip vote
function startSkipVote(initiator, io, platform = null) {
  const totalViewers = getUniqueViewerCount();
  const requiredVotes = Math.ceil(totalViewers * SKIP_VOTE_THRESHOLD);

  activeSkipVote = {
    startTime: Date.now(),
    voters: new Set([initiator.ip]), // Use IP to prevent duplicate votes
    voterUsernames: new Set([initiator.username]), // Track usernames for display
    requiredVotes: Math.max(requiredVotes, 1), // At least 1 vote required
    totalViewers: totalViewers,
    initiator: initiator.username,
    platform: platform  // Optional platform preference (kick or twitch)
  };

  // Announce the vote
  const platformText = platform ? ` ${platform.charAt(0).toUpperCase() + platform.slice(1)}` : '';
  sendSkipVoteMessage(`🗳️ SKIP VOTE STARTED by ${initiator.username}! Type !next to vote to skip to the next${platformText} stream.`, io);
  sendSkipVoteMessage(`📊 ${requiredVotes} votes needed (75% of ${totalViewers} viewers). Vote ends in 2 minutes!`, io);
  sendSkipVoteMessage(`ℹ️ If the vote passes, we'll rotate to a${platform ? ` ${platform.charAt(0).toUpperCase() + platform.slice(1)}` : ' random Twitch/Kick'} stream.`, io);
  sendSkipVoteMessage(`✅ ${initiator.username} voted to skip! (1/${requiredVotes})`, io);

  console.log(`🗳️ SKIP VOTE: Started by ${initiator.username}${platformText ? ` for${platformText}` : ''}. Need ${requiredVotes}/${totalViewers} votes (75%).`);

  // Schedule warning timers
  // Note: We're at 0 seconds, vote ends at 120 seconds (2 minutes)

  // 1 minute warning (at 60 seconds, 60 seconds remaining)
  skipVoteTimers.push(setTimeout(() => {
    if (activeSkipVote) {
      const currentVotes = activeSkipVote.voters.size;
      sendSkipVoteMessage(`⏰ 1 MINUTE remaining! ${currentVotes}/${activeSkipVote.requiredVotes} votes so far. Type !next to vote!`, io);
    }
  }, 60 * 1000));

  // 30 second warning
  skipVoteTimers.push(setTimeout(() => {
    if (activeSkipVote) {
      const currentVotes = activeSkipVote.voters.size;
      sendSkipVoteMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${activeSkipVote.requiredVotes} votes. Hurry!`, io);
    }
  }, 90 * 1000));

  // 5 second warning
  skipVoteTimers.push(setTimeout(() => {
    if (activeSkipVote) {
      const currentVotes = activeSkipVote.voters.size;
      sendSkipVoteMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${activeSkipVote.requiredVotes} votes!`, io);
    }
  }, 115 * 1000));

  // End vote timer (2 minutes)
  skipVoteTimers.push(setTimeout(() => {
    endSkipVote(io);
  }, SKIP_VOTE_DURATION));
}

// Register a vote for skipping
function registerSkipVote(user, io) {
  if (!activeSkipVote) return false;

  // Check if user already voted (by IP)
  if (activeSkipVote.voters.has(user.ip)) {
    return false; // Already voted
  }

  // Add vote
  activeSkipVote.voters.add(user.ip);
  activeSkipVote.voterUsernames.add(user.username);

  const currentVotes = activeSkipVote.voters.size;
  const requiredVotes = activeSkipVote.requiredVotes;

  sendSkipVoteMessage(`✅ ${user.username} voted to skip! (${currentVotes}/${requiredVotes})`, io);
  console.log(`🗳️ SKIP VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

  // Check if threshold reached early
  if (currentVotes >= requiredVotes) {
    sendSkipVoteMessage(`🎉 Vote threshold reached early!`, io);
    endSkipVote(io);
  }

  return true;
}

// ============================================
// Swap Vote System (!swap command)
// ============================================

// Validate and parse Twitch/Kick URL
function parseStreamUrl(url) {
  // Twitch URL patterns
  const twitchPatterns = [
    /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i,
    /(?:https?:\/\/)?(?:m\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i
  ];

  // Kick URL patterns
  const kickPatterns = [
    /(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)/i
  ];

  for (const pattern of twitchPatterns) {
    const match = url.match(pattern);
    if (match) {
      return { platform: 'twitch', channel: match[1], url: `https://twitch.tv/${match[1]}` };
    }
  }

  for (const pattern of kickPatterns) {
    const match = url.match(pattern);
    if (match) {
      return { platform: 'kick', channel: match[1], url: `https://kick.com/${match[1]}` };
    }
  }

  return null;
}

// Send StreamBot message for swap vote
function sendSwapVoteMessage(message, io) {
  const botMessage = {
    id: `streambot_swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#9B59B6', // Purple color for swap votes
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(botMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', botMessage);
}

// Clear all swap vote timers
function clearSwapVoteTimers() {
  swapVoteTimers.forEach(timerId => clearTimeout(timerId));
  swapVoteTimers = [];
}

// End the swap vote and tally results
async function endSwapVote(io) {
  if (!activeSwapVote) return;

  const vote = activeSwapVote;
  const voteCount = vote.voters.size;
  const requiredVotes = vote.requiredVotes;
  const passed = voteCount >= requiredVotes;

  // Clear timers and vote state
  clearSwapVoteTimers();
  activeSwapVote = null;
  lastSwapVoteEndTime = Date.now();
  lastSwapVotePassed = passed; // Track for cooldown duration

  if (passed) {
    const platformIcon = vote.platform === 'twitch' ? '📺' : '🟢';
    sendSwapVoteMessage(`🗳️ SWAP VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). Swapping to ${platformIcon} ${vote.channel}...`, io);
    console.log(`🗳️ SWAP VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Swapping to ${vote.targetUrl}`);

    // Trigger the stream swap via URL stream API
    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/url-stream`,
        {
          url: vote.targetUrl,
          quality: 'best',
          displayName: `${vote.channel} (Chat Vote)`,
          autoReconnect: true
        },
        getAxiosConfig({ timeout: 15000 })
      );

      if (response.data.success) {
        sendSwapVoteMessage(`✅ Successfully swapped to ${vote.platform === 'twitch' ? 'Twitch' : 'Kick'} channel: ${vote.channel}`, io);
        console.log('🗳️ SWAP VOTE: Stream swap triggered successfully');
        // Emit event to update the streaming header
        io.emit('stream-info-update', {
          source: 'swap-vote',
          channel: vote.channel,
          platform: vote.platform,
          message: `Swapped to ${vote.channel} by chat vote`
        });
        // Unlock rotation timer if it was locked
        try {
          await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
          console.log('🗳️ SWAP VOTE: Rotation timer unlocked after swap');
        } catch (unlockErr) {
          console.log('🗳️ SWAP VOTE: Timer was not locked or unlock failed:', unlockErr.message);
        }
      } else {
        sendSwapVoteMessage(`⚠️ Vote passed but failed to swap: ${response.data.error || 'Unknown error'}. The stream may be offline.`, io);
        console.error('🗳️ SWAP VOTE: Stream swap failed:', response.data.error);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      sendSwapVoteMessage(`⚠️ Vote passed but failed to swap: ${errorMsg}. The stream may be offline.`, io);
      console.error('🗳️ SWAP VOTE: Error triggering stream swap:', error.message);
    }
  } else {
    sendSwapVoteMessage(`🗳️ SWAP VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). Staying on current stream!`, io);
    sendSwapVoteMessage(`⏳ Next !swap vote available in 2 minutes.`, io);
    console.log(`🗳️ SWAP VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
  }
}

// Start a new swap vote
function startSwapVote(initiator, targetUrl, parsedUrl, io) {
  const totalViewers = getUniqueViewerCount();
  const requiredVotes = Math.ceil(totalViewers * SKIP_VOTE_THRESHOLD);
  const platformIcon = parsedUrl.platform === 'twitch' ? '📺' : '🟢';
  const platformName = parsedUrl.platform === 'twitch' ? 'Twitch' : 'Kick';

  activeSwapVote = {
    startTime: Date.now(),
    voters: new Set([initiator.ip]), // Use IP to prevent duplicate votes
    voterUsernames: new Set([initiator.username]), // Track usernames for display
    requiredVotes: Math.max(requiredVotes, 1), // At least 1 vote required
    totalViewers: totalViewers,
    initiator: initiator.username,
    targetUrl: parsedUrl.url,
    platform: parsedUrl.platform,
    channel: parsedUrl.channel
  };

  // Announce the vote
  sendSwapVoteMessage(`🔄 SWAP VOTE STARTED by ${initiator.username}!`, io);
  sendSwapVoteMessage(`${platformIcon} Target: ${platformName} channel "${parsedUrl.channel}" - ${parsedUrl.url}`, io);
  sendSwapVoteMessage(`📊 ${requiredVotes} votes needed (75% of ${totalViewers} viewers). Type !swap to vote! Vote ends in 2 minutes!`, io);
  sendSwapVoteMessage(`ℹ️ If the vote passes, we'll switch to ${parsedUrl.channel}'s ${platformName} stream (if they're live).`, io);
  sendSwapVoteMessage(`✅ ${initiator.username} voted to swap! (1/${requiredVotes})`, io);

  console.log(`🗳️ SWAP VOTE: Started by ${initiator.username} for ${parsedUrl.url}. Need ${requiredVotes}/${totalViewers} votes (75%).`);

  // Schedule warning timers (same timing as skip vote)

  // 1 minute warning
  swapVoteTimers.push(setTimeout(() => {
    if (activeSwapVote) {
      const currentVotes = activeSwapVote.voters.size;
      sendSwapVoteMessage(`⏰ 1 MINUTE remaining! ${currentVotes}/${activeSwapVote.requiredVotes} votes to swap to ${activeSwapVote.channel}. Type !swap to vote!`, io);
    }
  }, 60 * 1000));

  // 30 second warning
  swapVoteTimers.push(setTimeout(() => {
    if (activeSwapVote) {
      const currentVotes = activeSwapVote.voters.size;
      sendSwapVoteMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${activeSwapVote.requiredVotes} votes. Hurry!`, io);
    }
  }, 90 * 1000));

  // 5 second warning
  swapVoteTimers.push(setTimeout(() => {
    if (activeSwapVote) {
      const currentVotes = activeSwapVote.voters.size;
      sendSwapVoteMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${activeSwapVote.requiredVotes} votes!`, io);
    }
  }, 115 * 1000));

  // End vote timer (2 minutes)
  swapVoteTimers.push(setTimeout(() => {
    endSwapVote(io);
  }, SKIP_VOTE_DURATION));
}

// Register a vote for swapping
function registerSwapVote(user, io) {
  if (!activeSwapVote) return false;

  // Check if user already voted (by IP)
  if (activeSwapVote.voters.has(user.ip)) {
    return false; // Already voted
  }

  // Add vote
  activeSwapVote.voters.add(user.ip);
  activeSwapVote.voterUsernames.add(user.username);

  const currentVotes = activeSwapVote.voters.size;
  const requiredVotes = activeSwapVote.requiredVotes;

  sendSwapVoteMessage(`✅ ${user.username} voted to swap! (${currentVotes}/${requiredVotes})`, io);
  console.log(`🗳️ SWAP VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

  // Check if threshold reached early
  if (currentVotes >= requiredVotes) {
    sendSwapVoteMessage(`🎉 Vote threshold reached early!`, io);
    endSwapVote(io);
  }

  return true;
}

// ============================================
// Extend Vote System (!extend command)
// ============================================

// Send StreamBot message for extend vote
function sendExtendVoteMessage(message, io) {
  const botMessage = {
    id: `streambot_extend_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#10B981', // Green color for extend votes
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(botMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', botMessage);
}

// Clear all extend vote timers
function clearExtendVoteTimers() {
  extendVoteTimers.forEach(timerId => clearTimeout(timerId));
  extendVoteTimers = [];
}

// End the extend vote and tally results
async function endExtendVote(io) {
  if (!activeExtendVote) return;

  const vote = activeExtendVote;
  const voteCount = vote.voters.size;
  const requiredVotes = vote.requiredVotes;
  const passed = voteCount >= requiredVotes;

  // Clear timers and vote state
  clearExtendVoteTimers();
  activeExtendVote = null;
  lastExtendVoteEndTime = Date.now();

  if (passed) {
    sendExtendVoteMessage(`🎉 EXTEND VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). Extending the stream time...`, io);
    console.log(`🗳️ EXTEND VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Extending rotation timer.`);

    // Trigger the extend via API
    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/extend`,
        {},
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        sendExtendVoteMessage(`⏰ Stream extended by ${response.data.extendedByMinutes} minutes! Enjoy the extra time!`, io);
        console.log('🗳️ EXTEND VOTE: Rotation extend triggered successfully');
        // Emit event to update the countdown timer
        io.emit('stream-info-update', { source: 'extend-vote', message: 'Stream extended by chat vote' });
      } else {
        sendExtendVoteMessage(`⚠️ Vote passed but failed to extend: ${response.data.error || 'Unknown error'}`, io);
        console.error('🗳️ EXTEND VOTE: Rotation extend failed:', response.data.error);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      sendExtendVoteMessage(`⚠️ Vote passed but failed to extend: ${errorMsg}`, io);
      console.error('🗳️ EXTEND VOTE: Error triggering extend:', error.message);
    }
  } else {
    sendExtendVoteMessage(`🗳️ EXTEND VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). The timer continues as scheduled!`, io);
    sendExtendVoteMessage(`⏳ Next !extend vote available in 5 minutes.`, io);
    console.log(`🗳️ EXTEND VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
  }
}

// Start a new extend vote
function startExtendVote(initiator, io) {
  const totalViewers = getUniqueViewerCount();
  // Require at least 2 votes minimum, and 33% of viewers
  const requiredVotes = Math.max(Math.ceil(totalViewers * EXTEND_VOTE_THRESHOLD), 2);

  activeExtendVote = {
    startTime: Date.now(),
    voters: new Set([initiator.ip]), // Use IP to prevent duplicate votes
    voterUsernames: new Set([initiator.username]), // Track usernames for display
    requiredVotes: requiredVotes,
    totalViewers: totalViewers,
    initiator: initiator.username
  };

  // Announce the vote
  sendExtendVoteMessage(`⏰ EXTEND VOTE STARTED by ${initiator.username}!`, io);
  sendExtendVoteMessage(`📊 ${requiredVotes} votes needed (33% of ${totalViewers} viewers). Type !extend to vote! Vote ends in 2 minutes!`, io);
  sendExtendVoteMessage(`ℹ️ If the vote passes, the stream will be extended by 3-5 extra minutes before switching.`, io);
  sendExtendVoteMessage(`✅ ${initiator.username} voted to extend! (1/${requiredVotes})`, io);

  console.log(`🗳️ EXTEND VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (33%).`);

  // Schedule warning timers (same timing as other votes)

  // 1 minute warning
  extendVoteTimers.push(setTimeout(() => {
    if (activeExtendVote) {
      const currentVotes = activeExtendVote.voters.size;
      sendExtendVoteMessage(`⏰ 1 MINUTE remaining! ${currentVotes}/${activeExtendVote.requiredVotes} votes to extend. Type !extend to vote!`, io);
    }
  }, 60 * 1000));

  // 30 second warning
  extendVoteTimers.push(setTimeout(() => {
    if (activeExtendVote) {
      const currentVotes = activeExtendVote.voters.size;
      sendExtendVoteMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${activeExtendVote.requiredVotes} votes. Hurry!`, io);
    }
  }, 90 * 1000));

  // 5 second warning
  extendVoteTimers.push(setTimeout(() => {
    if (activeExtendVote) {
      const currentVotes = activeExtendVote.voters.size;
      sendExtendVoteMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${activeExtendVote.requiredVotes} votes!`, io);
    }
  }, 115 * 1000));

  // End vote timer (2 minutes)
  extendVoteTimers.push(setTimeout(() => {
    endExtendVote(io);
  }, EXTEND_VOTE_DURATION));
}

// Register a vote for extending
function registerExtendVote(user, io) {
  if (!activeExtendVote) return false;

  // Check if user already voted (by IP)
  if (activeExtendVote.voters.has(user.ip)) {
    return false; // Already voted
  }

  // Add vote
  activeExtendVote.voters.add(user.ip);
  activeExtendVote.voterUsernames.add(user.username);

  const currentVotes = activeExtendVote.voters.size;
  const requiredVotes = activeExtendVote.requiredVotes;

  sendExtendVoteMessage(`✅ ${user.username} voted to extend! (${currentVotes}/${requiredVotes})`, io);
  console.log(`🗳️ EXTEND VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

  // Check if threshold reached early
  if (currentVotes >= requiredVotes) {
    sendExtendVoteMessage(`🎉 Vote threshold reached early!`, io);
    endExtendVote(io);
  }

  return true;
}

// ============================================
// Reduce Vote System (!reduce command)
// ============================================

// Send StreamBot message for reduce vote
function sendReduceVoteMessage(message, io) {
  const botMessage = {
    id: `streambot_reduce_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#F59E0B', // Amber/orange color for reduce votes
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(botMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', botMessage);
}

// Clear all reduce vote timers
function clearReduceVoteTimers() {
  reduceVoteTimers.forEach(timerId => clearTimeout(timerId));
  reduceVoteTimers = [];
}

// End the reduce vote and tally results
async function endReduceVote(io) {
  if (!activeReduceVote) return;

  const vote = activeReduceVote;
  const voteCount = vote.voters.size;
  const requiredVotes = vote.requiredVotes;
  const passed = voteCount >= requiredVotes;

  // Clear timers and vote state
  clearReduceVoteTimers();
  activeReduceVote = null;
  lastReduceVoteEndTime = Date.now();

  if (passed) {
    sendReduceVoteMessage(`🗳️ REDUCE VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). Reducing stream time...`, io);
    console.log(`🗳️ REDUCE VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Reducing rotation time.`);

    // Trigger the reduce via API
    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/reduce`,
        {},
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        sendReduceVoteMessage(`⏰ Stream time reduced by ${response.data.reducedByMinutes} minutes!`, io);
        console.log(`🗳️ REDUCE VOTE: Rotation reduced by ${response.data.reducedByMinutes} minutes`);
      } else {
        sendReduceVoteMessage('⚠️ Vote passed but failed to reduce time. Try again later.', io);
        console.error('🗳️ REDUCE VOTE: Reduce failed:', response.data.error);
      }
    } catch (error) {
      sendReduceVoteMessage('⚠️ Vote passed but failed to reduce time. Try again later.', io);
      console.error('🗳️ REDUCE VOTE: Error reducing rotation:', error.message);
    }
  } else {
    sendReduceVoteMessage(`🗳️ REDUCE VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount/vote.totalViewers*100)}% of viewers).`, io);
    sendReduceVoteMessage(`⏳ Next !reduce vote available in 2 minutes.`, io);
    console.log(`🗳️ REDUCE VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
  }
}

// Start a new reduce vote
function startReduceVote(initiator, io) {
  const totalViewers = getUniqueViewerCount();
  const requiredVotes = Math.max(Math.ceil(totalViewers * REDUCE_VOTE_THRESHOLD), 2); // At least 2 votes required

  activeReduceVote = {
    startTime: Date.now(),
    voters: new Set([initiator.ip]),
    voterUsernames: new Set([initiator.username]),
    requiredVotes: requiredVotes,
    totalViewers: totalViewers,
    initiator: initiator.username
  };

  // Announce the vote
  sendReduceVoteMessage(`⏰ REDUCE VOTE STARTED by ${initiator.username}! Type !reduce to vote to reduce stream time.`, io);
  sendReduceVoteMessage(`📊 ${requiredVotes} votes needed (33% of ${totalViewers} viewers). Vote ends in 2 minutes!`, io);
  sendReduceVoteMessage(`ℹ️ If the vote passes, stream time will be reduced by 3-5 minutes.`, io);
  sendReduceVoteMessage(`✅ ${initiator.username} voted to reduce! (1/${requiredVotes})`, io);

  console.log(`🗳️ REDUCE VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (33%).`);

  // Schedule warning timers
  reduceVoteTimers.push(setTimeout(() => {
    if (activeReduceVote) {
      const currentVotes = activeReduceVote.voters.size;
      sendReduceVoteMessage(`⏰ 1 MINUTE remaining! ${currentVotes}/${activeReduceVote.requiredVotes} votes so far. Type !reduce to vote!`, io);
    }
  }, 60 * 1000));

  reduceVoteTimers.push(setTimeout(() => {
    if (activeReduceVote) {
      const currentVotes = activeReduceVote.voters.size;
      sendReduceVoteMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${activeReduceVote.requiredVotes} votes. Hurry!`, io);
    }
  }, 90 * 1000));

  reduceVoteTimers.push(setTimeout(() => {
    if (activeReduceVote) {
      const currentVotes = activeReduceVote.voters.size;
      sendReduceVoteMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${activeReduceVote.requiredVotes} votes!`, io);
    }
  }, 115 * 1000));

  // End vote timer
  reduceVoteTimers.push(setTimeout(() => {
    endReduceVote(io);
  }, REDUCE_VOTE_DURATION));
}

// Register a vote for reducing
function registerReduceVote(user, io) {
  if (!activeReduceVote) return false;

  if (activeReduceVote.voters.has(user.ip)) {
    return false;
  }

  activeReduceVote.voters.add(user.ip);
  activeReduceVote.voterUsernames.add(user.username);

  const currentVotes = activeReduceVote.voters.size;
  const requiredVotes = activeReduceVote.requiredVotes;

  sendReduceVoteMessage(`✅ ${user.username} voted to reduce! (${currentVotes}/${requiredVotes})`, io);
  console.log(`🗳️ REDUCE VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

  if (currentVotes >= requiredVotes) {
    sendReduceVoteMessage(`🎉 Vote threshold reached early!`, io);
    endReduceVote(io);
  }

  return true;
}

// ============================================
// Lock Vote System (!lock command)
// ============================================

// Send StreamBot message for lock vote
function sendLockVoteMessage(message, io) {
  const botMessage = {
    id: `streambot_lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#EF4444', // Red color for lock votes
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(botMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', botMessage);
}

// Clear all lock vote timers
function clearLockVoteTimers() {
  lockVoteTimers.forEach(timerId => clearTimeout(timerId));
  lockVoteTimers = [];
}

// End the lock vote and tally results
async function endLockVote(io) {
  if (!activeLockVote) return;

  const vote = activeLockVote;
  const voteCount = vote.voters.size;
  const requiredVotes = vote.requiredVotes;
  const passed = voteCount >= requiredVotes;

  // Clear timers and vote state
  clearLockVoteTimers();
  activeLockVote = null;
  lastLockVoteEndTime = Date.now();
  lastLockVotePassed = passed;

  if (passed) {
    sendLockVoteMessage(`🗳️ LOCK VOTE PASSED! ${voteCount}/${requiredVotes} votes (100% of viewers). Locking rotation...`, io);
    console.log(`🗳️ LOCK VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Locking rotation.`);

    // Trigger the lock via API
    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/lock`,
        {},
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        sendLockVoteMessage(`🔒 Rotation LOCKED! Stream will not rotate until a successful !next vote.`, io);
        console.log('🗳️ LOCK VOTE: Rotation locked successfully');
      } else {
        sendLockVoteMessage('⚠️ Vote passed but failed to lock rotation. Try again later.', io);
        console.error('🗳️ LOCK VOTE: Lock failed:', response.data.error);
      }
    } catch (error) {
      sendLockVoteMessage('⚠️ Vote passed but failed to lock rotation. Try again later.', io);
      console.error('🗳️ LOCK VOTE: Error locking rotation:', error.message);
    }
  } else {
    sendLockVoteMessage(`🗳️ LOCK VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received. Need 100% of viewers!`, io);
    sendLockVoteMessage(`⏳ Next !lock vote available in 2 minutes.`, io);
    console.log(`🗳️ LOCK VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
  }
}

// Start a new lock vote
function startLockVote(initiator, io) {
  const totalViewers = getUniqueViewerCount();
  const requiredVotes = Math.ceil(totalViewers * LOCK_VOTE_THRESHOLD); // 100% needed

  activeLockVote = {
    startTime: Date.now(),
    voters: new Set([initiator.ip]),
    voterUsernames: new Set([initiator.username]),
    requiredVotes: Math.max(requiredVotes, 2), // At least 2 votes required
    totalViewers: totalViewers,
    initiator: initiator.username
  };

  // Announce the vote
  sendLockVoteMessage(`🔒 LOCK VOTE STARTED by ${initiator.username}! Type !lock to vote to lock the rotation.`, io);
  sendLockVoteMessage(`📊 ${requiredVotes} votes needed (100% of ${totalViewers} viewers). Vote ends in 2 minutes!`, io);
  sendLockVoteMessage(`ℹ️ If the vote passes, stream will NOT rotate until a successful !next vote.`, io);
  sendLockVoteMessage(`✅ ${initiator.username} voted to lock! (1/${requiredVotes})`, io);

  console.log(`🗳️ LOCK VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (100%).`);

  // Schedule warning timers
  lockVoteTimers.push(setTimeout(() => {
    if (activeLockVote) {
      const currentVotes = activeLockVote.voters.size;
      sendLockVoteMessage(`⏰ 1 MINUTE remaining! ${currentVotes}/${activeLockVote.requiredVotes} votes so far. Type !lock to vote!`, io);
    }
  }, 60 * 1000));

  lockVoteTimers.push(setTimeout(() => {
    if (activeLockVote) {
      const currentVotes = activeLockVote.voters.size;
      sendLockVoteMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${activeLockVote.requiredVotes} votes. Hurry!`, io);
    }
  }, 90 * 1000));

  lockVoteTimers.push(setTimeout(() => {
    if (activeLockVote) {
      const currentVotes = activeLockVote.voters.size;
      sendLockVoteMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${activeLockVote.requiredVotes} votes!`, io);
    }
  }, 115 * 1000));

  // End vote timer
  lockVoteTimers.push(setTimeout(() => {
    endLockVote(io);
  }, LOCK_VOTE_DURATION));
}

// Register a vote for locking
function registerLockVote(user, io) {
  if (!activeLockVote) return false;

  if (activeLockVote.voters.has(user.ip)) {
    return false;
  }

  activeLockVote.voters.add(user.ip);
  activeLockVote.voterUsernames.add(user.username);

  const currentVotes = activeLockVote.voters.size;
  const requiredVotes = activeLockVote.requiredVotes;

  sendLockVoteMessage(`✅ ${user.username} voted to lock! (${currentVotes}/${requiredVotes})`, io);
  console.log(`🗳️ LOCK VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

  if (currentVotes >= requiredVotes) {
    sendLockVoteMessage(`🎉 Vote threshold reached early!`, io);
    endLockVote(io);
  }

  return true;
}

// ============================================
// Unlock Vote System (!unlock command)
// ============================================

// Send StreamBot message for unlock vote
function sendUnlockVoteMessage(message, io) {
  const botMessage = {
    id: `streambot_unlock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#22C55E', // Green color for unlock votes
    message: message,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true
  };

  chatMessages.push(botMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }

  io.emit('new-message', botMessage);
}

// Clear all unlock vote timers
function clearUnlockVoteTimers() {
  unlockVoteTimers.forEach(timerId => clearTimeout(timerId));
  unlockVoteTimers = [];
}

// End the unlock vote and tally results
async function endUnlockVote(io) {
  if (!activeUnlockVote) return;

  const vote = activeUnlockVote;
  const voteCount = vote.voters.size;
  const requiredVotes = vote.requiredVotes;
  const passed = voteCount >= requiredVotes;

  // Clear timers and vote state
  clearUnlockVoteTimers();
  activeUnlockVote = null;
  lastUnlockVoteEndTime = Date.now();
  lastUnlockVotePassed = passed;

  if (passed) {
    sendUnlockVoteMessage(`🗳️ UNLOCK VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount/vote.totalViewers*100)}% of viewers). Unlocking rotation...`, io);
    console.log(`🗳️ UNLOCK VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Unlocking rotation.`);

    // Trigger the unlock via API
    try {
      const response = await axios.post(
        `${MAIN_SERVER_URL}/api/random-stream/unlock`,
        {},
        getAxiosConfig({ timeout: 10000 })
      );

      if (response.data.success) {
        sendUnlockVoteMessage(`🔓 Rotation UNLOCKED! Stream will rotate at the next scheduled time.`, io);
        console.log('🗳️ UNLOCK VOTE: Rotation unlocked successfully');
      } else {
        sendUnlockVoteMessage('⚠️ Vote passed but failed to unlock rotation. Try again later.', io);
        console.error('🗳️ UNLOCK VOTE: Unlock failed:', response.data.error);
      }
    } catch (error) {
      sendUnlockVoteMessage('⚠️ Vote passed but failed to unlock rotation. Try again later.', io);
      console.error('🗳️ UNLOCK VOTE: Error unlocking rotation:', error.message);
    }
  } else {
    sendUnlockVoteMessage(`🗳️ UNLOCK VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount/vote.totalViewers*100)}% of viewers).`, io);
    sendUnlockVoteMessage(`⏳ Next !unlock vote available in 2 minutes.`, io);
    console.log(`🗳️ UNLOCK VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
  }
}

// Start a new unlock vote
function startUnlockVote(initiator, io) {
  const totalViewers = getUniqueViewerCount();
  const requiredVotes = Math.ceil(totalViewers * UNLOCK_VOTE_THRESHOLD); // 50% needed

  activeUnlockVote = {
    startTime: Date.now(),
    voters: new Set([initiator.ip]),
    voterUsernames: new Set([initiator.username]),
    requiredVotes: Math.max(requiredVotes, 2), // At least 2 votes required
    totalViewers: totalViewers,
    initiator: initiator.username
  };

  // Announce the vote
  sendUnlockVoteMessage(`🔓 UNLOCK VOTE STARTED by ${initiator.username}! Type !unlock to vote to unlock the rotation.`, io);
  sendUnlockVoteMessage(`📊 ${requiredVotes} votes needed (50% of ${totalViewers} viewers). Vote ends in 2 minutes!`, io);
  sendUnlockVoteMessage(`ℹ️ If the vote passes, stream will resume normal rotation schedule.`, io);
  sendUnlockVoteMessage(`✅ ${initiator.username} voted to unlock! (1/${requiredVotes})`, io);

  console.log(`🗳️ UNLOCK VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (50%).`);

  // Schedule warning timers
  unlockVoteTimers.push(setTimeout(() => {
    if (activeUnlockVote) {
      const currentVotes = activeUnlockVote.voters.size;
      sendUnlockVoteMessage(`⏰ 1 MINUTE remaining! ${currentVotes}/${activeUnlockVote.requiredVotes} votes so far. Type !unlock to vote!`, io);
    }
  }, 60 * 1000));

  unlockVoteTimers.push(setTimeout(() => {
    if (activeUnlockVote) {
      const currentVotes = activeUnlockVote.voters.size;
      sendUnlockVoteMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${activeUnlockVote.requiredVotes} votes. Hurry!`, io);
    }
  }, 90 * 1000));

  unlockVoteTimers.push(setTimeout(() => {
    if (activeUnlockVote) {
      const currentVotes = activeUnlockVote.voters.size;
      sendUnlockVoteMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${activeUnlockVote.requiredVotes} votes!`, io);
    }
  }, 115 * 1000));

  // End vote timer
  unlockVoteTimers.push(setTimeout(() => {
    endUnlockVote(io);
  }, UNLOCK_VOTE_DURATION));
}

// Register a vote for unlocking
function registerUnlockVote(user, io) {
  if (!activeUnlockVote) return false;

  if (activeUnlockVote.voters.has(user.ip)) {
    return false;
  }

  activeUnlockVote.voters.add(user.ip);
  activeUnlockVote.voterUsernames.add(user.username);

  const currentVotes = activeUnlockVote.voters.size;
  const requiredVotes = activeUnlockVote.requiredVotes;

  sendUnlockVoteMessage(`✅ ${user.username} voted to unlock! (${currentVotes}/${requiredVotes})`, io);
  console.log(`🗳️ UNLOCK VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

  if (currentVotes >= requiredVotes) {
    sendUnlockVoteMessage(`🎉 Vote threshold reached early!`, io);
    endUnlockVote(io);
  }

  return true;
}

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

// Handle public ! commands that show in chat
async function handlePublicCommand(command, args, user, socket, io) {
  switch(command) {
    case 'give':
      if (!user.isAuthenticated) {
        sendAdminResponse(socket, '❌ You must be logged in to give points. Please login first.');
        return;
      }
      
      if (args.length < 2) {
        sendAdminResponse(socket, 'Usage: !give [username] [amount]');
        return;
      }
      
      const giveAmount = parseInt(args[args.length - 1]);
      const giveTargetUsername = args.slice(0, -1).join(' ');
      
      if (isNaN(giveAmount) || giveAmount <= 0) {
        sendAdminResponse(socket, 'Invalid amount. Please provide a positive number.');
        return;
      }
      
      try {
        const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/transfer-points`, {
          fromUserId: user.authenticatedUserId,
          toUsername: giveTargetUsername,
          amount: giveAmount,
          senderUsername: user.username
        }, getAxiosConfig({
          headers: {
            'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
          },
          timeout: 10000
        }));
        
        if (response.data.success) {
          const streamerBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: `${user.username} gave ${giveTargetUsername} ${giveAmount} points!`,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(streamerBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', streamerBotMessage);
        } else {
          sendAdminResponse(socket, `❌ Failed to give points: ${response.data.error}`);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to give points:', error.message);
        sendAdminResponse(socket, `❌ Failed to give points: ${error.response?.data?.error || error.message}`);
      }
      break;
      
    case 'who':
      if (args.length < 1) {
        sendAdminResponse(socket, 'Usage: !who [username]');
        return;
      }
      
      const whoTargetUsername = args.join(' ');
      
      try {
        const response = await axios.get(
          `${MAIN_SERVER_URL}/api/internal/user-stats/${encodeURIComponent(whoTargetUsername)}`,
          getAxiosConfig({ timeout: 10000 })
        );
        
        if (response.data.success) {
          const stats = response.data.stats;
          
          const formatDuration = (seconds) => {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            
            if (hours > 0) {
              return `${hours}h ${minutes}m`;
            } else if (minutes > 0) {
              return `${minutes}m`;
            } else {
              return '0m';
            }
          };
          
          let statsMessage = `📊 Stats for ${whoTargetUsername}: `;
          statsMessage += `Points: ${stats.points_balance || 0} | `;
          statsMessage += `Watch Time: ${formatDuration(stats.total_view_time || 0)} | `;
          statsMessage += `Stream Time: ${formatDuration(stats.total_stream_time || 0)} | `;
          statsMessage += `Chat Messages: ${stats.chat_message_count || 0}`;
          
          const streamerBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: statsMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(streamerBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', streamerBotMessage);
        } else {
          sendAdminResponse(socket, `❌ User '${whoTargetUsername}' not found`);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to get user stats:', error.message);
        if (error.response?.status === 404) {
          sendAdminResponse(socket, `❌ User '${whoTargetUsername}' not found`);
        } else {
          sendAdminResponse(socket, `❌ Failed to get user stats: ${error.response?.data?.error || error.message}`);
        }
      }
      break;
      
    case 'stats':
      // Show user's own stats
      if (!user.isAuthenticated) {
        sendAdminResponse(socket, '❌ You must be logged in to view your stats.');
        return;
      }
      
      try {
        const response = await axios.get(
          `${MAIN_SERVER_URL}/api/internal/user-stats/${encodeURIComponent(user.username)}`,
          getAxiosConfig({ timeout: 10000 })
        );
        
        if (response.data.success) {
          const stats = response.data.stats;
          
          const formatDuration = (seconds) => {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            
            if (hours > 0) {
              return `${hours}h ${minutes}m`;
            } else if (minutes > 0) {
              return `${minutes}m`;
            } else {
              return '0m';
            }
          };
          
          let statsMessage = `📊 Your stats: `;
          statsMessage += `Points: ${stats.points_balance || 0} | `;
          statsMessage += `Watch Time: ${formatDuration(stats.total_view_time || 0)} | `;
          statsMessage += `Stream Time: ${formatDuration(stats.total_stream_time || 0)} | `;
          statsMessage += `Chat Messages: ${stats.chat_message_count || 0}`;
          
          const streamerBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: statsMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(streamerBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', streamerBotMessage);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to get user stats:', error.message);
        sendAdminResponse(socket, `❌ Failed to get your stats`);
      }
      break;
      
    case 'top':
      // Show leaderboard
      try {
        const response = await axios.get(
          `${MAIN_SERVER_URL}/api/internal/leaderboard`,
          getAxiosConfig({ timeout: 10000 })
        );
        
        if (response.data.success && response.data.leaderboard.length > 0) {
          let leaderMessage = '🏆 Top 10 Users by Points:\n';
          response.data.leaderboard.forEach((entry, index) => {
            leaderMessage += `${index + 1}. ${entry.username}: ${entry.points_balance || 0} points\n`;
          });
          
          const streamerBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: leaderMessage.trim(),
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(streamerBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', streamerBotMessage);
        } else {
          sendAdminResponse(socket, '❌ No leaderboard data available');
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to get leaderboard:', error.message);
        sendAdminResponse(socket, '❌ Failed to get leaderboard');
      }
      break;
      
    case 'uptime':
      // Show stream uptime
      try {
        const response = await axios.get(
          `${MAIN_SERVER_URL}/api/internal/stream-uptime`,
          getAxiosConfig({ timeout: 10000 })
        );
        
        if (response.data.success) {
          const { isLive, uptime, streamer } = response.data;
          
          if (isLive) {
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = uptime % 60;
            
            let uptimeStr = '';
            if (hours > 0) uptimeStr += `${hours}h `;
            if (minutes > 0) uptimeStr += `${minutes}m `;
            uptimeStr += `${seconds}s`;
            
            const message = `🔴 ${streamer || 'Stream'} has been live for ${uptimeStr}`;
            
            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };
            
            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }
            
            io.emit('new-message', streamerBotMessage);
          } else {
            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: '📺 No stream is currently live',
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };
            
            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }
            
            io.emit('new-message', streamerBotMessage);
          }
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to get uptime:', error.message);
        sendAdminResponse(socket, '❌ Failed to get stream uptime');
      }
      break;
      
    case 'help':
      const helpMessage = `📖 Available Commands:
!give [user] [amount] - Give points to another user
!who [user] - Show user stats
!stats - Show your own stats
!top - Show points leaderboard
!uptime - Show stream uptime
!channel - Show current random channel info
!next [kick|twitch] - Vote to skip to next stream (75% needed)
!swap [url] - Vote to swap to a specific stream (75% needed)
!extend - Vote to extend current stream by 3-5 minutes (33% needed)
!reduce - Vote to reduce current stream by 3-5 minutes (33% needed)
!lock - Vote to lock rotation (100% needed, stops auto-rotate)
!unlock - Vote to unlock rotation (50% needed, resumes auto-rotate)
!roll - Roll a dice (1-6)
!coinflip - Flip a coin
!gamble [amount] - 50/50 chance to double or lose
!slots [amount] - Play slots (costs 10 points minimum)
!gift [item] [user] [quantity] - Gift an item to another user
!claim [code] - Claim points during a claim event
!discord - Get the Discord invite link
!help - Show this help message`;
      
      const streamerBotMessage = {
        id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: '🤖 StreamBot',
        color: '#00FF00',
        message: helpMessage,
        timestamp: formatTime(),
        fullTimestamp: new Date().toISOString(),
        isSystem: true
      };
      
      chatMessages.push(streamerBotMessage);
      if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
      }
      
      io.emit('new-message', streamerBotMessage);
      break;
      
    case 'roll':
      const roll = Math.floor(Math.random() * 6) + 1;
      const rollMessage = `🎲 ${user.username} rolled a ${roll}!`;
      
      const rollBotMessage = {
        id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: '🤖 StreamBot',
        color: '#00FF00',
        message: rollMessage,
        timestamp: formatTime(),
        fullTimestamp: new Date().toISOString(),
        isSystem: true
      };
      
      chatMessages.push(rollBotMessage);
      if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
      }
      
      io.emit('new-message', rollBotMessage);
      break;
      
    case 'coinflip':
      const flip = Math.random() < 0.5 ? 'Heads' : 'Tails';
      const flipMessage = `🪙 ${user.username} flipped ${flip}!`;
      
      const flipBotMessage = {
        id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: '🤖 StreamBot',
        color: '#00FF00',
        message: flipMessage,
        timestamp: formatTime(),
        fullTimestamp: new Date().toISOString(),
        isSystem: true
      };
      
      chatMessages.push(flipBotMessage);
      if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
      }
      
      io.emit('new-message', flipBotMessage);
      break;
      
    case 'gamble':
      if (!user.isAuthenticated) {
        sendAdminResponse(socket, '❌ You must be logged in to gamble.');
        return;
      }
      
      if (args.length < 1) {
        sendAdminResponse(socket, 'Usage: !gamble [amount]');
        return;
      }
      
      const gambleAmount = parseInt(args[0]);
      
      if (isNaN(gambleAmount) || gambleAmount <= 0) {
        sendAdminResponse(socket, 'Invalid amount. Please provide a positive number.');
        return;
      }
      
      try {
        const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/gamble`, {
          userId: user.authenticatedUserId,
          amount: gambleAmount
        }, getAxiosConfig({
          headers: {
            'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
          },
          timeout: 10000
        }));
        
        if (response.data.success) {
          const { won, newBalance } = response.data;
          const gambleMessage = won 
            ? `🎰 ${user.username} won ${gambleAmount} points! New balance: ${newBalance}`
            : `💸 ${user.username} lost ${gambleAmount} points! New balance: ${newBalance}`;
          
          const gambleBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: gambleMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(gambleBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', gambleBotMessage);
        } else {
          sendAdminResponse(socket, `❌ ${response.data.error}`);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to gamble:', error.message);
        sendAdminResponse(socket, `❌ Failed to gamble: ${error.response?.data?.error || error.message}`);
      }
      break;
      
    case 'slots':
      if (!user.isAuthenticated) {
        sendAdminResponse(socket, '❌ You must be logged in to play slots.');
        return;
      }
      
      const slotAmount = args.length > 0 ? parseInt(args[0]) : 10;
      
      if (isNaN(slotAmount) || slotAmount < 10) {
        sendAdminResponse(socket, 'Minimum bet is 10 points. Usage: !slots [amount]');
        return;
      }
      
      try {
        const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/slots`, {
          userId: user.authenticatedUserId,
          amount: slotAmount
        }, getAxiosConfig({
          headers: {
            'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
          },
          timeout: 10000
        }));
        
        if (response.data.success) {
          const { symbols, winAmount, newBalance } = response.data;
          const slotsMessage = winAmount > 0
            ? `🎰 ${user.username} spun [${symbols.join(' ')}] and won ${winAmount} points! New balance: ${newBalance}`
            : `🎰 ${user.username} spun [${symbols.join(' ')}] and lost ${slotAmount} points! New balance: ${newBalance}`;
          
          const slotsBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: slotsMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(slotsBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', slotsBotMessage);
        } else {
          sendAdminResponse(socket, `❌ ${response.data.error}`);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to play slots:', error.message);
        sendAdminResponse(socket, `❌ Failed to play slots: ${error.response?.data?.error || error.message}`);
      }
      break;
      
    case 'claim': {
      // Active-claim state lives in claimEventService. Capture the live
      // object reference for this branch; property mutations on it
      // (e.g. .claimedBy) are visible to the service, which is the contract
      // the previous inline implementation also relied on.
      const activeClaimEvent = claimEventService.getActiveClaim();

      // Check if a claim event is active
      if (!activeClaimEvent) {
        sendAdminResponse(socket, '❌ No active claim event right now. Wait for the next one!');
        return;
      }

      // Check if already claimed
      if (activeClaimEvent.claimedBy) {
        sendAdminResponse(socket, `❌ Too late! This event was already claimed by ${activeClaimEvent.claimedBy}.`);
        return;
      }

      // Check if user provided the correct code
      if (args.length === 0 || args[0] !== activeClaimEvent.code) {
        sendAdminResponse(socket, '❌ Invalid claim code. Check the announcement and try again!');
        return;
      }

      // User must be authenticated to claim
      if (!user.isAuthenticated) {
        sendAdminResponse(socket, '❌ You must be logged in to claim rewards.');
        return;
      }

      // Process the claim
      activeClaimEvent.claimedBy = user.username;
      const claimedReward = activeClaimEvent.reward;

      // Award points to the user
      try {
        const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/award-points`, {
          userId: user.authenticatedUserId,
          amount: claimedReward,
          reason: 'Claim event winner'
        }, getAxiosConfig({
          headers: {
            'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
          },
          timeout: 10000
        }));

        if (response.data.success) {
          const winMessage = `🎊 ${user.username} claimed ${claimedReward} points! New balance: ${response.data.newBalance}`;
          const winBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: winMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };

          chatMessages.push(winBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }

          io.emit('new-message', winBotMessage);

          // Clear the active claim event
          claimEventService.clearActiveClaim();
        } else {
          sendAdminResponse(socket, `❌ ${response.data.error}`);
          activeClaimEvent.claimedBy = null; // Reset if award failed
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to award claim points:', error.message);
        sendAdminResponse(socket, '❌ Failed to award points. Please contact an admin.');
        activeClaimEvent.claimedBy = null; // Reset if award failed
      }
      break;
    }
      
    case 'gift':
      if (!user.isAuthenticated) {
        sendAdminResponse(socket, '❌ You must be logged in to gift items.');
        return;
      }
      
      // Parse arguments: !gift [item] [username] [quantity]
      if (args.length < 2) {
        sendAdminResponse(socket, 'Usage: !gift [item] [username] [quantity]');
        
        // Fetch and show user's giftable items
        try {
          const response = await axios.get(
            `${MAIN_SERVER_URL}/api/internal/giftable-items/${user.authenticatedUserId}`,
            getAxiosConfig({
              headers: {
                'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
              },
              timeout: 10000
            })
          );
          
          if (response.data.success && response.data.items.length > 0) {
            let itemsList = 'Your giftable items: ';
            response.data.items.forEach(item => {
              itemsList += `${item.emoji} ${item.display_name} (x${item.quantity}), `;
            });
            sendAdminResponse(socket, itemsList.slice(0, -2)); // Remove trailing comma
          } else {
            sendAdminResponse(socket, 'You have no giftable items.');
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to fetch giftable items:', error.message);
        }
        return;
      }
      
      // Determine if last arg is a number (quantity)
      let quantity = 1;
      let itemAndUsername = args;
      const lastArg = args[args.length - 1];
      
      if (!isNaN(parseInt(lastArg))) {
        quantity = parseInt(lastArg);
        itemAndUsername = args.slice(0, -1);
      }
      
      // The last remaining arg is the username, everything before is the item name
      const targetUsername = itemAndUsername[itemAndUsername.length - 1];
      const itemName = itemAndUsername.slice(0, -1).join(' ');
      
      if (!itemName || !targetUsername) {
        sendAdminResponse(socket, 'Usage: !gift [item] [username] [quantity]');
        return;
      }
      
      if (quantity <= 0) {
        sendAdminResponse(socket, 'Invalid quantity. Please provide a positive number.');
        return;
      }
      
      try {
        const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/gift-item`, {
          fromUserId: user.authenticatedUserId,
          toUsername: targetUsername,
          itemName: itemName,
          quantity: quantity
        }, getAxiosConfig({
          headers: {
            'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
          },
          timeout: 10000
        }));
        
        if (response.data.success) {
          const { item, from, to } = response.data;
          const giftMessage = quantity > 1 
            ? `🎁 ${from} gifted ${quantity}x ${item.emoji} ${item.name} to ${to}!`
            : `🎁 ${from} gifted ${item.emoji} ${item.name} to ${to}!`;
          
          const streamerBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: giftMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };
          
          chatMessages.push(streamerBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }
          
          io.emit('new-message', streamerBotMessage);
        } else {
          sendAdminResponse(socket, `❌ ${response.data.error}`);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to gift item:', error.message);
        sendAdminResponse(socket, `❌ Failed to gift item: ${error.response?.data?.error || error.message}`);
      }
      break;

    case 'discord':
      const discordMessage = `📢 Join the OneStreamer Discord community! Connect with other streamers, get support, and stay updated: https://discord.gg/As5CA3ekYA`;

      const discordBotMessage = {
        id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: '🤖 StreamBot',
        color: '#5865F2',
        message: discordMessage,
        timestamp: formatTime(),
        fullTimestamp: new Date().toISOString(),
        isSystem: true
      };

      chatMessages.push(discordBotMessage);
      if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
      }

      io.emit('new-message', discordBotMessage);
      break;

    case 'channel':
      // Show current random rotation channel info
      try {
        const response = await axios.get(
          `${MAIN_SERVER_URL}/api/random-stream/current-channel`,
          getAxiosConfig({ timeout: 10000 })
        );

        if (response.data.success && response.data.active) {
          const channel = response.data.channel;
          const channelMessage = `${channel.platformIcon} Currently watching: ${channel.streamerDisplayName || channel.streamerUsername} on ${channel.platformName} | ${channel.game || 'Unknown Game'} | ${channel.url}`;

          const channelBotMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: channelMessage,
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };

          chatMessages.push(channelBotMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }

          io.emit('new-message', channelBotMessage);
        } else {
          const noChannelMessage = {
            id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            username: '🤖 StreamBot',
            color: '#00FF00',
            message: '📺 Random rotation is not currently active. Be the streamer we need - go live!',
            timestamp: formatTime(),
            fullTimestamp: new Date().toISOString(),
            isSystem: true
          };

          chatMessages.push(noChannelMessage);
          if (chatMessages.length > MAX_CHAT_HISTORY) {
            chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
          }

          io.emit('new-message', noChannelMessage);
        }
      } catch (error) {
        console.error('❌ CHAT: Failed to get current channel:', error.message);
        sendAdminResponse(socket, '❌ Failed to get current channel info');
      }
      break;

    case 'next':
      // Skip vote command - allows viewers to vote to skip to the next stream
      // Usage: !next [kick|twitch] - optional platform to force

      // Parse optional platform argument
      const skipPlatform = args[0]?.toLowerCase();
      const validSkipPlatforms = ['kick', 'twitch'];
      if (skipPlatform && !validSkipPlatforms.includes(skipPlatform)) {
        sendAdminResponse(socket, '❌ Invalid platform. Use: !next [kick|twitch]');
        return;
      }

      // Check if there's already an active vote
      if (activeSkipVote) {
        // Try to register a vote (ignore platform arg when voting on existing vote)
        const voted = registerSkipVote(user, io);
        if (!voted) {
          sendAdminResponse(socket, '❌ You have already voted in this skip vote!');
        }
        return;
      }

      // Check for other active votes
      if (activeSwapVote) {
        sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeExtendVote) {
        sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeReduceVote) {
        sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeLockVote) {
        sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeUnlockVote) {
        sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
        return;
      }

      // Check cooldown (2 min after failed, 5 min after success)
      const skipCooldownDuration = lastSkipVotePassed ? VOTE_COOLDOWN_SUCCESS : VOTE_COOLDOWN_FAILED;
      const timeSinceLastSkipVote = Date.now() - lastSkipVoteEndTime;
      if (lastSkipVoteEndTime > 0 && timeSinceLastSkipVote < skipCooldownDuration) {
        const remainingSkipCooldown = Math.ceil((skipCooldownDuration - timeSinceLastSkipVote) / 1000);
        const cooldownReason = lastSkipVotePassed ? 'after a successful skip' : 'after a failed vote';
        sendAdminResponse(socket, `⏳ Please wait ${remainingSkipCooldown} seconds before starting another skip vote (${cooldownReason}).`);
        return;
      }

      // Check viewer count
      const currentViewerCount = getUniqueViewerCount();

      // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
      if (currentViewerCount === 1) {
        // Check single-viewer action cooldown
        const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
        if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
          const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
          return;
        }

        // Execute skip directly without voting
        const platformText = skipPlatform ? ` ${skipPlatform.charAt(0).toUpperCase() + skipPlatform.slice(1)}` : '';
        sendSkipVoteMessage(`⚡ Solo mode: ${user.username} is skipping to the next${platformText} stream...`, io);
        console.log(`🗳️ SKIP: Single viewer (${user.username}) - executing skip directly${skipPlatform ? ` (${skipPlatform})` : ''}`);

        lastSingleViewerActionTime = Date.now();
        lastSkipVoteEndTime = Date.now();
        lastSkipVotePassed = true;

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/rotate`,
            { platform: skipPlatform },
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendSkipVoteMessage(`✅ Stream skipped successfully!`, io);
            io.emit('stream-info-update', { source: 'skip-solo', message: 'Stream skipped by solo viewer' });
            try {
              await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
            } catch (unlockErr) {
              // Timer may not have been locked
            }
          } else {
            sendSkipVoteMessage('⚠️ Failed to skip stream. Try again later.', io);
          }
        } catch (error) {
          sendSkipVoteMessage('⚠️ Failed to skip stream. Try again later.', io);
          console.error('🗳️ SKIP: Error triggering stream rotation:', error.message);
        }
        return;
      }

      if (currentViewerCount < 2) {
        sendAdminResponse(socket, '❌ At least 2 viewers are needed to start a skip vote.');
        return;
      }

      // Start a new skip vote (with optional platform preference)
      startSkipVote(user, io, skipPlatform);
      break;

    case 'swap':
      // Swap vote command - allows viewers to vote to swap to a specific Twitch/Kick stream

      // Check if there's already an active swap vote
      if (activeSwapVote) {
        // Try to register a vote (no URL needed to vote on existing swap)
        const swapVoted = registerSwapVote(user, io);
        if (!swapVoted) {
          sendAdminResponse(socket, '❌ You have already voted in this swap vote!');
        }
        return;
      }

      // Check if there's an active skip vote (can't have both at once)
      if (activeSkipVote) {
        sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeExtendVote) {
        sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeReduceVote) {
        sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeLockVote) {
        sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeUnlockVote) {
        sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
        return;
      }

      // Check cooldown (2 min after failed, 5 min after success)
      const swapCooldownDuration = lastSwapVotePassed ? VOTE_COOLDOWN_SUCCESS : VOTE_COOLDOWN_FAILED;
      const timeSinceLastSwapVote = Date.now() - lastSwapVoteEndTime;
      if (lastSwapVoteEndTime > 0 && timeSinceLastSwapVote < swapCooldownDuration) {
        const remainingSwapCooldown = Math.ceil((swapCooldownDuration - timeSinceLastSwapVote) / 1000);
        const swapCooldownReason = lastSwapVotePassed ? 'after a successful swap' : 'after a failed vote';
        sendAdminResponse(socket, `⏳ Please wait ${remainingSwapCooldown} seconds before starting another swap vote (${swapCooldownReason}).`);
        return;
      }

      // Starting a new swap vote requires a URL
      if (args.length === 0) {
        sendAdminResponse(socket, '❌ Usage: !swap [twitch.tv/channel or kick.com/channel]');
        return;
      }

      // Parse the URL
      const swapTargetUrl = args[0];
      const parsedSwapUrl = parseStreamUrl(swapTargetUrl);

      if (!parsedSwapUrl) {
        sendAdminResponse(socket, '❌ Invalid URL. Please provide a valid Twitch or Kick channel URL (e.g., twitch.tv/channelname or kick.com/channelname)');
        return;
      }

      // Check viewer count
      const swapViewerCount = getUniqueViewerCount();

      // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
      if (swapViewerCount === 1) {
        // Check single-viewer action cooldown
        const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
        if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
          const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
          return;
        }

        // Execute swap directly without voting
        const platformIcon = parsedSwapUrl.platform === 'twitch' ? '📺' : '🟢';
        sendSwapVoteMessage(`⚡ Solo mode: ${user.username} is swapping to ${platformIcon} ${parsedSwapUrl.channel}...`, io);
        console.log(`🗳️ SWAP: Single viewer (${user.username}) - executing swap to ${parsedSwapUrl.url}`);

        lastSingleViewerActionTime = Date.now();
        lastSwapVoteEndTime = Date.now();
        lastSwapVotePassed = true;

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/url-stream`,
            {
              url: parsedSwapUrl.url,
              quality: 'best',
              displayName: `${parsedSwapUrl.channel} (Solo)`,
              autoReconnect: true
            },
            getAxiosConfig({ timeout: 15000 })
          );

          if (response.data.success) {
            sendSwapVoteMessage(`✅ Successfully swapped to ${parsedSwapUrl.platform === 'twitch' ? 'Twitch' : 'Kick'} channel: ${parsedSwapUrl.channel}`, io);
            io.emit('stream-info-update', {
              source: 'swap-solo',
              channel: parsedSwapUrl.channel,
              platform: parsedSwapUrl.platform,
              message: `Swapped to ${parsedSwapUrl.channel} by solo viewer`
            });
            try {
              await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
            } catch (unlockErr) {
              // Timer may not have been locked
            }
          } else {
            sendSwapVoteMessage(`⚠️ Failed to swap: ${response.data.error || 'Unknown error'}. The stream may be offline.`, io);
          }
        } catch (error) {
          const errorMsg = error.response?.data?.error || error.message;
          sendSwapVoteMessage(`⚠️ Failed to swap: ${errorMsg}. The stream may be offline.`, io);
          console.error('🗳️ SWAP: Error triggering stream swap:', error.message);
        }
        return;
      }

      if (swapViewerCount < 2) {
        sendAdminResponse(socket, '❌ At least 2 viewers are needed to start a swap vote.');
        return;
      }

      // Start a new swap vote
      startSwapVote(user, swapTargetUrl, parsedSwapUrl, io);
      break;

    case 'extend':
      // Extend vote command - allows viewers to vote to extend the current stream time

      // Check if there's already an active extend vote
      if (activeExtendVote) {
        // Try to register a vote
        const extendVoted = registerExtendVote(user, io);
        if (!extendVoted) {
          sendAdminResponse(socket, '❌ You have already voted in this extend vote!');
        }
        return;
      }

      // Check if there's an active skip or swap vote (can't have multiple votes at once)
      if (activeSkipVote) {
        sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeSwapVote) {
        sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeReduceVote) {
        sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeLockVote) {
        sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeUnlockVote) {
        sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
        return;
      }

      // Check cooldown (5 min between extend votes)
      const timeSinceLastExtendVote = Date.now() - lastExtendVoteEndTime;
      if (lastExtendVoteEndTime > 0 && timeSinceLastExtendVote < EXTEND_VOTE_COOLDOWN) {
        const remainingExtendCooldown = Math.ceil((EXTEND_VOTE_COOLDOWN - timeSinceLastExtendVote) / 1000);
        sendAdminResponse(socket, `⏳ Please wait ${remainingExtendCooldown} seconds before starting another extend vote.`);
        return;
      }

      // Check viewer count
      const extendViewerCount = getUniqueViewerCount();

      // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
      if (extendViewerCount === 1) {
        // Check single-viewer action cooldown
        const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
        if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
          const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
          return;
        }

        // Execute extend directly without voting
        sendExtendVoteMessage(`⚡ Solo mode: ${user.username} is extending the stream time...`, io);
        console.log(`🗳️ EXTEND: Single viewer (${user.username}) - executing extend directly`);

        lastSingleViewerActionTime = Date.now();
        lastExtendVoteEndTime = Date.now();

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/extend`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendExtendVoteMessage(`⏰ Stream extended by ${response.data.extendedByMinutes} minutes! Enjoy the extra time!`, io);
            io.emit('stream-info-update', { source: 'extend-solo', message: 'Stream extended by solo viewer' });
          } else {
            sendExtendVoteMessage(`⚠️ Failed to extend: ${response.data.error || 'Unknown error'}`, io);
          }
        } catch (error) {
          const errorMsg = error.response?.data?.error || error.message;
          sendExtendVoteMessage(`⚠️ Failed to extend: ${errorMsg}`, io);
          console.error('🗳️ EXTEND: Error triggering extend:', error.message);
        }
        return;
      }

      if (extendViewerCount < 3) {
        sendAdminResponse(socket, '❌ At least 3 viewers are needed to start an extend vote (requires 2 votes to pass).');
        return;
      }

      // Start a new extend vote
      startExtendVote(user, io);
      break;

    case 'reduce':
      // Reduce vote command - allows viewers to vote to reduce the current stream time

      // Check if there's already an active reduce vote
      if (activeReduceVote) {
        const reduceVoted = registerReduceVote(user, io);
        if (!reduceVoted) {
          sendAdminResponse(socket, '❌ You have already voted in this reduce vote!');
        }
        return;
      }

      // Check if there's an active vote of any kind
      if (activeSkipVote) {
        sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeSwapVote) {
        sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeExtendVote) {
        sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeLockVote) {
        sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeUnlockVote) {
        sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
        return;
      }

      // Check cooldown (5 min between reduce votes)
      const timeSinceLastReduceVote = Date.now() - lastReduceVoteEndTime;
      if (lastReduceVoteEndTime > 0 && timeSinceLastReduceVote < REDUCE_VOTE_COOLDOWN) {
        const remainingReduceCooldown = Math.ceil((REDUCE_VOTE_COOLDOWN - timeSinceLastReduceVote) / 1000);
        sendAdminResponse(socket, `⏳ Please wait ${remainingReduceCooldown} seconds before starting another reduce vote.`);
        return;
      }

      // Check viewer count
      const reduceViewerCount = getUniqueViewerCount();

      // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
      if (reduceViewerCount === 1) {
        // Check single-viewer action cooldown
        const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
        if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
          const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
          return;
        }

        // Execute reduce directly without voting
        sendReduceVoteMessage(`⚡ Solo mode: ${user.username} is reducing the stream time...`, io);
        console.log(`🗳️ REDUCE: Single viewer (${user.username}) - executing reduce directly`);

        lastSingleViewerActionTime = Date.now();
        lastReduceVoteEndTime = Date.now();

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/reduce`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendReduceVoteMessage(`⏰ Stream time reduced by ${response.data.reducedByMinutes} minutes!`, io);
          } else {
            sendReduceVoteMessage('⚠️ Failed to reduce time. Try again later.', io);
          }
        } catch (error) {
          sendReduceVoteMessage('⚠️ Failed to reduce time. Try again later.', io);
          console.error('🗳️ REDUCE: Error reducing rotation:', error.message);
        }
        return;
      }

      if (reduceViewerCount < 3) {
        sendAdminResponse(socket, '❌ At least 3 viewers are needed to start a reduce vote (requires 2 votes to pass).');
        return;
      }

      // Start a new reduce vote
      startReduceVote(user, io);
      break;

    case 'lock':
      // Lock vote command - allows viewers to vote to lock the rotation (100% required)

      // Check if there's already an active lock vote
      if (activeLockVote) {
        const lockVoted = registerLockVote(user, io);
        if (!lockVoted) {
          sendAdminResponse(socket, '❌ You have already voted in this lock vote!');
        }
        return;
      }

      // Check if there's an active vote of any kind
      if (activeSkipVote) {
        sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeSwapVote) {
        sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeExtendVote) {
        sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeReduceVote) {
        sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeUnlockVote) {
        sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
        return;
      }

      // Check cooldown
      const lockCooldownDuration = lastLockVotePassed ? LOCK_VOTE_COOLDOWN : VOTE_COOLDOWN_FAILED;
      const timeSinceLastLockVote = Date.now() - lastLockVoteEndTime;
      if (lastLockVoteEndTime > 0 && timeSinceLastLockVote < lockCooldownDuration) {
        const remainingLockCooldown = Math.ceil((lockCooldownDuration - timeSinceLastLockVote) / 1000);
        sendAdminResponse(socket, `⏳ Please wait ${remainingLockCooldown} seconds before starting another lock vote.`);
        return;
      }

      // Check if already locked
      try {
        const lockStatusResp = await axios.get(`${MAIN_SERVER_URL}/api/random-stream/lock-status`, getAxiosConfig({ timeout: 5000 }));
        if (lockStatusResp.data.isLocked) {
          sendAdminResponse(socket, '❌ Rotation is already locked. Use !unlock to start a vote to unlock it.');
          return;
        }
      } catch (err) {
        console.error('❌ LOCK VOTE: Failed to check lock status:', err.message);
      }

      // Check viewer count
      const lockViewerCount = getUniqueViewerCount();

      // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
      if (lockViewerCount === 1) {
        // Check single-viewer action cooldown
        const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
        if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
          const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
          return;
        }

        // Execute lock directly without voting
        sendLockVoteMessage(`⚡ Solo mode: ${user.username} is locking the rotation...`, io);
        console.log(`🗳️ LOCK: Single viewer (${user.username}) - executing lock directly`);

        lastSingleViewerActionTime = Date.now();
        lastLockVoteEndTime = Date.now();
        lastLockVotePassed = true;

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/lock`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendLockVoteMessage(`🔒 Rotation LOCKED! Stream will not rotate until a successful !next vote.`, io);
          } else {
            sendLockVoteMessage('⚠️ Failed to lock rotation. Try again later.', io);
          }
        } catch (error) {
          sendLockVoteMessage('⚠️ Failed to lock rotation. Try again later.', io);
          console.error('🗳️ LOCK: Error locking rotation:', error.message);
        }
        return;
      }

      if (lockViewerCount < 2) {
        sendAdminResponse(socket, '❌ At least 2 viewers are needed to start a lock vote.');
        return;
      }

      // Start a new lock vote
      startLockVote(user, io);
      break;

    case 'unlock':
      // Unlock vote command - allows viewers to vote to unlock the rotation (50% required)

      // Check if there's already an active unlock vote
      if (activeUnlockVote) {
        const unlockVoted = registerUnlockVote(user, io);
        if (!unlockVoted) {
          sendAdminResponse(socket, '❌ You have already voted in this unlock vote!');
        }
        return;
      }

      // Check if there's an active vote of any kind
      if (activeSkipVote) {
        sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeSwapVote) {
        sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeExtendVote) {
        sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeReduceVote) {
        sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
        return;
      }
      if (activeLockVote) {
        sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
        return;
      }

      // Check cooldown
      const unlockCooldownDuration = lastUnlockVotePassed ? UNLOCK_VOTE_COOLDOWN : VOTE_COOLDOWN_FAILED;
      const timeSinceLastUnlockVote = Date.now() - lastUnlockVoteEndTime;
      if (lastUnlockVoteEndTime > 0 && timeSinceLastUnlockVote < unlockCooldownDuration) {
        const remainingUnlockCooldown = Math.ceil((unlockCooldownDuration - timeSinceLastUnlockVote) / 1000);
        sendAdminResponse(socket, `⏳ Please wait ${remainingUnlockCooldown} seconds before starting another unlock vote.`);
        return;
      }

      // Check if actually locked
      try {
        const unlockStatusResp = await axios.get(`${MAIN_SERVER_URL}/api/random-stream/lock-status`, getAxiosConfig({ timeout: 5000 }));
        if (!unlockStatusResp.data.isLocked) {
          sendAdminResponse(socket, '❌ Rotation is not locked. Use !lock to start a vote to lock it.');
          return;
        }
      } catch (err) {
        console.error('❌ UNLOCK VOTE: Failed to check lock status:', err.message);
      }

      // Check viewer count
      const unlockViewerCount = getUniqueViewerCount();

      // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
      if (unlockViewerCount === 1) {
        // Check single-viewer action cooldown
        const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
        if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
          const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
          return;
        }

        // Execute unlock directly without voting
        sendUnlockVoteMessage(`⚡ Solo mode: ${user.username} is unlocking the rotation...`, io);
        console.log(`🗳️ UNLOCK: Single viewer (${user.username}) - executing unlock directly`);

        lastSingleViewerActionTime = Date.now();
        lastUnlockVoteEndTime = Date.now();
        lastUnlockVotePassed = true;

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/unlock`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendUnlockVoteMessage(`🔓 Rotation UNLOCKED! Stream will rotate at the next scheduled time.`, io);
          } else {
            sendUnlockVoteMessage('⚠️ Failed to unlock rotation. Try again later.', io);
          }
        } catch (error) {
          sendUnlockVoteMessage('⚠️ Failed to unlock rotation. Try again later.', io);
          console.error('🗳️ UNLOCK: Error unlocking rotation:', error.message);
        }
        return;
      }

      if (unlockViewerCount < 2) {
        sendAdminResponse(socket, '❌ At least 2 viewers are needed to start an unlock vote.');
        return;
      }

      // Start a new unlock vote
      startUnlockVote(user, io);
      break;

    default:
      sendAdminResponse(socket, `❓ Unknown command: !${command}. Type !help for available commands.`);
  }
}

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

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'onestreamer-chat',
    connectedUsers: connectedUsers.size,
    messagesInHistory: chatMessages.length,
    timestamp: new Date().toISOString()
  });
});

// Add middleware to parse JSON bodies
app.use(express.json());

// API endpoint to get moderation data
app.get('/api/moderation', (req, res) => {
  try {
    console.log(`📊 MODERATION API: Fetching moderation data`);
    console.log(`📊 MODERATION API: Current banned users:`, Array.from(bannedUsers));
    console.log(`📊 MODERATION API: Current timed out users:`, Array.from(timeoutUsers.keys()));
    
    const bannedUsersList = Array.from(bannedUsers).map(username => ({
      username,
      ...(bannedUsersData.get(username) || {
        bannedAt: new Date().toISOString(),
        reason: 'No reason recorded',
        bannedBy: 'Unknown'
      })
    }));
    
    // Filter out expired timeouts
    const currentTime = Date.now();
    const activeTimeouts = [];
    
    for (const [username, data] of timeoutUsers.entries()) {
      if (data.endTime > currentTime) {
        activeTimeouts.push({
          username,
          endTime: data.endTime,
          reason: data.reason || 'No reason recorded',
          startTime: currentTime - ((data.endTime - currentTime) > 0 ? 60000 : 0) // Approximate start time
        });
      } else {
        // Clean up expired timeouts
        timeoutUsers.delete(username);
        console.log(`⏱️ CLEANUP: Removed expired timeout for ${username}`);
      }
    }
    
    const response = {
      bannedUsers: bannedUsersList,
      timedOutUsers: activeTimeouts
    };
    
    console.log(`📊 MODERATION API: Returning:`, response);
    
    res.json(response);
  } catch (error) {
    console.error('Error getting moderation data:', error);
    res.status(500).json({ 
      error: 'Failed to get moderation data',
      bannedUsers: [],
      timedOutUsers: []
    });
  }
});

// API endpoint to ban a user
app.post('/api/ban', express.json(), (req, res) => {
  try {
    const { username, reason, bannedBy } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    bannedUsers.add(username);
    bannedUsersData.set(username, {
      bannedAt: new Date().toISOString(),
      reason: reason || 'No reason provided',
      bannedBy: bannedBy || 'Admin'
    });
    
    // Save to disk
    saveModerationData();
    
    // Delete all messages from the banned user
    const messagesToDelete = [];
    const lowerUsername = username.toLowerCase();
    
    // Find all message IDs from the banned user
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].username && chatMessages[i].username.toLowerCase() === lowerUsername) {
        messagesToDelete.push(chatMessages[i].id);
        chatMessages.splice(i, 1); // Remove from array
      }
    }
    
    // Emit event to delete messages from all clients
    if (messagesToDelete.length > 0) {
      io.emit('delete-messages', { messageIds: messagesToDelete, reason: 'user_banned' });
      console.log(`🔨 MODERATION: Deleted ${messagesToDelete.length} messages from ${username}`);
    }
    
    // Notify all clients about the ban
    const banMessage = {
      id: `ban_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: '🔨 MODERATION',
      color: '#FF0000',
      message: `${username} has been banned from chat and their messages have been removed${reason ? `: ${reason}` : ''}`,
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true
    };
    
    chatMessages.push(banMessage);
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }
    
    io.emit('new-message', banMessage);
    
    // Disconnect all sockets with this username (case-insensitive)
    let disconnectedCount = 0;
    connectedUsers.forEach((user, socketId) => {
      if (user.username.toLowerCase() === lowerUsername) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          console.log(`🔨 MODERATION: Disconnecting socket ${socketId} for user ${user.username}`);
          targetSocket.emit('banned', { reason: 'You have been banned by an administrator' });
          targetSocket.disconnect(true);
          disconnectedCount++;
        }
      }
    });
    
    console.log(`🔨 MODERATION: ${username} banned by ${bannedBy || 'admin'}, deleted ${messagesToDelete.length} messages, disconnected ${disconnectedCount} connection(s)`);
    res.json({ success: true, message: `${username} has been banned, ${messagesToDelete.length} messages deleted` });
  } catch (error) {
    console.error('Error banning user:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// API endpoint to unban a user
app.post('/api/unban', express.json(), (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    bannedUsers.delete(username);
    bannedUsersData.delete(username);
    
    // Save to disk
    saveModerationData();
    
    console.log(`✅ MODERATION: ${username} unbanned`);
    res.json({ success: true, message: `${username} has been unbanned` });
  } catch (error) {
    console.error('Error unbanning user:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// API endpoint to timeout a user
app.post('/api/timeout', express.json(), (req, res) => {
  try {
    const { username, duration, reason, timedOutBy } = req.body;
    
    if (!username || !duration) {
      return res.status(400).json({ error: 'Username and duration are required' });
    }
    
    const startTime = Date.now();
    const endTime = startTime + (duration * 1000);
    timeoutUsers.set(username, { 
      endTime, 
      reason: reason || 'No reason provided',
      startTime: startTime
    });
    
    // Save to disk
    saveModerationData();
    
    // Notify all clients
    const timeoutMessage = {
      id: `timeout_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: '⏱️ MODERATION',
      color: '#FFA500',
      message: `${username} has been timed out for ${duration} seconds${reason ? `: ${reason}` : ''}`,
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true
    };
    
    chatMessages.push(timeoutMessage);
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }
    
    io.emit('new-message', timeoutMessage);
    
    console.log(`⏱️ MODERATION: ${username} timed out for ${duration}s by ${timedOutBy || 'admin'}`);
    res.json({ success: true, message: `${username} has been timed out for ${duration} seconds` });
  } catch (error) {
    console.error('Error timing out user:', error);
    res.status(500).json({ error: 'Failed to timeout user' });
  }
});

// API endpoint to remove timeout
app.post('/api/remove-timeout', express.json(), (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    timeoutUsers.delete(username);
    
    // Save to disk
    saveModerationData();
    
    console.log(`✅ MODERATION: Timeout removed for ${username}`);
    res.json({ success: true, message: `Timeout removed for ${username}` });
  } catch (error) {
    console.error('Error removing timeout:', error);
    res.status(500).json({ error: 'Failed to remove timeout' });
  }
});

// Endpoint for main server to send system messages
app.post('/api/system-message', express.json(), (req, res) => {
  try {
    const { message, username = '🤖 StreamBot' } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    const systemMessage = {
      id: `system_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: username,
      color: '#FF6B35', // Orange robot color
      message: message.trim(),
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true
    };
    
    console.log(`🤖 CHAT: System message: ${systemMessage.message}`);
    
    // Add to message history
    chatMessages.push(systemMessage);
    
    // Trim history if too long
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }
    
    // Broadcast message to all connected users
    io.emit('new-message', systemMessage);
    
    res.json({
      success: true,
      message: 'System message sent successfully',
      messageId: systemMessage.id
    });
  } catch (error) {
    console.error('❌ CHAT: Error sending system message:', error);
    res.status(500).json({ error: 'Failed to send system message' });
  }
});

// API endpoint to get chat history for clip replay
// This is used by the main server when creating clips
app.get('/api/chat-history', (req, res) => {
  try {
    const { since, until, contextMs = 30000 } = req.query;

    // Parse timestamps (unix ms)
    const sinceMs = since ? parseInt(since) : null;
    const untilMs = until ? parseInt(until) : null;
    const contextWindow = parseInt(contextMs) || 30000; // Default 30 seconds of context

    // If no time range specified, return recent messages
    if (!sinceMs || !untilMs) {
      const recentMessages = chatMessages.slice(-50).map(msg => ({
        username: msg.username,
        message: msg.message,
        timestamp: msg.fullTimestamp || new Date().toISOString(),
        timestampMs: msg.fullTimestamp ? new Date(msg.fullTimestamp).getTime() : Date.now(),
        isSystem: msg.isSystem || false,
        color: msg.color
      }));

      return res.json({
        success: true,
        messages: recentMessages,
        count: recentMessages.length,
        range: { since: null, until: null }
      });
    }

    // Include context messages from before the clip start
    const effectiveStart = sinceMs - contextWindow;

    // Filter messages by time range
    const filteredMessages = chatMessages
      .filter(msg => {
        const msgTime = msg.fullTimestamp ? new Date(msg.fullTimestamp).getTime() : 0;
        return msgTime >= effectiveStart && msgTime <= untilMs;
      })
      .map(msg => {
        const msgTimeMs = msg.fullTimestamp ? new Date(msg.fullTimestamp).getTime() : 0;
        return {
          username: msg.username,
          message: msg.message,
          timestamp: msg.fullTimestamp || new Date().toISOString(),
          timestampMs: msgTimeMs,
          isSystem: msg.isSystem || false,
          color: msg.color,
          isContext: msgTimeMs < sinceMs // Mark messages before clip start as context
        };
      });

    console.log(`💬 CHAT API: Returning ${filteredMessages.length} messages for range ${new Date(sinceMs).toISOString()} to ${new Date(untilMs).toISOString()}`);

    res.json({
      success: true,
      messages: filteredMessages,
      count: filteredMessages.length,
      range: {
        since: sinceMs,
        until: untilMs,
        contextStart: effectiveStart
      }
    });
  } catch (error) {
    console.error('❌ CHAT: Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// Debug endpoint to test token validation
app.get('/debug/test-token', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  
  if (!token) {
    return res.json({ error: 'No token provided' });
  }
  
  const user = verifyToken(token);
  
  res.json({
    token: token.substring(0, 20) + '...',
    valid: !!user,
    user: user ? { id: user.id, username: user.username } : null,
    jwtSecret: JWT_SECRET.substring(0, 10) + '...'
  });
});

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
      await handlePublicCommand(command, args, user, socket, io);
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