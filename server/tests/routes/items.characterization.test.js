/**
 * Characterization tests for /api routes defined in server/routes/items.js.
 *
 * These PIN the CURRENT HTTP behavior (status codes, response shapes, and the
 * service methods invoked with their args) of a representative endpoint from
 * each concern group, so that a follow-up decomposition into sub-route modules
 * can be verified as behavior-preserving.
 *
 * DI reality being characterized:
 *   - The router is mounted at '/api' and is a plain express.Router (not a
 *     factory). Stateful services are read via `req.app.get('<name>')`, so
 *     tests inject mocks with `app.set('<name>', mock)`.
 *   - Three services are instantiated at MODULE scope inside items.js
 *     (DrawingService, ThrowingService, ItemUseService) and a ChatNotifier.
 *     These are replaced with jest.mock factories below so their HTTP contract
 *     can be pinned.
 *   - Auth middleware (authenticateToken / authenticateAdmin) is bypassed with
 *     a jest.mock so handler behavior (not the auth contract) is exercised. The
 *     mocks also let us assert that a route is GATED by a given middleware.
 */

const express = require('express');
const request = require('supertest');

// --- Auth middleware stub ---------------------------------------------------
// Pass-through stubs that record which middleware guarded a route and attach a
// deterministic req.user. A flag lets a single test force a 401 rejection to
// pin the auth-gating contract.
const authState = { rejectToken: false };

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, _res, next) => {
    if (authState.rejectToken) {
      return _res.status(401).json({ error: 'Access token required' });
    }
    req.user = { userId: 7, id: 7, username: 'tester' };
    next();
  }),
  authenticateAdmin: jest.fn((req, _res, next) => {
    req.user = { userId: 99, id: 99, username: 'admin' };
    next();
  }),
}));

// --- Module-scoped service stubs --------------------------------------------
// Names MUST be prefixed with "mock" so jest's hoisting allows them inside the
// jest.mock factories below.
const mockUseItem = jest.fn();
const mockStartDrawing = jest.fn();
const mockStartThrow = jest.fn();
const mockChatSend = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../../services/ItemUseService', () =>
  jest.fn().mockImplementation(() => ({ useItem: mockUseItem })));
jest.mock('../../services/DrawingService', () =>
  jest.fn().mockImplementation(() => ({ startDrawing: mockStartDrawing })));
jest.mock('../../services/ThrowingService', () =>
  jest.fn().mockImplementation(() => ({ startThrow: mockStartThrow })));
jest.mock('../../services/ChatNotifier', () =>
  jest.fn().mockImplementation(() => ({ send: mockChatSend })));

const itemsRouter = require('../../routes/items');

function buildApp(services = {}) {
  const app = express();
  app.use(express.json());
  for (const [name, impl] of Object.entries(services)) {
    app.set(name, impl);
  }
  app.use('/api', itemsRouter);
  return app;
}

beforeEach(() => {
  authState.rejectToken = false;
  mockUseItem.mockReset();
  mockStartDrawing.mockReset();
  mockStartThrow.mockReset();
});

describe('routes/items characterization', () => {
  // ---- Catalog / public reads ---------------------------------------------
  describe('catalog reads', () => {
    test('GET /api/items returns all items and calls getAllItems', async () => {
      const itemService = {
        getAllItems: jest.fn().mockResolvedValue([{ id: 1, name: 'sword' }]),
        getItemsByCategory: jest.fn(),
      };
      const res = await request(buildApp({ itemService })).get('/api/items');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: 1, name: 'sword' }]);
      expect(itemService.getAllItems).toHaveBeenCalledTimes(1);
      expect(itemService.getItemsByCategory).not.toHaveBeenCalled();
    });

    test('GET /api/items?category=foo filters by category', async () => {
      const itemService = {
        getAllItems: jest.fn(),
        getItemsByCategory: jest.fn().mockResolvedValue([{ id: 2 }]),
      };
      const res = await request(buildApp({ itemService })).get('/api/items?category=foo');

      expect(res.status).toBe(200);
      expect(itemService.getItemsByCategory).toHaveBeenCalledWith('foo');
      expect(itemService.getAllItems).not.toHaveBeenCalled();
    });

    test('GET /api/items/:id returns 404 when item is missing', async () => {
      const itemService = { getItemById: jest.fn().mockResolvedValue(null) };
      const res = await request(buildApp({ itemService })).get('/api/items/123');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Item not found' });
      expect(itemService.getItemById).toHaveBeenCalledWith('123');
    });

    test('GET /api/items surfaces a 500 on service failure', async () => {
      const itemService = { getAllItems: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = await request(buildApp({ itemService })).get('/api/items');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch items' });
    });

    test('GET /api/shop returns shop items', async () => {
      const shopService = { getShopItems: jest.fn().mockResolvedValue([{ id: 5 }]) };
      const res = await request(buildApp({ shopService })).get('/api/shop');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: 5 }]);
      expect(shopService.getShopItems).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Admin item CRUD -----------------------------------------------------
  describe('admin CRUD', () => {
    test('POST /api/items creates an item with 201 (admin-gated)', async () => {
      const auth = require('../../middleware/auth');
      const itemService = { createItem: jest.fn().mockResolvedValue({ id: 9, name: 'shield' }) };
      const res = await request(buildApp({ itemService }))
        .post('/api/items')
        .send({ name: 'shield' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 9, name: 'shield' });
      expect(itemService.createItem).toHaveBeenCalledWith({ name: 'shield' });
      expect(auth.authenticateAdmin).toHaveBeenCalled();
    });

    test('GET /api/admin/items/stats returns stats', async () => {
      const itemService = { getItemStats: jest.fn().mockResolvedValue({ total: 42 }) };
      const res = await request(buildApp({ itemService })).get('/api/admin/items/stats');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ total: 42 });
    });

    test('POST /api/admin/items/grant validates required fields', async () => {
      const inventoryService = { grantItemsToUser: jest.fn() };
      const res = await request(buildApp({ inventoryService }))
        .post('/api/admin/items/grant')
        .send({ itemId: 'x' }); // missing userId

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'User ID and Item ID required' });
      expect(inventoryService.grantItemsToUser).not.toHaveBeenCalled();
    });
  });

  // ---- Inventory reads -----------------------------------------------------
  describe('inventory reads', () => {
    test('GET /api/inventory returns the user inventory (token-gated)', async () => {
      const auth = require('../../middleware/auth');
      const inventoryService = {
        getUserInventory: jest.fn().mockResolvedValue([{ itemId: 1, quantity: 3 }]),
      };
      const res = await request(buildApp({ inventoryService })).get('/api/inventory');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ itemId: 1, quantity: 3 }]);
      // userId resolves from req.user.userId (7) injected by the token stub.
      expect(inventoryService.getUserInventory).toHaveBeenCalledWith(7);
      expect(auth.authenticateToken).toHaveBeenCalled();
    });

    test('GET /api/inventory is rejected with 401 when auth fails', async () => {
      authState.rejectToken = true;
      const inventoryService = { getUserInventory: jest.fn() };
      const res = await request(buildApp({ inventoryService })).get('/api/inventory');

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Access token required' });
      expect(inventoryService.getUserInventory).not.toHaveBeenCalled();
    });
  });

  // ---- Purchase ------------------------------------------------------------
  describe('purchase', () => {
    test('POST /api/shop/purchase 400 when itemId missing', async () => {
      const shopService = { purchaseItem: jest.fn() };
      const res = await request(buildApp({ shopService }))
        .post('/api/shop/purchase')
        .send({ quantity: 2 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Item ID required' });
      expect(shopService.purchaseItem).not.toHaveBeenCalled();
    });

    test('POST /api/shop/purchase calls purchaseItem and returns its result', async () => {
      const shopService = {
        purchaseItem: jest.fn().mockResolvedValue({ success: true, balance: 50 }),
      };
      const res = await request(buildApp({ shopService }))
        .post('/api/shop/purchase')
        .send({ itemId: 'pot', quantity: 2 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, balance: 50 });
      // userId 7 from token stub; quantity passed through.
      expect(shopService.purchaseItem).toHaveBeenCalledWith(7, 'pot', 2);
    });

    test('POST /api/shop/purchase maps insufficient points to 402', async () => {
      const shopService = {
        purchaseItem: jest.fn().mockRejectedValue(new Error('Insufficient points to buy')),
      };
      const res = await request(buildApp({ shopService }))
        .post('/api/shop/purchase')
        .send({ itemId: 'pot' });

      expect(res.status).toBe(402);
      expect(res.body).toEqual({ error: 'Insufficient points to buy' });
    });
  });

  // ---- Use item (module-scoped ItemUseService) -----------------------------
  describe('use item', () => {
    test('POST /api/inventory/use/:itemId returns the service body on success', async () => {
      mockUseItem.mockResolvedValue({ ok: true, status: 200, body: { used: true } });
      const res = await request(buildApp())
        .post('/api/inventory/use/55')
        .send({ foo: 'bar' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ used: true });
      expect(mockUseItem).toHaveBeenCalledTimes(1);
      const arg = mockUseItem.mock.calls[0][0];
      expect(arg.itemId).toBe('55');
      expect(arg.body).toEqual({ foo: 'bar' });
      expect(arg.user).toEqual({ userId: 7, id: 7, username: 'tester' });
    });

    test('POST /api/inventory/use/:itemId maps item-not-found to 404', async () => {
      mockUseItem.mockResolvedValue({ ok: false, kind: 'item-not-found' });
      const res = await request(buildApp())
        .post('/api/inventory/use/55')
        .send({});

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Item not found' });
    });

    test('POST /api/inventory/use/:itemId maps validation-failed to 429 with cooldownRemaining', async () => {
      mockUseItem.mockResolvedValue({
        ok: false,
        kind: 'validation-failed',
        error: 'on cooldown',
        cooldownRemaining: 12,
      });
      const res = await request(buildApp())
        .post('/api/inventory/use/55')
        .send({});

      expect(res.status).toBe(429);
      expect(res.body).toEqual({ error: 'on cooldown', cooldownRemaining: 12 });
    });
  });
});
