const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'items' });

const router = express.Router();
const DrawingService = require('../services/DrawingService');
const ThrowingService = require('../services/ThrowingService');
const ItemUseService = require('../services/ItemUseService');
const ChatNotifier = require('../services/ChatNotifier');

const createCatalogRouter = require('./items/catalog');
const createPurchaseRouter = require('./items/purchase');
const createInventoryRouter = require('./items/inventory');
const createAdminRouter = require('./items/admin');

// Single ChatNotifier instance shared across all item services so we have
// one place to swap the chat transport / inject in tests. PR-J/J2/J3.
const chatNotifier = new ChatNotifier();
const sendSystemMessage = chatNotifier.send;

const drawingService = new DrawingService();
const throwingService = new ThrowingService();
const itemUseService = new ItemUseService();

// Item/shop/inventory HTTP routes were decomposed into cohesive sub-route
// modules. The parent mounts them at the SAME base path ('/') so that, once
// this router is itself mounted at '/api' in server/index.js, every path,
// method, middleware/auth order, and handler body is byte-for-byte identical
// to the prior monolithic router. The module-scoped drawing/throwing/use
// services and the chat sender are injected so a single shared instance is
// used process-wide (preserving the prior behavior).
router.use(createCatalogRouter({ logger }));
router.use(createPurchaseRouter({ logger }));
router.use(createInventoryRouter({
    logger,
    drawingService,
    throwingService,
    itemUseService,
    sendSystemMessage,
}));
router.use(createAdminRouter({ logger }));

module.exports = router;
