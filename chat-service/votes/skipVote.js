// Skip vote (!next command).
//
// 75% of viewers needed within a 2-minute window. On pass, calls the main
// server's `/api/random-stream/rotate` endpoint to advance to the next
// random Twitch/Kick stream. Optional `platform` ('twitch'|'kick') filters
// rotation to one source.
//
// Cooldown:
//   - 2 minutes after a failed vote (VOTE_COOLDOWN_FAILED)
//   - 5 minutes after a successful skip (VOTE_COOLDOWN_SUCCESS)
// The parser still enforces cooldown by reading state.lastEndTime /
// state.lastPassed; we just maintain those values here.

const createVoteService = require('./voteService');

const SKIP_VOTE_DURATION = 2 * 60 * 1000; // 2 minutes voting window
const SKIP_VOTE_THRESHOLD = 0.75;          // 75% of viewers needed

function createSkipVote(deps) {
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
      kind: 'skip',
      idPrefix: 'streambot_skip',
      color: '#FF6B6B',
      actionVerb: 'skip',
      threshold: SKIP_VOTE_THRESHOLD,
      minRequiredVotes: 1,
      duration: SKIP_VOTE_DURATION,
      tracksPassed: true,

      announceStart({ initiator, extra, totalViewers, requiredVotes, sendMessage }) {
        const platform = extra.platform || null;
        const platformText = platform ? ` ${platform.charAt(0).toUpperCase() + platform.slice(1)}` : '';

        sendMessage(`🗳️ SKIP VOTE STARTED by ${initiator.username}! Type !next to vote to skip to the next${platformText} stream.`);
        sendMessage(`📊 ${requiredVotes} votes needed (75% of ${totalViewers} viewers). Vote ends in 2 minutes!`);
        sendMessage(`ℹ️ If the vote passes, we'll rotate to a${platform ? ` ${platform.charAt(0).toUpperCase() + platform.slice(1)}` : ' random Twitch/Kick'} stream.`);
        sendMessage(`✅ ${initiator.username} voted to skip! (1/${requiredVotes})`);

        console.log(`🗳️ SKIP VOTE: Started by ${initiator.username}${platformText ? ` for${platformText}` : ''}. Need ${requiredVotes}/${totalViewers} votes (75%).`);
      },

      async onPassed({ vote, voteCount, requiredVotes, sendMessage }) {
        const platform = vote.platform || null;
        const platformText = platform ? ` ${platform.charAt(0).toUpperCase() + platform.slice(1)}` : '';

        sendMessage(`🗳️ VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). Skipping to the next${platformText} stream...`);
        console.log(`🗳️ SKIP VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Triggering stream rotation${platform ? ` (${platform})` : ''}.`);

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/random-stream/rotate`,
            { platform },
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            console.log(`🗳️ SKIP VOTE: Stream rotation triggered successfully${platform ? ` (${platform})` : ''}`);
            io.emit('stream-info-update', { source: 'skip-vote', message: 'Stream skipped by chat vote' });
            try {
              await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
              console.log('🗳️ SKIP VOTE: Rotation timer unlocked after skip');
            } catch (unlockErr) {
              console.log('🗳️ SKIP VOTE: Timer was not locked or unlock failed:', unlockErr.message);
            }
          } else {
            sendMessage('⚠️ Vote passed but failed to skip stream. Try again later.');
            console.error('🗳️ SKIP VOTE: Stream rotation failed:', response.data.error);
          }
        } catch (error) {
          sendMessage('⚠️ Vote passed but failed to skip stream. Try again later.');
          console.error('🗳️ SKIP VOTE: Error triggering stream rotation:', error.message);
        }
      },

      onFailed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). The stream continues!`);
        sendMessage(`⏳ Next !next vote available in 2 minutes.`);
        console.log(`🗳️ SKIP VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
      }
    }
  });

  // Public API mirrors the legacy function names so the command parser keeps
  // calling `startSkipVote`, `registerSkipVote`, `clearSkipVoteTimers`, and
  // `sendSkipVoteMessage` unchanged.
  function startSkipVote(initiator, _io, platform = null) {
    service.start(initiator, { platform });
  }

  function registerSkipVote(user) {
    return service.register(user);
  }

  function clearSkipVoteTimers() {
    service.clearTimers();
  }

  function sendSkipVoteMessage(message) {
    service.sendMessage(message);
  }

  return {
    startSkipVote,
    registerSkipVote,
    clearSkipVoteTimers,
    sendSkipVoteMessage,
    state: service.state,
    constants: {
      SKIP_VOTE_DURATION,
      SKIP_VOTE_THRESHOLD
    }
  };
}

module.exports = createSkipVote;
