// server/services/ViewerCountNotifier.js
//
// Single emission chokepoint for the server's `viewer-count-update` socket
// event. Companion to `StreamNotifier` (PR 3.1) — same chokepoint pattern,
// smaller blast radius.
//
// Phase 3, PR 3.2. The 13 pre-existing call sites for `viewer-count-update`
// were all literally identical: `io.emit('viewer-count-update',
// sessionService.getUniqueViewerCount())`. No variation in payload shape, no
// extras, no per-site fields. The duplication was structural cost (each
// caller had to remember the right helper to call) without buying anything.
//
// The chokepoint owns both the emit AND the count derivation. Callers now
// just say `viewerCountNotifier.broadcast()` — they don't need a reference
// to `sessionService`, and they don't need to remember which of
// `streamService.getViewerCount()` (raw socket-id count, multi-tab counts
// twice) vs `sessionService.getUniqueViewerCount()` (unique IPs, the
// canonical user-facing number) is correct. The historical mistake of
// emitting the wrong count was always one autocomplete away from happening;
// the chokepoint removes the option.

class ViewerCountNotifier {
  /**
   * @param {object} io                Socket.IO server instance.
   * @param {object} sessionService    SessionService — provides the canonical
   *                                   unique-viewer count via
   *                                   `getUniqueViewerCount()`.
   */
  constructor(io, sessionService) {
    if (!io) {
      throw new Error('ViewerCountNotifier requires a Socket.IO instance');
    }
    if (!sessionService) {
      throw new Error('ViewerCountNotifier requires a SessionService');
    }
    this.io = io;
    this.sessionService = sessionService;
  }

  /**
   * Broadcast the current unique-viewer count to every connected client.
   *
   * No arguments — the count is derived from `sessionService` inside this
   * method. Callers signal "something happened that may have changed the
   * viewer count; please broadcast", not "the new count is N". This
   * eliminates a class of off-by-one bugs where a caller computed the count
   * before its own state change had landed.
   */
  broadcast() {
    const count = this.sessionService.getUniqueViewerCount();
    // _traceId propagation deliberately omitted (ADR-0020 §4): this event's
    // payload is a bare integer, not an object. Adding _traceId would break
    // every existing client consumer (which destructures `count` directly).
    // Migrating the signature to `{ count, _traceId }` is a separate
    // breaking-change PR that needs client coordination.
    this.io.emit('viewer-count-update', count);
  }
}

module.exports = ViewerCountNotifier;
