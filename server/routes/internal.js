// server/routes/internal.js
//
// /api/internal/* router. These endpoints are the HTTP surface that the
// chat microservice (and a few authenticated client features like gift,
// gamble, slots, admin point grants, leaderboard) call back into the main
// server with. Extracted from server/index.js in PR-G2.
//
// Service access:
//   - Early-core services come from `req.app.locals.services` (the PR-I
//     factory bag): sessionService, timeTrackingService, accountService,
//     itemService, inventoryService.
//   - viewbotService is built later in server/index.js (it depends on the
//     mediasoup adapter being selected first); it's read off
//     `req.app.locals.viewbotService` at request time so it can be null
//     before the viewbot subsystem comes online.
//   - viewbotUsernameCache / viewbotSocketIds and getStreamerDisplayName
//     (helper closure that consults sessionService + authService) are
//     exposed on app.locals from server/index.js once they exist.
//   - userBonusCooldowns is a Map of userId -> last-claim epoch ms. It was
//     declared mid-route-block before the extract; it's now hoisted into
//     app.locals so /claim-chat-bonus and /bonus-status/:userId share it.
//
// AuthService is module-scope (stateless wrt session-shared state — same
// pattern as routes/tutorial.js).

const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'internal' });

const router = express.Router();

const AuthService = require('../services/AuthService');
const AccountService = require('../services/AccountService');
const ItemService = require('../services/ItemService');
const InventoryService = require('../services/InventoryService');
// PR 16.2: GameMechanicsError is the typed error subclass that the game-
// mechanic methods throw for client-facing failures. The handler catches it
// and maps `{ statusCode, clientMessage, extra }` to the JSON HTTP shape that
// each route used to build inline. Keeps responses byte-equivalent without
// duplicating status-code knowledge between the service and the handlers.
const { GameMechanicsError } = require('../services/GameMechanicsService');
// PR 16.3: same typed-error pattern for gift-item eligibility failures.
const { InventoryError } = require('../services/InventoryService');

const authService = new AuthService();

// PR 16.2: small helper used by the five game-mechanic handlers. Catches the
// service's typed errors and maps to the byte-equivalent res.json shape;
// anything else (an unexpected throw) is rethrown so the per-route catch can
// still emit its own 500 log line and 500 body. Avoids three copies of the
// same map-and-respond block.
//
// Spread order: `extra` is spread FIRST, then `success` / `error` are written
// — so a future caller that accidentally puts an `error` key in `extra`
// cannot shadow the clientMessage. Today `extra` is only ever the 429
// cooldown's `{ remainingSeconds, nextAvailable }`, but the ordering hardens
// the contract for free.
function respondGameMechanicsError(err, res) {
  if (err instanceof GameMechanicsError) {
    res.status(err.statusCode).json({
      ...err.extra,
      success: false,
      error: err.clientMessage,
    });
    return true;
  }
  return false;
}

// API endpoint for chat service to track messages
router.post('/track-chat-message', express.json(), async (req, res) => {
  try {
    const { sessionService, timeTrackingService } = req.app.locals.services;
    const { userId, ip } = req.body;
    logger.debug(`💬 API: Received chat message tracking request - userId: ${userId}, ip: ${ip}`);

    if (!userId && !ip) {
      logger.debug(`❌ API: No userId or ip provided`);
      return res.status(400).json({ error: 'userId or ip required' });
    }

    // If only IP is provided, try to find the user ID
    let actualUserId = userId;
    if (!actualUserId && ip) {
      const session = sessionService.getSessionByIp(ip);
      actualUserId = session?.userId;
      logger.debug(`💬 API: Looking up user by IP ${ip} - found session:`, !!session, 'userId:', actualUserId);
    }

    if (actualUserId) {
      logger.debug(`✅ API: Tracking chat message for user ${actualUserId}`);
      await timeTrackingService.trackChatMessage(actualUserId);
      res.json({ success: true, userId: actualUserId });
    } else {
      logger.debug(`❌ API: User not found - userId: ${userId}, ip: ${ip}, session: ${sessionService.getSessionByIp(ip) ? 'exists but no userId' : 'not found'}`);
      res.json({ success: false, message: 'User not authenticated' });
    }
  } catch (error) {
    logger.error('❌ API: Error tracking chat message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint for chat service to sync usernames
router.post('/sync-chat-username', express.json(), async (req, res) => {
  try {
    const { sessionService } = req.app.locals.services;
    const { ip, username, color } = req.body;
    logger.debug(`💬 API: Received chat username sync request - ip: ${ip}, username: ${username}, color: ${color}`);

    if (!ip || !username) {
      logger.debug(`❌ API: Missing required fields - ip: ${ip}, username: ${username}`);
      return res.status(400).json({ error: 'ip and username required' });
    }

    // Update the session service with the chat username
    sessionService.setChatUsername(ip, username, color);
    logger.debug(`✅ API: Synced chat username for IP ${ip}: ${username} (${color})`);

    res.json({ success: true, ip, username, color });
  } catch (error) {
    logger.error('❌ API: Error syncing chat username:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test endpoint to verify viewbot username generation
router.post('/test-viewbot-username', express.json(), async (req, res) => {
  const { streamerId } = req.body;

  if (!streamerId) {
    return res.status(400).json({ error: 'streamerId is required' });
  }

  logger.debug(`🧪 TEST API: Testing viewbot username generation for ${streamerId}`);

  try {
    const viewbotService = req.app.locals.viewbotService;
    const viewbotSocketIds = req.app.locals.viewbotSocketIds;
    const viewbotUsernameCache = req.app.locals.viewbotUsernameCache;
    const getStreamerDisplayName = req.app.locals.getStreamerDisplayName;

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
    logger.error('❌ TEST API: Error testing viewbot username:', error);
    res.status(500).json({
      error: error.message,
      streamerId
    });
  }
});

// API endpoint to get leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const accountService = new AccountService();
    const db = require('../database/database');

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
    logger.error('❌ LEADERBOARD: Error fetching leaderboard:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch leaderboard'
    });
  }
});

// API endpoint to get stream uptime
router.get('/stream-uptime', async (req, res) => {
  try {
    const io = req.app.get('io');
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
    logger.error('❌ UPTIME: Error fetching stream uptime:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch stream uptime'
    });
  }
});

// API endpoint for awarding points (claim events, etc)
router.post('/award-points', express.json(), async (req, res) => {
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
    logger.error('❌ MAIN SERVER: Failed to award points:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to award points'
    });
  }
});

// API endpoint for gambling
router.post('/gamble', express.json(), async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
    if (!svc) {
      logger.error('❌ GAMBLE: gameMechanicsService not available on app.locals.services');
      return res.status(500).json({ success: false, error: 'Failed to process gamble' });
    }

    const result = await svc.gamble(userId, amount);
    res.json({ success: true, ...result });
  } catch (error) {
    if (respondGameMechanicsError(error, res)) return;
    logger.error('❌ GAMBLE: Error processing gamble:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process gamble'
    });
  }
});

// API endpoint for slots
router.post('/slots', express.json(), async (req, res) => {
  try {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
    if (!svc) {
      logger.error('❌ SLOTS: gameMechanicsService not available on app.locals.services');
      return res.status(500).json({ success: false, error: 'Failed to process slots' });
    }

    const result = await svc.slots(userId, amount);
    res.json({ success: true, ...result });
  } catch (error) {
    if (respondGameMechanicsError(error, res)) return;
    logger.error('❌ SLOTS: Error processing slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process slots'
    });
  }
});

// Endpoint for authenticated users to claim chat bonus
router.post('/claim-chat-bonus', express.json(), async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required'
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== userId) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
    if (!svc) {
      logger.error('❌ BONUS: gameMechanicsService not available on app.locals.services');
      return res.status(500).json({ success: false, error: 'Failed to claim bonus' });
    }

    const result = await svc.claimChatBonus(userId);
    res.json({ success: true, ...result });
  } catch (error) {
    if (respondGameMechanicsError(error, res)) return;
    logger.error('❌ BONUS: Error claiming chat bonus:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to claim bonus'
    });
  }
});

// Endpoint to gift an item to another user
router.post('/gift-item', express.json(), async (req, res) => {
  try {
    const { fromUserId, toUsername, itemName, quantity = 1 } = req.body;

    if (!fromUserId || !toUsername || !itemName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== fromUserId) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // HTTP-layer string-to-id resolution stays in the handler — username
    // → recipientId and itemName → item happen here, returning the
    // pre-PR 404s when either is unknown. The service receives only ids.
    const accountService = new AccountService();
    const itemService = new ItemService();

    const toUser = await accountService.getUserByUsername(toUsername);
    if (!toUser) {
      return res.status(404).json({
        success: false,
        error: `User '${toUsername}' not found`
      });
    }

    // Self-gift short-circuit BEFORE item lookup. The service guards self-
    // gift too (defense in depth), but the pre-PR inline handler ran this
    // check between username resolution and item-name resolution, so we
    // mirror that observable HTTP order here. Otherwise a `!gift bogus me`
    // would return `404 Item 'bogus' not found` instead of the historical
    // `400 Cannot gift items to yourself`.
    if (toUser.id === fromUserId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot gift items to yourself'
      });
    }

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

    const inventoryService =
      (req.app.locals.services && req.app.locals.services.inventoryService)
      || new InventoryService(itemService);

    const giftResult = await inventoryService.giftItem(fromUserId, toUser.id, item.id, quantity);

    // Sender-row lookup happens AFTER eligibility passes, matching pre-PR
    // order — the row is only needed for the log line + `from` field on the
    // 200 response.
    const fromUser = await accountService.getUserById(fromUserId);

    logger.debug(`🎁 GIFT: ${fromUser.username} gifted ${quantity}x ${item.display_name} to ${toUsername}`);

    res.json({
      success: true,
      item: giftResult.item,
      quantity: giftResult.quantity,
      from: fromUser.username,
      to: toUsername
    });
  } catch (error) {
    if (error instanceof InventoryError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.clientMessage,
      });
    }
    logger.error('❌ GIFT: Error processing gift:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process gift'
    });
  }
});

// Endpoint to get user's giftable items
router.get('/giftable-items/:userId', async (req, res) => {
  try {
    const userIdInt = parseInt(req.params.userId);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== userIdInt) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const inventoryService =
      (req.app.locals.services && req.app.locals.services.inventoryService)
      || new InventoryService(new ItemService());

    const giftableItems = await inventoryService.getGiftableItems(userIdInt);

    res.json({
      success: true,
      items: giftableItems
    });
  } catch (error) {
    logger.error('❌ GIFT: Error fetching giftable items:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch giftable items'
    });
  }
});

// Endpoint to check bonus availability for a user
router.get('/bonus-status/:userId', async (req, res) => {
  try {
    const userIdInt = parseInt(req.params.userId);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== userIdInt) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
    if (!svc) {
      logger.error('❌ BONUS: gameMechanicsService not available on app.locals.services');
      return res.status(500).json({ success: false, error: 'Failed to check bonus status' });
    }

    const result = svc.getBonusStatus(userIdInt);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('❌ BONUS: Error checking bonus status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check bonus status'
    });
  }
});

// Endpoint to get user stats by username
router.get('/user-stats/:username', async (req, res) => {
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
    logger.error('❌ STATS: Error fetching user stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user stats'
    });
  }
});

// Endpoint for users to transfer points to another user
router.post('/transfer-points', express.json(), async (req, res) => {
  try {
    const { fromUserId, toUsername, amount, senderUsername } = req.body;

    if (!fromUserId || !toUsername || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.substring(7);
    const decoded = authService.verifyToken(token);
    if (!decoded || decoded.id !== fromUserId) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const svc = req.app.locals.services && req.app.locals.services.gameMechanicsService;
    if (!svc) {
      logger.error('❌ TRANSFER: gameMechanicsService not available on app.locals.services');
      return res.status(500).json({ success: false, error: 'Failed to transfer points' });
    }

    const result = await svc.transferPoints(fromUserId, toUsername, amount, senderUsername);
    res.json({ success: true, ...result });
  } catch (error) {
    if (respondGameMechanicsError(error, res)) return;
    logger.error('❌ TRANSFER: Error transferring points:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to transfer points'
    });
  }
});

// Admin endpoint to award points to a user (creates new points)
router.post('/admin/award-points', express.json(), async (req, res) => {
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

    logger.debug(`💰 ADMIN: ${adminUser.username} awarded ${amount} points to ${targetUsername}. New balance: ${newBalance}`);

    res.json({
      success: true,
      newBalance,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username
    });
  } catch (error) {
    logger.error('❌ ADMIN: Error giving points:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to give points'
    });
  }
});

// Admin endpoint to take points from a user
router.post('/admin/take-points', express.json(), async (req, res) => {
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

    logger.debug(`💸 ADMIN: ${adminUser.username} deducted ${amount} points from ${targetUsername}. New balance: ${newBalance}`);

    res.json({
      success: true,
      newBalance,
      targetUserId: targetUser.id,
      targetUsername: targetUser.username
    });
  } catch (error) {
    logger.error('❌ ADMIN: Error taking points:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to take points'
    });
  }
});

// API endpoint to verify admin status for debug panel
router.get('/verify-admin', async (req, res) => {
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
    logger.error('❌ API: Error verifying admin status:', error);
    res.status(500).json({ isAdmin: false, error: 'Internal server error' });
  }
});

// API endpoint for chat service to get user admin status
router.get('/user/:userId/admin-status', express.json(), async (req, res) => {
  try {
    const { userId } = req.params;
    logger.debug(`💬 API: Received admin status request for user ${userId}`);

    if (!userId) {
      logger.debug(`❌ API: No userId provided`);
      return res.status(400).json({ error: 'userId required' });
    }

    const accountService = new AccountService();
    const user = await accountService.getUserById(userId);

    if (!user) {
      logger.debug(`❌ API: User ${userId} not found`);
      return res.status(404).json({ error: 'User not found' });
    }

    const isAdmin = !!user.is_admin;
    logger.debug(`✅ API: User ${userId} admin status: ${isAdmin}`);

    res.json({
      success: true,
      userId,
      isAdmin,
      username: user.username
    });
  } catch (error) {
    logger.error('❌ API: Error checking admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
