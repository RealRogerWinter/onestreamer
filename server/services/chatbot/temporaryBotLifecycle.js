// Helpers for the ChatBotService temporary-bot lifecycle, extracted verbatim
// (behavior-preserving) from createTemporaryBot / scheduleExpiration /
// cleanupExpiredBots. Pure computations + a repo-deletion sequence + an
// instance-quiesce; all timers/orchestration stay in the service.

function buildCombinedPrompt(moviePrompt, personalityPrompt, name) {
  return `${moviePrompt}\n\nYour specific personality: ${personalityPrompt}\nYour name is ${name}.`;
}

function temporaryBotExpiresAt(durationSeconds, now = Date.now()) {
  return new Date(now + durationSeconds * 1000);
}

// Delete a temporary bot's related rows in FK-safe order, then the chatbot row
// via the caller-chosen final delete (scheduleExpiration uses
// 'deleteTemporaryById'; cleanupExpiredBots uses 'deleteById').
async function deleteTemporaryBotRecords(repo, botId, finalDeleteMethod) {
  await repo.deleteAutoSummonedForBot(botId);
  await repo.deleteTemporaryRecord(botId);
  await repo[finalDeleteMethod](botId);
}

// Stop a live bot instance from doing anything further: cancel its pending
// response timer, mark disabled, and disconnect.
function quiesceBotInstance(botInstance) {
  if (!botInstance) return;
  if (botInstance.responseTimer) {
    clearTimeout(botInstance.responseTimer);
    botInstance.responseTimer = null;
  }
  botInstance.data.is_enabled = 0;
  botInstance.connected = false;
}

module.exports = {
  buildCombinedPrompt,
  temporaryBotExpiresAt,
  deleteTemporaryBotRecords,
  quiesceBotInstance,
};
