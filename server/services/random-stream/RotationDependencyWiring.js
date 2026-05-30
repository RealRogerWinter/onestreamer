/**
 * RotationDependencyWiring — the dependency-injection / service-registration
 * surface for RandomStreamRotationService. Extracted from the main service.
 *
 * Holds no rotation state of its own — every field it sets lives on the
 * `host` (single source of truth via `host.<field>`). Each method is
 * byte-equivalent to the pre-extraction `setViewBotURLService`,
 * `setViewBotRotation`, `setWhitelistService`, `setSocketIO`, and
 * `setStreamNotifier` bodies (same log lines, same fan-out, same
 * `url-stream-ended` auto-rotate listener).
 *
 * The `url-stream-ended` listener re-enters the rotation engine via
 * `host.*` (host.sendChatAnnouncement, host._rotateToNewStream,
 * host._recordSuccess/_recordFailure, host._scheduleNextRotation) so any
 * host-level instrumentation / test stubs intercept, matching the
 * pre-extraction callsite.
 *
 * Cross-service collaboration via `this.host.*`:
 *   host.viewBotURLService, host.viewBotRotation, host.whitelistService,
 *   host.io, host.streamNotifier, host.twitchService, host.kickService
 *   host.isEnabled, host.isRestarting, host.retryState
 *   host.sendChatAnnouncement(), host._rotateToNewStream(),
 *   host._recordSuccess(), host._recordFailure(),
 *   host._scheduleNextRotation(), host._setupStreamEndedListener()
 *
 * The shared `logger` is the RandomStreamRotationService child, so log lines
 * keep their `svc: 'RandomStreamRotationService'` binding.
 */

class RotationDependencyWiring {
  constructor({ host, logger }) {
    this.host = host;
    this.logger = logger;
  }

  setViewBotURLService(service) {
    const host = this.host;
    const logger = this.logger;

    host.viewBotURLService = service;
    logger.debug('✅ ViewBotURLService registered with RandomStreamRotation');

    // CRITICAL: Listen for URL stream failures to auto-rotate to next stream
    if (service) {
      service.on('url-stream-ended', async (data) => {
        const { urlId, reason } = data;
        logger.debug(`🔔 ROTATION: URL stream ${urlId} ended (reason: ${reason})`);

        // Only auto-rotate if the stream failed (not manual stop)
        const shouldRotate = ['error', 'reconnect_failed', 'source_ended', 'health-check', 'http_error'].includes(reason);

        if (shouldRotate && host.isEnabled) {
          logger.debug(`🔄 ROTATION: Auto-rotating to next stream due to ${reason}...`);

          // Announce to chat that stream disconnected and we're finding a new one
          host.sendChatAnnouncement('Stream disconnected - finding a new streamer...');

          // Small delay to let cleanup complete (shorter for HTTP errors since no reconnect was attempted)
          const cleanupDelay = reason === 'http_error' ? 500 : 1500;
          await new Promise(resolve => setTimeout(resolve, cleanupDelay));

          // CRITICAL: Check if service is busy (reconnecting or starting new stream)
          if (host.viewBotURLService.isBusy()) {
            logger.debug('⏳ ROTATION: Service is busy (reconnecting/starting), skipping auto-rotation');
            return;
          }

          // Check if already restarting or retry timer pending
          if (host.isRestarting || host.retryState.currentRetryTimer) {
            logger.debug('⏳ ROTATION: Already restarting or retry pending, skipping auto-rotation');
            return;
          }

          // Check if another stream started in the meantime
          if (host.viewBotURLService.activeStreams.size === 0) {
            host.isRestarting = true;
            try {
              const result = await host._rotateToNewStream();
              if (result.success) {
                logger.debug(`✅ ROTATION: Auto-rotated to new stream: ${result.stream?.displayName}`);
                host._recordSuccess();

                // Ensure rotation timer is scheduled
                if (!host.rotationTimer) {
                  host._scheduleNextRotation();
                }
              } else {
                logger.error(`❌ ROTATION: Auto-rotation failed: ${result.error}`);
                host._recordFailure();
                // Auto-restart monitor will handle retry with backoff
              }
            } catch (error) {
              logger.error(`❌ ROTATION: Auto-rotation error:`, error.message);
              host._recordFailure();
            } finally {
              host.isRestarting = false;
            }
          } else {
            logger.debug('⏭️ ROTATION: Another stream already started, skipping auto-rotation');
            host._recordSuccess(); // Stream recovered on its own
          }
        }
      });
      logger.debug('✅ URL stream failure listener registered for auto-rotation');
    }
  }

  setViewBotRotation(rotation) {
    this.host.viewBotRotation = rotation;
    this.logger.debug('✅ ViewBotRotation registered with RandomStreamRotation');
  }

  setWhitelistService(whitelistService) {
    const host = this.host;
    host.whitelistService = whitelistService;
    if (host.twitchService && typeof host.twitchService.setWhitelistService === 'function') {
      host.twitchService.setWhitelistService(whitelistService);
    }
    if (host.kickService && typeof host.kickService.setWhitelistService === 'function') {
      host.kickService.setWhitelistService(whitelistService);
    }
    this.logger.debug('✅ WhitelistService registered with RandomStreamRotation');
  }

  setSocketIO(io) {
    const host = this.host;
    host.io = io;
    this.logger.debug('✅ Socket.IO registered with RandomStreamRotation');

    // Listen for stream-ended events to auto-restart rotation
    if (io) {
      // Use a separate handler that checks if we should auto-restart
      host._setupStreamEndedListener();
    }
  }

  setStreamNotifier(streamNotifier) {
    this.host.streamNotifier = streamNotifier;
    this.logger.debug('✅ StreamNotifier registered with RandomStreamRotation');
  }
}

module.exports = RotationDependencyWiring;
