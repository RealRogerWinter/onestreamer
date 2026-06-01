/**
 * Tests for the PR 14.1 schema migration runner (ADR-0022).
 *
 * Three guarantees this file pins:
 *
 *   1. **Bit-identical fixture**: the committed
 *      `server/tests/fixtures/schema-snapshot-pre-pr-14-1.json` is a snapshot
 *      of `PRAGMA table_info` for every user table produced by the pre-PR-14.1
 *      bootstrap (CREATE TABLE + inline ALTERs). The post-PR bootstrap (which
 *      this PR introduces — CREATE TABLE + migration runner) must reproduce
 *      that exact snapshot. We assert it by booting an in-memory copy of the
 *      live `database.js` and diffing.
 *
 *   2. **Legacy-DB scenario**: when migrations run against an older DB shape
 *      whose tables PREDATE the columns being added, the runner backfills
 *      every column with the expected type/default. This is the path that
 *      actually moves real customer DBs forward.
 *
 *   3. **Idempotency**: running every migration a second time is a no-op.
 *      This is the per-boot guarantee — no `schema_migrations` tracking
 *      table means each migration runs every cold start.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const migrationRunner = require('../../migrations/_runner');

const FIXTURE_PATH = path.join(
    __dirname,
    '..',
    'fixtures',
    'schema-snapshot-pre-pr-14-1.json'
);

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function snapshotSchema(db) {
    const tables = await allAsync(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const out = {};
    for (const { name } of tables) {
        const cols = await allAsync(db, `PRAGMA table_info(${name})`);
        out[name] = cols
            .map((c) => ({
                name: c.name,
                type: c.type,
                notnull: c.notnull,
                dflt_value: c.dflt_value,
                pk: c.pk,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k];
    return sorted;
}

// Quiet logger that records errors so the tests can assert.
function makeLogger() {
    const calls = { error: [], debug: [] };
    return {
        error: (...args) => calls.error.push(args),
        debug: (...args) => calls.debug.push(args),
        _calls: calls,
    };
}

describe('migration runner — filename discovery', () => {
    it('lists only files matching 2026MMDDHHMM-<desc>.js, in lexicographic order', () => {
        const files = migrationRunner.listMigrationFiles();
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            expect(f).toMatch(migrationRunner.MIGRATION_FILENAME_RE);
        }
        const sorted = [...files].sort();
        expect(files).toEqual(sorted);
    });

    it('does NOT pick up legacy ad-hoc migration scripts', () => {
        const files = migrationRunner.listMigrationFiles();
        // Names from the pre-Phase-14 inventory that must stay legacy. The
        // first group still lives in server/migrations/ (one-off data
        // backfills / schema appliers, run manually). The second group was the
        // set of load-bearing table creators promoted into database.js in the
        // C1 schema reconciliation and DELETED — the runner must never have
        // matched them either (they lack the 2026MMDDHHMM- prefix).
        const legacy = [
            'add_ai_moderation_tables.js',
            'migrate-points-system.js',
            'setup-recording-tables.js',
            // Promoted into database.js + deleted (C1):
            'add_streamer_connections.js',
            'add_streaming_logs.js',
            'add_bug_reports.js',
            'create_streambot_messages.sql',
            'create_chatbots_table.sql',
        ];
        for (const name of legacy) {
            expect(files).not.toContain(name);
        }
    });
});

describe('migration runner — legacy-DB backfill', () => {
    let db;
    let logger;

    beforeEach(async () => {
        db = new sqlite3.Database(':memory:');
        logger = makeLogger();

        // Pre-Phase-14 schema shape: tables exist but WITHOUT the columns the
        // migrations are supposed to add. This mirrors a DB created by an old
        // deployment that has since been brought forward.
        await runAsync(db, `
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT,
                username TEXT,
                is_verified BOOLEAN DEFAULT 0
            )
        `);
        await runAsync(db, `
            CREATE TABLE user_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                points INTEGER DEFAULT 0
            )
        `);
        await runAsync(db, `
            CREATE TABLE items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT
            )
        `);
        await runAsync(db, `
            CREATE TABLE chatbot_message_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER NOT NULL,
                message TEXT NOT NULL
            )
        `);
        await runAsync(db, `
            CREATE TABLE chatbot_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                global_prompt TEXT
            )
        `);
        await runAsync(db, `
            CREATE TABLE chatbots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                prompt TEXT NOT NULL
            )
        `);
        await runAsync(db, `
            CREATE TABLE recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT UNIQUE NOT NULL
            )
        `);
        await runAsync(db, `
            CREATE TABLE recording_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_id TEXT NOT NULL
            )
        `);
    });

    afterEach((done) => {
        db.close(done);
    });

    it('backfills every column the inline ALTERs used to add', async () => {
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.runAll(db, logger);
            db.run('SELECT 1', resolve); // flush serialize queue
        }));

        expect(logger._calls.error).toEqual([]);

        const expected = {
            users: ['is_admin', 'is_banned', 'is_moderator', 'vision_audit_optout'],
            user_stats: ['chat_color'],
            items: ['duration_seconds', 'effect_data', 'stack_behavior'],
            chatbot_message_history: ['exact_prompt', 'message_type', 'content', 'metadata'],
            chatbot_config: ['llm_model'],
            chatbots: ['use_assigned_name', 'llm_model', 'moviebot_enabled', 'vision_bot_enabled'],
            recordings: ['session_id', 'user_id'],
            recording_events: ['user_id'],
        };

        for (const [table, columns] of Object.entries(expected)) {
            const rows = await allAsync(db, `PRAGMA table_info(${table})`);
            const names = rows.map((r) => r.name);
            for (const col of columns) {
                expect({ table, names }).toEqual(expect.objectContaining({
                    table,
                    names: expect.arrayContaining([col]),
                }));
            }
        }
    });

    it('drops the legacy user_stats.points column', async () => {
        // Pre-condition: legacy table includes `points`.
        const beforeCols = (await allAsync(db, 'PRAGMA table_info(user_stats)')).map((r) => r.name);
        expect(beforeCols).toContain('points');

        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.runAll(db, logger);
            db.run('SELECT 1', resolve);
        }));

        const afterCols = (await allAsync(db, 'PRAGMA table_info(user_stats)')).map((r) => r.name);
        expect(afterCols).not.toContain('points');
        expect(logger._calls.error).toEqual([]);
    });

    it('preserves expected types and defaults on added columns', async () => {
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.runAll(db, logger);
            db.run('SELECT 1', resolve);
        }));

        // Spot-check a few columns where the DEFAULT shape matters.
        const userCols = await allAsync(db, 'PRAGMA table_info(users)');
        const isAdmin = userCols.find((c) => c.name === 'is_admin');
        expect(isAdmin).toMatchObject({ type: 'BOOLEAN', dflt_value: '0' });

        const stackBehavior = (await allAsync(db, 'PRAGMA table_info(items)'))
            .find((c) => c.name === 'stack_behavior');
        expect(stackBehavior).toMatchObject({ type: 'TEXT', dflt_value: "'replace'" });

        const messageType = (await allAsync(db, 'PRAGMA table_info(chatbot_message_history)'))
            .find((c) => c.name === 'message_type');
        expect(messageType).toMatchObject({ type: 'TEXT', dflt_value: "'chat'" });

        const llmModel = (await allAsync(db, 'PRAGMA table_info(chatbot_config)'))
            .find((c) => c.name === 'llm_model');
        expect(llmModel).toMatchObject({ type: 'TEXT', dflt_value: "'mistral'" });
    });
});

describe('migration runner — idempotency on fresh DB', () => {
    let db;
    let logger;

    beforeEach(async () => {
        db = new sqlite3.Database(':memory:');
        logger = makeLogger();

        // Fresh-DB shape: bootstrap-style CREATE TABLEs that ALREADY include
        // the columns the migrations would add. This is what `npm start`
        // against an empty DB produces.
        await runAsync(db, `
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                is_admin BOOLEAN DEFAULT 0,
                is_banned BOOLEAN DEFAULT 0,
                is_moderator BOOLEAN DEFAULT 0,
                vision_audit_optout BOOLEAN DEFAULT 0
            )
        `);
        await runAsync(db, `
            CREATE TABLE user_stats (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                chat_color TEXT DEFAULT NULL
            )
        `);
        await runAsync(db, `
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                duration_seconds INTEGER DEFAULT 0,
                effect_data TEXT,
                stack_behavior TEXT DEFAULT 'replace'
            )
        `);
        await runAsync(db, `
            CREATE TABLE chatbot_message_history (
                id INTEGER PRIMARY KEY,
                chatbot_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                exact_prompt TEXT,
                message_type TEXT DEFAULT 'chat',
                content TEXT,
                metadata TEXT
            )
        `);
        await runAsync(db, `
            CREATE TABLE chatbot_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                llm_model TEXT DEFAULT 'mistral'
            )
        `);
        await runAsync(db, `
            CREATE TABLE chatbots (
                id INTEGER PRIMARY KEY,
                use_assigned_name BOOLEAN DEFAULT 1,
                llm_model TEXT,
                moviebot_enabled BOOLEAN DEFAULT 0,
                vision_bot_enabled BOOLEAN DEFAULT 0
            )
        `);
        await runAsync(db, `
            CREATE TABLE recordings (
                id INTEGER PRIMARY KEY,
                session_id TEXT,
                user_id INTEGER
            )
        `);
        await runAsync(db, `
            CREATE TABLE recording_events (
                id INTEGER PRIMARY KEY,
                user_id INTEGER
            )
        `);
    });

    afterEach((done) => {
        db.close(done);
    });

    it('logs zero errors on a fresh DB (every ALTER is duplicate-column)', async () => {
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.runAll(db, logger);
            db.run('SELECT 1', resolve);
        }));
        expect(logger._calls.error).toEqual([]);
    });

    it('is safe to run twice (per-boot idempotency)', async () => {
        const before = await snapshotSchema(db);

        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.runAll(db, logger);
            migrationRunner.runAll(db, logger);
            db.run('SELECT 1', resolve);
        }));

        const after = await snapshotSchema(db);
        expect(after).toEqual(before);
        expect(logger._calls.error).toEqual([]);
    });
});

describe('migration runner — bit-identical bootstrap', () => {
    // The committed fixture is a snapshot of the `database.js` bootstrap
    // (CREATE TABLE + inline ALTERs) producing 38 tables. The post-PR
    // bootstrap (CREATE TABLE + migration runner) must produce the same
    // PRAGMA shape. (The fixture was re-baselined when the dead viewbot_*
    // tables were dropped from the bootstrap — see the viewbot removal — and
    // again in the C1 schema reconciliation, which promoted 5 load-bearing
    // tables into the bootstrap: bug_reports, streambot_messages,
    // streambot_settings, streamer_connections, streaming_logs.)
    //
    // Strategy: boot database.js against an in-memory DB by monkey-patching
    // sqlite3.Database before requiring the module, wait for the bootstrap
    // setTimeout (recording indexes @1000ms) to settle, snapshot, diff
    // against fixture.

    let originalSqliteDatabase;
    let snapshot;

    beforeAll(async () => {
        // Force a fresh require so the monkey-patch is effective.
        jest.resetModules();
        originalSqliteDatabase = sqlite3.Database;
        function PatchedDatabase(_filename, ...rest) {
            return new originalSqliteDatabase(':memory:', ...rest);
        }
        PatchedDatabase.prototype = originalSqliteDatabase.prototype;
        sqlite3.Database = PatchedDatabase;

        // Loading database.js triggers the bootstrap.
        const { db } = require('../../database/database');

        // The bootstrap queues a setTimeout for the recording indexes at
        // 1000 ms (which require columns added by the migration runner).
        // Wait long enough for it to settle.
        await new Promise((r) => setTimeout(r, 2500));

        snapshot = await snapshotSchema(db);
    }, 10_000);

    afterAll(() => {
        sqlite3.Database = originalSqliteDatabase;
    });

    it('produces a schema bit-identical to the pre-PR-14.1 fixture', () => {
        const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
        expect(snapshot).toEqual(fixture);
    });
});
