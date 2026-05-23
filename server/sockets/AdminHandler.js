/**
 * AdminHandler
 *
 * Registers admin-targeted socket events on a per-connection basis.
 * Pilot extraction for PR-H — follows the same pattern PR-G established
 * for HTTP route modules: a single `register(io, socket, deps)` entry
 * point invoked from inside `io.on('connection', ...)` in server/index.js.
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - admin-message      Broadcast an admin notification to a target socket.
 *   - admin-kick         Forcibly disconnect a target socket after notifying it.
 *   - admin:game-status  Report current game-stream status to the caller.
 *
 * `deps` (all required):
 *   - gameStreamService  Source of `getStatus()` for the admin:game-status event.
 *                        Other handlers don't use it but it's injected here for
 *                        cohesion — one module, one deps bag.
 *
 * Env reads (kept identical to the inline original):
 *   - process.env.ADMIN_KEY  Compared with the `adminKey` field on incoming
 *                            admin-message / admin-kick payloads.
 */
module.exports = function registerAdminHandler(io, socket, deps) {
  const { gameStreamService } = deps;

  // Fail-closed admin-key gate. If process.env.ADMIN_KEY is unset, the
  // raw `!==` comparison would evaluate `undefined !== undefined` -> false
  // and let an unauthenticated socket send {adminKey: undefined}; see #31.
  function verifyAdminKey(adminKey) {
    const expected = process.env.ADMIN_KEY;
    return Boolean(expected) && adminKey === expected;
  }

  // Admin connection management handlers
  socket.on('admin-message', async (data) => {
    const { targetSocketId, message, adminKey } = data;

    // Verify admin key
    if (!verifyAdminKey(adminKey)) {
      console.log('❌ ADMIN: Invalid admin key for message');
      return;
    }

    // Find target socket and send message
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('admin-notification', {
        message: message,
        timestamp: Date.now(),
        type: 'info'
      });
      console.log(`💬 ADMIN: Message sent to ${targetSocketId}`);
    }
  });

  socket.on('admin-kick', async (data) => {
    const { targetSocketId, adminKey } = data;

    // Verify admin key
    if (!verifyAdminKey(adminKey)) {
      console.log('❌ ADMIN: Invalid admin key for kick');
      return;
    }

    // Find target socket and disconnect
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('admin-notification', {
        message: 'You have been disconnected by an administrator',
        timestamp: Date.now(),
        type: 'error'
      });

      setTimeout(() => {
        targetSocket.disconnect(true);
        console.log(`🚫 ADMIN: Kicked connection ${targetSocketId}`);
      }, 1000);
    }
  });

  // Admin: Get game status
  socket.on('admin:game-status', async (data, callback) => {
    try {
      const status = gameStreamService.getStatus();
      if (callback) callback({ success: true, status });
    } catch (error) {
      console.error('🎮 GAME: Error getting status:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
};
