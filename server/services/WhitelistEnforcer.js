const logger = require('../bootstrap/logger').child({ svc: 'WhitelistEnforcer' });

/**
 * WhitelistEnforcer.js — mid-stream drift enforcement for URL relay.
 *
 * ADR-0010, PR-W4 / Phase 3. The PR-W1 service holds policy; PR-W2 gates
 * direct submission; PR-W3 filters rotation candidates; this PR catches the
 * one remaining case the above can't: a whitelisted streamer switches their
 * own category mid-broadcast to something not on the policy.
 *
 * Loop:
 *   1. Every drift_check_seconds (default 60s), get the active URL relay.
 *   2. If non-Twitch/non-Kick, skip — not gated by the whitelist.
 *   3. Re-fetch the streamer's current category + mature flags via the
 *      platform API (Twitch /helix/streams + /helix/channels; Kick /channels).
 *   4. Pass the fresh snapshot to WhitelistService.isStillAllowed.
 *   5. If not allowed, stop the relay via viewBotURLService.stopURLStream
 *      (which the existing failure handler turns into a rotation), emit
 *      `whitelist-drift-stop` so the admin UI surfaces the reason, and
 *      write an audit row.
 *
 * The platform API can be flaky. Three consecutive snapshot failures inside
 * a 3-minute window are treated as "platform degraded" — we keep last-known
 * state and don't stop the stream. Beyond that we err on the safe side and
 * stop, on the assumption that an extended outage shouldn't keep a possibly-
 * out-of-policy relay running.
 */

const DEFAULT_DRIFT_CHECK_SECONDS = 60;
const PLATFORM_DEGRADED_TOLERANCE_MS = 3 * 60 * 1000;

class WhitelistEnforcer {
  constructor({
    viewBotURLService,
    whitelistService,
    twitchService,
    kickService,
    io,
  } = {}) {
    this.viewBotURLService = viewBotURLService || null;
    this.whitelistService = whitelistService || null;
    this.twitchService = twitchService || null;
    this.kickService = kickService || null;
    this.io = io || null;

    this._timer = null;
    this._driftCheckSeconds = DEFAULT_DRIFT_CHECK_SECONDS;
    this._lastSnapshotFailureAt = new Map(); // urlId -> ts

    logger.debug('🛡️  WhitelistEnforcer created (not yet started)');
  }

  start({ intervalSeconds } = {}) {
    if (this._timer) return;
    if (!this.viewBotURLService || !this.whitelistService) {
      logger.warn('⚠️  WhitelistEnforcer: missing required deps; not starting');
      return;
    }
    this._driftCheckSeconds = intervalSeconds || this._readDriftIntervalFromConfig();
    this._timer = setInterval(() => {
      this._tick().catch((e) =>
        logger.error('❌ WhitelistEnforcer tick failed:', e.message || e)
      );
    }, this._driftCheckSeconds * 1000);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    logger.debug(`✅ WhitelistEnforcer started (interval ${this._driftCheckSeconds}s)`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      logger.debug('🛑 WhitelistEnforcer stopped');
    }
  }

  /**
   * One drift-check pass. Exposed for tests so they can advance the loop
   * deterministically without leaning on fake timers.
   */
  async _tick() {
    const active = this.viewBotURLService.getActiveURLStream && this.viewBotURLService.getActiveURLStream();
    if (!active) return { skipped: 'no_active_stream' };

    const platform = active.platform || active.validation?.platform;
    if (!['twitch', 'kick'].includes(platform)) {
      return { skipped: 'platform_not_gated', platform };
    }

    const login = this._loginFromActive(active);
    if (!login) return { skipped: 'unknown_login' };

    let snapshot = null;
    try {
      snapshot = platform === 'twitch'
        ? await this.twitchService?.getCurrentStreamSnapshot(login)
        : await this.kickService?.getCurrentStreamSnapshot(login);
    } catch (e) {
      snapshot = null;
    }

    if (!snapshot) {
      const last = this._lastSnapshotFailureAt.get(active.urlId);
      const now = Date.now();
      if (!last) {
        this._lastSnapshotFailureAt.set(active.urlId, now);
        return { skipped: 'snapshot_failed_first', login };
      }
      if (now - last < PLATFORM_DEGRADED_TOLERANCE_MS) {
        return { skipped: 'snapshot_failed_recent', login };
      }
      await this._stop(active, { reason: 'platform_degraded_extended', login, platform });
      return { stopped: true, reason: 'platform_degraded_extended' };
    }

    this._lastSnapshotFailureAt.delete(active.urlId);

    const decision = this.whitelistService.isStillAllowed(snapshot);
    if (decision.allowed) {
      return { ok: true, reason: decision.reason };
    }

    await this._stop(active, {
      reason: decision.reason,
      gateThatBlocked: decision.gateThatBlocked,
      login,
      platform,
      currentGameName: snapshot.currentGameName,
    });
    return { stopped: true, reason: decision.reason, gateThatBlocked: decision.gateThatBlocked };
  }

  async _stop(active, context) {
    logger.debug(`⛔ WhitelistEnforcer: drift detected, stopping ${active.urlId} (${context.reason})`);

    // Stop first, then audit with the actual outcome. Per code review:
    // an audit row written before the stop attempt implied stream-was-
    // -stopped when in fact the stop could still throw. Now we capture
    // whether the stop succeeded and include it in the audit context.
    let stopSucceeded = false;
    try {
      await this.viewBotURLService.stopURLStream(active.urlId);
      stopSucceeded = true;
    } catch (e) {
      logger.error('❌ WhitelistEnforcer: stopURLStream failed:', e.message);
    }

    try {
      await this.whitelistService.logAudit({
        action: 'drift_block',
        platform: context.platform,
        value: context.login,
        context: JSON.stringify({ ...context, stopSucceeded }),
      });
    } catch (e) {
      logger.warn('⚠️  WhitelistEnforcer: audit log write failed:', e.message);
    }

    // Socket event fires regardless of stop success — the admin UI needs to
    // know about the policy decision either way; the operator can manually
    // intervene if the stop didn't take.
    if (this.io && typeof this.io.emit === 'function') {
      this.io.emit('whitelist-drift-stop', {
        urlId: active.urlId,
        login: context.login,
        platform: context.platform,
        reason: context.reason,
        gateThatBlocked: context.gateThatBlocked,
        currentGameName: context.currentGameName,
        stopSucceeded,
      });
    }
  }

  _loginFromActive(active) {
    // Active stream's sourceUrl is the original Twitch/Kick URL. Use the
    // URLStreamExtractorService pattern (we have access via the
    // viewBotURLService's extractor) to extract the login.
    const url = active.sourceUrl;
    if (!url) return null;
    if (this.viewBotURLService.extractorService
        && typeof this.viewBotURLService.extractorService.extractIdentifier === 'function') {
      const ident = this.viewBotURLService.extractorService.extractIdentifier(url);
      if (ident && ident.identifier) return String(ident.identifier).toLowerCase();
    }
    // Fallback: naive parse.
    const m = url.match(/(?:twitch\.tv|kick\.com)\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  _readDriftIntervalFromConfig() {
    try {
      const cfg = this.whitelistService.chooseFallback('twitch')
        || this.whitelistService.chooseFallback('kick');
      // chooseFallback returns the seeded drift_check_seconds via the
      // platform config row. Fall back to the default.
      // (The current chooseFallback signature doesn't return this directly,
      // so for now we accept the default; a future revision could surface
      // it. Phase 5 hardcoding the seed default is acceptable.)
    } catch (e) {
      /* ignore */
    }
    return DEFAULT_DRIFT_CHECK_SECONDS;
  }
}

module.exports = WhitelistEnforcer;
module.exports.DEFAULT_DRIFT_CHECK_SECONDS = DEFAULT_DRIFT_CHECK_SECONDS;
module.exports.PLATFORM_DEGRADED_TOLERANCE_MS = PLATFORM_DEGRADED_TOLERANCE_MS;
