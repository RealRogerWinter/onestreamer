// Pure filter for the MovieBot-enabled roster, extracted from
// ChatBotService.getMovieBotEnabledBots. Given the repo's movie-bot rows, the
// live bot-instance map, and `now`, returns the connected, non-expired bots in
// the { id, username, name, model } shape the callers expect. Optional logger
// preserves the original "skipping expired bot" debug line.

function filterActiveMovieBots(repoBots, botInstances, now, logger = null) {
  const activeBots = [];

  for (const bot of repoBots) {
    const botInstance = botInstances.get(bot.id);
    if (botInstance && botInstance.connected) {
      // Skip expired temporary bots.
      if (bot.is_temporary && bot.expires_at) {
        const expiresAt = new Date(bot.expires_at);
        if (now >= expiresAt) {
          logger?.debug(`🚫 Skipping expired bot ${bot.id} (${bot.name}) from MovieBot list`);
          continue;
        }
      }

      activeBots.push({
        id: bot.id,
        username: botInstance.username,
        name: bot.name,
        model: bot.llm_model,
      });
    }
  }

  return activeBots;
}

module.exports = { filterActiveMovieBots };
