/**
 * Integration test: PR 5.1's atomic addPoints/subtractPoints SQL against
 * the real better-sqlite3 adapter (no mock).
 *
 * The race test at server/tests/services/AccountService.points-race.test.js
 * mocks `database/database` with an in-JS map, so it proves the *AccountService
 * code shape* is atomic but not that the underlying engine actually serializes
 * the UPDATE...RETURNING statement properly. This file runs the same SQL
 * straight through better-sqlite3 — closing the loop on ADR-0014's claim
 * that the adapter preserves ADR-0013's atomicity guarantee.
 *
 * If this test ever fails, EITHER the adapter is broken OR better-sqlite3
 * itself has stopped honoring per-statement atomicity. Both warrant pulling
 * the env-flag default OFF and investigating before any rollout.
 */

const {
    makeBetterPrimitives,
    bootstrapProductionSchema,
} = require('../integration/_helpers/db-fixture');

describe('better-sqlite3 adapter — atomic points-race SQL (PR 5.1 + ADR-0014)', () => {
    let adapter;

    beforeEach(async () => {
        // Boot the REAL schema (database.js initializeSchema) against
        // :memory: instead of a hand-copied user_stats — ADR-0030. This is
        // also a regression net for audit finding DB1: the SQL below only
        // works because the prod boot path now provisions points_balance.
        adapter = makeBetterPrimitives();
        await bootstrapProductionSchema(adapter);
    });

    afterEach(async () => {
        await adapter.close();
    });

    // Prod schema enforces the user_stats→users FK (the adapter runs with
    // foreign_keys=ON), so each test seeds its parent users row first.
    function seedUser(userId, balance) {
        adapter.db
            .prepare('INSERT INTO users (id, email, username) VALUES (?, ?, ?)')
            .run(userId, `race-${userId}@example.com`, `race-user-${userId}`);
        adapter.db
            .prepare('INSERT INTO user_stats (user_id, points_balance) VALUES (?, ?)')
            .run(userId, balance);
    }

    test('20 concurrent addPoints-shape UPDATEs land the exact arithmetic answer', async () => {
        const userId = 42;
        seedUser(userId, 0);

        const N = 20;
        const amount = 5;

        await Promise.all(
            Array.from({ length: N }, () =>
                adapter.getAsync(
                    `UPDATE user_stats
                        SET points_balance = points_balance + ?,
                            updated_at = CURRENT_TIMESTAMP
                      WHERE user_id = ?
                  RETURNING points_balance`,
                    [amount, userId]
                )
            )
        );

        const finalRow = adapter.db.prepare('SELECT points_balance FROM user_stats WHERE user_id = ?').get(userId);
        expect(finalRow.points_balance).toBe(N * amount); // 100, exactly
    });

    test('20 concurrent subtractPoints-shape guarded UPDATEs land the exact arithmetic answer', async () => {
        const userId = 99;
        const seed = 10_000;
        seedUser(userId, seed);

        const N = 20;
        const amount = 5;

        await Promise.all(
            Array.from({ length: N }, () =>
                adapter.getAsync(
                    `UPDATE user_stats
                        SET points_balance = points_balance - ?,
                            updated_at = CURRENT_TIMESTAMP
                      WHERE user_id = ?
                        AND points_balance >= ?
                  RETURNING points_balance`,
                    [amount, userId, amount]
                )
            )
        );

        const finalRow = adapter.db.prepare('SELECT points_balance FROM user_stats WHERE user_id = ?').get(userId);
        expect(finalRow.points_balance).toBe(seed - N * amount); // 9900, exactly
    });

    test('guarded subtract refuses to go below the floor under concurrent contention', async () => {
        const userId = 7;
        const seed = 30; // Only enough for 6 debits at amount=5
        seedUser(userId, seed);

        const N = 20;
        const amount = 5;

        const results = await Promise.all(
            Array.from({ length: N }, () =>
                adapter.getAsync(
                    `UPDATE user_stats
                        SET points_balance = points_balance - ?
                      WHERE user_id = ?
                        AND points_balance >= ?
                  RETURNING points_balance`,
                    [amount, userId, amount]
                )
            )
        );

        const successes = results.filter((r) => r !== undefined);
        // Exactly 6 debits succeed (30/5 = 6); the other 14 hit the floor and resolve undefined.
        expect(successes).toHaveLength(seed / amount);
        const finalRow = adapter.db.prepare('SELECT points_balance FROM user_stats WHERE user_id = ?').get(userId);
        expect(finalRow.points_balance).toBe(0); // Drained exactly to zero, never below.
    });
});
