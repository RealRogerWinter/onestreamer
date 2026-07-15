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
        // backfills / schema appliers, run manually). The second group was
        // DELETED — promoted into database.js in the C1 schema reconciliation
        // or in the DB1/DB3 fresh-boot fix (setup-recording/clips/
        // transcription-tables.js) — and the runner must never have matched
        // them either (they lack the 2026MMDDHHMM- prefix).
        const legacy = [
            'add_ai_moderation_tables.js',
            'migrate-points-system.js',
            // Promoted into database.js + deleted (C1 / DB1+DB3):
            'setup-recording-tables.js',
            'setup-clips-tables.js',
            'setup-transcription-tables.js',
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
            users: [
                'is_admin', 'is_banned', 'is_moderator', 'vision_audit_optout',
                // 202607140011 — profile + deletion-lifecycle backfill (DB1)
                'username_changed', 'deletion_requested_at', 'deletion_confirmed_at',
                'deletion_scheduled_for', 'deletion_token', 'deletion_token_expires',
                'account_status', 'bio', 'website', 'location', 'display_name',
                'avatar_url', 'description',
            ],
            // 202607140010 — points economy backfill (DB1)
            user_stats: ['chat_color', 'points_balance'],
            // 202607140012 — category (live parity) + is_tradeable (gifting gate)
            items: ['duration_seconds', 'effect_data', 'stack_behavior', 'category', 'is_tradeable'],
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

        // 202607140010/11/12 — shapes must match the live DB byte-for-byte
        // (the DB1 parity requirement).
        const pointsBalance = (await allAsync(db, 'PRAGMA table_info(user_stats)'))
            .find((c) => c.name === 'points_balance');
        expect(pointsBalance).toMatchObject({ type: 'INTEGER', dflt_value: '0' });

        const accountStatus = (await allAsync(db, 'PRAGMA table_info(users)'))
            .find((c) => c.name === 'account_status');
        expect(accountStatus).toMatchObject({ type: 'TEXT', dflt_value: "'active'" });

        const itemCols = await allAsync(db, 'PRAGMA table_info(items)');
        expect(itemCols.find((c) => c.name === 'category'))
            .toMatchObject({ type: 'TEXT', dflt_value: "'general'" });
        expect(itemCols.find((c) => c.name === 'is_tradeable'))
            .toMatchObject({ type: 'BOOLEAN', dflt_value: '0' });
    });

    it('enforces the account_status CHECK constraint added via ALTER TABLE (202607140011)', async () => {
        // SQLite allows ADD COLUMN with a CHECK when the default is a
        // constant; this pins that the constraint actually took (and that the
        // CI runner's SQLite supports it).
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.runAll(db, logger);
            db.run('SELECT 1', resolve);
        }));
        expect(logger._calls.error).toEqual([]);

        await runAsync(db, "INSERT INTO users (email, username) VALUES ('a@b.c', 'checker')");
        const row = await new Promise((resolve, reject) => {
            db.get("SELECT account_status FROM users WHERE username = 'checker'", (err, r) => {
                if (err) reject(err);
                else resolve(r);
            });
        });
        expect(row.account_status).toBe('active');

        await expect(
            runAsync(db, "UPDATE users SET account_status = 'bogus' WHERE username = 'checker'")
        ).rejects.toThrow(/CHECK constraint failed/);
        await expect(
            runAsync(db, "UPDATE users SET account_status = 'pending_deletion' WHERE username = 'checker'")
        ).resolves.toBeDefined();
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
                vision_audit_optout BOOLEAN DEFAULT 0,
                username_changed BOOLEAN DEFAULT 0,
                deletion_requested_at DATETIME DEFAULT NULL,
                deletion_confirmed_at DATETIME DEFAULT NULL,
                deletion_scheduled_for DATETIME DEFAULT NULL,
                deletion_token TEXT DEFAULT NULL,
                deletion_token_expires DATETIME DEFAULT NULL,
                account_status TEXT DEFAULT 'active' CHECK(account_status IN ('active', 'pending_deletion', 'deleted')),
                bio TEXT DEFAULT NULL,
                website TEXT DEFAULT NULL,
                location TEXT DEFAULT NULL,
                display_name TEXT DEFAULT NULL,
                avatar_url TEXT,
                description TEXT
            )
        `);
        await runAsync(db, `
            CREATE TABLE user_stats (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                chat_color TEXT DEFAULT NULL,
                points_balance INTEGER DEFAULT 0
            )
        `);
        await runAsync(db, `
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                duration_seconds INTEGER DEFAULT 0,
                effect_data TEXT,
                stack_behavior TEXT DEFAULT 'replace',
                category TEXT DEFAULT 'general',
                is_tradeable BOOLEAN DEFAULT 0
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
    // producing every user table. Any DDL change must reproduce that exact
    // snapshot or re-baseline the fixture deliberately (regenerate with
    // scripts/ops/regenerate-schema-snapshot.js — never hand-edit). The
    // fixture was re-baselined when the dead viewbot_* tables were dropped;
    // again in the C1 schema reconciliation (promoted 5 load-bearing tables);
    // and again in the DB1/DB3 fresh-boot fix, which promoted
    // points_transactions / transcriptions / transcription_chunks + the
    // user_stats.points_balance, users profile/deletion, and items
    // category/is_tradeable columns into the bootstrap.
    //
    // Strategy: boot the production init path (`initializeSchema` from the
    // side-effect-free server/database/schema.js — the same function
    // database.js's module boot calls, ADR-0030) against an in-memory DB and
    // diff. It resolves when the whole serialize queue (tables, seeds,
    // migrations, indexes) has flushed, so the old monkey-patch-require of
    // database.js and the 2500 ms sleep — which covered a setTimeout the
    // recording indexes used to hide in — are both gone.

    let snapshot;

    beforeAll(async () => {
        const { initializeSchema } = require('../../database/schema');
        const db = new sqlite3.Database(':memory:');
        await initializeSchema(db, makeLogger());
        snapshot = await snapshotSchema(db);
        await new Promise((r) => db.close(r));
    }, 10_000);

    it('produces a schema bit-identical to the committed fixture', () => {
        const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
        expect(snapshot).toEqual(fixture);
    });
});

describe('migration 202607150900 — user_stats dedup + UNIQUE(user_id) (audit DB5 / ADR-0035)', () => {
    let db;
    let logger;

    const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });

    async function runMigration() {
        const mod = require('../../migrations/202607150900-user-stats-unique-user-id');
        await new Promise((resolve) => db.serialize(() => {
            mod.run(db, logger);
            db.run('SELECT 1', resolve);
        }));
    }

    beforeEach(async () => {
        db = new sqlite3.Database(':memory:');
        logger = makeLogger();
        // Pre-fix shape: no uniqueness on user_id — exactly the live-DB
        // hazard the migration remediates.
        await runAsync(db, `
            CREATE TABLE user_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                total_stream_time INTEGER DEFAULT 0,
                points_balance INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    });

    afterEach((done) => {
        migrationRunner.drainAsyncFailures(); // never leak into other suites
        db.close(done);
    });

    it('keeps the MAX(points_balance) row per user (favor the user), deletes the rest', async () => {
        // User 1: three duplicate rows from racing first-credits. Balances
        // diverge only by what each row captured at INSERT time (later
        // UPDATEs hit all rows equally), so the migration keeps the highest.
        await runAsync(db, 'INSERT INTO user_stats (id, user_id, points_balance) VALUES (1, 1, 100)');
        await runAsync(db, 'INSERT INTO user_stats (id, user_id, points_balance) VALUES (2, 1, 250)');
        await runAsync(db, 'INSERT INTO user_stats (id, user_id, points_balance) VALUES (3, 1, 250)');
        // User 2: healthy single row — untouched.
        await runAsync(db, 'INSERT INTO user_stats (id, user_id, points_balance) VALUES (4, 2, 40)');

        await runMigration();

        expect(logger._calls.error).toEqual([]);
        expect(migrationRunner.drainAsyncFailures()).toEqual([]);

        const user1 = await new Promise((resolve, reject) => {
            db.all('SELECT id, points_balance FROM user_stats WHERE user_id = 1', (e, r) => (e ? reject(e) : resolve(r)));
        });
        // One row; MAX balance; equal-balance tie broken by lowest id.
        expect(user1).toEqual([{ id: 2, points_balance: 250 }]);

        const user2 = await getAsync('SELECT id, points_balance FROM user_stats WHERE user_id = 2');
        expect(user2).toEqual({ id: 4, points_balance: 40 });
    });

    it('creates the UNIQUE index so duplicate rows can never come back', async () => {
        await runAsync(db, 'INSERT INTO user_stats (user_id, points_balance) VALUES (1, 10)');
        await runMigration();

        const idx = await getAsync(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_user_stats_user_id_unique'");
        expect(idx).toBeDefined();

        await expect(
            runAsync(db, 'INSERT INTO user_stats (user_id, points_balance) VALUES (1, 999)')
        ).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('is idempotent (the ADR-0022 every-boot contract)', async () => {
        await runAsync(db, 'INSERT INTO user_stats (user_id, points_balance) VALUES (1, 100)');
        await runAsync(db, 'INSERT INTO user_stats (user_id, points_balance) VALUES (1, 250)');

        await runMigration();
        await runMigration();

        expect(logger._calls.error).toEqual([]);
        expect(migrationRunner.drainAsyncFailures()).toEqual([]);
        const row = await getAsync('SELECT COUNT(*) AS n, MAX(points_balance) AS b FROM user_stats');
        expect(row).toEqual({ n: 1, b: 250 });
    });

    it('the repository upsert SQL is race-safe against the new index (sqlite3 driver)', async () => {
        await runMigration();

        // The exact upsertStatsWithBalance shape: two "first credits" for the
        // same user — the second folds into an increment, never a second row.
        const upsertSql = `INSERT INTO user_stats (user_id, points_balance)
             VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                 points_balance = points_balance + excluded.points_balance,
                 updated_at = CURRENT_TIMESTAMP
             RETURNING points_balance`;
        const first = await getAsync(upsertSql, [7, 50]);
        const second = await getAsync(upsertSql, [7, 25]);
        expect(first).toEqual({ points_balance: 50 });
        expect(second).toEqual({ points_balance: 75 });

        const row = await getAsync('SELECT COUNT(*) AS n FROM user_stats WHERE user_id = 7');
        expect(row).toEqual({ n: 1 });
    });
});

describe('migration runner — fail-loud (audit DB6 / ADR-0035)', () => {
    const FIXTURES = path.join(__dirname, '..', 'fixtures', 'failloud-migrations');
    let db;
    let logger;

    beforeEach(() => {
        db = new sqlite3.Database(':memory:');
        logger = makeLogger();
    });

    afterEach((done) => {
        migrationRunner.drainAsyncFailures();
        db.close(done);
    });

    it('a migration whose run() throws synchronously aborts the run', () => {
        expect(() => migrationRunner.runAll(db, logger, path.join(FIXTURES, 'throws')))
            .toThrow(/202601010001-throws-synchronously\.js threw synchronously: fixture migration exploded/);
        expect(logger._calls.error.length).toBe(1);
    });

    it('a migration module missing run() aborts the run', () => {
        expect(() => migrationRunner.runAll(db, logger, path.join(FIXTURES, 'missing-run')))
            .toThrow(/202601010002-missing-run-export\.js is missing its run\(db, logger\) export/);
    });

    it('a migration module that fails to load aborts the run', () => {
        expect(() => migrationRunner.runAll(db, logger, path.join(FIXTURES, 'load-error')))
            .toThrow(/202601010003-throws-at-load\.js failed to load: fixture migration failed to load/);
    });

    it('the abort propagates out of initializeSchema as a rejection (boot-abort wiring)', async () => {
        // The sink is drained at initializeSchema's flush marker; recording a
        // failure before boot proves a non-benign async migration error turns
        // into a rejected bootstrap instead of a log line.
        const { initializeSchema } = require('../../database/schema');
        migrationRunner.recordAsyncFailure({
            err: new Error('injected failure'),
            op: 'test-injection',
            table: 'user_stats',
        });
        const memDb = new sqlite3.Database(':memory:');
        await expect(initializeSchema(memDb, makeLogger()))
            .rejects.toThrow(/1 migration statement\(s\) failed — test-injection\(user_stats\): injected failure/);
        await new Promise((r) => memDb.close(r));
    });

    it('benign duplicate-column errors are still tolerated (addColumn)', async () => {
        await runAsync(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, existing TEXT)');
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.addColumn(db, 't', 'existing', 'TEXT', logger);
            db.run('SELECT 1', resolve);
        }));
        expect(logger._calls.error).toEqual([]);
        expect(migrationRunner.drainAsyncFailures()).toEqual([]);
    });

    it('benign no-such-column errors are still tolerated (dropColumn)', async () => {
        await runAsync(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.dropColumn(db, 't', 'never_existed', logger);
            db.run('SELECT 1', resolve);
        }));
        expect(logger._calls.error).toEqual([]);
        expect(migrationRunner.drainAsyncFailures()).toEqual([]);
    });

    it('a NON-benign addColumn error is logged AND recorded for the boot-abort path', async () => {
        await new Promise((resolve) => db.serialize(() => {
            migrationRunner.addColumn(db, 'no_such_table', 'col', 'TEXT', logger);
            db.run('SELECT 1', resolve);
        }));
        expect(logger._calls.error.length).toBe(1);
        const failures = migrationRunner.drainAsyncFailures();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ op: 'addColumn', table: 'no_such_table', column: 'col' });
    });
});
