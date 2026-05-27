/**
 * PR 13.1 — money-flow integration test through the HTTP route layer.
 *
 * Companion to server/tests/services/ShopService.purchaseItem.atomic.test.js
 * and ShopService.purchaseItem.realAccount.test.js. Those two prove the
 * atomic SQL contract at the *service* boundary (calling
 * shopService.purchaseItem(...) directly). This file proves the same
 * guarantees survive the *route* boundary — error mapping, JSON shape,
 * status codes, side-effect notifier emission — by hitting
 * `POST /api/shop/purchase` through supertest against an in-process Express
 * app wired to in-memory primitives.
 *
 * What gets exercised end-to-end:
 *   - Route mounting and JSON body parsing
 *   - Auth middleware contract (mocked to a pass-through that stamps req.user)
 *   - app.get(...) wiring of shopService / inventoryService / itemService
 *   - ShopService.purchaseItem (real)  →
 *     AccountService.subtractPoints (real)  →
 *     ShopRepository.decrementStockLimit (real)  →
 *     InventoryService.addItemToInventory (real)  →
 *     ItemTransactionRepository.insertPurchase (real)
 *   - withTransaction over in-memory sqlite3 / better-sqlite3 (matrix)
 *   - Route's catch-block error mapping (e.g. "Insufficient points" → 402)
 *   - Post-commit side effects: sessionService.getSocketsByUserId + buffNotifier.inventoryUpdated
 *
 * What this file deliberately does NOT test (covered elsewhere):
 *   - Concurrent-call atomicity under microtask interleaving
 *     (AccountService.points-race.test.js)
 *   - The rollback contract at the service boundary
 *     (ShopService.purchaseItem.atomic.test.js / realAccount.test.js)
 *   - Items / inventory / drawing / throw routes (separate scope)
 *
 * Auth + database isolation:
 *   - middleware/auth.js is jest.mocked so authenticateToken passes through
 *     and stamps a deterministic req.user. The middleware's real behavior is
 *     exercised by other test files; here we're testing the route handler.
 *   - The production database module is jest.mocked through a slot pattern
 *     (same shape as ShopService.purchaseItem.realAccount.test.js) so the
 *     real AccountService — which captures runAsync/getAsync at require time
 *     via destructuring — routes through the same in-memory connection as
 *     ShopRepository and the withTransaction helper.
 */

// Mocks must be declared before any require that pulls them in.
jest.mock('../../middleware/auth', () => ({
    authenticateToken: (req, _res, next) => {
        req.user = { id: 42, userId: 42, username: 'tester' };
        next();
    },
    authenticateAdmin: (req, _res, next) => {
        req.user = { id: 1, userId: 1, username: 'admin' };
        next();
    },
}));

// Slot pattern: jest.mock is hoisted but its factory runs once. The slot
// gives each test fresh in-memory primitives that the production database
// module's wrappers (captured at require time inside services) route through.
const dbSlot = {
    runAsync: null,
    getAsync: null,
    allAsync: null,
    withTransaction: null,
};

jest.mock('../../database/database', () => ({
    get db() { return null; },
    runAsync: (...args) => dbSlot.runAsync(...args),
    getAsync: (...args) => dbSlot.getAsync(...args),
    allAsync: (...args) => dbSlot.allAsync(...args),
    withTransaction: (...args) => dbSlot.withTransaction(...args),
    _betterAdapter: () => null,
}));

const express = require('express');
const request = require('supertest');

const { createWithTransaction } = require('../../database/transaction');
const {
    forEachBackend,
    bootstrapMoneyFlowSchema,
    seedUserAndItem,
} = require('./_helpers/db-fixture');

const AccountService = require('../../services/AccountService');
const InventoryService = require('../../services/InventoryService');
const ShopService = require('../../services/ShopService');
const UserRepository = require('../../database/repository/UserRepository');
const ShopRepository = require('../../database/repository/ShopRepository');
const ItemTransactionRepository = require('../../database/repository/ItemTransactionRepository');
const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');

// The route module pulls in chat notifier transitively; instantiating it
// hits an HTTP client to chat-service which we don't run in tests. Stub it.
jest.mock('../../services/ChatNotifier', () => {
    return class ChatNotifierStub {
        constructor() {
            this.send = jest.fn(async () => ({ delivered: true }));
        }
    };
});

const itemsRouter = require('../../routes/items');

function buildItemServiceStub(primitives) {
    return {
        async getItemById(id) {
            return await primitives.getAsync('SELECT * FROM items WHERE id = ?', [id]);
        },
        async getItemsByCategory() { return []; },
        async getAllItems() { return await primitives.allAsync('SELECT * FROM items'); },
        async getAllCategories() { return []; },
        async getItemStats() { return {}; },
        async getItemCooldowns() { return []; },
        async getGlobalCooldownInfo() { return null; },
        async resetUserItemCooldowns() { return 0; },
        async createItem() { throw new Error('not implemented in stub'); },
        async updateItem() { throw new Error('not implemented in stub'); },
        async deleteItem() { throw new Error('not implemented in stub'); },
        async validateItemUsage() { return { valid: true }; },
        isBuffOrDebuffItem() { return false; },
        async applyItemCooldown() {},
    };
}

function buildApp({ shopService, inventoryService, itemService, sessionService, buffNotifier, io }) {
    const app = express();
    app.use(express.json());
    app.set('shopService', shopService);
    app.set('inventoryService', inventoryService);
    app.set('itemService', itemService);
    app.set('sessionService', sessionService);
    app.set('buffNotifier', buffNotifier);
    app.set('io', io);
    app.use('/api', itemsRouter);
    return app;
}

forEachBackend(({ make, label }) => {
    describe(`POST /api/shop/purchase (${label})`, () => {
        let primitives;
        let services;
        let sessionService;
        let buffNotifier;
        let io;
        let app;
        let originalConsoleLog;
        let originalConsoleError;

        beforeEach(async () => {
            primitives = make();
            await bootstrapMoneyFlowSchema(primitives);
            await seedUserAndItem(primitives);

            // Populate slot the mocked database.js delegates to. AccountService
            // captured the module-level wrappers at require time, so its writes
            // land on our primitives.
            dbSlot.runAsync = primitives.runAsync;
            dbSlot.getAsync = primitives.getAsync;
            dbSlot.allAsync = primitives.allAsync;
            dbSlot.withTransaction = createWithTransaction({
                runAsync: primitives.runAsync,
                getAsync: primitives.getAsync,
                allAsync: primitives.allAsync,
            });

            originalConsoleLog = console.log;
            originalConsoleError = console.error;
            console.log = jest.fn();
            console.error = jest.fn();

            const repoDeps = {
                getAsync: primitives.getAsync,
                runAsync: primitives.runAsync,
                allAsync: primitives.allAsync,
            };
            const userRepository = new UserRepository(repoDeps);
            const shopRepository = new ShopRepository(repoDeps);
            const itemTransactionRepository = new ItemTransactionRepository(repoDeps);
            const userInventoryRepository = new UserInventoryRepository(repoDeps);

            const itemService = buildItemServiceStub(primitives);
            const accountService = new AccountService();
            const inventoryService = new InventoryService(itemService, null, {
                userInventoryRepository,
                itemTransactionRepository,
            });
            const shopService = new ShopService(itemService, inventoryService, accountService, null, {
                userRepository,
                shopRepository,
                itemTransactionRepository,
                withTransaction: dbSlot.withTransaction,
            });
            await shopService.initializeShop();

            sessionService = {
                getSocketsByUserId: jest.fn(() => ['socket-abc']),
            };
            buffNotifier = {
                inventoryUpdated: jest.fn(),
            };
            io = { emit: jest.fn() };

            services = { shopService, inventoryService, itemService, shopRepository, itemTransactionRepository, userInventoryRepository };
            app = buildApp({ shopService, inventoryService, itemService, sessionService, buffNotifier, io });
        });

        afterEach(async () => {
            console.log = originalConsoleLog;
            console.error = originalConsoleError;
            dbSlot.runAsync = null;
            dbSlot.getAsync = null;
            dbSlot.allAsync = null;
            dbSlot.withTransaction = null;
            await primitives.close();
        });

        describe('happy path', () => {
            it('200 OK; debits points, credits inventory, writes audit, decrements stock, emits notifier', async () => {
                const res = await request(app)
                    .post('/api/shop/purchase')
                    .send({ itemId: 7, quantity: 2 });

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    success: true,
                    item: 'Pizza',
                    quantity: 2,
                    totalCost: 200,
                    remainingPoints: 800,
                });

                const balanceRow = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balanceRow.points_balance).toBe(800);

                const invRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
                expect(invRow.quantity).toBe(2);

                const itxRows = await primitives.allAsync(
                    'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
                expect(itxRows).toHaveLength(1);
                expect(itxRows[0]).toMatchObject({
                    transaction_type: 'purchase',
                    quantity: 2,
                    price_per_item: 100,
                    total_cost: 200,
                    points_before: 1000,
                    points_after: 800,
                });

                const ptxRows = await primitives.allAsync(
                    'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
                expect(ptxRows).toHaveLength(1);
                expect(ptxRows[0]).toMatchObject({ amount: -200, balance_after: 800, type: 'purchase' });

                const stockRow = await primitives.getAsync(
                    'SELECT stock_limit FROM shop_items WHERE id = ?', [1]);
                expect(stockRow.stock_limit).toBe(8);

                // Post-commit side effects fired exactly once.
                expect(sessionService.getSocketsByUserId).toHaveBeenCalledWith(42);
                expect(buffNotifier.inventoryUpdated).toHaveBeenCalledTimes(1);
                expect(buffNotifier.inventoryUpdated).toHaveBeenCalledWith({
                    toSocketId: 'socket-abc',
                    action: 'purchase',
                    itemId: 7,
                    quantity: 2,
                });
            });

            it('200 OK with default quantity=1 when body omits it', async () => {
                const res = await request(app)
                    .post('/api/shop/purchase')
                    .send({ itemId: 7 });

                expect(res.status).toBe(200);
                expect(res.body.quantity).toBe(1);
                expect(res.body.totalCost).toBe(100);
                expect(res.body.remainingPoints).toBe(900);
            });
        });

        describe('client-error mapping', () => {
            it('400 when itemId is missing from body', async () => {
                const res = await request(app)
                    .post('/api/shop/purchase')
                    .send({ quantity: 1 });

                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/Item ID required/);
                // No notifier emission for client errors that short-circuit before service call.
                expect(buffNotifier.inventoryUpdated).not.toHaveBeenCalled();
            });

            it('402 Payment Required when user has insufficient points', async () => {
                // Drain the balance below the purchase cost.
                await primitives.runAsync(
                    'UPDATE user_stats SET points_balance = ? WHERE user_id = ?', [50, 42]);

                const res = await request(app)
                    .post('/api/shop/purchase')
                    .send({ itemId: 7, quantity: 1 });

                expect(res.status).toBe(402);
                expect(res.body.error).toMatch(/Insufficient points/);

                // Side effects MUST NOT have fired.
                const invRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
                expect(invRow).toBeUndefined();

                const itxRows = await primitives.allAsync(
                    'SELECT * FROM item_transactions WHERE user_id = ?', [42]);
                expect(itxRows).toEqual([]);

                const balanceRow = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balanceRow.points_balance).toBe(50);

                expect(buffNotifier.inventoryUpdated).not.toHaveBeenCalled();
            });

            it('500 Cannot exceed maximum stack — pre-tx guard surfaces as generic 500 (route does not special-case)', async () => {
                // Seed the user's inventory at the cap. Pre-tx guard rejects.
                await primitives.runAsync(
                    'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)',
                    [42, 7, 5]
                );

                const res = await request(app)
                    .post('/api/shop/purchase')
                    .send({ itemId: 7, quantity: 1 });

                expect(res.status).toBe(500);
                expect(res.body.error).toMatch(/Cannot exceed maximum stack/);

                // Inventory unchanged (still at 5, no extra row), balance unchanged.
                const invRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
                expect(invRow.quantity).toBe(5);

                const balanceRow = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balanceRow.points_balance).toBe(1000);

                expect(buffNotifier.inventoryUpdated).not.toHaveBeenCalled();
            });
        });

        describe('server-error mapping (intra-tx failure)', () => {
            it('500 + complete rollback when the audit-write step throws mid-tx', async () => {
                // Force the LAST tx-body step (insertPurchase) to throw. Points,
                // inventory, and stock must all roll back. The notifier must NOT
                // fire — emission only happens after a successful purchase
                // resolves through ShopService.
                const original = services.itemTransactionRepository.insertPurchase
                    .bind(services.itemTransactionRepository);
                services.itemTransactionRepository.insertPurchase = jest.fn(async () => {
                    throw new Error('simulated audit-write failure');
                });

                const res = await request(app)
                    .post('/api/shop/purchase')
                    .send({ itemId: 7, quantity: 1 });

                expect(res.status).toBe(500);
                expect(res.body.error).toMatch(/simulated audit-write failure/);

                const balanceRow = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balanceRow.points_balance).toBe(1000);

                const invRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
                expect(invRow).toBeUndefined();

                const ptxRows = await primitives.allAsync(
                    'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
                expect(ptxRows).toEqual([]);

                const stockRow = await primitives.getAsync(
                    'SELECT stock_limit FROM shop_items WHERE id = ?', [1]);
                expect(stockRow.stock_limit).toBe(10);

                expect(buffNotifier.inventoryUpdated).not.toHaveBeenCalled();

                services.itemTransactionRepository.insertPurchase = original;
            });
        });
    });
});
