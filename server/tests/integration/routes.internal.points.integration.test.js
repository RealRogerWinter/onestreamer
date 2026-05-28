/**
 * PR 13.1 — money-flow integration test through the /api/internal/* route layer.
 *
 * Companion to routes.shop.purchase.integration.test.js. That file covers the
 * ShopService side of the money flow; this file covers the AccountService
 * end-to-end paths exposed by server/routes/internal.js:
 *
 *   POST /api/internal/award-points        — addPoints (claim events)
 *   POST /api/internal/transfer-points     — subtractPoints + addPoints (peer gift)
 *   POST /api/internal/admin/award-points  — addPoints with is_admin guard
 *
 * Both successful and failure HTTP shapes are asserted: the addPoints/subtractPoints
 * atomic SQL guarantee proven by AccountService.points-race.test.js must
 * surface through the route layer with the right status codes, audit row
 * count, and balance arithmetic.
 *
 * The internal.js routes verify Bearer tokens via authService.verifyToken
 * inside each handler — there is no middleware to bypass. We mock AuthService
 * with a stub whose verifyToken returns whatever id the test passed in the
 * Bearer header (so the handler's id-vs-decoded.id equality check passes).
 *
 * Database isolation uses the same slot-pattern mock as the shop test:
 * AccountService's module-level runAsync/getAsync (captured at require time)
 * delegate to in-memory primitives populated per-test. See
 * routes.shop.purchase.integration.test.js for the rationale.
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
// Any other token returns null (handler responds 401).
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
    seedUserAndItem,
} = require('./_helpers/db-fixture');

const internalRouter = require('../../routes/internal');

// PR 16.2: /transfer-points now dispatches to
// req.app.locals.services.gameMechanicsService instead of constructing
// `new AccountService()` inline. Other internal routes (/award-points,
// /admin/award-points) still construct AccountService inside the handler
// in PR 16.2's diff — that scope is PR 16.4. Wire just enough services bag
// for the routes-under-test to resolve their dependencies.
const AccountServiceForTest = require('../../services/AccountService');
const GameMechanicsService = require('../../services/GameMechanicsService');

function buildApp() {
    const app = express();
    app.use(express.json());
    const accountService = new AccountServiceForTest();
    const userBonusCooldowns = new Map();
    app.locals.services = {
        gameMechanicsService: new GameMechanicsService({
            accountService,
            userBonusCooldowns,
        }),
    };
    app.locals.userBonusCooldowns = userBonusCooldowns;
    app.use('/api/internal', internalRouter);
    return app;
}

forEachBackend(({ make, label }) => {
    describe(`/api/internal money-flow routes (${label})`, () => {
        let primitives;
        let app;
        let originalConsoleLog;
        let originalConsoleError;

        beforeEach(async () => {
            primitives = make();
            await bootstrapMoneyFlowSchema(primitives);

            // Two users: sender (id=42, 1000 pts) and recipient (id=99, 0 pts).
            // seedUserAndItem covers the first; add the second by hand.
            await seedUserAndItem(primitives, { userId: 42, username: 'sender', email: 's@e.com', balance: 1000 });
            await primitives.runAsync(
                'INSERT INTO users (id, email, username) VALUES (?, ?, ?)',
                [99, 'recipient@e.com', 'recipient']
            );
            await primitives.runAsync(
                'INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)',
                [99, 0]
            );

            // Admin user id=1 for the /admin/award-points test.
            await primitives.runAsync(
                'INSERT INTO users (id, email, username, is_admin) VALUES (?, ?, ?, ?)',
                [1, 'admin@e.com', 'theadmin', 1]
            );
            await primitives.runAsync(
                'INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)',
                [1, 0]
            );

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

        describe('POST /award-points (addPoints path)', () => {
            it('200; credits balance and writes one audit row', async () => {
                const res = await request(app)
                    .post('/api/internal/award-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({ userId: 42, amount: 250, reason: 'Daily login bonus' });

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    success: true,
                    newBalance: 1250,
                    awarded: 250,
                });

                const balance = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balance.points_balance).toBe(1250);

                const audit = await primitives.allAsync(
                    'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
                expect(audit).toHaveLength(1);
                expect(audit[0]).toMatchObject({
                    amount: 250,
                    balance_after: 1250,
                    type: 'award',
                });
            });

            it('400 when required params are missing', async () => {
                const res = await request(app)
                    .post('/api/internal/award-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({ userId: 42 }); // no amount

                expect(res.status).toBe(400);
                expect(res.body.success).toBe(false);

                // No mutation occurred.
                const balance = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balance.points_balance).toBe(1000);
            });

            it('401 when Authorization header is missing', async () => {
                const res = await request(app)
                    .post('/api/internal/award-points')
                    .send({ userId: 42, amount: 250 });

                expect(res.status).toBe(401);
                expect(res.body.error).toMatch(/Unauthorized/);
            });

            it('401 when Bearer token does not match the userId in the body', async () => {
                const res = await request(app)
                    .post('/api/internal/award-points')
                    .set('Authorization', 'Bearer user:99')
                    .send({ userId: 42, amount: 250 });

                expect(res.status).toBe(401);
                expect(res.body.error).toMatch(/Invalid credentials/);

                const balance = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balance.points_balance).toBe(1000);
            });
        });

        describe('POST /transfer-points (subtractPoints + addPoints pair)', () => {
            it('200; debits sender, credits recipient, writes two audit rows (one each)', async () => {
                const res = await request(app)
                    .post('/api/internal/transfer-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({
                        fromUserId: 42,
                        toUsername: 'recipient',
                        amount: 300,
                        senderUsername: 'sender',
                    });

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    success: true,
                    senderNewBalance: 700,
                    recipientNewBalance: 300,
                    recipientUserId: 99,
                    recipientUsername: 'recipient',
                });

                const senderBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(senderBal.points_balance).toBe(700);

                const recBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [99]);
                expect(recBal.points_balance).toBe(300);

                const senderTx = await primitives.allAsync(
                    'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
                expect(senderTx).toHaveLength(1);
                expect(senderTx[0]).toMatchObject({ amount: -300, balance_after: 700, type: 'transfer_out' });

                const recTx = await primitives.allAsync(
                    'SELECT * FROM points_transactions WHERE user_id = ?', [99]);
                expect(recTx).toHaveLength(1);
                expect(recTx[0]).toMatchObject({ amount: 300, balance_after: 300, type: 'transfer_in' });
            });

            it('400 when sender has insufficient points (pre-check rejects before any mutation)', async () => {
                const res = await request(app)
                    .post('/api/internal/transfer-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({
                        fromUserId: 42,
                        toUsername: 'recipient',
                        amount: 5000, // > 1000 balance
                    });

                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/Insufficient points/);

                // Neither balance moved; no audit rows on either side.
                const senderBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(senderBal.points_balance).toBe(1000);

                const recBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [99]);
                expect(recBal.points_balance).toBe(0);

                const ptxRows = await primitives.allAsync('SELECT * FROM points_transactions');
                expect(ptxRows).toEqual([]);
            });

            it('400 when sender tries to transfer to themselves', async () => {
                const res = await request(app)
                    .post('/api/internal/transfer-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({
                        fromUserId: 42,
                        toUsername: 'sender', // same as sender username
                        amount: 100,
                    });

                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/Cannot send points to yourself/);

                const senderBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(senderBal.points_balance).toBe(1000);
            });

            it('404 when the recipient username is unknown', async () => {
                const res = await request(app)
                    .post('/api/internal/transfer-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({
                        fromUserId: 42,
                        toUsername: 'does-not-exist',
                        amount: 100,
                    });

                expect(res.status).toBe(404);
                expect(res.body.error).toMatch(/not found/);

                const senderBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(senderBal.points_balance).toBe(1000);
            });
        });

        describe('POST /admin/award-points (is_admin guard)', () => {
            it('200 when caller is_admin=1', async () => {
                const res = await request(app)
                    .post('/api/internal/admin/award-points')
                    .set('Authorization', 'Bearer user:1')
                    .send({ targetUsername: 'sender', amount: 500, adminUserId: 1 });

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    success: true,
                    newBalance: 1500,
                    targetUserId: 42,
                    targetUsername: 'sender',
                });

                const balance = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [42]);
                expect(balance.points_balance).toBe(1500);

                const audit = await primitives.allAsync(
                    'SELECT * FROM points_transactions WHERE user_id = ?', [42]);
                expect(audit).toHaveLength(1);
                expect(audit[0]).toMatchObject({ amount: 500, type: 'admin_award' });
            });

            it('403 when caller is_admin=0 (regular user attempting an admin grant)', async () => {
                const res = await request(app)
                    .post('/api/internal/admin/award-points')
                    .set('Authorization', 'Bearer user:42')
                    .send({ targetUsername: 'recipient', amount: 500, adminUserId: 42 });

                expect(res.status).toBe(403);
                expect(res.body.error).toMatch(/Admin access required/);

                // No mutation occurred to either user.
                const recBal = await primitives.getAsync(
                    'SELECT points_balance FROM user_stats WHERE user_id = ?', [99]);
                expect(recBal.points_balance).toBe(0);
            });
        });
    });
});
