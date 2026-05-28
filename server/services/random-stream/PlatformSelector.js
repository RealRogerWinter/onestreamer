/**
 * PlatformSelector — chooses which platform (Twitch / Kick) the next URL-relay
 * stream rotation should pull from, and computes the interval until the next
 * scheduled rotation. Wraps three originally-on-the-main-service methods:
 *
 *   isReady(settings, viewBotURLService)
 *     → { ready: true, availablePlatforms: [...] }
 *       or { ready: false, error: '<why>' }
 *
 *   selectRandom(settings)
 *     → 'twitch' | 'kick' | null      (weighted pick from enabled+configured)
 *
 *   getRandomInterval(settings)
 *     → ms between minRotationMinutes and maxRotationMinutes inclusive
 *
 * Construction:
 *   new PlatformSelector({ twitchService, kickService })
 *
 * Stateless w.r.t. settings — every call takes the current settings snapshot
 * from the main service. Kept untyped on purpose; the main service is the only
 * caller and passes its own `this.settings` object verbatim.
 */

class PlatformSelector {
  constructor({ twitchService, kickService }) {
    this.twitchService = twitchService;
    this.kickService = kickService;
  }

  _enabledAvailablePlatforms(settings) {
    const enabledPlatforms = settings.platforms || ['twitch'];
    const availablePlatforms = [];

    if (enabledPlatforms.includes('twitch') && this.twitchService.isConfigured()) {
      availablePlatforms.push('twitch');
    }
    if (enabledPlatforms.includes('kick')) {
      availablePlatforms.push('kick'); // Kick doesn't need API keys
    }

    return { enabledPlatforms, availablePlatforms };
  }

  isReady(settings, viewBotURLService) {
    const { enabledPlatforms, availablePlatforms } = this._enabledAvailablePlatforms(settings);

    if (availablePlatforms.length === 0) {
      if (enabledPlatforms.includes('twitch') && !this.twitchService.isConfigured()) {
        return { ready: false, error: 'Twitch API not configured and Kick not enabled' };
      }
      return { ready: false, error: 'No platforms enabled' };
    }

    if (!viewBotURLService) {
      return { ready: false, error: 'ViewBotURLService not set' };
    }

    return { ready: true, availablePlatforms };
  }

  selectRandom(settings) {
    const { availablePlatforms } = this._enabledAvailablePlatforms(settings);

    if (availablePlatforms.length === 0) {
      return null;
    }

    if (availablePlatforms.length === 1) {
      return availablePlatforms[0];
    }

    const weights = settings.platformWeight || { twitch: 50, kick: 50 };
    const totalWeight = availablePlatforms.reduce((sum, p) => sum + (weights[p] || 50), 0);
    let random = Math.random() * totalWeight;

    for (const platform of availablePlatforms) {
      random -= (weights[platform] || 50);
      if (random <= 0) {
        return platform;
      }
    }

    return availablePlatforms[0];
  }

  getRandomInterval(settings) {
    const minMs = settings.minRotationMinutes * 60 * 1000;
    const maxMs = settings.maxRotationMinutes * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }
}

module.exports = PlatformSelector;
