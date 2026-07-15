/**
 * Enforce one user_stats row per user (audit DB5 / ADR-0035).
 *
 * user_stats.user_id had NO uniqueness constraint, and the economy's
 * first-credit path (PointsManager.addPoints → the UPDATE-missed INSERT
 * fallback) was a plain INSERT — so two concurrent first-credits for the
 * same user could each miss the UPDATE and each INSERT, leaving duplicate
 * balance rows. Every subsequent `UPDATE … WHERE user_id = ?` then hits ALL
 * of that user's rows, while every `SELECT/RETURNING` reads only one —
 * permanent balance corruption.
 *
 * Two steps, order-guaranteed by the serialize queue:
 *
 *   1. Dedup existing duplicates. KEEP the row with the highest
 *      points_balance per user_id (lowest id as the deterministic
 *      tie-break). Rationale: once duplicates exist, every subsequent
 *      UPDATE (credits, debits, stat ticks) hits all of a user's rows
 *      equally, so the rows differ only by what each captured at its own
 *      INSERT time — there is no "more correct" row to reconstruct. We
 *      resolve the ambiguity in the user's favor: MAX(points_balance).
 *      The discarded rows' cumulative stat columns are lost, which is
 *      acceptable — they diverge by at most one row's initial defaults
 *      (zeros), and the balance is the column with real value attached.
 *   2. CREATE UNIQUE INDEX so it can never happen again. This is also what
 *      the repository's ON CONFLICT(user_id) upsert (the race-safe rewrite
 *      of the INSERT fallback) targets. Fresh DBs get the same index from
 *      schema.js; both use IF NOT EXISTS, so each is a no-op after the
 *      other (the ADR-0022 every-boot idempotency contract).
 *
 * Runs after 202607140010 (which guarantees points_balance exists on
 * stale DBs) by filename order.
 *
 * Errors here are NON-benign: a failed dedup or index build means the
 * uniqueness invariant is not in force, so we record into the runner's
 * async-failure sink and boot aborts (fail-loud, DB6 / ADR-0035).
 */

'use strict';

const { recordAsyncFailure } = require('./_runner');

function run(db, logger) {
    // Delete every row for which a strictly-preferable keeper exists:
    // higher balance wins; equal balance → lower id wins. Idempotent —
    // after the first pass no row has a preferable sibling.
    db.run(
        `DELETE FROM user_stats AS d
         WHERE EXISTS (
             SELECT 1 FROM user_stats AS k
             WHERE k.user_id = d.user_id
               AND (k.points_balance > d.points_balance
                    OR (k.points_balance = d.points_balance AND k.id < d.id))
         )`,
        [],
        function (err) {
            if (err) {
                logger.error({ err }, 'migration 202607150900: user_stats dedup failed');
                recordAsyncFailure({ err, op: 'user-stats-dedup', table: 'user_stats' });
                return;
            }
            if (this.changes > 0 && typeof logger.debug === 'function') {
                logger.debug(`migration 202607150900: removed ${this.changes} duplicate user_stats row(s)`);
            }
        }
    );

    db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_stats_user_id_unique
         ON user_stats(user_id)`,
        [],
        (err) => {
            if (err) {
                logger.error({ err }, 'migration 202607150900: unique index on user_stats(user_id) failed');
                recordAsyncFailure({ err, op: 'user-stats-unique-index', table: 'user_stats' });
            }
        }
    );
}

module.exports = { run };
