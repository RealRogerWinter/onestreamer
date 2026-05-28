/**
 * PR 16.3 — gift-flow integration test through the /api/internal/* route layer.
 *
 * Companion to routes.internal.points.integration.test.js. That file covers
 * the AccountService money-flow paths; this file covers the gift surface:
 *
 *   POST /api/internal/gift-item            — inventory transfer + audit row
 *   GET  /api/internal/giftable-items/:id   — filter to is_tradeable rows
 *
 * Why this exists: PR 16.3 extracted both handlers' bodies into new
 * InventoryService methods. The reviewer subagent on PR 16.3 found a
 * behaviour-change risk in the new code's *ordering* of validation checks —
 * specifically that a self-gift with a bogus item name should still return
 * `400 Cannot gift items to yourself` (pre-PR observable order), not
 * `404 Item 'X' not found`. The unit tests cover the service in isolation
 * but cannot pin the route-level ordering. This file does.
 *
 * Database isolation uses the same slot-pattern mock as the money-flow tests:
 * the module-level runAsync/getAsync (captured at require time by both
 * AccountService and the late-required database in InventoryService.giftItem)
 * delegate to per-test in-memory primitives.
 */

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

// AuthService.verifyToken: token === "user:<id>" returns { id, userId: id, username: token }.
jest.mock('../../services/AuthService', () => {
    return class AuthServiceStub {
        verifyToken(token) {
            const m = /^user:(\d+)$/.exec(token);
            if (!m) return null;
            const id = parseInt(m[1], 10);
            return { id, userId: id, username: `user${id}` };
        }
    };
});

const express = require('express');
const request = require('supertest');

const { createWithTransaction } = require('../../database/transaction');
const {
    forEachBackend,
    bootstrapMoneyFlowSchema,
} = require('./_helpers/db-fixture');

const internalRouter = require('../../routes/internal');

function buildApp() {
    const app = express();
    app.use(express.json());
    // The /gift-item and /giftable-items handlers BOTH construct services
    // inline (new AccountService(), new ItemService(), new InventoryService(...))
    // when req.app.locals.services is unset — that fallback path is the
    // simplest setup for this integration test. The services themselves
    // hit the dbSlot mock; behaviour through Express is identical to the
    // production path.
    app.use('/api/internal', internalRouter);
    return app;
}

async function seedGiftFixture(primitives) {
    // Two users: 42 (sender), 99 (recipient). No starting balances needed
    // (gifts are inventory-only, not points). One item, marked tradeable.
    await primitives.runAsync(
        'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
        [42, 's@e.com', 'sender']
    );
    await primitives.runAsync(
        'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
        [99, 'r@e.com', 'recipient']
    );
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, emoji, description, item_type, rarity, is_tradeable, max_stack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [7, 'rose', 'Rose', '🌹', 'A red rose', 'utility', 'common', 1, 0]
    );
    await primitives.runAsync(
        `INSERT INTO items (id, name, display_name, emoji, description, item_type, rarity, is_tradeable, max_stack)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [8, 'crown', 'Crown of Streamerly', '👑', 'A soulbound crown', 'utility', 'legendary', 0, 0]
    );
    await primitives.runAsync(
        'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)',
        [42, 7, 5]
    );
    await primitives.runAsync(
        'INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (?, ?, ?)',
        [42, 8, 1]
    );
}

forEachBackend(({ make, label }) => {
    describe(`/api/internal gift routes (${label})`, () => {
        let primitives;
        let app;
        let originalConsoleLog;
        let originalConsoleError;

        beforeEach(async () => {
            primitives = make();
            await bootstrapMoneyFlowSchema(primitives);
            await seedGiftFixture(primitives);

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

            app = buildApp();
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

        describe('POST /gift-item', () => {
            it('200; debits sender inventory, credits recipient, writes audit row, returns expected body shape', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'rose', quantity: 2 });

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    success: true,
                    item: { id: 7, name: 'Rose', emoji: '🌹' },
                    quantity: 2,
                    from: 'sender',
                    to: 'recipient',
                });

                // Sender inventory: 5 → 3
                const senderRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
                expect(senderRow.quantity).toBe(3);

                // Recipient inventory: new row, quantity 2
                const recipientRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [99, 7]);
                expect(recipientRow.quantity).toBe(2);

                // Audit row
                const auditRows = await primitives.allAsync('SELECT * FROM gift_transactions');
                expect(auditRows).toHaveLength(1);
                expect(auditRows[0]).toMatchObject({
                    from_user_id: 42,
                    to_user_id: 99,
                    item_id: 7,
                    quantity: 2,
                });
            });

            it('case-insensitive item-name lookup matches both `name` and `display_name`', async () => {
                // Match by display_name (`Rose`) — pre-PR handler used
                // case-insensitive .toLowerCase() compare across name OR display_name.
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'ROSE', quantity: 1 });

                expect(res.status).toBe(200);
                expect(res.body.item.id).toBe(7);
            });

            it('400 when required params are missing', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'recipient' }); // no itemName

                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/Missing required parameters/);
            });

            it('401 when Authorization header is missing', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'rose' });

                expect(res.status).toBe(401);
                expect(res.body.error).toMatch(/Unauthorized/);
            });

            it('401 when Bearer token does not match fromUserId', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:99')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'rose' });

                expect(res.status).toBe(401);
                expect(res.body.error).toMatch(/Invalid credentials/);
            });

            it('404 when recipient username does not exist', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'nobody', itemName: 'rose' });

                expect(res.status).toBe(404);
                expect(res.body.error).toBe("User 'nobody' not found");
            });

            // PR 16.3 reviewer subagent BLOCKER 1 — observable ordering check.
            // Pre-PR: username 404 → self-gift 400 → item 404 → not-tradeable
            // 400 → insufficient 400. A `!gift sender bogus-item` (self + bad
            // name) must return 400 self-gift, NOT 404 item. The fix runs the
            // self-gift check in the route between username resolution and
            // item resolution; this test pins that ordering.
            it('400 self-gift FIRES BEFORE 404 item-not-found (PR 16.3 reviewer blocker)', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'sender', itemName: 'bogus-name-that-does-not-exist' });

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('Cannot gift items to yourself');
            });

            it('400 when sender gifts to themselves (valid item)', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'sender', itemName: 'rose' });

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('Cannot gift items to yourself');

                // No mutation.
                const auditRows = await primitives.allAsync('SELECT * FROM gift_transactions');
                expect(auditRows).toEqual([]);
            });

            it('404 when itemName does not resolve (no fold-through to a different status)', async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'nonexistent' });

                expect(res.status).toBe(404);
                expect(res.body.error).toBe("Item 'nonexistent' not found");
            });

            it("400 with display_name in the message when item is not is_tradeable", async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'crown' });

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('Crown of Streamerly cannot be gifted');

                const auditRows = await primitives.allAsync('SELECT * FROM gift_transactions');
                expect(auditRows).toEqual([]);
            });

            it("400 with detailed have/need message when sender doesn't have enough", async () => {
                const res = await request(app)
                    .post('/api/internal/gift-item')
                    .set('Authorization', 'Bearer user:42')
                    .send({ fromUserId: 42, toUsername: 'recipient', itemName: 'rose', quantity: 10 });

                expect(res.status).toBe(400);
                expect(res.body.error).toBe("You don't have enough Rose to gift (have: 5, need: 10)");

                // No mutation.
                const senderRow = await primitives.getAsync(
                    'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_id = ?', [42, 7]);
                expect(senderRow.quantity).toBe(5);
                const auditRows = await primitives.allAsync('SELECT * FROM gift_transactions');
                expect(auditRows).toEqual([]);
            });
        });

        describe('GET /giftable-items/:userId', () => {
            it('200; returns only is_tradeable rows with quantity > 0', async () => {
                const res = await request(app)
                    .get('/api/internal/giftable-items/42')
                    .set('Authorization', 'Bearer user:42');

                expect(res.status).toBe(200);
                expect(res.body.success).toBe(true);
                // Only Rose (tradeable, qty=5) — Crown (soulbound) excluded.
                expect(res.body.items).toHaveLength(1);
                expect(res.body.items[0]).toMatchObject({
                    id: 7,
                    name: 'rose',
                    display_name: 'Rose',
                    emoji: '🌹',
                    quantity: 5,
                    rarity: 'common',
                });
            });

            it('401 when token does not match path userId', async () => {
                const res = await request(app)
                    .get('/api/internal/giftable-items/42')
                    .set('Authorization', 'Bearer user:99');

                expect(res.status).toBe(401);
                expect(res.body.error).toMatch(/Invalid credentials/);
            });

            it('returns an empty list when user has no giftable inventory', async () => {
                const res = await request(app)
                    .get('/api/internal/giftable-items/99')
                    .set('Authorization', 'Bearer user:99');

                expect(res.status).toBe(200);
                expect(res.body.items).toEqual([]);
            });
        });
    });
});
