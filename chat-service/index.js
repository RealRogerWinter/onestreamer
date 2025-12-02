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

const app = express();

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

// Claim event system
let activeClaimEvent = null; // { code: string, reward: number, claimedBy: null|username, startedAt: timestamp }
let claimEventTimer = null; // Timer for next random claim event
let lastClaimEventTime = 0; // Track last claim event time to enforce minimum spacing
const MIN_CLAIM_INTERVAL = 20 * 60 * 1000; // Minimum 20 minutes between events
const MAX_CLAIM_INTERVAL = 60 * 60 * 1000; // Maximum 60 minutes between events
const CLAIM_TIMEOUT = 60 * 1000; // Claim events expire after 60 seconds if not claimed

// Persistence paths
const MODERATION_DATA_PATH = path.join(__dirname, 'moderation_data.json');

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

// JWT secret (should match the main server)
const JWT_SECRET = process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***';

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

// Claim event helper functions
function generateClaimCode() {
  // Generate a random 4-digit code
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function startClaimEvent(manuallyTriggered = false) {
  // Don't start a new event if one is already active
  if (activeClaimEvent) {
    return false;
  }
  
  const code = generateClaimCode();
  const reward = 1000 + Math.floor(Math.random() * 1001); // 1000-2000 points
  
  activeClaimEvent = {
    code: code,
    reward: reward,
    claimedBy: null,
    startedAt: Date.now(),
    manuallyTriggered: manuallyTriggered
  };
  
  // Announce the claim event
  const claimMessage = `🎉 CLAIM EVENT! Type !claim ${code} to win ${reward} points! ⏰ Expires in 60 seconds!`;
  const streamerBotMessage = {
    id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    username: '🤖 StreamBot',
    color: '#FFD700',
    message: claimMessage,
    timestamp: formatTime(),
    fullTimestamp: new Date().toISOString(),
    isSystem: true,
    isClaimEvent: true
  };
  
  chatMessages.push(streamerBotMessage);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }
  
  io.emit('new-message', streamerBotMessage);
  
  // Set timeout to expire the claim event
  setTimeout(() => {
    if (activeClaimEvent && !activeClaimEvent.claimedBy) {
      const expiredMessage = `⏰ Claim event expired! No one claimed the ${activeClaimEvent.reward} points.`;
      const expiredBotMessage = {
        id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: '🤖 StreamBot',
        color: '#FF6B6B',
        message: expiredMessage,
        timestamp: formatTime(),
        fullTimestamp: new Date().toISOString(),
        isSystem: true
      };
      
      chatMessages.push(expiredBotMessage);
      if (chatMessages.length > MAX_CHAT_HISTORY) {
        chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
      }
      
      io.emit('new-message', expiredBotMessage);
      activeClaimEvent = null;
    }
  }, CLAIM_TIMEOUT);
  
  lastClaimEventTime = Date.now();
  return true;
}

function scheduleNextClaimEvent() {
  // Clear existing timer if any
  if (claimEventTimer) {
    clearTimeout(claimEventTimer);
  }
  
  // Schedule next event with random interval (20-60 minutes)
  const nextEventDelay = MIN_CLAIM_INTERVAL + Math.random() * (MAX_CLAIM_INTERVAL - MIN_CLAIM_INTERVAL);
  const nextEventMinutes = Math.floor(nextEventDelay / 60000);
  
  console.log(`📅 CLAIM: Next claim event scheduled in ${nextEventMinutes} minutes`);
  
  claimEventTimer = setTimeout(() => {
    startClaimEvent(false);
    scheduleNextClaimEvent(); // Schedule the next one
  }, nextEventDelay);
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
/announce [message] - Send a highlighted announcement`;
    } else if (userInfo.isModerator) {
      // Moderator commands only
      helpMessage = `Available moderator commands:
/help - Show this help message
/ban [username] - Ban a user from chat
/unban [username] - Unban a user from chat
/timeout [username] [seconds] - Timeout a user for specified duration
/clear - Clear all chat messages
/tts [message] - Send a TTS message
/announce [message] - Send a highlighted announcement`;
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
!roll - Roll a dice (1-6)
!coinflip - Flip a coin
!gamble [amount] - 50/50 chance to double or lose
!slots [amount] - Play slots (costs 10 points minimum)
!gift [item] [user] [quantity] - Gift an item to another user
!claim [code] - Claim points during a claim event
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
      
    case 'claim':
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
          activeClaimEvent = null;
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
    
    // Profanity filter - silently block messages containing banned words
    const bannedWords = ['nigger', 'faggot'];
    const lowerMessage = trimmedMessage.toLowerCase();
    for (const word of bannedWords) {
      if (lowerMessage.includes(word)) {
        console.log(`🚫 PROFANITY: Blocked message from ${user.username} containing banned word`);
        // Silently return without sending the message
        return;
      }
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