/**
 * StreamHandler
 *
 * Registers the core streaming/takeover socket events on a per-connection
 * basis. Continuation of PR-H's socket-extraction pattern (see AdminHandler,
 * EffectHandler, GameHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - join-as-viewer    A client opts in to receive the stream. Adds to the
 *                      viewers room, emits stream-status + rotation/cooldown
 *                      hints, starts time-tracking, etc.
 *   - request-to-stream A client asks to become the active streamer. Performs
 *                      permission/cooldown/IP-ban gating, stops any current
 *                      viewbot (or marks real-streamer-active), sets the new
 *                      streamer, emits stream-ended/streaming-approved, opens
 *                      logging/time-tracking sessions, and for ViewBots emits
 *                      stream-ready immediately.
 *   - stream-offer      Streamer -> specific viewer signalling pass-through
 *                      (legacy WebRTC P2P; the modern path uses MediaSoup).
 *   - stream-answer     Viewer  -> streamer signalling pass-through.
 *   - stop-streaming    The active streamer voluntarily ends their session.
 *                      Persists disconnect time, ends log + time-tracking
 *                      sessions, applies individual cooldown, broadcasts
 *                      stream-ended, clears viewbot protection, and (after a
 *                      delay) restarts viewbot rotation.
 *   - request-stream    Viewer-side ask: relayed to the named streamer socket
 *                      as `viewer-requesting-stream`. Pure pass-through; no
 *                      services touched. Moved here in Phase 4's inline-
 *                      listener sweep because it pairs with stream-offer /
 *                      stream-answer (the streamer's response cycle).
 *   - request-test-stream  Viewer-side graceful-degradation request. If no
 *                      ViewbotService is wired, falls back to the legacy
 *                      TestStreamService. Otherwise auto-starts a ViewBot
 *                      with synthetic-user-id linkage so the buff system
 *                      treats it as a streamer. Broadcasts new-streamer +
 *                      bumps the viewer count. Moved here in Phase 4 for
 *                      the same reason as request-stream — it's the
 *                      fallback half of the stream-acquisition flow.
 *
 * Note: `stream-ready` is emitted by the server (e.g., by request-to-stream
 * for ViewBots, and from MediaSoup producer-created paths in index.js); there
 * is no `socket.on('stream-ready', ...)` to register, so it is not listed
 * here as a handler — it remains an outbound event only.
 *
 * `deps` (all required unless noted):
 *   - streamService            Active-streamer registry + status getters.
 *   - sessionService           Socket/IP -> session + userId mapping.
 *   - takeoverService          Cooldown ledger.
 *   - mediasoupService         For cleanup() on takeover + currentStreamer sync.
 *   - testStreamService        Used by the graceful-degradation request-test-stream
 *                              fallback path when no ViewbotService is wired.
 *   - timeTrackingService      Viewing/streaming session bookkeeping.
 *   - buffDebuffService        Streamer-buff lookup on new-stream broadcast.
 *   - streamingLogsService     Per-session streaming log (start/end).
 *   - recordingService         Stream-end recording finalisation (may be null).
 *   - SimpleViewBotRotation    Module with stopRotation/startRotation.
 *   - IPBanService             Static helpers for IP fingerprint + ban lookup.
 *   - notifiedStreamers        Shared Set<string> of socket IDs the server has
 *                              already emitted stream-ready for.
 *   - viewbotSocketIds         Shared Set<string> of ViewBot socket IDs.
 *   - lastEmittedStreamReady   Shared mutable { streamerId, timestamp } used
 *                              to dedupe stream-ready emissions across the
 *                              process. MUST be mutated in place (not
 *                              reassigned) so other modules see updates.
 *   - getViewbotService        () => viewbotService. Lazy because the legacy
 *                              ViewbotService is constructed after io.on
 *                              wiring (post-startServer init).
 *   - getViewBotClientService  () => viewBotClientService. Same reason.
 *   - enrichStreamStatus       Helper from index.js: adds streamerDisplayName.
 *   - getStreamerDisplayName   Helper from index.js: socketId -> display name.
 *   - notifyViewersStreamStarted  Helper from index.js (room broadcast +
 *                                 server-side viewer-session bootstrapping).
 *   - notifyViewersStreamEnded    Helper from index.js (room broadcast +
 *                                 stop tracking + schedule rotation).
 *   - broadcastGlobalCooldown  Helper from index.js: cooldown fanout.
 *   - runAsync                 db helper (sqlite promisified writer).
 *   - database                 db handle (for allAsync reads).
 *   - axios                    HTTP client for chat-service announcement POST.
 *   - https                    Used for the relaxed-TLS Agent on the above.
 *
 * ---------------------------------------------------------------------------
 * Decomposition (refactor/streamhandler-socket-decompose):
 *
 * The handler bodies were split into cohesive sub-modules under
 * `server/sockets/streamHandler/`, each exporting a registration function that
 * takes the same `(io, socket, deps)`. This parent is now a thin orchestrator
 * that calls each sub-registration in the SAME order the listeners were
 * originally registered, forwarding the full `deps` bag (each sub-module
 * destructures only what it needs). Handler bodies are VERBATIM — no event
 * names, payloads, emit targets, or logic changed.
 *
 * Registration order (must be preserved — pinned by the characterization
 * suite at server/tests/sockets/StreamHandler.characterization.test.js):
 *   join-as-viewer        -> viewers.js
 *   request-to-stream     -> takeover.js
 *   stream-offer          -> signaling.js (registerOfferAnswer)
 *   stream-answer         -> signaling.js (registerOfferAnswer)
 *   stop-streaming        -> lifecycle.js
 *   request-stream        -> signaling.js (registerRequestStream)
 *   request-test-stream   -> testStream.js
 *
 * `stream-offer`/`stream-answer` and `request-stream` straddle
 * `stop-streaming` in the original ordering, so signaling.js exposes two
 * registration functions that are interleaved here to keep the `socket.on`
 * sequence byte-identical.
 */
const registerViewers = require('./streamHandler/viewers');
const registerTakeover = require('./streamHandler/takeover');
const { registerOfferAnswer, registerRequestStream } = require('./streamHandler/signaling');
const registerLifecycle = require('./streamHandler/lifecycle');
const registerTestStream = require('./streamHandler/testStream');

module.exports = function registerStreamHandler(io, socket, deps) {
  registerViewers(io, socket, deps);
  registerTakeover(io, socket, deps);
  registerOfferAnswer(io, socket, deps);
  registerLifecycle(io, socket, deps);
  registerRequestStream(io, socket, deps);
  registerTestStream(io, socket, deps);
};
