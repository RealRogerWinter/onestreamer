// Admin command dispatch table for chat-service.
//
// `/`-prefixed commands (issued by admins and moderators via the chat input)
// route through this object. Each handler has signature
// `(socket, args, userInfo, io) => void|Promise<void>` — identical to the
// inline object that previously lived in chat-service/index.js, so call sites
// (the socket-layer `send-message` listener) keep working unchanged.
//
// Behavior must remain byte-equivalent to the inline implementation that
// existed pre-PR-K6. In particular:
//   - All public broadcasts still push into the shared `chatMessages` ring
//     (with the same `MAX_CHAT_HISTORY` trim) and emit `new-message`.
//   - Ban/unban/timeout mutate the moderation-service Set/Map instances
//     in-place (same references the HTTP API + isUserBanned check use), then
//     call `saveModerationData()` so disk + memory agree.
//   - Every admin response path goes through the injected
//     `sendAdminResponse(socket, text)` helper so the `isAdminOnly` flag is
//     preserved exactly.
//   - HTTP calls to the main server retain the same URLs, payloads,
//     timeouts, error-message formatting, and console log lines so log
//     scraping / dashboards continue to match.
//
// Permission gating: the socket handler in core/socketHandlers.js verifies
// `user.isAuthenticated && (user.isAdmin || user.isModerator)` before
// dispatching here, so handlers that are admin-only (claim/award/take/
// extend/reduce/lock/unlock) re-check `userInfo.isAdmin` and reject
// moderators with the same wording that was inline before.

const createAdminCommands = (deps) => {
  const {
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
    voteServices
  } = deps;

  const { bannedUsers, bannedUsersData, timeoutUsers, saveModerationData } = moderationService;
  const { startClaimEvent } = claimEventService;
  const { parseStreamUrl } = voteServices.swapVote;

  return {
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
};

module.exports = createAdminCommands;
