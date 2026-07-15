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
// Ban + timeout (the heavy paths that were duplicated between the HTTP API and
// the command parser) are exposed via side-effecting helpers
// (banUserWithSideEffects, timeoutUserWithSideEffects) so both call sites run
// identical logic. Unban / remove-timeout / the moderation listing stay on the
// raw bannedUsers/bannedUsersData/timeoutUsers handles, which are also read by
// the socket layer (core/socketHandlers.js) on every connect / message.

const fs = require('fs');
const crypto = require('crypto');

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
 *   banUserWithSideEffects: (opts: object) => { messagesDeleted: number, disconnectedCount: number, messageIds: string[] },
 *   timeoutUserWithSideEffects: (opts: object) => { endTime: number, startTime: number, notifiedCount: number },
 *   getAnonSalt: () => string,
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

  // Apply a parsed store object to the in-memory Sets/Maps. Extracted so both
  // the primary store and the `.bak` recovery path share identical load logic.
  function applyModerationData(data) {
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

  // Load moderation data from disk. Tries the primary store first; if it is
  // missing or corrupt (e.g. a crash truncated it mid-write), falls back to the
  // last-known-good `.bak` snapshot before giving up — so one bad write can't
  // silently wipe every ban/timeout on the next restart.
  function loadModerationData() {
    const backupPath = `${moderationDataPath}.bak`;
    try {
      if (fs.existsSync(moderationDataPath)) {
        applyModerationData(JSON.parse(fs.readFileSync(moderationDataPath, 'utf8')));
        return;
      }
    } catch (error) {
      console.error('❌ MODERATION: Primary moderation store unreadable, trying backup:', error);
      try {
        if (fs.existsSync(backupPath)) {
          applyModerationData(JSON.parse(fs.readFileSync(backupPath, 'utf8')));
          console.log('♻️  MODERATION: Recovered moderation data from .bak backup');
          return;
        }
      } catch (backupError) {
        console.error('❌ MODERATION: Backup moderation store also unreadable:', backupError);
      }
    }
  }

  // Save moderation data to disk atomically: write to a temp file, snapshot the
  // current store to `.bak`, then rename the temp over the primary. rename(2) is
  // atomic on POSIX, so a crash mid-save leaves either the old file or the new
  // one intact — never a truncated store that loadModerationData would read as
  // "no bans".
  function saveModerationData() {
    const tmpPath = `${moderationDataPath}.tmp`;
    const backupPath = `${moderationDataPath}.bak`;
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

      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      // Preserve the previous good copy as a backup before swapping in the new one.
      if (fs.existsSync(moderationDataPath)) {
        try {
          fs.copyFileSync(moderationDataPath, backupPath);
        } catch (backupError) {
          console.error('⚠️  MODERATION: Could not refresh .bak backup:', backupError);
        }
      }
      fs.renameSync(tmpPath, moderationDataPath);
      console.log(`💾 MODERATION: Saved moderation data to disk (${bannedUsersList.length} bans, ${timedOutUsersList.length} timeouts)`);
    } catch (error) {
      console.error('❌ MODERATION: Failed to save moderation data:', error);
    }
  }

  // Per-install salt for deterministic anonymous-identity derivation
  // (audit CH5). Bans are persisted by USERNAME, but anonymous usernames
  // were random per process — a chat-service restart regenerated a fresh
  // name for the same IP, silently voiding every anonymous ban. The socket
  // layer (core/socketHandlers.js) now derives the anonymous username from
  // hash(salt + IP), so the same IP maps to the same username across
  // restarts and the persisted username-ban keeps holding. The salt lives
  // in a sibling file of the moderation store (same directory, same
  // runtime-state posture, gitignored) so it survives restarts but never
  // ships in the repo; it also keeps the IP -> name mapping unguessable to
  // outsiders. If the file can't be written, we fall back to an ephemeral
  // per-process salt — identical to the pre-fix behavior, never worse.
  const anonSaltPath = `${moderationDataPath}.salt`;
  let anonSalt = null;

  function getAnonSalt() {
    if (anonSalt) return anonSalt;
    try {
      if (fs.existsSync(anonSaltPath)) {
        const onDisk = fs.readFileSync(anonSaltPath, 'utf8').trim();
        if (onDisk.length >= 16) {
          anonSalt = onDisk;
          return anonSalt;
        }
      }
    } catch (error) {
      console.error('❌ MODERATION: Failed to read anonymous-identity salt, regenerating:', error);
    }
    anonSalt = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(anonSaltPath, `${anonSalt}\n`, { mode: 0o600 });
      console.log('💾 MODERATION: Persisted new anonymous-identity salt');
    } catch (error) {
      console.error('❌ MODERATION: Failed to persist anonymous-identity salt (anonymous bans will not survive restart):', error);
    }
    return anonSalt;
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

  // Canonical ban side effect. Both the HTTP API (POST /api/ban) and the
  // /ban admin command route through this so the two paths are byte-identical.
  // It performs the full ban side effect that was previously duplicated:
  //   1. record the ban in bannedUsers / bannedUsersData,
  //   2. persist to disk (saveModerationData),
  //   3. backward-splice every message from the target out of `chatMessages`,
  //   4. broadcast 'delete-messages' for those IDs (only if any were removed),
  //   5. disconnect every connected socket whose username matches
  //      (case-insensitive), emitting 'banned' and forcing disconnect.
  // The ban-notification broadcast and the admin/HTTP response are NOT done
  // here — callers differ in how they announce the ban (the HTTP route pushes
  // a '🔨 MODERATION' system message into the ring; the admin command calls
  // sendSystemMessage) — so each caller keeps that bit unchanged. Because the
  // HTTP route originally broadcast its notification BETWEEN the
  // 'delete-messages' emit and the socket disconnects, an optional
  // `onAfterDeleteMessages` hook is invoked at exactly that point so the HTTP
  // event ordering is preserved byte-for-byte. The admin command broadcasts
  // AFTER disconnect, so it passes no hook and calls sendSystemMessage itself
  // once the helper returns.
  //
  // Log lines for the delete + disconnect steps are emitted here with a
  // caller-supplied `logPrefix` ('MODERATION' for HTTP, 'BAN' for the command)
  // so the exact log strings each path produced are preserved.
  //
  // @param {object} opts
  // @param {object} opts.io                socket.io server
  // @param {Array<object>} opts.chatMessages  shared message ring
  // @param {Map} opts.connectedUsers       socketId -> user info
  // @param {string} opts.username          target username
  // @param {string} opts.reason            reason stored in bannedUsersData
  // @param {string} opts.bannedBy          actor stored in bannedUsersData
  // @param {string} opts.logPrefix         '🔨 <logPrefix>:' log namespace
  // @param {() => void} [opts.onAfterRecord]
  //        invoked after the ban is recorded + saved, before message-splicing
  //        (the /ban command's two 'Adding...'/'Current banned users' logs)
  // @param {(messageIds: string[]) => void} [opts.onAfterDeleteMessages]
  //        invoked after the 'delete-messages' emit and before disconnects
  // @returns {{ messagesDeleted: number, disconnectedCount: number, messageIds: string[] }}
  function banUserWithSideEffects(opts) {
    const { io, chatMessages, connectedUsers, username, reason, bannedBy, logPrefix, onAfterRecord, onAfterDeleteMessages } = opts;

    bannedUsers.add(username);
    bannedUsersData.set(username, {
      bannedAt: new Date().toISOString(),
      reason,
      bannedBy
    });

    // Save to disk
    saveModerationData();

    // Caller hook: ran after record+save, before message-splicing.
    if (typeof onAfterRecord === 'function') {
      onAfterRecord();
    }

    // Delete all messages from the banned user
    const messagesToDelete = [];
    const lowerUsername = username.toLowerCase();

    // Find all message IDs from the banned user
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].username && chatMessages[i].username.toLowerCase() === lowerUsername) {
        messagesToDelete.push(chatMessages[i].id);
        chatMessages.splice(i, 1); // Remove from array
      }
    }

    // Emit event to delete messages from all clients
    if (messagesToDelete.length > 0) {
      io.emit('delete-messages', { messageIds: messagesToDelete, reason: 'user_banned' });
      console.log(`🔨 ${logPrefix}: Deleted ${messagesToDelete.length} messages from ${username}`);
    }

    // Caller hook: broadcast the ban notification at the canonical point the
    // HTTP route used (after delete-messages, before disconnects).
    if (typeof onAfterDeleteMessages === 'function') {
      onAfterDeleteMessages(messagesToDelete);
    }

    // Disconnect all sockets with this username (case-insensitive)
    let disconnectedCount = 0;
    connectedUsers.forEach((user, socketId) => {
      if (user.username.toLowerCase() === lowerUsername) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          console.log(`🔨 ${logPrefix}: Disconnecting socket ${socketId} for user ${user.username}`);
          targetSocket.emit('banned', { reason: 'You have been banned by an administrator' });
          targetSocket.disconnect(true);
          disconnectedCount++;
        }
      }
    });

    return { messagesDeleted: messagesToDelete.length, disconnectedCount, messageIds: messagesToDelete };
  }

  // Canonical timeout side effect. Both POST /api/timeout and the /timeout
  // admin command route through this. It:
  //   1. records the timeout in timeoutUsers (startTime + endTime),
  //   2. persists to disk (saveModerationData),
  //   3. emits a 'timeout' socket event to every connected socket whose
  //      username matches the target (the admin command's behavior).
  // The public broadcast + response differ per caller and stay in the callers.
  //
  // Socket matching here is EXACT-case to preserve the /timeout command's
  // prior behavior (`user.username === targetUsername`). The HTTP route never
  // emitted per-socket 'timeout' events, so it passes `notifySockets: false`.
  //
  // @param {object} opts
  // @param {object} opts.io                socket.io server
  // @param {Map} opts.connectedUsers       socketId -> user info
  // @param {string} opts.username          target username
  // @param {number} opts.durationSeconds   timeout length in seconds
  // @param {string} opts.reason            reason stored in timeoutUsers
  // @param {boolean} opts.notifySockets    emit per-socket 'timeout' events
  // @param {() => void} [opts.onAfterRecord]
  //        invoked after the timeout is recorded + saved, before per-socket
  //        notifies (the /timeout command's two diagnostic logs)
  // @returns {{ endTime: number, startTime: number, notifiedCount: number }}
  function timeoutUserWithSideEffects(opts) {
    const { io, connectedUsers, username, durationSeconds, reason, notifySockets, onAfterRecord } = opts;

    const startTime = Date.now();
    const endTime = startTime + (durationSeconds * 1000);
    timeoutUsers.set(username, {
      endTime,
      reason,
      startTime: startTime
    });

    // Save to disk
    saveModerationData();

    // Caller hook: ran after record+save, before per-socket notifies.
    if (typeof onAfterRecord === 'function') {
      onAfterRecord();
    }

    // Send timeout notification to affected users (exact-case match)
    let notifiedCount = 0;
    if (notifySockets) {
      connectedUsers.forEach((user, socketId) => {
        if (user.username === username) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) {
            targetSocket.emit('timeout', {
              duration: durationSeconds,
              endTime: endTime,
              reason: 'You have been timed out by an administrator'
            });
            notifiedCount++;
          }
        }
      });
    }

    return { endTime, startTime, notifiedCount };
  }

  return {
    loadModerationData,
    saveModerationData,
    isUserBanned,
    isUserTimedOut,
    banUserWithSideEffects,
    timeoutUserWithSideEffects,
    // Audit CH5: consumed by core/socketHandlers.js to derive stable
    // anonymous usernames (see comment on getAnonSalt above).
    getAnonSalt,
    // Direct state handles. The HTTP API (api/routes.js) drives unban /
    // remove-timeout / moderation-listing directly off these (an unconditional
    // delete + save that intentionally differs from a membership-checked
    // helper), and the socket layer (core/socketHandlers.js) reads
    // isUserBanned/isUserTimedOut + timeoutUsers on every connect / message.
    bannedUsers,
    bannedUsersData,
    timeoutUsers
  };
}

module.exports = createModerationService;
