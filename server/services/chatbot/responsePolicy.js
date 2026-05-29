// Pure response-pipeline policy helpers, extracted from ChatBotService's
// scheduleNextResponse / generateAndSendMessage. No side effects — the service
// keeps the timers, LLM call, socket emit, and cleanup orchestration.

// True when a temporary bot is past its expiry. Non-temporary bots (or those
// without an expires_at) are never expired.
function isBotExpired(botData, now = new Date()) {
  if (botData.is_temporary && botData.expires_at) {
    return now >= new Date(botData.expires_at);
  }
  return false;
}

// Random delay (ms) in [min, max) derived from the bot's configured interval
// seconds. rng defaults to Math.random (production); injectable for tests.
function computeResponseInterval(botData, rng = Math.random) {
  const minInterval = botData.response_interval_min * 1000;
  const maxInterval = botData.response_interval_max * 1000;
  return rng() * (maxInterval - minInterval) + minInterval;
}

// Parse the bot's personality_traits JSON, or {} when absent. (The vision path
// uses this directly — it passes temperature to the LLM separately and must NOT
// have a temperature key folded into the personality object.)
function parsePersonalityTraits(botData) {
  return botData.personality_traits ? JSON.parse(botData.personality_traits) : {};
}

// Parsed personality_traits with the configured creativity temperature layered
// on when present (the regular chat + MovieBot paths).
function buildResponsePersonality(botData) {
  const personality = parsePersonalityTraits(botData);
  if (
    botData.response_creativity_temperature !== undefined &&
    botData.response_creativity_temperature !== null
  ) {
    personality.temperature = botData.response_creativity_temperature;
  }
  return personality;
}

module.exports = { isBotExpired, computeResponseInterval, parsePersonalityTraits, buildResponsePersonality };
