// Unlock vote (!unlock command).
//
// Counter to lock: 50% of viewers needed to release a previously-locked
// rotation. Minimum 2 votes, 2-minute window. On pass, calls
// `/api/random-stream/unlock`.
//
// Cooldown is pass/fail dependent: UNLOCK_VOTE_COOLDOWN after success,
// VOTE_COOLDOWN_FAILED after fail. tracksPassed = true.

const createVoteService = require('./voteService');

const UNLOCK_VOTE_DURATION = 2 * 60 * 1000;
const UNLOCK_VOTE_THRESHOLD = 0.5;
const UNLOCK_VOTE_COOLDOWN = 5 * 60 * 1000;

function createUnlockVote(deps) {
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
      kind: 'unlock',
      idPrefix: 'streambot_unlock',
      color: '#22C55E',
      actionVerb: 'unlock',
      threshold: UNLOCK_VOTE_THRESHOLD,
      minRequiredVotes: 2,
      duration: UNLOCK_VOTE_DURATION,
      tracksPassed: true,

      announceStart({ initiator, totalViewers, requiredVotes, sendMessage }) {
        sendMessage(`🔓 UNLOCK VOTE STARTED by ${initiator.username}! Type !unlock to vote to unlock the rotation.`);
        sendMessage(`📊 ${requiredVotes} votes needed (50% of ${totalViewers} viewers). Vote ends in 2 minutes!`);
        sendMessage(`ℹ️ If the vote passes, stream will resume normal rotation schedule.`);
        sendMessage(`✅ ${initiator.username} voted to unlock! (1/${requiredVotes})`);
        console.log(`🗳️ UNLOCK VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (50%).`);
      },

      async onPassed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ UNLOCK VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). Unlocking rotation...`);
        console.log(`🗳️ UNLOCK VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Unlocking rotation.`);

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/unlock`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendMessage(`🔓 Rotation UNLOCKED! Stream will rotate at the next scheduled time.`);
            console.log('🗳️ UNLOCK VOTE: Rotation unlocked successfully');
          } else {
            sendMessage('⚠️ Vote passed but failed to unlock rotation. Try again later.');
            console.error('🗳️ UNLOCK VOTE: Unlock failed:', response.data.error);
          }
        } catch (error) {
          sendMessage('⚠️ Vote passed but failed to unlock rotation. Try again later.');
          console.error('🗳️ UNLOCK VOTE: Error unlocking rotation:', error.message);
        }
      },

      onFailed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ UNLOCK VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers).`);
        sendMessage(`⏳ Next !unlock vote available in 2 minutes.`);
        console.log(`🗳️ UNLOCK VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
      }
    }
  });

  function startUnlockVote(initiator, _io) {
    service.start(initiator);
  }

  function registerUnlockVote(user) {
    return service.register(user);
  }

  function clearUnlockVoteTimers() {
    service.clearTimers();
  }

  function sendUnlockVoteMessage(message) {
    service.sendMessage(message);
  }

  return {
    startUnlockVote,
    registerUnlockVote,
    clearUnlockVoteTimers,
    sendUnlockVoteMessage,
    state: service.state,
    constants: {
      UNLOCK_VOTE_DURATION,
      UNLOCK_VOTE_THRESHOLD,
      UNLOCK_VOTE_COOLDOWN
    }
  };
}

module.exports = createUnlockVote;
