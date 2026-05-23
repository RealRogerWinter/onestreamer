// Reduce vote (!reduce command).
//
// Same shape as extend but the action is "reduce the rotation timer by
// 3-5 minutes" via `/api/random-stream/reduce`. 33% threshold, minimum 2
// votes, 2-minute window, 5-minute cooldown (REDUCE_VOTE_COOLDOWN). Like
// extend, cooldown is fixed (not pass/fail dependent), so tracksPassed =
// false.

const createVoteService = require('./voteService');

const REDUCE_VOTE_DURATION = 2 * 60 * 1000;
const REDUCE_VOTE_THRESHOLD = 0.33;
const REDUCE_VOTE_COOLDOWN = 5 * 60 * 1000;

function createReduceVote(deps) {
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
      kind: 'reduce',
      idPrefix: 'streambot_reduce',
      color: '#F59E0B',
      actionVerb: 'reduce',
      threshold: REDUCE_VOTE_THRESHOLD,
      minRequiredVotes: 2,
      duration: REDUCE_VOTE_DURATION,
      tracksPassed: false,

      announceStart({ initiator, totalViewers, requiredVotes, sendMessage }) {
        sendMessage(`⏰ REDUCE VOTE STARTED by ${initiator.username}! Type !reduce to vote to reduce stream time.`);
        sendMessage(`📊 ${requiredVotes} votes needed (33% of ${totalViewers} viewers). Vote ends in 2 minutes!`);
        sendMessage(`ℹ️ If the vote passes, stream time will be reduced by 3-5 minutes.`);
        sendMessage(`✅ ${initiator.username} voted to reduce! (1/${requiredVotes})`);
        console.log(`🗳️ REDUCE VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (33%).`);
      },

      async onPassed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ REDUCE VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). Reducing stream time...`);
        console.log(`🗳️ REDUCE VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Reducing rotation time.`);

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/reduce`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendMessage(`⏰ Stream time reduced by ${response.data.reducedByMinutes} minutes!`);
            console.log(`🗳️ REDUCE VOTE: Rotation reduced by ${response.data.reducedByMinutes} minutes`);
          } else {
            sendMessage('⚠️ Vote passed but failed to reduce time. Try again later.');
            console.error('🗳️ REDUCE VOTE: Reduce failed:', response.data.error);
          }
        } catch (error) {
          sendMessage('⚠️ Vote passed but failed to reduce time. Try again later.');
          console.error('🗳️ REDUCE VOTE: Error reducing rotation:', error.message);
        }
      },

      onFailed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ REDUCE VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers).`);
        sendMessage(`⏳ Next !reduce vote available in 2 minutes.`);
        console.log(`🗳️ REDUCE VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
      }
    }
  });

  function startReduceVote(initiator, _io) {
    service.start(initiator);
  }

  function registerReduceVote(user) {
    return service.register(user);
  }

  function clearReduceVoteTimers() {
    service.clearTimers();
  }

  function sendReduceVoteMessage(message) {
    service.sendMessage(message);
  }

  return {
    startReduceVote,
    registerReduceVote,
    clearReduceVoteTimers,
    sendReduceVoteMessage,
    state: service.state,
    constants: {
      REDUCE_VOTE_DURATION,
      REDUCE_VOTE_THRESHOLD,
      REDUCE_VOTE_COOLDOWN
    }
  };
}

module.exports = createReduceVote;
