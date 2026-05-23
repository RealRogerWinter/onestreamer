// Extend vote (!extend command).
//
// 33% of viewers needed (lower threshold) within a 2-minute window. Minimum
// 2 votes regardless of viewer count. On pass, calls the main server's
// `/api/random-stream/extend` endpoint, which adds 3-5 minutes to the
// rotation timer (the exact amount is decided server-side and reported back).
//
// Cooldown: 5 minutes between extend votes regardless of pass/fail
// (EXTEND_VOTE_COOLDOWN). The parser does the cooldown check; we only need
// to maintain state.lastEndTime. tracksPassed = false.

const createVoteService = require('./voteService');

const EXTEND_VOTE_DURATION = 2 * 60 * 1000;
const EXTEND_VOTE_THRESHOLD = 0.33;
const EXTEND_VOTE_COOLDOWN = 5 * 60 * 1000;

function createExtendVote(deps) {
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
      kind: 'extend',
      idPrefix: 'streambot_extend',
      color: '#10B981',
      actionVerb: 'extend',
      threshold: EXTEND_VOTE_THRESHOLD,
      minRequiredVotes: 2,
      duration: EXTEND_VOTE_DURATION,
      tracksPassed: false,

      announceStart({ initiator, totalViewers, requiredVotes, sendMessage }) {
        sendMessage(`⏰ EXTEND VOTE STARTED by ${initiator.username}!`);
        sendMessage(`📊 ${requiredVotes} votes needed (33% of ${totalViewers} viewers). Type !extend to vote! Vote ends in 2 minutes!`);
        sendMessage(`ℹ️ If the vote passes, the stream will be extended by 3-5 extra minutes before switching.`);
        sendMessage(`✅ ${initiator.username} voted to extend! (1/${requiredVotes})`);
        console.log(`🗳️ EXTEND VOTE: Started by ${initiator.username}. Need ${requiredVotes}/${totalViewers} votes (33%).`);
      },

      async onPassed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🎉 EXTEND VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). Extending the stream time...`);
        console.log(`🗳️ EXTEND VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Extending rotation timer.`);

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/extend`,
            {},
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            sendMessage(`⏰ Stream extended by ${response.data.extendedByMinutes} minutes! Enjoy the extra time!`);
            console.log('🗳️ EXTEND VOTE: Rotation extend triggered successfully');
            io.emit('stream-info-update', { source: 'extend-vote', message: 'Stream extended by chat vote' });
          } else {
            sendMessage(`⚠️ Vote passed but failed to extend: ${response.data.error || 'Unknown error'}`);
            console.error('🗳️ EXTEND VOTE: Rotation extend failed:', response.data.error);
          }
        } catch (error) {
          const errorMsg = error.response?.data?.error || error.message;
          sendMessage(`⚠️ Vote passed but failed to extend: ${errorMsg}`);
          console.error('🗳️ EXTEND VOTE: Error triggering extend:', error.message);
        }
      },

      onFailed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ EXTEND VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). The timer continues as scheduled!`);
        sendMessage(`⏳ Next !extend vote available in 5 minutes.`);
        console.log(`🗳️ EXTEND VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
      }
    }
  });

  function startExtendVote(initiator, _io) {
    service.start(initiator);
  }

  function registerExtendVote(user) {
    return service.register(user);
  }

  function clearExtendVoteTimers() {
    service.clearTimers();
  }

  function sendExtendVoteMessage(message) {
    service.sendMessage(message);
  }

  return {
    startExtendVote,
    registerExtendVote,
    clearExtendVoteTimers,
    sendExtendVoteMessage,
    state: service.state,
    constants: {
      EXTEND_VOTE_DURATION,
      EXTEND_VOTE_THRESHOLD,
      EXTEND_VOTE_COOLDOWN
    }
  };
}

module.exports = createExtendVote;
