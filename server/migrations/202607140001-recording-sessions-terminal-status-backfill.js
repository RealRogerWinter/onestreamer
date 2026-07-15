/**
 * Backfill terminal status on finished recording_sessions rows (ADR-0028).
 *
 * The retired per-day session model deliberately never wrote a terminal
 * status ("session represents the whole day's recording"), so every
 * finished session sat at status='recording' forever — invisible to
 * RecordingUploadScheduler's recovery (which keyed on 'completed') and
 * immortal to RecordingCleanupScheduler's DB-row reaping (which keys on
 * status IN ('completed','uploaded')). ~82 such rows exist on the
 * production DB.
 *
 * A crash mid-upload can likewise strand a row at 'processing'.
 *
 * Idempotent and safe to re-run every boot (the ADR-0022 runner model):
 * a live recording's row has end_time IS NULL until its run stops, so it
 * can never match; per-run rows that already reached 'uploaded' aren't
 * touched.
 */

'use strict';

function run(db, logger) {
    db.run(
        `UPDATE recording_sessions
         SET status = 'completed', updated_at = CURRENT_TIMESTAMP
         WHERE status IN ('recording', 'processing') AND end_time IS NOT NULL`,
        [],
        function (err) {
            if (err) {
                // Pre-recording-schema DBs (and fresh boots — recording tables
                // are created later by recording-schema.sql, not database.js)
                // have nothing to backfill; every other error is real.
                if (/no such table: recording_sessions/.test(err.message)) return;
                logger.error({ err }, 'migration 202607140001: terminal-status backfill failed');
                return;
            }
            // The runner contract only guarantees logger.error / logger.debug.
            if (this.changes > 0 && typeof logger.debug === 'function') {
                logger.debug(`migration 202607140001: marked ${this.changes} finished recording session(s) 'completed'`);
            }
        }
    );
}

module.exports = { run };
