/**
 * ViewBotCleanupCoordinator — the comprehensive "stop every viewbot system"
 * teardown that runs before random rotation takes over the stream. Extracted
 * from RandomStreamRotationService.
 *
 * Holds no rotation state of its own — just a `host` back-reference. The
 * `cleanupAll()` body is byte-equivalent to the pre-extraction
 * `_cleanupAllViewbots` (same ordered teardown of SimpleViewBotRotation,
 * the global ViewBotRotationService/ViewBotManager/UnifiedViewBotRotation/
 * LiveKit viewbots, the StreamService + MediaSoup current-streamer clears,
 * the StreamNotifier stream-ended chokepoint, and the trailing 1 s pause).
 *
 * Cross-service collaboration via `this.host.*`:
 *   host.viewBotRotation, host.streamNotifier
 *   global.viewBotRotation, global.viewBotManager,
 *   global.unifiedViewBotRotation, global.viewBotLiveKitService,
 *   global.streamService, global.mediasoupService
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

    // 2. CRITICAL: Stop ViewBotRotationService (global.viewBotRotation)
    // This is a SEPARATE service from SimpleViewBotRotation!
    if (global.viewBotRotation && global.viewBotRotation.stopRotation) {
      logger.debug('🛑 Stopping ViewBotRotationService (global.viewBotRotation)...');
      try {
        global.viewBotRotation.enabled = false;
        await global.viewBotRotation.stopRotation();
        logger.debug('✅ ViewBotRotationService stopped and disabled');
      } catch (error) {
        logger.error('⚠️ Error stopping ViewBotRotationService:', error.message);
      }
    }

    // 3. Stop ViewBotManager if it exists (alternative viewbot system)
    if (global.viewBotManager) {
      logger.debug('🛑 Stopping ViewBotManager...');
      try {
        // Stop rotation first
        global.viewBotManager.stopRotation();
        // Then cleanup all bots
        await global.viewBotManager.cleanup();
        logger.debug('✅ ViewBotManager cleaned up');
      } catch (error) {
        logger.error('⚠️ Error cleaning up ViewBotManager:', error.message);
      }
    }

    // 4. Stop UnifiedViewBotRotation if it exists
    if (global.unifiedViewBotRotation) {
      logger.debug('🛑 Stopping UnifiedViewBotRotation...');
      try {
        if (global.unifiedViewBotRotation.stopRotation) {
          await global.unifiedViewBotRotation.stopRotation();
        }
        logger.debug('✅ UnifiedViewBotRotation stopped');
      } catch (error) {
        logger.error('⚠️ Error stopping UnifiedViewBotRotation:', error.message);
      }
    }

    // 5. CRITICAL: Stop all LiveKit viewbots and remove them from the room
    if (global.viewBotLiveKitService) {
      logger.debug('🛑 Stopping all LiveKit viewbots...');
      try {
        await global.viewBotLiveKitService.stopAllViewBots();
        logger.debug('✅ All LiveKit viewbots stopped');
      } catch (error) {
        logger.error('⚠️ Error stopping LiveKit viewbots:', error.message);
      }
    }

    // 4. Clear current streamer from StreamService (viewbot was the current streamer)
    if (global.streamService) {
      const currentStreamer = global.streamService.getCurrentStreamer();
      if (currentStreamer && (currentStreamer.startsWith('viewbot-') || currentStreamer.includes('viewbot'))) {
        logger.debug(`🧹 Clearing viewbot streamer: ${currentStreamer}`);
        global.streamService.clearStreamer();
      }
    }

    // 5. Clear MediasoupService/WebRTCAdapter currentStreamer
    if (global.mediasoupService && global.mediasoupService.currentStreamer) {
      const current = global.mediasoupService.currentStreamer;
      if (current.startsWith('viewbot-') || current.includes('viewbot')) {
        logger.debug(`🧹 Clearing MediaSoup viewbot streamer: ${current}`);
        global.mediasoupService.currentStreamer = null;
      }
    }

    // 6. Emit stream-ended to notify viewers the current content is ending
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
