// server/services/BuffNotifier.js
//
// Single emission chokepoint for the buff/inventory cluster of socket events:
// `streamer-buffs-update`, `inventory-updated`, and `buff-error`. Third PR
// of Phase 3, following the chokepoint pattern from PR 3.1 (StreamNotifier)
// and PR 3.2 (ViewerCountNotifier).
//
// Why this cluster is different from PRs 3.1/3.2:
//   - The 28 baseline emit sites live in BOTH service code (BuffDebuffService,
//     ItemUseService, DrawingService, ThrowingService) AND inline route
//     handlers (routes/items.js) AND socket handlers (BuffHandler,
//     StreamHandler). That service-vs-route mix is the structural issue —
//     the route handlers were emitting *because the inline code path
//     happened to know about io* rather than because emit-ownership lived
//     in one service.
//   - Three event names share the cluster but they target three different
//     scopes:
//       streamer-buffs-update  → broadcast (8 sites) OR per-socket response (1 site)
//       inventory-updated      → always targeted via io.to(socketId).emit (9 sites)
//       buff-error             → always per-calling-socket via socket.emit (10 sites)
//     One service exposes three methods rather than three services, because
//     the cluster is conceptually one feature (buffs/inventory state) and
//     splitting would force every consumer to inject three deps.
//
// Action-string surface pinning (`INVENTORY_ACTIONS`): same shape as
// StreamNotifier's REASONS — the 6 inventory actions produced by the 9
// baseline sites (purchase, sell, grant, use, draw, throw) are pinned in a
// Set. At runtime an unknown action still emits (typo doesn't silently
// swallow the event) but logs a structured warn so monitoring catches
// surface drift. The other two events don't have discriminator fields
// (streamer-buffs-update is just `{ buffs }`; buff-error is just `{ error }`),
// so no pinning needed.

class BuffNotifier {
  /**
   * @param {object} io Socket.IO server instance.
   */
  constructor(io) {
    if (!io) {
      throw new Error('BuffNotifier requires a Socket.IO instance');
    }
    this.io = io;
  }

  /**
   * Emit `streamer-buffs-update`.
   *
   * If `toSocket` is provided, the emit is targeted to that single socket
   * (the per-query response variant used by `BuffHandler.on('get-streamer-buffs')`).
   * Otherwise broadcast via `io.emit` (every state-change site).
   *
   * @param {object} opts
   * @param {Array}  opts.buffs        Current buff list (may be empty).
   * @param {object} [opts.toSocket]   Per-query response target; otherwise broadcast.
   */
  streamerBuffsUpdate(opts = {}) {
    const { buffs, toSocket = null } = opts;
    if (!Array.isArray(buffs)) {
      console.warn('⚠️ BUFF_NOTIFIER: streamerBuffsUpdate called without `buffs` array — emit suppressed');
      return;
    }
    const payload = { buffs };
    if (toSocket) {
      toSocket.emit('streamer-buffs-update', payload);
    } else {
      this.io.emit('streamer-buffs-update', payload);
    }
  }

  /**
   * Notify a specific user's socket that their inventory changed.
   * Always targeted via `io.to(socketId).emit`.
   *
   * The `action` discriminator pins the shape — receivers (mostly
   * inventory-UI hooks on the client) switch on `action` to decide
   * whether to play a sound, animate a count change, etc.
   *
   * @param {object} opts
   * @param {string} opts.toSocketId       Required.
   * @param {string} opts.action           Required. One of INVENTORY_ACTIONS.
   * @param {number} opts.itemId           Required.
   * @param {number} opts.quantity         Required.
   * @param {number} [opts.remainingQuantity]  Optional — present on `use`/`draw`/`throw`,
   *                                            absent on `purchase`/`sell`/`grant`.
   */
  inventoryUpdated(opts = {}) {
    const { toSocketId, action, itemId, quantity, remainingQuantity } = opts;
    if (!toSocketId) {
      console.warn('⚠️ BUFF_NOTIFIER: inventoryUpdated called without toSocketId — emit suppressed');
      return;
    }
    if (!action) {
      console.warn('⚠️ BUFF_NOTIFIER: inventoryUpdated called without action — emit suppressed');
      return;
    }
    if (!BuffNotifier.INVENTORY_ACTIONS.has(action)) {
      console.warn(`⚠️ BUFF_NOTIFIER: unknown inventory action "${action}" — INVENTORY_ACTIONS set is out of date`);
    }
    const payload = { action, itemId, quantity };
    if (remainingQuantity !== undefined) {
      payload.remainingQuantity = remainingQuantity;
    }
    this.io.to(toSocketId).emit('inventory-updated', payload);
  }

  /**
   * Send a buff-related error to the requesting socket.
   * Always per-socket (the calling socket of a buff socket-event handler).
   *
   * @param {object} opts
   * @param {object} opts.toSocket    Required. The socket the error belongs to.
   * @param {string} opts.error       Required. Error message.
   */
  buffError(opts = {}) {
    const { toSocket, error } = opts;
    if (!toSocket) {
      console.warn('⚠️ BUFF_NOTIFIER: buffError called without toSocket — emit suppressed');
      return;
    }
    if (typeof error !== 'string' || error.length === 0) {
      // Suppressing the emit is strictly safer than the pre-PR behaviour of
      // sending `{ error: undefined }` (which can happen if a catch block
      // hands us a re-thrown non-Error value whose `.message` is undefined).
      // But silently dropping costs the operator a server-log breadcrumb —
      // log the original argument so the underlying exception is recoverable
      // from the logs even though the wire emit was suppressed.
      console.warn('⚠️ BUFF_NOTIFIER: buffError called without `error` string — emit suppressed');
      console.error('⚠️ BUFF_NOTIFIER: original error argument was:', error);
      return;
    }
    toSocket.emit('buff-error', { error });
  }
}

// Phase 3 / PR 3.3 baseline: the 6 distinct `action` values emitted by the
// 9 `inventory-updated` callsites. Adding a new action: append it here AND
// to the PHASE_3_3_BASELINE in the unit test (the size-pin test forces a
// deliberate baseline update). Removing one: don't — receivers may switch
// on it. The per-action test.each catches a missing one.
BuffNotifier.INVENTORY_ACTIONS = new Set([
  // routes/items.js
  'purchase',
  'sell',
  'grant',
  // ItemUseService.js (×4), all use the same 'use' action
  'use',
  // DrawingService.js
  'draw',
  // ThrowingService.js
  'throw',
]);

module.exports = BuffNotifier;
