// Swap vote (!swap command).
//
// Same 75% threshold and 2-minute window as the skip vote, but instead of
// rotating to a random next stream it swaps to a specific Twitch/Kick channel
// supplied by the initiator. The URL is parsed before start() (so we don't
// commit a vote on an invalid URL) and the parsed parts ride along as
// vote-instance extras.
//
// Cooldown:
//   - 2 minutes after a failed vote (VOTE_COOLDOWN_FAILED)
//   - 5 minutes after a successful swap (VOTE_COOLDOWN_SUCCESS)

const createVoteService = require('./voteService');

const SWAP_VOTE_DURATION = 2 * 60 * 1000;  // matches SKIP_VOTE_DURATION
const SWAP_VOTE_THRESHOLD = 0.75;          // matches SKIP_VOTE_THRESHOLD

// Validate and parse Twitch/Kick URL. Returns { platform, channel, url }
// or null on no match. Kept here (rather than in voteService) because only
// the swap variant needs it.
function parseStreamUrl(url) {
  // Twitch URL patterns
  const twitchPatterns = [
    /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i,
    /(?:https?:\/\/)?(?:m\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i
  ];

  // Kick URL patterns
  const kickPatterns = [
    /(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)/i
  ];

  for (const pattern of twitchPatterns) {
    const match = url.match(pattern);
    if (match) {
      return { platform: 'twitch', channel: match[1], url: `https://twitch.tv/${match[1]}` };
    }
  }

  for (const pattern of kickPatterns) {
    const match = url.match(pattern);
    if (match) {
      return { platform: 'kick', channel: match[1], url: `https://kick.com/${match[1]}` };
    }
  }

  return null;
}

function createSwapVote(deps) {
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
      kind: 'swap',
      idPrefix: 'streambot_swap',
      color: '#9B59B6',
      actionVerb: 'swap',
      threshold: SWAP_VOTE_THRESHOLD,
      minRequiredVotes: 1,
      duration: SWAP_VOTE_DURATION,
      tracksPassed: true,

      announceStart({ initiator, extra, totalViewers, requiredVotes, sendMessage }) {
        const platformIcon = extra.platform === 'twitch' ? '📺' : '🟢';
        const platformName = extra.platform === 'twitch' ? 'Twitch' : 'Kick';

        sendMessage(`🔄 SWAP VOTE STARTED by ${initiator.username}!`);
        sendMessage(`${platformIcon} Target: ${platformName} channel "${extra.channel}" - ${extra.targetUrl}`);
        sendMessage(`📊 ${requiredVotes} votes needed (75% of ${totalViewers} viewers). Type !swap to vote! Vote ends in 2 minutes!`);
        sendMessage(`ℹ️ If the vote passes, we'll switch to ${extra.channel}'s ${platformName} stream (if they're live).`);
        sendMessage(`✅ ${initiator.username} voted to swap! (1/${requiredVotes})`);

        console.log(`🗳️ SWAP VOTE: Started by ${initiator.username} for ${extra.targetUrl}. Need ${requiredVotes}/${totalViewers} votes (75%).`);
      },

      async onPassed({ vote, voteCount, requiredVotes, sendMessage }) {
        const platformIcon = vote.platform === 'twitch' ? '📺' : '🟢';
        sendMessage(`🗳️ SWAP VOTE PASSED! ${voteCount}/${requiredVotes} votes (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). Swapping to ${platformIcon} ${vote.channel}...`);
        console.log(`🗳️ SWAP VOTE: Vote passed with ${voteCount}/${requiredVotes} votes. Swapping to ${vote.targetUrl}`);

        try {
          const response = await axios.post(
            `${MAIN_SERVER_URL}/api/url-stream`,
            {
              url: vote.targetUrl,
              quality: 'best',
              displayName: `${vote.channel} (Chat Vote)`,
              autoReconnect: true
            },
            getAxiosConfig({ timeout: 15000 })
          );

          if (response.data.success) {
            sendMessage(`✅ Successfully swapped to ${vote.platform === 'twitch' ? 'Twitch' : 'Kick'} channel: ${vote.channel}`);
            console.log('🗳️ SWAP VOTE: Stream swap triggered successfully');
            io.emit('stream-info-update', {
              source: 'swap-vote',
              channel: vote.channel,
              platform: vote.platform,
              message: `Swapped to ${vote.channel} by chat vote`
            });
            try {
              await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
              console.log('🗳️ SWAP VOTE: Rotation timer unlocked after swap');
            } catch (unlockErr) {
              console.log('🗳️ SWAP VOTE: Timer was not locked or unlock failed:', unlockErr.message);
            }
          } else {
            sendMessage(`⚠️ Vote passed but failed to swap: ${response.data.error || 'Unknown error'}. The stream may be offline.`);
            console.error('🗳️ SWAP VOTE: Stream swap failed:', response.data.error);
          }
        } catch (error) {
          const errorMsg = error.response?.data?.error || error.message;
          sendMessage(`⚠️ Vote passed but failed to swap: ${errorMsg}. The stream may be offline.`);
          console.error('🗳️ SWAP VOTE: Error triggering stream swap:', error.message);
        }
      },

      onFailed({ vote, voteCount, requiredVotes, sendMessage }) {
        sendMessage(`🗳️ SWAP VOTE FAILED. Only ${voteCount}/${requiredVotes} votes received (${Math.round(voteCount / vote.totalViewers * 100)}% of viewers). Staying on current stream!`);
        sendMessage(`⏳ Next !swap vote available in 2 minutes.`);
        console.log(`🗳️ SWAP VOTE: Vote failed with ${voteCount}/${requiredVotes} votes.`);
      }
    }
  });

  // Legacy signature: startSwapVote(initiator, targetUrl, parsedUrl, io).
  // We forward the parsed-URL pieces into the vote state via `extra`.
  function startSwapVote(initiator, targetUrl, parsedUrl, _io) {
    service.start(initiator, {
      targetUrl: parsedUrl.url,
      platform: parsedUrl.platform,
      channel: parsedUrl.channel
    });
  }

  function registerSwapVote(user) {
    return service.register(user);
  }

  function clearSwapVoteTimers() {
    service.clearTimers();
  }

  function sendSwapVoteMessage(message) {
    service.sendMessage(message);
  }

  return {
    startSwapVote,
    registerSwapVote,
    clearSwapVoteTimers,
    sendSwapVoteMessage,
    parseStreamUrl,
    state: service.state,
    constants: {
      SWAP_VOTE_DURATION,
      SWAP_VOTE_THRESHOLD
    }
  };
}

module.exports = createSwapVote;
module.exports.parseStreamUrl = parseStreamUrl;
