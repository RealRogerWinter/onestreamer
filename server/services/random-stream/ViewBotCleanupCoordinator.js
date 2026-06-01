/**
 * ViewBotCleanupCoordinator — the comprehensive "stop every viewbot system"
 * teardown that runs before random rotation takes over the stream. Extracted
 * from RandomStreamRotationService.
 *
 * Holds no rotation state of its own — just a `host` back-reference. The
 * `cleanupAll()` body performs the ordered teardown of SimpleViewBotRotation,
 * the LiveKit viewbots, the StreamService + WebRTC current-streamer clears,
 * the StreamNotifier stream-ended chokepoint, and the trailing 1 s pause.
 * (The dead never-assigned globals ViewBotRotationService/ViewBotManager/
 * UnifiedViewBotRotation were removed once the viewbot fleet was retired.)
 *
 * Cross-service collaboration:
 *   host.viewBotRotation, host.streamNotifier
 *   global.viewBotLiveKitService, global.streamService, global.webrtcService
 *
 * The shared `logger` is the RandomStreamRotationService child, so log lines
 * keep their `svc: 'RandomStreamRotationService'` binding.
 */

class ViewBotCleanupCoordinator {
  constructor({ host, logger }) {
    this.host = host;
    this.logger = logger;
  }

  async cleanupAll() {
    const host = this.host;
    const logger = this.logger;

    logger.debug('🧹 Performing comprehensive viewbot cleanup...');

    // 1. Stop SimpleViewBotRotation (primary viewbot system)
    if (host.viewBotRotation) {
      logger.debug('🛑 Stopping SimpleViewBotRotation...');
      // Disable the rotation to prevent auto-restart
      host.viewBotRotation.settings.enabled = false;
      // Stop and wait for cleanup
      await host.viewBotRotation.stopRotation();
      logger.debug('✅ SimpleViewBotRotation stopped and disabled');
    }

    // 2. CRITICAL: Stop all LiveKit viewbots and remove them from the room
    if (global.viewBotLiveKitService) {
      logger.debug('🛑 Stopping all LiveKit viewbots...');
      try {
        await global.viewBotLiveKitService.stopAllViewBots();
        logger.debug('✅ All LiveKit viewbots stopped');
      } catch (error) {
        logger.error('⚠️ Error stopping LiveKit viewbots:', error.message);
      }
    }

    // 3. Clear current streamer from StreamService (viewbot was the current streamer)
    if (global.streamService) {
      const currentStreamer = global.streamService.getCurrentStreamer();
      if (currentStreamer && (currentStreamer.startsWith('viewbot-') || currentStreamer.includes('viewbot'))) {
        logger.debug(`🧹 Clearing viewbot streamer: ${currentStreamer}`);
        global.streamService.clearStreamer();
      }
    }

    // 4. Clear WebRTC current-streamer (viewbot was the current streamer)
    if (global.webrtcService && global.webrtcService.currentStreamer) {
      const current = global.webrtcService.currentStreamer;
      if (current.startsWith('viewbot-') || current.includes('viewbot')) {
        logger.debug(`🧹 Clearing MediaSoup viewbot streamer: ${current}`);
        global.webrtcService.currentStreamer = null;
      }
    }

    // 5. Emit stream-ended to notify viewers the current content is ending
    // PR 3.1: routed through StreamNotifier (single chokepoint).
    if (host.streamNotifier) {
      logger.debug('📢 Broadcasting stream-ended to prepare for rotation...');
      host.streamNotifier.streamEnded({
        reason: 'random_rotation_starting',
        isRandomRotation: true,
      });
    }

    // Brief pause to allow cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    logger.debug('✅ Viewbot cleanup complete');
  }
}

module.exports = ViewBotCleanupCoordinator;
