// server/routes/internal/gift.js
//
// Sub-route module of the /api/internal/* router. Holds the item-gift surface:
// the gift-item transfer and the giftable-items read. Handler bodies are
// VERBATIM from the former monolithic server/routes/internal.js; the parent
// mounts this at the SAME base path so every path/method/auth order is
// byte-for-byte identical.

const express = require('express');

const AccountService = require('../../services/AccountService');
const ItemService = require('../../services/ItemService');
const InventoryService = require('../../services/InventoryService');
const { InventoryError } = require('../../services/InventoryService');

/**
 * @param {{ logger: import('pino').Logger, authService: object }} deps
 */
module.exports = function createGiftRouter({ logger, authService }) {
  const router = express.Router();

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

      // A negative/zero/fractional quantity inverts both inventory writes
      // (removeItemFromInventory subtracts a negative → mints for the sender;
      // addItemToInventory adds a negative → steals from the recipient). Reject
      // anything that isn't a positive integer.
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({
          success: false,
          error: 'quantity must be a positive integer'
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

  return router;
};
