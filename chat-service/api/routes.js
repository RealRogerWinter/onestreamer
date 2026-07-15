// HTTP API for chat-service.
//
// Mounts every Express route the chat-service exposes on its own port (8444):
//   GET  /health                 — service liveness + basic counters
//   GET  /api/moderation         — list current bans + active timeouts
//   POST /api/ban                — ban a user (deletes their msgs + disconnects)
//   POST /api/unban              — unban a user
//   POST /api/timeout            — timeout a user for N seconds
//   POST /api/remove-timeout     — clear an active timeout
//   POST /api/system-message     — main-server bot/system message broadcast
//   GET  /api/chat-history       — clip-replay window of chat history
//
// Behavior must remain byte-equivalent to the inline implementation in
// chat-service/index.js prior to PR-K5:
//   - Same paths, status codes, response shapes, log lines.
//   - Same in-place mutation of bannedUsers/bannedUsersData/timeoutUsers
//     (router shares the very same Set/Map instances exposed by
//     moderationService, so command-parser / socket call sites are unaffected).
//   - Same chatMessages ring (push + MAX_CHAT_HISTORY trim) for ban / timeout
//     / system-message broadcasts.
//   - Auth posture (audit CH3): every route except /health is gated by
//     `internalAuth` — the X-Internal-Secret header the main server attaches
//     via server/utils/chatServiceClient.js, matched against
//     INTERNAL_API_SECRET. Enforcement is staged behind
//     ENFORCE_CHAT_INTERNAL_AUTH (permissive warn-log while off); see
//     ./internalAuth.js. The gated set deliberately includes the two READ
//     endpoints: GET /api/moderation leaks the ban list (sole caller is
//     server/routes/admin-moderation.js) and GET /api/chat-history leaks
//     chat history (callers: server ClipService + SessionChatCaptureService;
//     verified no browser/client code calls it directly — the client gets
//     history via the 'chat-history' socket event).

const express = require('express');
const { internalAuth } = require('./internalAuth');

/**
 * Create the chat-service HTTP API router.
 *
 * @param {object} deps
 * @param {object} deps.io                          socket.io server (for ban/timeout/system broadcasts)
 * @param {object} deps.moderationService           { bannedUsers, bannedUsersData, timeoutUsers, saveModerationData }
 * @param {Array<object>} deps.chatMessages         in-memory message ring (shared instance)
 * @param {number} deps.MAX_CHAT_HISTORY            ring size
 * @param {() => string} deps.formatTime            "HH:MM" formatter
 * @param {Map<string, object>} deps.connectedUsers socketId -> user info (for /health count + ban disconnect)
 * @returns {import('express').Router}
 */
function createApiRouter(deps) {
  const {
    io,
    moderationService,
    chatMessages,
    MAX_CHAT_HISTORY,
    formatTime,
    connectedUsers
  } = deps;

  const {
    bannedUsers,
    bannedUsersData,
    timeoutUsers,
    saveModerationData,
    banUserWithSideEffects,
    timeoutUserWithSideEffects
  } = moderationService;

  const router = express.Router();

  // Basic health check endpoint
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'onestreamer-chat',
      connectedUsers: connectedUsers.size,
      messagesInHistory: chatMessages.length,
      timestamp: new Date().toISOString()
    });
  });

  // API endpoint to get moderation data
  router.get('/api/moderation', internalAuth, (req, res) => {
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
  router.post('/api/ban', internalAuth, express.json(), (req, res) => {
    try {
      const { username, reason, bannedBy } = req.body;

      if (!username) {
        return res.status(400).json({ error: 'Username is required' });
      }

      // Canonical ban side effect (state + save + message-splice +
      // 'delete-messages' emit + socket disconnect). The ban notification is
      // broadcast via the hook so it lands at the original point: after
      // 'delete-messages' and before the disconnects.
      const { messagesDeleted, disconnectedCount } = banUserWithSideEffects({
        io,
        chatMessages,
        connectedUsers,
        username,
        reason: reason || 'No reason provided',
        bannedBy: bannedBy || 'Admin',
        logPrefix: 'MODERATION',
        onAfterDeleteMessages: () => {
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
        }
      });

      console.log(`🔨 MODERATION: ${username} banned by ${bannedBy || 'admin'}, deleted ${messagesDeleted} messages, disconnected ${disconnectedCount} connection(s)`);
      res.json({ success: true, message: `${username} has been banned, ${messagesDeleted} messages deleted` });
    } catch (error) {
      console.error('Error banning user:', error);
      res.status(500).json({ error: 'Failed to ban user' });
    }
  });

  // API endpoint to unban a user
  router.post('/api/unban', internalAuth, express.json(), (req, res) => {
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
  router.post('/api/timeout', internalAuth, express.json(), (req, res) => {
    try {
      const { username, duration, reason, timedOutBy } = req.body;

      if (!username || !duration) {
        return res.status(400).json({ error: 'Username and duration are required' });
      }

      // Canonical timeout side effect (state + save). The HTTP route never
      // emitted per-socket 'timeout' events, so notifySockets is false; the
      // public broadcast below is unchanged.
      timeoutUserWithSideEffects({
        io,
        connectedUsers,
        username,
        durationSeconds: duration,
        reason: reason || 'No reason provided',
        notifySockets: false
      });

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
  router.post('/api/remove-timeout', internalAuth, express.json(), (req, res) => {
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
  router.post('/api/system-message', internalAuth, express.json(), (req, res) => {
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
  router.get('/api/chat-history', internalAuth, (req, res) => {
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

  return router;
}

module.exports = createApiRouter;
