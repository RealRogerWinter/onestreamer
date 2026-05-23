// Common scaffold for chat-service vote subsystems.
//
// Each of the six vote types (skip, swap, extend, reduce, lock, unlock) has
// the same overall shape:
//   1. A StreamBot "vote message" helper with a type-specific color/prefix.
//   2. A timer array (warning at 1m / 30s / 5s, then the final end timer).
//   3. start(initiator, extra) -> seed active state, announce, schedule timers.
//   4. register(user) -> dedupe by IP, announce progress, early-terminate on
//      threshold.
//   5. end() -> clear timers, tally, call onPassed/onFailed callback, then
//      update last-end bookkeeping.
//
// This factory packages those pieces. Per-vote files in ./<name>Vote.js call
// createVoteService with a config object that supplies the type-specific bits
// (color, threshold, duration, action verb strings, axios calls in onPassed).
//
// State is exposed via the returned object's mutable `state` field so the
// command parser can keep doing direct cross-vote checks (`activeSkipVote`,
// `lastSkipVoteEndTime`, etc.) until PR-K4 migrates it to a structured form.
// Cross-vote concerns (one-at-a-time enforcement, single-viewer auto-execute,
// cooldown reads) stay in the parser; the service intentionally does not
// know about other vote types.

/**
 * Create a vote subsystem.
 *
 * @param {object} deps
 * @param {import('socket.io').Server} deps.io
 * @param {Array<object>} deps.chatMessages          Live ref to chat history.
 * @param {number} deps.MAX_CHAT_HISTORY
 * @param {() => string} deps.formatTime
 * @param {() => number} deps.getUniqueViewerCount
 * @param {object} deps.config
 * @param {string} deps.config.kind                  e.g. 'skip', 'swap'
 * @param {string} deps.config.idPrefix              e.g. 'streambot_skip'
 * @param {string} deps.config.color                 hex color for StreamBot
 * @param {string} deps.config.command               e.g. '!next', '!swap'
 * @param {string} deps.config.actionVerb            e.g. 'skip', 'swap', 'extend'
 * @param {number} deps.config.threshold             fraction 0..1
 * @param {number} deps.config.minRequiredVotes      e.g. 1 (skip/swap) or 2 (rest)
 * @param {number} deps.config.duration              ms — vote window
 * @param {boolean} deps.config.tracksPassed         skip/swap/lock/unlock track
 *                                                   passed-vs-failed for variable
 *                                                   cooldown; extend/reduce don't.
 * @param {(args: {
 *   initiator: object, extra: object, vote: object, totalViewers: number,
 *   requiredVotes: number, sendMessage: (msg: string) => void
 * }) => void} deps.config.announceStart            Sends the type-specific start banner
 * @param {(args: {
 *   vote: object, passed: boolean, voteCount: number, requiredVotes: number,
 *   sendMessage: (msg: string) => void
 * }) => Promise<void>|void} deps.config.onPassed   Runs the pass-path action
 *                                                   (axios call + follow-up
 *                                                   messages). Caller is
 *                                                   responsible for its own
 *                                                   error handling.
 * @param {(args: {
 *   vote: object, voteCount: number, requiredVotes: number,
 *   sendMessage: (msg: string) => void
 * }) => void} deps.config.onFailed                 Sends the fail-path
 *                                                   announcement (the verbiage
 *                                                   differs slightly per vote
 *                                                   type, hence a callback
 *                                                   rather than a template).
 */
function createVoteService(deps) {
  const {
    io,
    chatMessages,
    MAX_CHAT_HISTORY,
    formatTime,
    getUniqueViewerCount,
    config
  } = deps;

  const {
    kind,
    idPrefix,
    color,
    actionVerb,
    threshold,
    minRequiredVotes,
    duration,
    tracksPassed,
    announceStart,
    onPassed,
    onFailed
  } = config;

  // Lifecycle state. Exposed via the returned `state` object so the parser
  // can do its existing `if (activeXVote)` truthy checks and cooldown reads
  // until PR-K4 migrates it.
  const state = {
    active: null,         // null | { startTime, voters: Set, voterUsernames: Set, requiredVotes, totalViewers, initiator, ... }
    timers: [],           // setTimeout handles for warnings + end
    lastEndTime: 0,       // wall-clock of last end(); 0 means "no prior vote"
    lastPassed: false     // only meaningful when tracksPassed === true
  };

  // Send StreamBot vote message (used for start banner, progress, warnings,
  // and pass/fail tally).
  function sendMessage(message) {
    const botMessage = {
      id: `${idPrefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: '🤖 StreamBot',
      color,
      message,
      timestamp: formatTime(),
      fullTimestamp: new Date().toISOString(),
      isSystem: true
    };

    chatMessages.push(botMessage);
    if (chatMessages.length > MAX_CHAT_HISTORY) {
      chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
    }

    io.emit('new-message', botMessage);
  }

  function clearTimers() {
    state.timers.forEach(timerId => clearTimeout(timerId));
    state.timers = [];
  }

  async function end() {
    if (!state.active) return;

    const vote = state.active;
    const voteCount = vote.voters.size;
    const requiredVotes = vote.requiredVotes;
    const passed = voteCount >= requiredVotes;

    // Clear timers + reset active before the async action so re-entries don't
    // see a stale vote. Match the legacy ordering: lastEndTime/lastPassed
    // also flip here, then the action runs.
    clearTimers();
    state.active = null;
    state.lastEndTime = Date.now();
    if (tracksPassed) {
      state.lastPassed = passed;
    }

    if (passed) {
      await onPassed({ vote, passed, voteCount, requiredVotes, sendMessage });
    } else {
      onFailed({ vote, voteCount, requiredVotes, sendMessage });
    }
  }

  // Start a new vote. `extra` carries vote-specific seed fields that the
  // skip/swap variants need (e.g. platform, targetUrl, channel).
  function start(initiator, extra = {}) {
    const totalViewers = getUniqueViewerCount();
    const computedRequired = Math.ceil(totalViewers * threshold);
    const requiredVotes = Math.max(computedRequired, minRequiredVotes);

    state.active = {
      startTime: Date.now(),
      voters: new Set([initiator.ip]),
      voterUsernames: new Set([initiator.username]),
      requiredVotes,
      totalViewers,
      initiator: initiator.username,
      ...extra
    };

    announceStart({
      initiator,
      extra,
      vote: state.active,
      totalViewers,
      requiredVotes,
      sendMessage
    });

    // Warning timer pattern: 1m, 30s, 5s, then end at `duration`. The
    // verbiage of each warning is the same across vote types apart from the
    // verb ("vote to skip", "vote to swap", etc.). The swap vote has one
    // extra "to {channel}" fragment in its 1-minute warning — that's
    // handled inline below as a special case to preserve byte-equivalence
    // with the legacy messages.
    state.timers.push(setTimeout(() => {
      if (state.active) {
        const currentVotes = state.active.voters.size;
        if (kind === 'swap') {
          sendMessage(
            `⏰ 1 MINUTE remaining! ${currentVotes}/${state.active.requiredVotes} votes to swap to ${state.active.channel}. Type !swap to vote!`
          );
        } else {
          // skip/extend/reduce/lock/unlock all use either "votes so far. Type
          // !X to vote!" or "votes to {verb}. Type !X to vote!". Match each
          // legacy exactly.
          if (kind === 'extend') {
            sendMessage(
              `⏰ 1 MINUTE remaining! ${currentVotes}/${state.active.requiredVotes} votes to extend. Type !extend to vote!`
            );
          } else {
            sendMessage(
              `⏰ 1 MINUTE remaining! ${currentVotes}/${state.active.requiredVotes} votes so far. Type !${legacyCommandForKind(kind)} to vote!`
            );
          }
        }
      }
    }, 60 * 1000));

    state.timers.push(setTimeout(() => {
      if (state.active) {
        const currentVotes = state.active.voters.size;
        sendMessage(`⏰ 30 SECONDS remaining! ${currentVotes}/${state.active.requiredVotes} votes. Hurry!`);
      }
    }, 90 * 1000));

    state.timers.push(setTimeout(() => {
      if (state.active) {
        const currentVotes = state.active.voters.size;
        sendMessage(`⏰ 5 SECONDS! Final count: ${currentVotes}/${state.active.requiredVotes} votes!`);
      }
    }, 115 * 1000));

    state.timers.push(setTimeout(() => {
      end();
    }, duration));
  }

  // Register a vote from `user`. Returns false if the user already voted
  // (IP-deduped) or if there is no active vote. Triggers an early end() when
  // the threshold is reached.
  function register(user) {
    if (!state.active) return false;

    if (state.active.voters.has(user.ip)) {
      return false;
    }

    state.active.voters.add(user.ip);
    state.active.voterUsernames.add(user.username);

    const currentVotes = state.active.voters.size;
    const requiredVotes = state.active.requiredVotes;

    sendMessage(`✅ ${user.username} voted to ${actionVerb}! (${currentVotes}/${requiredVotes})`);
    console.log(`🗳️ ${kind.toUpperCase()} VOTE: ${user.username} voted. ${currentVotes}/${requiredVotes} votes.`);

    if (currentVotes >= requiredVotes) {
      sendMessage(`🎉 Vote threshold reached early!`);
      end();
    }

    return true;
  }

  return {
    state,
    sendMessage,
    clearTimers,
    start,
    register,
    end
  };
}

// Maps internal `kind` to the legacy `!command` token used in warning
// strings. Only the 1-minute warning needs this (the 30s/5s warnings don't
// mention the command name).
function legacyCommandForKind(kind) {
  switch (kind) {
    case 'skip':   return 'next';
    case 'swap':   return 'swap';
    case 'extend': return 'extend';
    case 'reduce': return 'reduce';
    case 'lock':   return 'lock';
    case 'unlock': return 'unlock';
    default:       return kind;
  }
}

module.exports = createVoteService;
