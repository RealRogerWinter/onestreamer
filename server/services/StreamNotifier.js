// server/services/StreamNotifier.js
//
// Single emission chokepoint for the server's `stream-ended` socket event.
//
// Phase 3 of the refactor names "state unification + typed socket facade" as
// its conceptual goal: each conceptually-singular socket event currently has
// multiple independently-maintained emit sites (16+ for `stream-ended` across
// 9 files), and those fan-out points are how cross-channel ordering bugs
// creep in (see PR 2.5b's `streamGeneration` counter, which papered over one
// such ordering hazard on `stream-status`). The mechanical fix is to collapse
// every `stream-ended` callsite into a single notifier method so the
// emit-side invariants (event name, payload shape, the eventual addition of
// a monotonic counter, the broadcast-vs-targeted distinction) live in ONE
// place — not 17.
//
// What this class is and is NOT:
//   - It IS a thin façade — exactly one `io.emit('stream-ended', payload)`
//     call, mirrored by exactly one `socket.broadcast.emit(...)` for the
//     takeover variant that excludes the new streamer's own socket.
//   - It is NOT a dispatcher with per-reason handlers. The receivers
//     (client-side `useStreamState.ts:318`) DO discriminate on `reason` for
//     a few specific values (`takeover`, `random_rotation_*`, prefix
//     `url_stream_`, `webrtc_disconnect`), but the rest are display tags;
//     a Map<reason, handler> would be ceremony.
//   - It does NOT bump `streamGeneration`. Today's `stream-ended` payload
//     carries no counter; the cross-channel ordering work is concentrated
//     on `stream-status`. If a future PR threads the counter onto
//     `stream-ended`, this is the one place that has to change.
//
// Reason-string pinning:
//   `REASONS` is the union of every reason emitted at PR 3.1's baseline.
//   Tests pin this set so a typo in a callsite ("admin_clearr") doesn't
//   silently produce an event that no client switch-case matches. At runtime
//   an unknown reason still emits (so a typo never silently swallows an
//   event), but logs a structured warning so monitoring can catch surface
//   drift. New emit sites are expected to extend the set explicitly.

class StreamNotifier {
  /**
   * @param {object} io Socket.IO server instance.
   */
  constructor(io) {
    if (!io) {
      throw new Error('StreamNotifier requires a Socket.IO instance');
    }
    this.io = io;
  }

  /**
   * Broadcast a `stream-ended` event.
   *
   * @param {object}   opts
   * @param {string}   opts.reason          Required. One of `StreamNotifier.REASONS`.
   *                                        If omitted, the call is a no-op (warned).
   * @param {object}   [opts.excludeSocket] A specific socket to EXCLUDE from
   *                                        the broadcast (sends via
   *                                        `socket.broadcast.emit`). Used by
   *                                        the takeover path so the new
   *                                        streamer doesn't process its own
   *                                        stream as "ended".
   * @param {string}   [opts.previousStreamer]      Various reasons.
   * @param {string}   [opts.newStreamer]           `takeover` only.
   * @param {string}   [opts.newStreamerDisplayName] `takeover` only.
   * @param {string}   [opts.streamerId]            `url_stream_*`, `webrtc_viewbot_*`,
   *                                                `random_rotation_stopped`.
   * @param {boolean}  [opts.isRandomRotation]      Random rotation transitions.
   * @param {boolean}  [opts.isUrlStream]           URL-stream variants.
   * @param {string}   [opts.message]               `webrtc_disconnect`.
   * @param {string}   [opts.streamType]            `webrtc_viewbot_stopped`.
   * @param {number}   [opts.timestamp]             `rotation`.
   */
  streamEnded(opts = {}) {
    const { reason, excludeSocket, ...extras } = opts;

    if (!reason) {
      console.warn('⚠️ STREAM_NOTIFIER: streamEnded() called without `reason` — emit suppressed');
      return;
    }

    if (!StreamNotifier.REASONS.has(reason)) {
      console.warn(`⚠️ STREAM_NOTIFIER: unknown stream-ended reason "${reason}" — REASONS set is out of date`);
    }

    const payload = { reason, ...extras };

    if (excludeSocket) {
      excludeSocket.broadcast.emit('stream-ended', payload);
    } else {
      this.io.emit('stream-ended', payload);
    }
  }
}

// Phase 3 baseline. Every reason emitted by the 17 callsites this PR
// collapses is listed here. Adding a new reason: append it. Removing a
// reason: don't — receivers may discriminate on it. The test suite asserts
// the baseline set is a subset of REASONS, so future extensions are safe
// but accidental deletions fail loud.
//
// The four `url_stream_*` reasons are produced by the dynamic
// `url_stream_${reason}` template inside `ViewBotURLService._handleStreamEnd`
// at line 1236 (inner reasons: 'source_ended', 'http_error',
// 'reconnect_failed', 'error'). The client guard at
// `client/src/hooks/useStreamState.ts:343` is `reason?.startsWith('url_stream_')`,
// so adding new url_stream_* reasons doesn't require client changes — but
// adding them here means a typo'd new one still gets flagged.
StreamNotifier.REASONS = new Set([
  // server/sockets/ViewBotHandler.js
  'stop_stream_request',
  // server/sockets/StreamHandler.js (takeover branch — broadcast variant)
  'takeover',
  // server/sockets/StreamHandler.js (stop-streaming)
  'user_stopped_streaming',
  // server/index.js — admin/test/viewbot stop endpoints
  'viewbot_stopped',
  'viewbot_legacy_stopped',
  'test_stream_stopped',
  'admin_clear',
  'admin_disconnect',
  'streamer_banned',
  // server/index.js — socket disconnect handler
  'streamer_disconnected',
  // server/services/ViewBotURLService.js — _handleStreamEnd dynamic template
  'url_stream_source_ended',
  'url_stream_http_error',
  'url_stream_reconnect_failed',
  'url_stream_error',
  // server/services/ViewBotURLService.js — explicit stop
  'url_stream_stopped',
  // server/services/LiveKitService.js — health-check stale clear
  'webrtc_disconnect',
  // server/services/ViewBotRotationService.js — bot stop
  'rotation',
  // server/services/RandomStreamRotationService.js
  'random_rotation_starting',
  'random_rotation_stopped',
  // server/services/WebRTCViewBotRotation.js — bot stop (formerly no-reason,
  // PR 3.1 adds an explicit reason so the chokepoint can pin the surface)
  'webrtc_viewbot_stopped',
]);

module.exports = StreamNotifier;
