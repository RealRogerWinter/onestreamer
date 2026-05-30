/**
 * ViewBotHandler
 *
 * Registers ViewBot socket events on a per-connection basis. Continuation of
 * PR-H's socket-extraction pattern (see AdminHandler, EffectHandler,
 * GameHandler, StreamHandler, MediaSoupHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - viewbot-create-plain-bridge      Create a Plain RTP bridge transport so
 *                                      FFmpeg/GStreamer can pipe RTP into a
 *                                      WebRTC producer.
 *   - viewbot-create-webrtc-transport  (Two listeners, both preserved.) The
 *                                      first is the legacy variant that also
 *                                      auto-creates a producer + transport
 *                                      under a `viewbot-<botId>-<kind>` key.
 *                                      The second is the modern mobile-friendly
 *                                      variant that just returns
 *                                      transport options to the caller.
 *   - viewbot-create-plain-transport   Create a Plain RTP transport for a
 *                                      single kind and immediately produce on
 *                                      it with fixed SSRCs / RTP parameters.
 *   - stop-stream                      ViewBot-rotation-specific stream stop
 *                                      (NOT the user-facing stop-streaming —
 *                                      that one is in StreamHandler).
 *   - viewbot-create-transport         Create paired Plain RTP transports
 *                                      (video + audio) for a ViewBot. Branches
 *                                      to LiveKit-mode response when the
 *                                      adapter is configured for LiveKit.
 *   - viewbot-webrtc-produce           Create video + audio producers on the
 *                                      ViewBot's WebRTC transport with the
 *                                      canned RTP parameters that GStreamer
 *                                      will send. Includes real-streamer-vs-
 *                                      viewbot priority gating.
 *   - viewbot-create-producers         Same idea but on the paired Plain RTP
 *                                      transports created by
 *                                      viewbot-create-transport.
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
 *   - `global.webrtcAdapter` and `global.viewBotRotation` are accessed
 *     directly to preserve byte-equivalent runtime behaviour. These are
 *     long-lived singletons set up during startServer and the inline code
 *     reaches into them the same way.
 *
 * PR (this refactor): the verbatim handler bodies have been split into
 * cohesive sub-modules under `server/sockets/viewBotHandler/`, each exporting
 * a registration fn with the SAME `(io, socket, deps)` signature. This parent
 * is now a thin orchestrator that calls each sub-registration in the original
 * `socket.on` order — event names, payloads, emit targets, and the dual
 * `viewbot-create-webrtc-transport` listener are all preserved byte-for-byte:
 *
 *   1. registerTransportCreation     viewbot-create-plain-bridge,
 *                                    viewbot-create-webrtc-transport (legacy),
 *                                    viewbot-create-plain-transport
 *   2. registerStopStream            stop-stream
 *   3. registerProducerCreation      viewbot-create-webrtc-transport (modern),
 *                                    viewbot-create-transport,
 *                                    viewbot-webrtc-produce,
 *                                    viewbot-create-producers
 *   4. registerRotationAndCleanup    viewbot-stream-ready,
 *                                    viewbot-rotation-request,
 *                                    viewbot-video-ended,
 *                                    viewbot-cleanup-transports
 */
const registerTransportCreation = require('./viewBotHandler/registerTransportCreation');
const registerStopStream = require('./viewBotHandler/registerStopStream');
const registerProducerCreation = require('./viewBotHandler/registerProducerCreation');
const registerRotationAndCleanup = require('./viewBotHandler/registerRotationAndCleanup');

module.exports = function registerViewBotHandler(io, socket, deps) {
  // Sub-registrations are invoked in the same order the events were originally
  // registered inline, so `socket.on` call ordering is identical.
  registerTransportCreation(io, socket, deps);
  registerStopStream(io, socket, deps);
  registerProducerCreation(io, socket, deps);
  registerRotationAndCleanup(io, socket, deps);
};
