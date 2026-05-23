// Moderation subsystem
//
// Owns ban + timeout state for chat-service: which usernames are banned,
// the metadata recorded for each ban, and the timeouts in effect with their
// expiry. Handles persistence to/from a JSON file on disk (path is
// configurable via the MODERATION_STORE_PATH env var, resolved by the
// caller and passed in as `moderationDataPath`).
//
// Behavior must be byte-equivalent to the inline implementation it replaces:
//   - Same on-disk JSON format (bannedUsers[], timedOutUsers[], lastUpdated).
//   - Same case-insensitive matching for isUserBanned / isUserTimedOut.
//   - Same lazy expiry: isUserTimedOut removes the entry on a stale hit.
//   - Same console-log lines (callers grep these in operations).
//
// State is exposed both via mutation helpers (banUser, unbanUser, etc.) and
// via the raw bannedUsers/bannedUsersData/timeoutUsers handles so that legacy
// call sites in the command parser and HTTP API (PR-K3/K4/K5) can keep
// mutating the same instances unchanged until they migrate.

const fs = require('fs');

/**
 * Create a moderation service.
 *
 * @param {object} deps
 * @param {string} deps.moderationDataPath  Absolute path to the JSON store on disk.
 * @returns {{
 *   loadModerationData: () => void,
 *   saveModerationData: () => void,
 *   isUserBanned: (username: string) => boolean,
 *   isUserTimedOut: (username: string) => boolean,
 *   banUser: (username: string, reason?: string, bannedBy?: string) => void,
 *   unbanUser: (username: string) => boolean,
 *   timeoutUser: (username: string, durationMs: number, reason?: string, startedBy?: string) => { endTime: number, startTime: number },
 *   removeTimeout: (username: string) => boolean,
 *   bannedUsers: Set<string>,
 *   bannedUsersData: Map<string, object>,
 *   timeoutUsers: Map<string, object>
 * }}
 */
function createModerationService(deps) {
  const { moderationDataPath } = deps;

  if (!moderationDataPath) {
    throw new Error('createModerationService: moderationDataPath is required');
  }

  // Module-private state (was previously module-scope in chat-service/index.js)
  const bannedUsers = new Set();         // Banned usernames (authenticated or anonymous)
  const bannedUsersData = new Map();     // username -> { bannedAt, reason, bannedBy }
  const timeoutUsers = new Map();        // username -> { endTime, reason, startTime }

  // Load moderation data from disk
  function loadModerationData() {
    try {
      if (fs.existsSync(moderationDataPath)) {
        const data = JSON.parse(fs.readFileSync(moderationDataPath, 'utf8'));

        // Load banned users
        if (data.bannedUsers && Array.isArray(data.bannedUsers)) {
          bannedUsers.clear();
          bannedUsersData.clear();
          data.bannedUsers.forEach(user => {
            bannedUsers.add(user.username);
            bannedUsersData.set(user.username, {
              bannedAt: user.bannedAt,
              reason: user.reason || 'No reason recorded',
              bannedBy: user.bannedBy
            });
          });
          console.log(`📂 MODERATION: Loaded ${bannedUsers.size} banned users from disk`);
        }

        // Load timeout users (only active ones)
        if (data.timedOutUsers && Array.isArray(data.timedOutUsers)) {
          const currentTime = Date.now();
          timeoutUsers.clear();
          data.timedOutUsers.forEach(user => {
            if (user.endTime > currentTime) {
              timeoutUsers.set(user.username, {
                endTime: user.endTime,
                reason: user.reason || 'No reason recorded',
                startTime: user.startTime || currentTime
              });
            }
          });
          console.log(`📂 MODERATION: Loaded ${timeoutUsers.size} active timeouts from disk`);
        }
      }
    } catch (error) {
      console.error('❌ MODERATION: Failed to load moderation data:', error);
    }
  }

  // Save moderation data to disk
  function saveModerationData() {
    try {
      const bannedUsersList = Array.from(bannedUsers).map(username => ({
        username,
        ...(bannedUsersData.get(username) || {
          bannedAt: new Date().toISOString(),
          reason: 'No reason recorded'
        })
      }));

      const timedOutUsersList = Array.from(timeoutUsers.entries()).map(([username, data]) => ({
        username,
        endTime: data.endTime,
        reason: data.reason,
        startTime: data.startTime
      }));

      const data = {
        bannedUsers: bannedUsersList,
        timedOutUsers: timedOutUsersList,
        lastUpdated: new Date().toISOString()
      };

      fs.writeFileSync(moderationDataPath, JSON.stringify(data, null, 2));
      console.log(`💾 MODERATION: Saved moderation data to disk (${bannedUsersList.length} bans, ${timedOutUsersList.length} timeouts)`);
    } catch (error) {
      console.error('❌ MODERATION: Failed to save moderation data:', error);
    }
  }

  // Check if username is banned (case-insensitive)
  function isUserBanned(username) {
    // Convert to lowercase for comparison
    const lowerUsername = username.toLowerCase();
    for (const bannedUser of bannedUsers) {
      if (bannedUser.toLowerCase() === lowerUsername) {
        console.log(`🔨 BAN CHECK: User "${username}" matches banned user "${bannedUser}"`);
        return true;
      }
    }
    return false;
  }

  // Check if username is timed out (case-insensitive)
  function isUserTimedOut(username) {
    const lowerUsername = username.toLowerCase();

    for (const [timedOutUser, timeoutData] of timeoutUsers.entries()) {
      if (timedOutUser.toLowerCase() === lowerUsername) {
        if (Date.now() >= timeoutData.endTime) {
          console.log(`⏱️ TIMEOUT: Expired timeout for "${timedOutUser}"`);
          timeoutUsers.delete(timedOutUser);
          return false;
        }
        console.log(`⏱️ TIMEOUT CHECK: User "${username}" matches timed out user "${timedOutUser}"`);
        return true;
      }
    }
    return false;
  }

  // Mutation helpers. Callers that need to drive surrounding effects
  // (deleting messages, disconnecting sockets, broadcasting bans) should
  // perform those alongside the helper — these only touch state + disk.
  function banUser(username, reason, bannedBy) {
    bannedUsers.add(username);
    bannedUsersData.set(username, {
      bannedAt: new Date().toISOString(),
      reason: reason || 'No reason recorded',
      bannedBy: bannedBy || 'Unknown'
    });
    saveModerationData();
  }

  function unbanUser(username) {
    if (!bannedUsers.has(username)) {
      return false;
    }
    bannedUsers.delete(username);
    bannedUsersData.delete(username);
    saveModerationData();
    return true;
  }

  function timeoutUser(username, durationMs, reason, startedBy) {
    const startTime = Date.now();
    const endTime = startTime + durationMs;
    timeoutUsers.set(username, {
      endTime,
      reason: reason || 'No reason recorded',
      startTime,
      // startedBy is informational; legacy on-disk format doesn't persist it
      // but callers can pass it for logging consistency.
      ...(startedBy ? { startedBy } : {})
    });
    saveModerationData();
    return { endTime, startTime };
  }

  function removeTimeout(username) {
    if (!timeoutUsers.has(username)) {
      return false;
    }
    timeoutUsers.delete(username);
    saveModerationData();
    return true;
  }

  return {
    loadModerationData,
    saveModerationData,
    isUserBanned,
    isUserTimedOut,
    banUser,
    unbanUser,
    timeoutUser,
    removeTimeout,
    // Direct state handles for legacy call sites (parser + HTTP API) that
    // mutate alongside other side effects. PR-K3/K4/K5 will migrate those
    // to use the helpers above.
    bannedUsers,
    bannedUsersData,
    timeoutUsers
  };
}

module.exports = createModerationService;
