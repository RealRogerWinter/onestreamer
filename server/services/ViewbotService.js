/**
 * isViewbotStream — stateless predicate classifying whether a stream/streamer
 * id belongs to a viewbot.
 *
 * Under LiveKit (the sole WebRTC backend, ADR-0024) the viewbot
 * CREATION/STREAMING half of the former `ViewbotService` class was dead: live
 * viewbots run via SimpleViewBotRotation → ViewBotLiveKitService, tracked by
 * socket id, never through `ViewbotService.startViewbot`. That half — and the
 * mutable state + ViewBotWebRTCService backend it drove — was removed once it
 * was confirmed admin-only.
 *
 * All that remained was this pure prefix check, used across the socket and
 * route layers (~12 callers: server/index.js, BuffHandler, DisconnectHandler,
 * takeover.js, routes/buffs.js, admin-moderation.js, internal/callbacks.js,
 * viewbot-admin/test-stream.js). The class wrapper (constructed via the
 * `createViewBotServices` factory with now-unused webrtcService/livekitService
 * args, and carried in the services bag) added nothing, so it was demoted to
 * this stateless module.
 *
 * Exported both as the bare function and as `{ isViewbotStream }` so existing
 * `viewbotService.isViewbotStream(id)` call sites keep working unchanged when
 * `viewbotService` is bound to this module.
 */
function isViewbotStream(streamId) {
  return !!(streamId && streamId.startsWith('viewbot-'));
}

module.exports = isViewbotStream;
module.exports.isViewbotStream = isViewbotStream;
