// Public command parser (`!xxx` commands).
//
// Owns the big switch that dispatches in-chat commands sent by viewers:
// !give, !who, !stats, !top, !uptime, !channel, !help, !roll, !coinflip,
// !gamble, !slots, !claim, !gift, !discord, !next, !swap, !extend,
// !reduce, !lock, !unlock.
//
// Behavior must remain byte-equivalent to the inline implementation in
// chat-service/index.js prior to PR-K4:
//   - Same per-vote cooldown gates and cross-vote mutual exclusion.
//   - Same single-viewer auto-execute paths (and shared 60s cooldown).
//   - Same StreamBot chat outputs (color, prefix, MAX_CHAT_HISTORY trim).
//   - Same admin-only / authenticated gates per command.
//
// The parser does NOT extract:
//   - The pre-`!` flow (rate-limiting, profanity, ban/timeout, duplicate
//     detection) — that stays in chat-service/index.js's send-message
//     handler.
//   - Admin `/` commands — those are dispatched via `adminCommands` in
//     index.js.
//   - Vote subsystem internals — owned by ./votes/*Vote.js (PR-K3).
//   - Claim event internals — owned by ./claims/claimEventService.js
//     (PR-K).
//   - Moderation state — owned by ./moderation/moderationService.js
//     (PR-K2).
//
// Single-viewer cooldown (`lastSingleViewerActionTime`) lives here because
// only the parser reads/writes it. Cross-vote cooldown constants
// (VOTE_COOLDOWN_FAILED / VOTE_COOLDOWN_SUCCESS) are passed in via deps so
// index.js can keep them as the canonical source.

const { formatDuration } = require('./formatters');

/**
 * Create a public-command parser.
 *
 * @param {object} deps
 * @param {object} deps.io                          socket.io server instance
 * @param {Array<object>} deps.chatMessages         in-memory message ring
 * @param {number} deps.MAX_CHAT_HISTORY            ring size
 * @param {() => string} deps.formatTime            "HH:MM" formatter
 * @param {() => number} deps.getUniqueViewerCount  unique non-bot IP count
 * @param {object} deps.axios                       axios instance
 * @param {string} deps.MAIN_SERVER_URL             main server base URL
 * @param {(extra?: object) => object} deps.getAxiosConfig  axios config helper
 * @param {(socket: object, message: string) => void} deps.sendAdminResponse
 * @param {object} deps.claimEventService           { getActiveClaim, clearActiveClaim }
 * @param {object} deps.voteServices                { skipVote, swapVote, extendVote, reduceVote, lockVote, unlockVote }
 * @param {object} deps.voteCooldowns               { VOTE_COOLDOWN_FAILED, VOTE_COOLDOWN_SUCCESS, EXTEND_VOTE_COOLDOWN, REDUCE_VOTE_COOLDOWN, LOCK_VOTE_COOLDOWN, UNLOCK_VOTE_COOLDOWN, SINGLE_VIEWER_ACTION_COOLDOWN }
 * @returns {{ parse: (command: string, args: string[], user: object, socket: object) => Promise<void> }}
 */
function createCommandParser(deps) {
  const {
    io,
    chatMessages,
    MAX_CHAT_HISTORY,
    formatTime,
    getUniqueViewerCount,
    axios,
    MAIN_SERVER_URL,
    getAxiosConfig,
    sendAdminResponse,
    claimEventService,
    voteServices,
    voteCooldowns
  } = deps;

  const {
    skipVote,
    swapVote,
    extendVote,
    reduceVote,
    lockVote,
    unlockVote
  } = voteServices;

  const {
    startSkipVote, registerSkipVote, sendSkipVoteMessage
  } = skipVote;
  const {
    startSwapVote, registerSwapVote, sendSwapVoteMessage, parseStreamUrl
  } = swapVote;
  const {
    startExtendVote, registerExtendVote, sendExtendVoteMessage
  } = extendVote;
  const {
    startReduceVote, registerReduceVote, sendReduceVoteMessage
  } = reduceVote;
  const {
    startLockVote, registerLockVote, sendLockVoteMessage
  } = lockVote;
  const {
    startUnlockVote, registerUnlockVote, sendUnlockVoteMessage
  } = unlockVote;

  const {
    VOTE_COOLDOWN_FAILED,
    VOTE_COOLDOWN_SUCCESS,
    EXTEND_VOTE_COOLDOWN,
    REDUCE_VOTE_COOLDOWN,
    LOCK_VOTE_COOLDOWN,
    UNLOCK_VOTE_COOLDOWN,
    SINGLE_VIEWER_ACTION_COOLDOWN
  } = voteCooldowns;

  // Single-viewer cooldown timestamp. Lives inside the parser closure: only
  // the parser reads/writes it (the auto-execute paths in !next/!swap/
  // !extend/!reduce/!lock/!unlock). Initialized to 0 so the first solo
  // action is always allowed.
  let lastSingleViewerActionTime = 0;

  async function parse(command, args, user, socket) {
    switch(command) {
      case 'give':
        if (!user.isAuthenticated) {
          sendAdminResponse(socket, '❌ You must be logged in to give points. Please login first.');
          return;
        }

        if (args.length < 2) {
          sendAdminResponse(socket, 'Usage: !give [username] [amount]');
          return;
        }

        const giveAmount = parseInt(args[args.length - 1]);
        const giveTargetUsername = args.slice(0, -1).join(' ');

        if (isNaN(giveAmount) || giveAmount <= 0) {
          sendAdminResponse(socket, 'Invalid amount. Please provide a positive number.');
          return;
        }

        try {
          const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/transfer-points`, {
            fromUserId: user.authenticatedUserId,
            toUsername: giveTargetUsername,
            amount: giveAmount,
            senderUsername: user.username
          }, getAxiosConfig({
            headers: {
              'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
            },
            timeout: 10000
          }));

          if (response.data.success) {
            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: `${user.username} gave ${giveTargetUsername} ${giveAmount} points!`,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', streamerBotMessage);
          } else {
            sendAdminResponse(socket, `❌ Failed to give points: ${response.data.error}`);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to give points:', error.message);
          sendAdminResponse(socket, `❌ Failed to give points: ${error.response?.data?.error || error.message}`);
        }
        break;

      case 'who':
        if (args.length < 1) {
          sendAdminResponse(socket, 'Usage: !who [username]');
          return;
        }

        const whoTargetUsername = args.join(' ');

        try {
          const response = await axios.get(
            `${MAIN_SERVER_URL}/api/internal/user-stats/${encodeURIComponent(whoTargetUsername)}`,
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            const stats = response.data.stats;

            let statsMessage = `📊 Stats for ${whoTargetUsername}: `;
            statsMessage += `Points: ${stats.points_balance || 0} | `;
            statsMessage += `Watch Time: ${formatDuration(stats.total_view_time || 0)} | `;
            statsMessage += `Stream Time: ${formatDuration(stats.total_stream_time || 0)} | `;
            statsMessage += `Chat Messages: ${stats.chat_message_count || 0}`;

            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: statsMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', streamerBotMessage);
          } else {
            sendAdminResponse(socket, `❌ User '${whoTargetUsername}' not found`);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to get user stats:', error.message);
          if (error.response?.status === 404) {
            sendAdminResponse(socket, `❌ User '${whoTargetUsername}' not found`);
          } else {
            sendAdminResponse(socket, `❌ Failed to get user stats: ${error.response?.data?.error || error.message}`);
          }
        }
        break;

      case 'stats':
        // Show user's own stats
        if (!user.isAuthenticated) {
          sendAdminResponse(socket, '❌ You must be logged in to view your stats.');
          return;
        }

        try {
          const response = await axios.get(
            `${MAIN_SERVER_URL}/api/internal/user-stats/${encodeURIComponent(user.username)}`,
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            const stats = response.data.stats;

            let statsMessage = `📊 Your stats: `;
            statsMessage += `Points: ${stats.points_balance || 0} | `;
            statsMessage += `Watch Time: ${formatDuration(stats.total_view_time || 0)} | `;
            statsMessage += `Stream Time: ${formatDuration(stats.total_stream_time || 0)} | `;
            statsMessage += `Chat Messages: ${stats.chat_message_count || 0}`;

            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: statsMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', streamerBotMessage);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to get user stats:', error.message);
          sendAdminResponse(socket, `❌ Failed to get your stats`);
        }
        break;

      case 'top':
        // Show leaderboard
        try {
          const response = await axios.get(
            `${MAIN_SERVER_URL}/api/internal/leaderboard`,
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success && response.data.leaderboard.length > 0) {
            let leaderMessage = '🏆 Top 10 Users by Points:\n';
            response.data.leaderboard.forEach((entry, index) => {
              leaderMessage += `${index + 1}. ${entry.username}: ${entry.points_balance || 0} points\n`;
            });

            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: leaderMessage.trim(),
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', streamerBotMessage);
          } else {
            sendAdminResponse(socket, '❌ No leaderboard data available');
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to get leaderboard:', error.message);
          sendAdminResponse(socket, '❌ Failed to get leaderboard');
        }
        break;

      case 'uptime':
        // Show stream uptime
        try {
          const response = await axios.get(
            `${MAIN_SERVER_URL}/api/internal/stream-uptime`,
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success) {
            const { isLive, uptime, streamer } = response.data;

            if (isLive) {
              const hours = Math.floor(uptime / 3600);
              const minutes = Math.floor((uptime % 3600) / 60);
              const seconds = uptime % 60;

              let uptimeStr = '';
              if (hours > 0) uptimeStr += `${hours}h `;
              if (minutes > 0) uptimeStr += `${minutes}m `;
              uptimeStr += `${seconds}s`;

              const message = `🔴 ${streamer || 'Stream'} has been live for ${uptimeStr}`;

              const streamerBotMessage = {
                id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                username: '🤖 StreamBot',
                color: '#00FF00',
                message,
                timestamp: formatTime(),
                fullTimestamp: new Date().toISOString(),
                isSystem: true
              };

              chatMessages.push(streamerBotMessage);
              if (chatMessages.length > MAX_CHAT_HISTORY) {
                chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
              }

              io.emit('new-message', streamerBotMessage);
            } else {
              const streamerBotMessage = {
                id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                username: '🤖 StreamBot',
                color: '#00FF00',
                message: '📺 No stream is currently live',
                timestamp: formatTime(),
                fullTimestamp: new Date().toISOString(),
                isSystem: true
              };

              chatMessages.push(streamerBotMessage);
              if (chatMessages.length > MAX_CHAT_HISTORY) {
                chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
              }

              io.emit('new-message', streamerBotMessage);
            }
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to get uptime:', error.message);
          sendAdminResponse(socket, '❌ Failed to get stream uptime');
        }
        break;

      case 'help':
        const helpMessage = `📖 Available Commands:
!give [user] [amount] - Give points to another user
!who [user] - Show user stats
!stats - Show your own stats
!top - Show points leaderboard
!uptime - Show stream uptime
!channel - Show current random channel info
!next [kick|twitch] - Vote to skip to next stream (75% needed)
!swap [url] - Vote to swap to a specific stream (75% needed)
!extend - Vote to extend current stream by 3-5 minutes (33% needed)
!reduce - Vote to reduce current stream by 3-5 minutes (33% needed)
!lock - Vote to lock rotation (100% needed, stops auto-rotate)
!unlock - Vote to unlock rotation (50% needed, resumes auto-rotate)
!roll - Roll a dice (1-6)
!coinflip - Flip a coin
!gamble [amount] - 50/50 chance to double or lose
!slots [amount] - Play slots (costs 10 points minimum)
!gift [item] [user] [quantity] - Gift an item to another user
!claim [code] - Claim points during a claim event
!discord - Get the Discord invite link
!help - Show this help message`;

        const streamerBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#00FF00',
          message: helpMessage,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(streamerBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', streamerBotMessage);
        break;

      case 'roll':
        const roll = Math.floor(Math.random() * 6) + 1;
        const rollMessage = `🎲 ${user.username} rolled a ${roll}!`;

        const rollBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#00FF00',
          message: rollMessage,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(rollBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', rollBotMessage);
        break;

      case 'coinflip':
        const flip = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const flipMessage = `🪙 ${user.username} flipped ${flip}!`;

        const flipBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#00FF00',
          message: flipMessage,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(flipBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', flipBotMessage);
        break;

      case 'gamble':
        if (!user.isAuthenticated) {
          sendAdminResponse(socket, '❌ You must be logged in to gamble.');
          return;
        }

        if (args.length < 1) {
          sendAdminResponse(socket, 'Usage: !gamble [amount]');
          return;
        }

        const gambleAmount = parseInt(args[0]);

        if (isNaN(gambleAmount) || gambleAmount <= 0) {
          sendAdminResponse(socket, 'Invalid amount. Please provide a positive number.');
          return;
        }

        try {
          const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/gamble`, {
            userId: user.authenticatedUserId,
            amount: gambleAmount
          }, getAxiosConfig({
            headers: {
              'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
            },
            timeout: 10000
          }));

          if (response.data.success) {
            const { won, newBalance } = response.data;
            const gambleMessage = won
              ? `🎰 ${user.username} won ${gambleAmount} points! New balance: ${newBalance}`
              : `💸 ${user.username} lost ${gambleAmount} points! New balance: ${newBalance}`;

            const gambleBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: gambleMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(gambleBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', gambleBotMessage);
          } else {
            sendAdminResponse(socket, `❌ ${response.data.error}`);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to gamble:', error.message);
          sendAdminResponse(socket, `❌ Failed to gamble: ${error.response?.data?.error || error.message}`);
        }
        break;

      case 'slots':
        if (!user.isAuthenticated) {
          sendAdminResponse(socket, '❌ You must be logged in to play slots.');
          return;
        }

        const slotAmount = args.length > 0 ? parseInt(args[0]) : 10;

        if (isNaN(slotAmount) || slotAmount < 10) {
          sendAdminResponse(socket, 'Minimum bet is 10 points. Usage: !slots [amount]');
          return;
        }

        try {
          const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/slots`, {
            userId: user.authenticatedUserId,
            amount: slotAmount
          }, getAxiosConfig({
            headers: {
              'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
            },
            timeout: 10000
          }));

          if (response.data.success) {
            const { symbols, winAmount, newBalance } = response.data;
            const slotsMessage = winAmount > 0
              ? `🎰 ${user.username} spun [${symbols.join(' ')}] and won ${winAmount} points! New balance: ${newBalance}`
              : `🎰 ${user.username} spun [${symbols.join(' ')}] and lost ${slotAmount} points! New balance: ${newBalance}`;

            const slotsBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: slotsMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(slotsBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', slotsBotMessage);
          } else {
            sendAdminResponse(socket, `❌ ${response.data.error}`);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to play slots:', error.message);
          sendAdminResponse(socket, `❌ Failed to play slots: ${error.response?.data?.error || error.message}`);
        }
        break;

      case 'claim': {
        // Active-claim state lives in claimEventService. Capture the live
        // object reference for this branch; property mutations on it
        // (e.g. .claimedBy) are visible to the service, which is the contract
        // the previous inline implementation also relied on.
        const activeClaimEvent = claimEventService.getActiveClaim();

        // Check if a claim event is active
        if (!activeClaimEvent) {
          sendAdminResponse(socket, '❌ No active claim event right now. Wait for the next one!');
          return;
        }

        // Check if already claimed
        if (activeClaimEvent.claimedBy) {
          sendAdminResponse(socket, `❌ Too late! This event was already claimed by ${activeClaimEvent.claimedBy}.`);
          return;
        }

        // Check if user provided the correct code
        if (args.length === 0 || args[0] !== activeClaimEvent.code) {
          sendAdminResponse(socket, '❌ Invalid claim code. Check the announcement and try again!');
          return;
        }

        // User must be authenticated to claim
        if (!user.isAuthenticated) {
          sendAdminResponse(socket, '❌ You must be logged in to claim rewards.');
          return;
        }

        // Process the claim
        activeClaimEvent.claimedBy = user.username;
        const claimedReward = activeClaimEvent.reward;

        // Award points to the user
        try {
          const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/award-points`, {
            userId: user.authenticatedUserId,
            amount: claimedReward,
            reason: 'Claim event winner'
          }, getAxiosConfig({
            headers: {
              'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
            },
            timeout: 10000
          }));

          if (response.data.success) {
            const winMessage = `🎊 ${user.username} claimed ${claimedReward} points! New balance: ${response.data.newBalance}`;
            const winBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: winMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(winBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', winBotMessage);

            // Clear the active claim event
            claimEventService.clearActiveClaim();
          } else {
            sendAdminResponse(socket, `❌ ${response.data.error}`);
            activeClaimEvent.claimedBy = null; // Reset if award failed
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to award claim points:', error.message);
          sendAdminResponse(socket, '❌ Failed to award points. Please contact an admin.');
          activeClaimEvent.claimedBy = null; // Reset if award failed
        }
        break;
      }

      case 'gift':
        if (!user.isAuthenticated) {
          sendAdminResponse(socket, '❌ You must be logged in to gift items.');
          return;
        }

        // Parse arguments: !gift [item] [username] [quantity]
        if (args.length < 2) {
          sendAdminResponse(socket, 'Usage: !gift [item] [username] [quantity]');

          // Fetch and show user's giftable items
          try {
            const response = await axios.get(
              `${MAIN_SERVER_URL}/api/internal/giftable-items/${user.authenticatedUserId}`,
              getAxiosConfig({
                headers: {
                  'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
                },
                timeout: 10000
              })
            );

            if (response.data.success && response.data.items.length > 0) {
              let itemsList = 'Your giftable items: ';
              response.data.items.forEach(item => {
                itemsList += `${item.emoji} ${item.display_name} (x${item.quantity}), `;
              });
              sendAdminResponse(socket, itemsList.slice(0, -2)); // Remove trailing comma
            } else {
              sendAdminResponse(socket, 'You have no giftable items.');
            }
          } catch (error) {
            console.error('❌ CHAT: Failed to fetch giftable items:', error.message);
          }
          return;
        }

        // Determine if last arg is a number (quantity)
        let quantity = 1;
        let itemAndUsername = args;
        const lastArg = args[args.length - 1];

        if (!isNaN(parseInt(lastArg))) {
          quantity = parseInt(lastArg);
          itemAndUsername = args.slice(0, -1);
        }

        // The last remaining arg is the username, everything before is the item name
        const targetUsername = itemAndUsername[itemAndUsername.length - 1];
        const itemName = itemAndUsername.slice(0, -1).join(' ');

        if (!itemName || !targetUsername) {
          sendAdminResponse(socket, 'Usage: !gift [item] [username] [quantity]');
          return;
        }

        if (quantity <= 0) {
          sendAdminResponse(socket, 'Invalid quantity. Please provide a positive number.');
          return;
        }

        try {
          const response = await axios.post(`${MAIN_SERVER_URL}/api/internal/gift-item`, {
            fromUserId: user.authenticatedUserId,
            toUsername: targetUsername,
            itemName: itemName,
            quantity: quantity
          }, getAxiosConfig({
            headers: {
              'Authorization': socket.handshake.auth?.token ? `Bearer ${socket.handshake.auth.token}` : undefined
            },
            timeout: 10000
          }));

          if (response.data.success) {
            const { item, from, to } = response.data;
            const giftMessage = quantity > 1
              ? `🎁 ${from} gifted ${quantity}x ${item.emoji} ${item.name} to ${to}!`
              : `🎁 ${from} gifted ${item.emoji} ${item.name} to ${to}!`;

            const streamerBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: giftMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(streamerBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', streamerBotMessage);
          } else {
            sendAdminResponse(socket, `❌ ${response.data.error}`);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to gift item:', error.message);
          sendAdminResponse(socket, `❌ Failed to gift item: ${error.response?.data?.error || error.message}`);
        }
        break;

      case 'discord':
        const discordMessage = `📢 Join the OneStreamer Discord community! Connect with other streamers, get support, and stay updated: https://discord.gg/As5CA3ekYA`;

        const discordBotMessage = {
          id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          username: '🤖 StreamBot',
          color: '#5865F2',
          message: discordMessage,
          timestamp: formatTime(),
          fullTimestamp: new Date().toISOString(),
          isSystem: true
        };

        chatMessages.push(discordBotMessage);
        if (chatMessages.length > MAX_CHAT_HISTORY) {
          chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
        }

        io.emit('new-message', discordBotMessage);
        break;

      case 'channel':
        // Show current random rotation channel info
        try {
          const response = await axios.get(
            `${MAIN_SERVER_URL}/api/random-stream/current-channel`,
            getAxiosConfig({ timeout: 10000 })
          );

          if (response.data.success && response.data.active) {
            const channel = response.data.channel;
            const channelMessage = `${channel.platformIcon} Currently watching: ${channel.streamerDisplayName || channel.streamerUsername} on ${channel.platformName} | ${channel.game || 'Unknown Game'} | ${channel.url}`;

            const channelBotMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: channelMessage,
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(channelBotMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', channelBotMessage);
          } else {
            const noChannelMessage = {
              id: `streambot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              username: '🤖 StreamBot',
              color: '#00FF00',
              message: '📺 Random rotation is not currently active. Be the streamer we need - go live!',
              timestamp: formatTime(),
              fullTimestamp: new Date().toISOString(),
              isSystem: true
            };

            chatMessages.push(noChannelMessage);
            if (chatMessages.length > MAX_CHAT_HISTORY) {
              chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
            }

            io.emit('new-message', noChannelMessage);
          }
        } catch (error) {
          console.error('❌ CHAT: Failed to get current channel:', error.message);
          sendAdminResponse(socket, '❌ Failed to get current channel info');
        }
        break;

      case 'next':
        // Skip vote command - allows viewers to vote to skip to the next stream
        // Usage: !next [kick|twitch] - optional platform to force

        // Parse optional platform argument
        const skipPlatform = args[0]?.toLowerCase();
        const validSkipPlatforms = ['kick', 'twitch'];
        if (skipPlatform && !validSkipPlatforms.includes(skipPlatform)) {
          sendAdminResponse(socket, '❌ Invalid platform. Use: !next [kick|twitch]');
          return;
        }

        // Check if there's already an active vote
        if (skipVote.state.active) {
          // Try to register a vote (ignore platform arg when voting on existing vote)
          const voted = registerSkipVote(user, io);
          if (!voted) {
            sendAdminResponse(socket, '❌ You have already voted in this skip vote!');
          }
          return;
        }

        // Check for other active votes
        if (swapVote.state.active) {
          sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (extendVote.state.active) {
          sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (reduceVote.state.active) {
          sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (lockVote.state.active) {
          sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (unlockVote.state.active) {
          sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
          return;
        }

        // Check cooldown (2 min after failed, 5 min after success)
        const skipCooldownDuration = skipVote.state.lastPassed ? VOTE_COOLDOWN_SUCCESS : VOTE_COOLDOWN_FAILED;
        const timeSinceLastSkipVote = Date.now() - skipVote.state.lastEndTime;
        if (skipVote.state.lastEndTime > 0 && timeSinceLastSkipVote < skipCooldownDuration) {
          const remainingSkipCooldown = Math.ceil((skipCooldownDuration - timeSinceLastSkipVote) / 1000);
          const cooldownReason = skipVote.state.lastPassed ? 'after a successful skip' : 'after a failed vote';
          sendAdminResponse(socket, `⏳ Please wait ${remainingSkipCooldown} seconds before starting another skip vote (${cooldownReason}).`);
          return;
        }

        // Check viewer count
        const currentViewerCount = getUniqueViewerCount();

        // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
        if (currentViewerCount === 1) {
          // Check single-viewer action cooldown
          const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
          if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
            const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
            sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
            return;
          }

          // Execute skip directly without voting
          const platformText = skipPlatform ? ` ${skipPlatform.charAt(0).toUpperCase() + skipPlatform.slice(1)}` : '';
          sendSkipVoteMessage(`⚡ Solo mode: ${user.username} is skipping to the next${platformText} stream...`, io);
          console.log(`🗳️ SKIP: Single viewer (${user.username}) - executing skip directly${skipPlatform ? ` (${skipPlatform})` : ''}`);

          lastSingleViewerActionTime = Date.now();
          skipVote.state.lastEndTime = Date.now();
          skipVote.state.lastPassed = true;

          try {
            const response = await axios.post(
              `${MAIN_SERVER_URL}/api/random-stream/rotate`,
              { platform: skipPlatform },
              getAxiosConfig({ timeout: 10000 })
            );

            if (response.data.success) {
              sendSkipVoteMessage(`✅ Stream skipped successfully!`, io);
              io.emit('stream-info-update', { source: 'skip-solo', message: 'Stream skipped by solo viewer' });
              try {
                await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
              } catch (unlockErr) {
                // Timer may not have been locked
              }
            } else {
              sendSkipVoteMessage('⚠️ Failed to skip stream. Try again later.', io);
            }
          } catch (error) {
            sendSkipVoteMessage('⚠️ Failed to skip stream. Try again later.', io);
            console.error('🗳️ SKIP: Error triggering stream rotation:', error.message);
          }
          return;
        }

        if (currentViewerCount < 2) {
          sendAdminResponse(socket, '❌ At least 2 viewers are needed to start a skip vote.');
          return;
        }

        // Start a new skip vote (with optional platform preference)
        startSkipVote(user, io, skipPlatform);
        break;

      case 'swap':
        // Swap vote command - allows viewers to vote to swap to a specific Twitch/Kick stream

        // Check if there's already an active swap vote
        if (swapVote.state.active) {
          // Try to register a vote (no URL needed to vote on existing swap)
          const swapVoted = registerSwapVote(user, io);
          if (!swapVoted) {
            sendAdminResponse(socket, '❌ You have already voted in this swap vote!');
          }
          return;
        }

        // Check if there's an active skip vote (can't have both at once)
        if (skipVote.state.active) {
          sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (extendVote.state.active) {
          sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (reduceVote.state.active) {
          sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (lockVote.state.active) {
          sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (unlockVote.state.active) {
          sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
          return;
        }

        // Check cooldown (2 min after failed, 5 min after success)
        const swapCooldownDuration = swapVote.state.lastPassed ? VOTE_COOLDOWN_SUCCESS : VOTE_COOLDOWN_FAILED;
        const timeSinceLastSwapVote = Date.now() - swapVote.state.lastEndTime;
        if (swapVote.state.lastEndTime > 0 && timeSinceLastSwapVote < swapCooldownDuration) {
          const remainingSwapCooldown = Math.ceil((swapCooldownDuration - timeSinceLastSwapVote) / 1000);
          const swapCooldownReason = swapVote.state.lastPassed ? 'after a successful swap' : 'after a failed vote';
          sendAdminResponse(socket, `⏳ Please wait ${remainingSwapCooldown} seconds before starting another swap vote (${swapCooldownReason}).`);
          return;
        }

        // Starting a new swap vote requires a URL
        if (args.length === 0) {
          sendAdminResponse(socket, '❌ Usage: !swap [twitch.tv/channel or kick.com/channel]');
          return;
        }

        // Parse the URL
        const swapTargetUrl = args[0];
        const parsedSwapUrl = parseStreamUrl(swapTargetUrl);

        if (!parsedSwapUrl) {
          sendAdminResponse(socket, '❌ Invalid URL. Please provide a valid Twitch or Kick channel URL (e.g., twitch.tv/channelname or kick.com/channelname)');
          return;
        }

        // Check viewer count
        const swapViewerCount = getUniqueViewerCount();

        // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
        if (swapViewerCount === 1) {
          // Check single-viewer action cooldown
          const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
          if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
            const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
            sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
            return;
          }

          // Execute swap directly without voting
          const platformIcon = parsedSwapUrl.platform === 'twitch' ? '📺' : '🟢';
          sendSwapVoteMessage(`⚡ Solo mode: ${user.username} is swapping to ${platformIcon} ${parsedSwapUrl.channel}...`, io);
          console.log(`🗳️ SWAP: Single viewer (${user.username}) - executing swap to ${parsedSwapUrl.url}`);

          lastSingleViewerActionTime = Date.now();
          swapVote.state.lastEndTime = Date.now();
          swapVote.state.lastPassed = true;

          try {
            const response = await axios.post(
              `${MAIN_SERVER_URL}/api/url-stream`,
              {
                url: parsedSwapUrl.url,
                quality: 'best',
                displayName: `${parsedSwapUrl.channel} (Solo)`,
                autoReconnect: true
              },
              getAxiosConfig({ timeout: 15000 })
            );

            if (response.data.success) {
              sendSwapVoteMessage(`✅ Successfully swapped to ${parsedSwapUrl.platform === 'twitch' ? 'Twitch' : 'Kick'} channel: ${parsedSwapUrl.channel}`, io);
              io.emit('stream-info-update', {
                source: 'swap-solo',
                channel: parsedSwapUrl.channel,
                platform: parsedSwapUrl.platform,
                message: `Swapped to ${parsedSwapUrl.channel} by solo viewer`
              });
              try {
                await axios.post(`${MAIN_SERVER_URL}/api/random-stream/unlock`, {}, getAxiosConfig({ timeout: 5000 }));
              } catch (unlockErr) {
                // Timer may not have been locked
              }
            } else {
              sendSwapVoteMessage(`⚠️ Failed to swap: ${response.data.error || 'Unknown error'}. The stream may be offline.`, io);
            }
          } catch (error) {
            const errorMsg = error.response?.data?.error || error.message;
            sendSwapVoteMessage(`⚠️ Failed to swap: ${errorMsg}. The stream may be offline.`, io);
            console.error('🗳️ SWAP: Error triggering stream swap:', error.message);
          }
          return;
        }

        if (swapViewerCount < 2) {
          sendAdminResponse(socket, '❌ At least 2 viewers are needed to start a swap vote.');
          return;
        }

        // Start a new swap vote
        startSwapVote(user, swapTargetUrl, parsedSwapUrl, io);
        break;

      case 'extend':
        // Extend vote command - allows viewers to vote to extend the current stream time

        // Check if there's already an active extend vote
        if (extendVote.state.active) {
          // Try to register a vote
          const extendVoted = registerExtendVote(user, io);
          if (!extendVoted) {
            sendAdminResponse(socket, '❌ You have already voted in this extend vote!');
          }
          return;
        }

        // Check if there's an active skip or swap vote (can't have multiple votes at once)
        if (skipVote.state.active) {
          sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (swapVote.state.active) {
          sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (reduceVote.state.active) {
          sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (lockVote.state.active) {
          sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (unlockVote.state.active) {
          sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
          return;
        }

        // Check cooldown (5 min between extend votes)
        const timeSinceLastExtendVote = Date.now() - extendVote.state.lastEndTime;
        if (extendVote.state.lastEndTime > 0 && timeSinceLastExtendVote < EXTEND_VOTE_COOLDOWN) {
          const remainingExtendCooldown = Math.ceil((EXTEND_VOTE_COOLDOWN - timeSinceLastExtendVote) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingExtendCooldown} seconds before starting another extend vote.`);
          return;
        }

        // Check viewer count
        const extendViewerCount = getUniqueViewerCount();

        // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
        if (extendViewerCount === 1) {
          // Check single-viewer action cooldown
          const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
          if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
            const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
            sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
            return;
          }

          // Execute extend directly without voting
          sendExtendVoteMessage(`⚡ Solo mode: ${user.username} is extending the stream time...`, io);
          console.log(`🗳️ EXTEND: Single viewer (${user.username}) - executing extend directly`);

          lastSingleViewerActionTime = Date.now();
          extendVote.state.lastEndTime = Date.now();

          try {
            const response = await axios.post(
              `${MAIN_SERVER_URL}/api/random-stream/extend`,
              {},
              getAxiosConfig({ timeout: 10000 })
            );

            if (response.data.success) {
              sendExtendVoteMessage(`⏰ Stream extended by ${response.data.extendedByMinutes} minutes! Enjoy the extra time!`, io);
              io.emit('stream-info-update', { source: 'extend-solo', message: 'Stream extended by solo viewer' });
            } else {
              sendExtendVoteMessage(`⚠️ Failed to extend: ${response.data.error || 'Unknown error'}`, io);
            }
          } catch (error) {
            const errorMsg = error.response?.data?.error || error.message;
            sendExtendVoteMessage(`⚠️ Failed to extend: ${errorMsg}`, io);
            console.error('🗳️ EXTEND: Error triggering extend:', error.message);
          }
          return;
        }

        if (extendViewerCount < 3) {
          sendAdminResponse(socket, '❌ At least 3 viewers are needed to start an extend vote (requires 2 votes to pass).');
          return;
        }

        // Start a new extend vote
        startExtendVote(user, io);
        break;

      case 'reduce':
        // Reduce vote command - allows viewers to vote to reduce the current stream time

        // Check if there's already an active reduce vote
        if (reduceVote.state.active) {
          const reduceVoted = registerReduceVote(user, io);
          if (!reduceVoted) {
            sendAdminResponse(socket, '❌ You have already voted in this reduce vote!');
          }
          return;
        }

        // Check if there's an active vote of any kind
        if (skipVote.state.active) {
          sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (swapVote.state.active) {
          sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (extendVote.state.active) {
          sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (lockVote.state.active) {
          sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (unlockVote.state.active) {
          sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
          return;
        }

        // Check cooldown (5 min between reduce votes)
        const timeSinceLastReduceVote = Date.now() - reduceVote.state.lastEndTime;
        if (reduceVote.state.lastEndTime > 0 && timeSinceLastReduceVote < REDUCE_VOTE_COOLDOWN) {
          const remainingReduceCooldown = Math.ceil((REDUCE_VOTE_COOLDOWN - timeSinceLastReduceVote) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingReduceCooldown} seconds before starting another reduce vote.`);
          return;
        }

        // Check viewer count
        const reduceViewerCount = getUniqueViewerCount();

        // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
        if (reduceViewerCount === 1) {
          // Check single-viewer action cooldown
          const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
          if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
            const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
            sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
            return;
          }

          // Execute reduce directly without voting
          sendReduceVoteMessage(`⚡ Solo mode: ${user.username} is reducing the stream time...`, io);
          console.log(`🗳️ REDUCE: Single viewer (${user.username}) - executing reduce directly`);

          lastSingleViewerActionTime = Date.now();
          reduceVote.state.lastEndTime = Date.now();

          try {
            const response = await axios.post(
              `${MAIN_SERVER_URL}/api/random-stream/reduce`,
              {},
              getAxiosConfig({ timeout: 10000 })
            );

            if (response.data.success) {
              sendReduceVoteMessage(`⏰ Stream time reduced by ${response.data.reducedByMinutes} minutes!`, io);
            } else {
              sendReduceVoteMessage('⚠️ Failed to reduce time. Try again later.', io);
            }
          } catch (error) {
            sendReduceVoteMessage('⚠️ Failed to reduce time. Try again later.', io);
            console.error('🗳️ REDUCE: Error reducing rotation:', error.message);
          }
          return;
        }

        if (reduceViewerCount < 3) {
          sendAdminResponse(socket, '❌ At least 3 viewers are needed to start a reduce vote (requires 2 votes to pass).');
          return;
        }

        // Start a new reduce vote
        startReduceVote(user, io);
        break;

      case 'lock':
        // Lock vote command - allows viewers to vote to lock the rotation (100% required)

        // Check if there's already an active lock vote
        if (lockVote.state.active) {
          const lockVoted = registerLockVote(user, io);
          if (!lockVoted) {
            sendAdminResponse(socket, '❌ You have already voted in this lock vote!');
          }
          return;
        }

        // Check if there's an active vote of any kind
        if (skipVote.state.active) {
          sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (swapVote.state.active) {
          sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (extendVote.state.active) {
          sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (reduceVote.state.active) {
          sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (unlockVote.state.active) {
          sendAdminResponse(socket, '❌ An unlock vote is currently in progress. Please wait for it to finish.');
          return;
        }

        // Check cooldown
        const lockCooldownDuration = lockVote.state.lastPassed ? LOCK_VOTE_COOLDOWN : VOTE_COOLDOWN_FAILED;
        const timeSinceLastLockVote = Date.now() - lockVote.state.lastEndTime;
        if (lockVote.state.lastEndTime > 0 && timeSinceLastLockVote < lockCooldownDuration) {
          const remainingLockCooldown = Math.ceil((lockCooldownDuration - timeSinceLastLockVote) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingLockCooldown} seconds before starting another lock vote.`);
          return;
        }

        // Check if already locked
        try {
          const lockStatusResp = await axios.get(`${MAIN_SERVER_URL}/api/random-stream/lock-status`, getAxiosConfig({ timeout: 5000 }));
          if (lockStatusResp.data.isLocked) {
            sendAdminResponse(socket, '❌ Rotation is already locked. Use !unlock to start a vote to unlock it.');
            return;
          }
        } catch (err) {
          console.error('❌ LOCK VOTE: Failed to check lock status:', err.message);
        }

        // Check viewer count
        const lockViewerCount = getUniqueViewerCount();

        // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
        if (lockViewerCount === 1) {
          // Check single-viewer action cooldown
          const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
          if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
            const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
            sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
            return;
          }

          // Execute lock directly without voting
          sendLockVoteMessage(`⚡ Solo mode: ${user.username} is locking the rotation...`, io);
          console.log(`🗳️ LOCK: Single viewer (${user.username}) - executing lock directly`);

          lastSingleViewerActionTime = Date.now();
          lockVote.state.lastEndTime = Date.now();
          lockVote.state.lastPassed = true;

          try {
            const response = await axios.post(
              `${MAIN_SERVER_URL}/api/random-stream/lock`,
              {},
              getAxiosConfig({ timeout: 10000 })
            );

            if (response.data.success) {
              sendLockVoteMessage(`🔒 Rotation LOCKED! Stream will not rotate until a successful !next vote.`, io);
            } else {
              sendLockVoteMessage('⚠️ Failed to lock rotation. Try again later.', io);
            }
          } catch (error) {
            sendLockVoteMessage('⚠️ Failed to lock rotation. Try again later.', io);
            console.error('🗳️ LOCK: Error locking rotation:', error.message);
          }
          return;
        }

        if (lockViewerCount < 2) {
          sendAdminResponse(socket, '❌ At least 2 viewers are needed to start a lock vote.');
          return;
        }

        // Start a new lock vote
        startLockVote(user, io);
        break;

      case 'unlock':
        // Unlock vote command - allows viewers to vote to unlock the rotation (50% required)

        // Check if there's already an active unlock vote
        if (unlockVote.state.active) {
          const unlockVoted = registerUnlockVote(user, io);
          if (!unlockVoted) {
            sendAdminResponse(socket, '❌ You have already voted in this unlock vote!');
          }
          return;
        }

        // Check if there's an active vote of any kind
        if (skipVote.state.active) {
          sendAdminResponse(socket, '❌ A skip vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (swapVote.state.active) {
          sendAdminResponse(socket, '❌ A swap vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (extendVote.state.active) {
          sendAdminResponse(socket, '❌ An extend vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (reduceVote.state.active) {
          sendAdminResponse(socket, '❌ A reduce vote is currently in progress. Please wait for it to finish.');
          return;
        }
        if (lockVote.state.active) {
          sendAdminResponse(socket, '❌ A lock vote is currently in progress. Please wait for it to finish.');
          return;
        }

        // Check cooldown
        const unlockCooldownDuration = unlockVote.state.lastPassed ? UNLOCK_VOTE_COOLDOWN : VOTE_COOLDOWN_FAILED;
        const timeSinceLastUnlockVote = Date.now() - unlockVote.state.lastEndTime;
        if (unlockVote.state.lastEndTime > 0 && timeSinceLastUnlockVote < unlockCooldownDuration) {
          const remainingUnlockCooldown = Math.ceil((unlockCooldownDuration - timeSinceLastUnlockVote) / 1000);
          sendAdminResponse(socket, `⏳ Please wait ${remainingUnlockCooldown} seconds before starting another unlock vote.`);
          return;
        }

        // Check if actually locked
        try {
          const unlockStatusResp = await axios.get(`${MAIN_SERVER_URL}/api/random-stream/lock-status`, getAxiosConfig({ timeout: 5000 }));
          if (!unlockStatusResp.data.isLocked) {
            sendAdminResponse(socket, '❌ Rotation is not locked. Use !lock to start a vote to lock it.');
            return;
          }
        } catch (err) {
          console.error('❌ UNLOCK VOTE: Failed to check lock status:', err.message);
        }

        // Check viewer count
        const unlockViewerCount = getUniqueViewerCount();

        // Single-viewer auto-execute: if only 1 viewer, skip voting and execute directly
        if (unlockViewerCount === 1) {
          // Check single-viewer action cooldown
          const timeSinceSingleAction = Date.now() - lastSingleViewerActionTime;
          if (lastSingleViewerActionTime > 0 && timeSinceSingleAction < SINGLE_VIEWER_ACTION_COOLDOWN) {
            const remainingCooldown = Math.ceil((SINGLE_VIEWER_ACTION_COOLDOWN - timeSinceSingleAction) / 1000);
            sendAdminResponse(socket, `⏳ Please wait ${remainingCooldown} seconds before using another solo command.`);
            return;
          }

          // Execute unlock directly without voting
          sendUnlockVoteMessage(`⚡ Solo mode: ${user.username} is unlocking the rotation...`, io);
          console.log(`🗳️ UNLOCK: Single viewer (${user.username}) - executing unlock directly`);

          lastSingleViewerActionTime = Date.now();
          unlockVote.state.lastEndTime = Date.now();
          unlockVote.state.lastPassed = true;

          try {
            const response = await axios.post(
              `${MAIN_SERVER_URL}/api/random-stream/unlock`,
              {},
              getAxiosConfig({ timeout: 10000 })
            );

            if (response.data.success) {
              sendUnlockVoteMessage(`🔓 Rotation UNLOCKED! Stream will rotate at the next scheduled time.`, io);
            } else {
              sendUnlockVoteMessage('⚠️ Failed to unlock rotation. Try again later.', io);
            }
          } catch (error) {
            sendUnlockVoteMessage('⚠️ Failed to unlock rotation. Try again later.', io);
            console.error('🗳️ UNLOCK: Error unlocking rotation:', error.message);
          }
          return;
        }

        if (unlockViewerCount < 2) {
          sendAdminResponse(socket, '❌ At least 2 viewers are needed to start an unlock vote.');
          return;
        }

        // Start a new unlock vote
        startUnlockVote(user, io);
        break;

      default:
        sendAdminResponse(socket, `❓ Unknown command: !${command}. Type !help for available commands.`);
    }
  }

  return { parse };
}

module.exports = createCommandParser;
