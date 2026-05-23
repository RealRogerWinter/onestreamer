// Claim event subsystem
//
// Periodically (or on demand) broadcasts a "CLAIM EVENT" StreamBot message
// containing a 4-digit code. Authenticated users redeem the code via the
// `!claim <code>` command (handler still lives in chat-service/index.js).
// This module owns the random code generation, the random scheduling, and
// the timeout that expires unclaimed events.
//
// Behavior must be byte-equivalent to the inline implementation it replaces.
// In particular: same code-generation algorithm (4-digit numeric), same
// reward range (1000-2000), same broadcast id/color/format, same scheduling
// window (20-60 minutes), same 60s expiry.

const DEFAULT_MIN_CLAIM_INTERVAL = 20 * 60 * 1000; // 20 minutes
const DEFAULT_MAX_CLAIM_INTERVAL = 60 * 60 * 1000; // 60 minutes
const DEFAULT_CLAIM_TIMEOUT = 60 * 1000;           // 60 seconds

/**
 * Create a claim event service.
 *
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io                 Socket.IO server (for broadcasting)
 * @param {Array<object>} deps.chatMessages                    Live ref to chat history array (for persistence)
 * @param {number} deps.MAX_CHAT_HISTORY                       Max history length before trim
 * @param {() => string} deps.formatTime                       Returns "HH:MM" for the message timestamp
 * @param {() => number} [deps.getUniqueViewerCount]           Reserved for future use (e.g. dynamic reward scaling)
 * @param {object} [deps.constants]
 * @param {number} [deps.constants.MIN_CLAIM_INTERVAL]
 * @param {number} [deps.constants.MAX_CLAIM_INTERVAL]
 * @param {number} [deps.constants.CLAIM_TIMEOUT]
 * @returns {{
 *   startClaimEvent: (manuallyTriggered?: boolean) => boolean,
 *   scheduleNextClaimEvent: () => void,
 *   generateClaimCode: () => string,
 *   getActiveClaim: () => (object|null),
 *   clearActiveClaim: () => void
 * }}
 */
function createClaimEventService(deps) {
  const {
    io,
    chatMessages,
    MAX_CHAT_HISTORY,
    formatTime,
    constants = {}
  } = deps;

  const MIN_CLAIM_INTERVAL = constants.MIN_CLAIM_INTERVAL ?? DEFAULT_MIN_CLAIM_INTERVAL;
  const MAX_CLAIM_INTERVAL = constants.MAX_CLAIM_INTERVAL ?? DEFAULT_MAX_CLAIM_INTERVAL;
  const CLAIM_TIMEOUT = constants.CLAIM_TIMEOUT ?? DEFAULT_CLAIM_TIMEOUT;

  // Module-private state (was previously module-scope in chat-service/index.js)
  let activeClaimEvent = null; // { code, reward, claimedBy, startedAt, manuallyTriggered }
  let claimEventTimer = null;  // setTimeout handle for the next scheduled event
  let lastClaimEventTime = 0;  // Wall-clock of last event start (informational)

  function generateClaimCode() {
    // Generate a random 4-digit code
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  function startClaimEvent(manuallyTriggered = false) {
    // Don't start a new event if one is already active
    if (activeClaimEvent) {
      return false;
    }

    const code = generateClaimCode();
    const reward = 1000 + Math.floor(Math.random() * 1001); // 1000-2000 points

    activeClaimEvent = {
      code: code,
      reward: reward,
      claimedBy: null,
      startedAt: Date.now(),
      manuallyTriggered: manuallyTriggered
    };

    // Announce the claim event
    const claimMessage = `🎉 CLAIM EVENT! Type !claim ${code} to win ${reward} points! ⏰ Expires in 60 seconds!`;
    const streamerBotMessage = {
      id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: '🤖 StreamBot',
      color: '#FFD700',
      message: claimMessage,
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true,
      isClaimEvent: true
    };

    chatMessages.push(streamerBotMessage);
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }

    io.emit('new-message', streamerBotMessage);

    // Set timeout to expire the claim event
    setTimeout(() => {
      if (activeClaimEvent && !activeClaimEvent.claimedBy) {
        const expiredMessage = `⏰ Claim event expired! No one claimed the ${activeClaimEvent.reward} points.`;
        const expiredBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#FF6B6B',
          message: expiredMessage,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(expiredBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', expiredBotMessage);
        activeClaimEvent = null;
      }
    }, CLAIM_TIMEOUT);

    lastClaimEventTime = Date.now();
    return true;
  }

  function scheduleNextClaimEvent() {
    // Clear existing timer if any
    if (claimEventTimer) {
      clearTimeout(claimEventTimer);
    }

    // Schedule next event with random interval (20-60 minutes)
    const nextEventDelay = MIN_CLAIM_INTERVAL + Math.random() * (MAX_CLAIM_INTERVAL - MIN_CLAIM_INTERVAL);
    const nextEventMinutes = Math.floor(nextEventDelay / 60000);

    console.log(`📅 CLAIM: Next claim event scheduled in ${nextEventMinutes} minutes`);

    claimEventTimer = setTimeout(() => {
      startClaimEvent(false);
      scheduleNextClaimEvent(); // Schedule the next one
    }, nextEventDelay);
  }

  // Returns the live active-claim object (or null). Callers may mutate
  // `.claimedBy` to record a winner; the parser in chat-service/index.js
  // relies on this. Use `clearActiveClaim()` to fully reset to null.
  function getActiveClaim() {
    return activeClaimEvent;
  }

  function clearActiveClaim() {
    activeClaimEvent = null;
  }

  return {
    startClaimEvent,
    scheduleNextClaimEvent,
    generateClaimCode,
    getActiveClaim,
    clearActiveClaim
  };
}

module.exports = createClaimEventService;
