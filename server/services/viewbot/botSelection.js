// Weighted-random bot selection, extracted from
// ViewBotClientService.selectViewBotWithCooldown. Pure aside from the injected
// rng + optional logger: given the candidate bots and a per-bot weight lookup,
// pick one with probability proportional to its weight.
//
// `rng` defaults to Math.random (production behavior); tests inject a
// deterministic value. `getWeight(botId) -> number` supplies each bot's weight
// (the service passes its cooldown-based probability multiplier).

function selectWeightedBot(availableBots, getWeight, { logger = null, rng = Math.random } = {}) {
  if (availableBots.length === 0) {
    return null;
  }

  if (availableBots.length === 1) {
    return availableBots[0];
  }

  const weights = availableBots.map(bot => ({
    bot,
    weight: getWeight(bot.botId)
  }));

  if (logger) {
    logger.debug(`🎲 COOLDOWN: Bot selection weights:`, weights.map(w =>
      `${w.bot.botId.split('-').pop()}: ${(w.weight * 100).toFixed(0)}%`
    ).join(', '));
  }

  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

  let random = rng() * totalWeight;

  for (const { bot, weight } of weights) {
    random -= weight;
    if (random <= 0) {
      return bot;
    }
  }

  // Fallback (shouldn't happen)
  return availableBots[0];
}

module.exports = { selectWeightedBot };
