// server/services/moderation/Retention.js
//
// Retention purge + scheduler collaborator for ModerationService.
// Extracted as part of the ModerationService decomposition — behavior is
// identical to the methods it replaces.
//
// Owns: purgeOldEvents, startRetentionScheduler, and the timer handles
//       (cleared by stop(), invoked from ModerationService.stop()).

const logger = require('../../bootstrap/logger').child({ svc: 'ModerationService' });

class Retention {
  /**
   * @param {object} deps
   * @param {object} deps.database  OneStreamer sqlite wrapper.
   */
  constructor({ database }) {
    this.database = database;
    this._retentionTimer = null;
    this._retentionFirstRun = null;
  }

  /**
   * Purge moderation_events rows older than the configured retention
   * windows: 90 days for non-clean decisions (kept to cover the appeal
   * window + DSA Article 17 statement-of-reasons accessibility), 30 days
   * for `final_decision='clean'` rows (which we don't write today —
   * PR-M1 only writes on Stage 1 hits — but the constraint is kept so the
   * window applies cleanly if a future PR starts logging clean
   * classifications). Returns counts so the scheduler can log.
   *
   * @param {object} [opts]
   * @param {number} [opts.flaggedRetentionDays=90]
   * @param {number} [opts.cleanRetentionDays=30]
   */
  async purgeOldEvents({ flaggedRetentionDays = 90, cleanRetentionDays = 30 } = {}) {
    const flaggedCutoff = `-${Math.max(1, flaggedRetentionDays)} days`;
    const cleanCutoff = `-${Math.max(1, cleanRetentionDays)} days`;

    let flaggedDeleted = 0;
    let cleanDeleted = 0;
    try {
      const r = await this.database.runAsync(
        `DELETE FROM moderation_events
          WHERE final_decision <> 'clean'
            AND created_at < datetime('now', ?)`,
        [flaggedCutoff]
      );
      flaggedDeleted = (r && r.changes) || 0;
    } catch (err) {
      logger.error('❌ ModerationService.purgeOldEvents (flagged) failed:', err.message);
    }
    try {
      const r = await this.database.runAsync(
        `DELETE FROM moderation_events
          WHERE final_decision = 'clean'
            AND created_at < datetime('now', ?)`,
        [cleanCutoff]
      );
      cleanDeleted = (r && r.changes) || 0;
    } catch (err) {
      logger.error('❌ ModerationService.purgeOldEvents (clean) failed:', err.message);
    }
    if (flaggedDeleted > 0 || cleanDeleted > 0) {
      logger.debug(`🧹 ModerationService: purged ${flaggedDeleted} flagged + ${cleanDeleted} clean moderation_events rows`);
    }
    return { flaggedDeleted, cleanDeleted };
  }

  /**
   * Start the daily retention scheduler. setInterval-driven; the handle
   * is unref'd so it doesn't keep the process alive on shutdown.
   * `stop()` clears it.
   */
  startRetentionScheduler(opts = {}) {
    const interval = opts.intervalMs || 24 * 60 * 60 * 1000; // 24h
    if (this._retentionTimer) return; // idempotent
    // Kick off the first run after a 60s grace period so we don't compete
    // with other boot-time IO.
    this._retentionFirstRun = setTimeout(() => {
      this.purgeOldEvents(opts).catch((err) => logger.error('retention first run:', err));
    }, 60_000);
    if (typeof this._retentionFirstRun.unref === 'function') this._retentionFirstRun.unref();
    this._retentionTimer = setInterval(() => {
      this.purgeOldEvents(opts).catch((err) => logger.error('retention tick:', err));
    }, interval);
    if (typeof this._retentionTimer.unref === 'function') this._retentionTimer.unref();
  }

  /**
   * Clear the scheduler timers. Invoked from ModerationService.stop().
   */
  stop() {
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
      this._retentionTimer = null;
    }
    if (this._retentionFirstRun) {
      clearTimeout(this._retentionFirstRun);
      this._retentionFirstRun = null;
    }
  }
}

module.exports = Retention;
