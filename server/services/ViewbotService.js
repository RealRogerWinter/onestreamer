/**
 * ViewbotService — reduced to the stateless `isViewbotStream` predicate.
 *
 * Under LiveKit (the sole WebRTC backend, ADR-0024) the viewbot
 * CREATION/STREAMING half of this service is dead: live viewbots run via
 * SimpleViewBotRotation → ViewBotLiveKitService and are tracked by socket id,
 * never through ViewbotService.startViewbot. That half — startViewbot,
 * stopViewbot, cleanup/stop, handleTakeover, updateViewbotConfig,
 * mapContentToPattern, spawnAdditionalViewbot, removeViewbot, getViewbotStatus,
 * getViewbotMetrics, isHealthy — plus the ViewBotWebRTCService backend it drove
 * and all of its mutable state was removed once it was confirmed admin-only.
 *
 * What remains is `isViewbotStream`: a pure prefix check used across the
 * socket and route layers (~12 callers — server/index.js, BuffHandler,
 * DisconnectHandler, takeover.js, routes/buffs.js, admin-moderation.js,
 * internal/callbacks.js, viewbot-admin/test-stream.js) to classify whether the
 * current streamer is any flavour of viewbot. It is stateless and fully
 * decoupled from the removed creation half.
 */
class ViewbotService {
  isViewbotStream(streamId) {
    return streamId && streamId.startsWith('viewbot-');
  }
}

module.exports = ViewbotService;
