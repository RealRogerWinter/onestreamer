/**
 * DB4-remainder (audit Plan 04): database.js exports a `ready` promise that
 * resolves once the async self-boot (connection open + PRAGMAs +
 * initializeSchema, incl. numbered migrations) has completed.
 *
 * server/index.js's startServer() awaits it before any service work, so a
 * fresh clone / DR restore can no longer race services against the DDL.
 *
 * Harness: same sqlite3.Database monkey-patch as fresh-boot-schema.test.js —
 * database.js self-boots on require against its hardcoded data-file path, so
 * redirect it to :memory: for this suite. USE_BETTER_SQLITE3=false is pinned
 * by config/jest/jest.setup.js, so no second (better-sqlite3) handle opens
 * against the real file either.
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();

const originalSqliteDatabase = sqlite3.Database;
function PatchedDatabase(_filename, ...rest) {
    return new originalSqliteDatabase(':memory:', ...rest);
}
PatchedDatabase.prototype = originalSqliteDatabase.prototype;
sqlite3.Database = PatchedDatabase;
let database;
try {
    database = require('../../database/database');
} finally {
    sqlite3.Database = originalSqliteDatabase;
}

describe('database.ready (DB4-remainder)', () => {
    it('is exported as a promise', () => {
        expect(database.ready).toBeDefined();
        expect(typeof database.ready.then).toBe('function');
    });

    it('resolves after schema init; wrapper queries then see the bootstrapped tables', async () => {
        await database.ready;

        // Spot-check load-bearing tables the boot DDL creates across
        // domains (economy, clips, users).
        for (const table of ['users', 'user_stats', 'points_transactions', 'clips']) {
            const row = await database.getAsync(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                [table]
            );
            expect(row && row.name).toBe(table);
        }

        // And an actual query through the gated wrappers works.
        const clips = await database.getAsync('SELECT COUNT(*) AS n FROM clips');
        expect(clips.n).toBe(0);
    });
});
