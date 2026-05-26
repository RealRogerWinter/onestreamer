/**
 * Apply the project-wide SQLite PRAGMAs to a sqlite3.Database handle.
 *
 * `foreign_keys` and `busy_timeout` are per-connection in SQLite, so every
 * handle that opens onestreamer.db has to call this — otherwise the auxiliary
 * handles (e.g. routes/bug-reports.js, services/URLStreamDatabaseService.js)
 * silently run with FKs OFF and SQLITE_BUSY surfaced immediately.
 *
 * `synchronous=NORMAL` is only safe under WAL. If WAL is silently rejected
 * (unusual FS, locking_mode quirks), we keep the default `synchronous=FULL`
 * to avoid the corruption hazard that NORMAL+rollback journal creates on
 * power loss.
 *
 * Pass `tuneForLargeReads: true` on handles that carry the bulk of read
 * traffic — today that's only the main handle in database.js.
 */

const logger = require('../bootstrap/logger');

function run(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, (err) => (err ? reject(err) : resolve()));
    });
}

function get(db, sql) {
    return new Promise((resolve, reject) => {
        db.get(sql, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function applyPragmas(db, { tuneForLargeReads = false } = {}) {
    // journal_mode returns the resulting mode as a row, not a status code.
    // db.run's error callback does NOT fire on silent fallback — only db.get
    // surfaces the actual mode SQLite chose.
    const modeRow = await get(db, 'PRAGMA journal_mode = WAL');
    const walActive = modeRow && modeRow.journal_mode === 'wal';

    if (!walActive) {
        logger.error(
            { actualMode: modeRow && modeRow.journal_mode },
            'SQLite did not enter WAL mode; keeping synchronous=FULL to avoid corruption risk on power loss'
        );
    } else {
        await run(db, 'PRAGMA synchronous = NORMAL');
    }

    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'PRAGMA busy_timeout = 5000');

    if (tuneForLargeReads) {
        await run(db, 'PRAGMA temp_store = MEMORY');
        await run(db, 'PRAGMA mmap_size = 268435456');  // 256 MB
        await run(db, 'PRAGMA cache_size = -64000');    // 64 MB
    }

    return { walActive };
}

module.exports = applyPragmas;
