/**
 * Lightweight migration runner (ADR-0022).
 *
 * Reads `server/migrations/2026MMDDHHMM-<description>.js` files in
 * lexicographic order and invokes each module's `run(db, logger)` function.
 * The runner is callback-driven: each migration queues its statements onto
 * the same sqlite3 handle that the bootstrap is currently serializing, so a
 * caller inside `db.serialize(...)` is guaranteed the migrations execute
 * AFTER all queued `CREATE TABLE IF NOT EXISTS` statements complete.
 *
 * Filename convention:
 *   2026MMDDHHMM-<short-description>.js
 *
 * The 12-digit prefix is what gives lexicographic = chronological ordering.
 * Legacy pre-PR-14.1 scripts (e.g. add-X.js, migrate-X.js) are deliberately
 * NOT picked up — they had their own ad-hoc invocation pattern. Every table
 * they CREATE that the running code still reads has been promoted into the
 * boot path (server/database/database.js, the sole boot DDL source per
 * ADR-0030), so a fresh clone is fully provisioned without them. The
 * remaining legacy scripts are one-shot data backfills
 * (migrate-points-system.js, add-summon-bot-item.js, …) kept for historical
 * reference / manual re-run only and are NOT part of the boot path. (The
 * setup-recording/clips/transcription-tables.js scripts and
 * recording-schema.sql were deleted outright in the DB3 single-source fix —
 * their DDL was either a duplicate no-op or contradicted the live schema.)
 *
 * Why no schema_migrations tracking table: every migration here is idempotent
 * (uses `IF NOT EXISTS` or catches "duplicate column"). Re-running them on a
 * fresh OR existing DB converges to the same end state. We pay one no-op
 * ALTER per migration per boot — at single-host single-tenant scale this is
 * cheaper than a tracking table + its bug surface. See ADR-0022.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATION_FILENAME_RE = /^\d{12}-[a-z0-9-]+\.js$/;

function listMigrationFiles(dir = __dirname) {
    return fs.readdirSync(dir)
        .filter((f) => MIGRATION_FILENAME_RE.test(f))
        .sort();
}

/**
 * Run every migration in the directory in lexicographic filename order.
 *
 * Each migration module must export `run(db, logger)`. The migration is free
 * to use callback-style `db.run(...)` — when invoked from inside
 * `db.serialize(...)`, statements queue in order on the same handle.
 *
 * @param {sqlite3.Database} db
 * @param {{ error: Function, debug?: Function }} logger
 */
function runAll(db, logger) {
    const files = listMigrationFiles();
    for (const file of files) {
        let mod;
        try {
            mod = require(path.join(__dirname, file));
        } catch (e) {
            logger.error({ err: e, file }, 'Migration module failed to load');
            continue;
        }
        if (typeof mod.run !== 'function') {
            logger.error({ file }, 'Migration module missing run(db, logger) export');
            continue;
        }
        try {
            mod.run(db, logger);
        } catch (e) {
            logger.error({ err: e, file }, 'Migration run() threw synchronously');
        }
    }
    if (typeof logger.debug === 'function') {
        logger.debug({ count: files.length }, 'Schema migrations queued');
    }
}

/**
 * Helper used by individual migration modules: ALTER TABLE ... ADD COLUMN
 * with the "already added" branch silently swallowed. Mirrors the exact
 * pattern the pre-PR-14.1 inline ALTERs used.
 */
function addColumn(db, table, column, definition, logger) {
    db.run(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        (err) => {
            if (err && !err.message.includes('duplicate column')) {
                logger.error(
                    { err, table, column },
                    'Migration ALTER TABLE ADD COLUMN failed'
                );
            }
        }
    );
}

/**
 * Helper: DROP COLUMN with the "already dropped" branch silently swallowed.
 * SQLite supports DROP COLUMN since 3.35 (2021); when the column was never
 * present, SQLite raises "no such column" which we ignore.
 */
function dropColumn(db, table, column, logger) {
    db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`, (err) => {
        if (err && !err.message.includes('no such column')) {
            logger.error(
                { err, table, column },
                'Migration ALTER TABLE DROP COLUMN failed'
            );
        }
    });
}

module.exports = {
    runAll,
    listMigrationFiles,
    addColumn,
    dropColumn,
    MIGRATION_FILENAME_RE,
};
