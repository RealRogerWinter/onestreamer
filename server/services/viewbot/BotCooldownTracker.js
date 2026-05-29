// Per-bot cooldown tracker for ViewBot rotation weighting. Extracted verbatim
// (behavior-preserving) from ViewBotClientService: the botCooldowns map plus
// applyBotCooldown / getBotProbabilityMultiplier and the cooldown-cleanup sweep.
//
// A bot's selection weight decays by `decayFactor` per play within `windowMs`
// (floored at `minProbability`); after the window elapses it resets to 1.0.
// Pure aside from the optional `logger`; `now` (ms) is injectable so the
// time-based behavior is deterministically testable.

class BotCooldownTracker {
  constructor({ windowMs, decayFactor, minProbability, logger = null }) {
    this.windowMs = windowMs;
    this.decayFactor = decayFactor;
    this.minProbability = minProbability;
    this.logger = logger;
    this.cooldowns = new Map(); // botId -> { count: number, lastPlayed: Date }
  }

  // Record that a bot just played (was applyBotCooldown).
  record(botId, now = Date.now()) {
    const existing = this.cooldowns.get(botId);

    if (existing) {
      if (now - existing.lastPlayed.getTime() <= this.windowMs) {
        existing.count++;
        existing.lastPlayed = new Date(now);
        this.logger?.debug(`📉 COOLDOWN: ViewBot ${botId} played ${existing.count} times in window`);
      } else {
        this.cooldowns.set(botId, { count: 1, lastPlayed: new Date(now) });
        this.logger?.debug(`🔄 COOLDOWN: Reset and applied cooldown for ViewBot ${botId}`);
      }
    } else {
      this.cooldowns.set(botId, { count: 1, lastPlayed: new Date(now) });
      this.logger?.debug(`📝 COOLDOWN: Applied first cooldown for ViewBot ${botId}`);
    }
  }

  // Selection-weight multiplier for a bot (was getBotProbabilityMultiplier).
  // Expired entries are dropped and treated as full probability.
  getMultiplier(botId, now = Date.now()) {
    const cooldown = this.cooldowns.get(botId);

    if (!cooldown) {
      return 1.0;
    }

    if (now - cooldown.lastPlayed.getTime() > this.windowMs) {
      this.cooldowns.delete(botId);
      return 1.0;
    }

    return Math.max(
      this.minProbability,
      Math.pow(this.decayFactor, cooldown.count)
    );
  }

  // Drop all entries past the window; returns the removed botIds (was the body
  // of the startCooldownCleanup interval).
  sweepExpired(now = Date.now()) {
    const expired = [];
    for (const [botId, cooldown] of this.cooldowns.entries()) {
      if (now - cooldown.lastPlayed.getTime() > this.windowMs) {
        expired.push(botId);
      }
    }
    for (const botId of expired) {
      this.cooldowns.delete(botId);
    }
    return expired;
  }
}

module.exports = BotCooldownTracker;
