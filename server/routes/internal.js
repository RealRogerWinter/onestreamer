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

const authService = new AuthService();

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

    logger.debug(`🎲 GAMBLE: User ${userId} ${won ? 'won' : 'lost'} ${amount} points. New balance: ${newBalance}`);

    res.json({
      success: true,
      won,
      amount,
      newBalance
    });
  } catch (error) {
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

    logger.debug(`🎰 SLOTS: User ${userId} bet ${amount}, got [${symbols.join(' ')}], won ${winAmount}. New balance: ${newBalance}`);

    res.json({
      success: true,
      symbols,
      winAmount,
      newBalance
    });
  } catch (error) {
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
    const userBonusCooldowns = req.app.locals.userBonusCooldowns;
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
        logger.debug(`⏰ BONUS: User ${userId} tried to claim too soon. ${remainingTime}s remaining`);
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

    logger.debug(`🎁 BONUS: User ${userId} claimed 100 chat bonus points. New balance: ${newBalance}. Next available: ${nextBonusTime.toISOString()}`);

    res.json({
      success: true,
      pointsAwarded: 100,
      newBalance,
      nextBonusDelay, // Send delay to client for timer
      nextBonusTime: nextBonusTime.toISOString()
    });
  } catch (error) {
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
    const db = require('../database/database');
    await db.runAsync(
      `INSERT INTO gift_transactions (from_user_id, to_user_id, item_id, quantity, timestamp)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [fromUserId, toUser.id, item.id, quantity]
    );

    logger.debug(`🎁 GIFT: ${fromUser.username} gifted ${quantity}x ${item.display_name} to ${toUsername}`);

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
    const userBonusCooldowns = req.app.locals.userBonusCooldowns;
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

    logger.debug(`💸 TRANSFER: ${senderUsername || senderUser.username} sent ${amount} points to ${toUsername}. Sender balance: ${senderNewBalance}, Recipient balance: ${recipientNewBalance}`);

    res.json({
      success: true,
      senderNewBalance,
      recipientNewBalance,
      recipientUserId: targetUser.id,
      recipientUsername: targetUser.username
    });
  } catch (error) {
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
