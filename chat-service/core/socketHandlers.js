// Socket.IO connection + per-socket event wiring for chat-service.
//
// Owns the bulk of the previous `io.on('connection', ...)` body that lived in
// chat-service/index.js prior to PR-K6:
//   - Connection accept: token verification, admin/moderator lookup,
//     animal-name generation for anonymous users, IP-based username reuse,
//     ban / timeout gate at connect time, initial `user-assigned` +
//     `chat-history` emit, `user-count-update` broadcast.
//   - `send-message` listener: profanity filter, ban / timeout gate,
//     rate-limit + duplicate-message gates (with per-user throttle state),
//     `!`-prefix dispatch to the command parser, `/`-prefix dispatch to
//     adminCommands, mention extraction, message-tracking POST to the main
//     server, broadcast + history-ring append.
//   - `join-chat` listener for view-bots.
//   - `disconnect` listener (cleanup + user-count rebroadcast).
//   - `update-user-color` listener (validates hex, persists for
//     authenticated users via the main-server REST endpoint).
//
// Behavior must remain byte-equivalent to the inline implementation that
// existed before this extraction. In particular:
//   - RATE_LIMIT_DELAY (5s) and DUPLICATE_MESSAGE_WINDOW (30s) are unchanged.
//   - Profanity-filtered messages are silently dropped — no error emission.
//   - Admin / moderator users bypass rate-limit + duplicate gates exactly
//     as before.
//   - All `console.log`/`console.error` lines retain their original prefixes
//     so log scraping / dashboards keep matching.
//   - The throttle Maps (`userLastMessage`, `userMessageHistory`) are owned
//     here but exposed on the returned factory so graceful-shutdown in
//     chat-service/index.js can `.clear()` them at SIGTERM/SIGINT.
//
// The factory returns:
//   - `register(socket)` — installs all listeners for one connection.
//   - `userLastMessage` / `userMessageHistory` — the throttle Maps, exposed
//     for graceful-shutdown cleanup. Do not mutate from outside otherwise.

// Client-IP derivation (audit CH2): last-XFF-hop parse + IPv6 normalization
// moved to ./ipAddress.js so the spoof-resistant parse is unit-testable.
const { getIpAddress } = require('./ipAddress');

// Rate-limit and duplicate-detection windows. Kept here (not as deps) since
// they are implementation details of the throttle subsystem and have no
// other consumer in the codebase.
const RATE_LIMIT_DELAY = 5000; // 5 seconds between messages
const DUPLICATE_MESSAGE_WINDOW = 30000; // 30 seconds for duplicate detection

// Animal names used for anonymous-viewer usernames. Owned here because
// `generateUsername()` (below) is the only consumer.
const ANIMALS = [
  'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
  'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
  'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
  'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
  'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
];

// Color palette used for both anonymous-viewer usernames (random pick) and
// authenticated users (deterministic `id % COLORS.length` index). Both
// consumers live in this module, so the array stays here.
const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8E8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#A9DFBF', '#F9E79F',
  '#D7BDE2', '#A3E4D7', '#FAD7A0', '#D5A6BD', '#87CEEB', '#DEB887', '#F0E68C', '#FFB6C1'
];

/**
 * Create the chat-service socket handler factory.
 *
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {object} deps.profanityFilter           ProfanityFilterService instance (isClean(text))
 * @param {object} deps.moderationService         { isUserBanned, isUserTimedOut, timeoutUsers }
 * @param {object} deps.commandParser             { parse(command, args, user, socket) }
 * @param {object} deps.adminCommands             dispatch table from core/adminCommands.js
 * @param {Map<string, object>} deps.connectedUsers   socketId -> user info
 * @param {Map<string, object>} deps.ipToUser         IP -> { name, color, isAuthenticated }
 * @param {Array<object>} deps.chatMessages       in-memory ring (shared instance)
 * @param {number} deps.MAX_CHAT_HISTORY          ring size
 * @param {() => string} deps.formatTime          "HH:MM" formatter
 * @param {(token: string) => object|null} deps.verifyToken
 * @param {(socket, message: string) => void} deps.sendAdminResponse
 * @param {string} deps.MAIN_SERVER_URL
 * @param {import('axios').AxiosStatic} deps.axios
 * @param {(extra?: object) => object} deps.getAxiosConfig
 * @param {(input: string) => string} deps.uuidv4    UUID generator for outgoing messages
 */
function createSocketHandlers(deps) {
  const {
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
  } = deps;

  // Generate random username with color for anonymous viewers.
  function generateUsername() {
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const number = Math.floor(Math.random() * 9999) + 1;
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];

    return {
      name: `${animal}${number}`,
      color: color
    };
  }

  // Get user admin/moderator status from main server. Called once per
  // authenticated connection to populate `user.isAdmin` / `user.isModerator`
  // in the connectedUsers map (the `/`-command permission gate reads them).
  async function getUserStatus(userId) {
    try {
      const response = await axios.get(
        `${MAIN_SERVER_URL}/api/admin/internal/user/${userId}/status`,
        getAxiosConfig({ timeout: 5000 })
      );
      return {
        isAdmin: response.data.isAdmin || false,
        isModerator: response.data.isModerator || false,
        isBanned: response.data.isBanned || false,
        // M4: chat-specific ban flag (users.chat_banned) — enforced at
        // connect exactly like isBanned. `|| false` also covers main-server
        // builds that predate the field.
        isChatBanned: response.data.isChatBanned || false
      };
    } catch (error) {
      // Deliberately fails OPEN (audit CH1 decision): if the main server is
      // unreachable, chat stays available rather than blocking every
      // authenticated connect — availability over enforcement for this gate.
      console.error(`❌ CHAT: Failed to check user status for user ${userId}:`, error.message);
      return { isAdmin: false, isModerator: false, isBanned: false, isChatBanned: false };
    }
  }

  // Track chat message with main server (server-side per-user message
  // counters for rate-tracking / abuse signals).
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

  // Sync chat username with main server. Called for anonymous viewers so
  // the main server can resolve socket-IP -> chat-username (e.g. for the
  // points API).
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

  const { isUserBanned, isUserTimedOut, timeoutUsers } = moderationService;

  // Per-user throttle state. Owned by this module; chat-service/index.js
  // reaches into these to `.clear()` during graceful shutdown via the
  // returned factory object.
  const userLastMessage = new Map();    // username -> last-message timestamp
  const userMessageHistory = new Map(); // username -> [{ message, timestamp }, ...]

  // Send throttle notification to user (private message). Kept inline here
  // (not a top-level helper in index.js) because nothing outside this
  // module produces the `isThrottleNotification: true` payload.
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

  // Check if user is rate limited (5 second cooldown).
  function isRateLimited(username) {
    if (!userLastMessage.has(username)) {
      return false;
    }

    const lastMessageTime = userLastMessage.get(username);
    const timeSinceLastMessage = Date.now() - lastMessageTime;

    return timeSinceLastMessage < RATE_LIMIT_DELAY;
  }

  // Check if message is duplicate within the 30s window.
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

  // Update user's message history for throttling.
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

  // Install all listeners for one socket. Called once per `io.on('connection')`.
  async function register(socket) {
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

      // Check user status (admin/moderator/banned)
      let isAdmin = false;
      let isModerator = false;
      try {
        const userStatus = await getUserStatus(authenticatedUser.id);

        // CH1 (audit): enforce the account-level ban the main server just
        // reported — previously isBanned was fetched then DISCARDED, so
        // banned accounts kept chatting. Mirrors the local username-ban
        // branch below (emit('banned') + disconnect(true) + return), and
        // runs BEFORE the saved-color fetch to skip the wasted round-trip.
        // M4: users.chat_banned (isChatBanned) is treated identically.
        if (userStatus.isBanned || userStatus.isChatBanned) {
          console.log(`💬 CHAT: Banned account ${authenticatedUser.username} (ID: ${authenticatedUser.id}) attempted to connect (isBanned: ${userStatus.isBanned}, isChatBanned: ${userStatus.isChatBanned})`);
          socket.emit('banned', { reason: 'You are banned from chat' });
          socket.disconnect(true);
          return;
        }

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
    });
  }

  return {
    register,
    userLastMessage,
    userMessageHistory
  };
}

module.exports = createSocketHandlers;
