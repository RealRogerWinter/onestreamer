// Lock vote (!lock command).
//
// Highest bar of the six: 100% of viewers needed to pass (every connected,
// non-bot user must !lock within the window). Minimum 2 votes regardless.
// On pass, calls `/api/random-stream/lock` to freeze the rotation timer until
// either a !unlock vote passes or a !next vote passes.
//
// Cooldown is pass/fail dependent: LOCK_VOTE_COOLDOWN after success,
// VOTE_COOLDOWN_FAILED after fail. tracksPassed = true so the parser can
// switch between them.

const createVoteService = require('./voteService');

const LOCK_VOTE_DURATION = 2 * 60 * 1000;
const LOCK_VOTE_THRESHOLD = 1.0;
const LOCK_VOTE_COOLDOWN = 5 * 60 * 1000;

function createLockVote(deps) {
  const {
    io,
    chatMessages,
    MAX_CHAT_HISTORY,
    formatTime,
    getUniqueViewerCount,
    axios,
    MAIN_SERVER_URL,
    getAxiosConfig
  } = deps;

  const service = createVoteService({
    io,
    chatMessages,
    MAX_CHAT_HISTORY,
    formatTime,
    getUniqueViewerCount,
    config: {
      kind: 'lock',
      idPrefix: 'streambot_lock',
      color: '#EF4444',
      actionVerb: 'lock',
      threshold: LOCK_VOTE_THRESHOLD,
      minRequiredVotes: 2,
      duration: LOCK_VOTE_DURATION,
      tracksPassed: true,

      announceStart({ initiator, totalViewers, requiredVotes, sendMessage }) {
        sendMessage(`🔒 LOCK VOTE STARTED by ${initiator.username}! Type !lock to vote to lock the rotation.`);
        sendMessage(`📊 ${requiredVotes} votes needed (100% of ${totalViewers} viewers). Vote ends in 2 minutes!`);
        sendMessage(`ℹ️ If the vote passes, stream will NOT rotate until a successful !next vote.`);
        sendMessage(`✅ ${initiator.username} voted to lock! (1/${requiredVotes})`);
        console.log(`🗳️ LOCK VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (100%).`);
      },

      async onPassed({ voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ LOCK VOTE PASSED! ${voteCount}/${requiredVotes} votes (100% of viewers). Locking rotation...`);
        console.log(`🗳️ LOCK VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Locking rotation.`);

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/lock`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendMessage(`🔒 Rotation LOCKED! Stream will not rotate until a successful !next vote.`);
            console.log('🗳️ LOCK VOTE: Rotation locked successfully');
          } else {
            sendMessage('⚠️ Vote passed but failed to lock rotation. Try again later.');
            console.error('🗳️ LOCK VOTE: Lock failed:', response.data.error);
          }
        } catch (error) {
          sendMessage('⚠️ Vote passed but failed to lock rotation. Try again later.');
          console.error('🗳️ LOCK VOTE: Error locking rotation:', error.message);
        }
      },

      onFailed({ voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ LOCK VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received. Need 100% of viewers!`);
        sendMessage(`⏳ Next !lock vote available in 2 minutes.`);
        console.log(`🗳️ LOCK VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
      }
    }
  });

  function startLockVote(initiator, _io) {
    service.start(initiator);
  }

  function registerLockVote(user) {
    return service.register(user);
  }

  function clearLockVoteTimers() {
    service.clearTimers();
  }

  function sendLockVoteMessage(message) {
    service.sendMessage(message);
  }

  return {
    startLockVote,
    registerLockVote,
    clearLockVoteTimers,
    sendLockVoteMessage,
    state: service.state,
    constants: {
      LOCK_VOTE_DURATION,
      LOCK_VOTE_THRESHOLD,
      LOCK_VOTE_COOLDOWN
    }
  };
}

module.exports = createLockVote;
