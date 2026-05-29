/**
 * WhitelistGate.js - URL submission policy gate (ADR-0010), extracted from
 * ViewBotURLService.
 *
 * Pure helpers that translate a platform URL into a login and consult the
 * owner's whitelistService. Reads owner.extractorService / owner.whitelistService
 * via the `owner` back-reference so behavior is identical to the in-service form.
 */

class WhitelistGate {
  constructor(owner) {
    this.owner = owner;
  }

  /**
   * Extract the channel login from a platform URL.
   * Returns null for unknown platforms or URLs we can't parse.
   * Logins are lowercased to match WhitelistService's canonical form.
   */
  extractLoginFromUrl(url, platform) {
    if (!url || !platform) return null;
    const ident = this.owner.extractorService.extractIdentifier(url);
    if (!ident || !ident.identifier) return null;
    if (ident.platform !== platform) return null;
    return String(ident.identifier).toLowerCase();
  }

  /**
   * Apply the whitelist policy gate (ADR-0010) to a pending URL submission.
   * Phase 1 only knows the platform + login at this point; the current
   * category isn't resolved yet, so callers in `whitelist` mode will fall
   * through to the streamer allowlist alone here. A post-extraction re-check
   * is deferred to PR-W3 once TwitchRandomService surfaces the category.
   *
   * Returns { allowed: true } when no whitelistService is wired (Phase 0
   * behavior preserved) OR when the service grants the request. Returns
   * { allowed: false, reason, gateThatBlocked } otherwise.
   *
   * Non-Twitch / non-Kick platforms (YouTube, Facebook, etc.) are not gated
   * by this service — they're not on the whitelist's per-platform tables.
   */
  check(url, validation) {
    if (!this.owner.whitelistService) return { allowed: true, reason: 'service_unset' };
    if (!validation || !['twitch', 'kick'].includes(validation.platform)) {
      return { allowed: true, reason: 'platform_not_gated' };
    }
    const login = this.extractLoginFromUrl(url, validation.platform);
    return this.owner.whitelistService.checkAllowed({
      platform: validation.platform,
      login,
      currentGameName: null,
      isMature: null,
      ccls: null,
      hasMatureContent: null,
    });
  }
}

module.exports = WhitelistGate;
