/**
 * ViewBotHandler
 *
 * Registers ViewBot socket events on a per-connection basis. Continuation of
 * PR-H's socket-extraction pattern (see AdminHandler,
 * GameHandler, StreamHandler, MediaSoupHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - stop-stream                      ViewBot-rotation-specific stream stop
 *                                      (NOT the user-facing stop-streaming —
 *                                      that one is in StreamHandler).
 *   - viewbot-stream-ready             ViewBot reports media is flowing; emit
 *                                      stream-ready with the same dedup as the
 *                                      MediaSoup path.
 *   - viewbot-rotation-request         Pass through to viewBotClientService
 *                                      and broadcast the result.
 *   - viewbot-video-ended              ViewBot's playback ended naturally;
 *                                      force a rotation via the global
 *                                      viewBotRotation singleton.
 *   - viewbot-cleanup-transports       Explicit teardown of a ViewBot's
 *                                      transports + producers, supporting
 *                                      lookup by socketId or by botId.
 *
 * `deps` (all required unless noted):
 *   - mediasoupService             The MediaSoup SFU wrapper (router,
 *                                  transports, producers).
 *   - streamService                Current-streamer registry.
 *   - plainTransportService        Stateful service for ViewBot Plain RTP
 *                                  resources. Used by stop-stream cleanup.
 *   - lastEmittedStreamReady       Shared mutable { streamerId, timestamp }
 *                                  for stream-ready dedup. MUST be mutated in
 *                                  place so other modules see updates.
 *   - notifyViewersStreamEnded     Helper from index.js (room broadcast +
 *                                  stop tracking + schedule rotation). Used
 *                                  on stop-stream when it's NOT a ViewBot
 *                                  rotation.
 *   - getViewBotClientService      () => viewBotClientService. Lazy because
 *                                  ViewBotClientService is constructed after
 *                                  io.on wiring (post-startServer init).
 *   - getViewbotService            () => viewbotService. Reserved for parity
 *                                  with other handlers; the inline ViewBot
 *                                  code paths do not currently read it, but
 *                                  passing it keeps the dep bag uniform with
 *                                  StreamHandler.
 *
 * Notes on global state intentionally NOT in the deps bag:
 *   - `process.env.ANNOUNCED_IP`, `process.env.USE_WEBRTC_ADAPTER`, and
 *     `process.env.WEBRTC_BACKEND` are read directly (same as inline).
 *   - `global.viewBotRotation` is accessed directly to preserve
 *     byte-equivalent runtime behaviour. It's a long-lived singleton set up
 *     during startServer and the inline code reaches into it the same way.
 *
 * PR (this refactor): the verbatim handler bodies have been split into
 * cohesive sub-modules under `server/sockets/viewBotHandler/`, each exporting
 * a registration fn with the SAME `(io, socket, deps)` signature. This parent
 * is now a thin orchestrator that calls each sub-registration in the original
 * `socket.on` order — event names, payloads, and emit targets are all
 * preserved:
 *
 *   1. registerStopStream            stop-stream
 *   2. registerRotationAndCleanup    viewbot-stream-ready,
 *                                    viewbot-rotation-request,
 *                                    viewbot-video-ended,
 *                                    viewbot-cleanup-transports
 */
const registerStopStream = require('./viewBotHandler/registerStopStream');
const registerRotationAndCleanup = require('./viewBotHandler/registerRotationAndCleanup');

module.exports = function registerViewBotHandler(io, socket, deps) {
  // Sub-registrations are invoked in the same order the events were originally
  // registered inline, so `socket.on` call ordering is identical.
  registerStopStream(io, socket, deps);
  registerRotationAndCleanup(io, socket, deps);
};
