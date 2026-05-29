const logger = require('../../bootstrap/logger').child({ svc: 'RealStreamerGuard' });

/**
 * RealStreamerGuard - real-streamer protection collaborator for
 * ViewBotClientService.
 *
 * Owns the realStreamerActive flag transitions and the periodic
 * auto-validation timer. Extracted verbatim from ViewBotClientService;
 * behavior unchanged. State (realStreamerActive, currentLiveBot,
 * rotationEnabled, pendingTakeoverTimer, validationTimer) remains the single
 * source of truth on the owning service instance, so this collaborator
 * mutates `owner.<field>` directly and delegates rotation actions
 * (stopViewBotRotation, scheduleViewBotTakeover, maintainViewBotPresence) back
 * to the owner.
 *
 * @param {Object} deps
 * @param {Object} deps.streamService - StreamService (current streamer lookup).
 * @param {Object} deps.mediasoupService - MediaSoupService (fallback lookup).
 * @param {Object} deps.viewbotService - ViewbotService (viewbot-stream check).
 * @param {Object} deps.owner - Back-reference to ViewBotClientService for live
 *   state and rotation methods.
 */
class RealStreamerGuard {
  constructor({ streamService, mediasoupService, viewbotService, owner }) {
    this.streamService = streamService;
    this.mediasoupService = mediasoupService;
    this.viewbotService = viewbotService;
    this.owner = owner;
  }

  /**
   * Sets the real streamer status (protects from ViewBot takeover)
   */
  setRealStreamerStatus(isActive) {
    const previousStatus = this.owner.realStreamerActive;
    this.owner.realStreamerActive = isActive;
    logger.debug(`👤 Real streamer status: ${isActive ? 'ACTIVE' : 'INACTIVE'} (was: ${previousStatus ? 'ACTIVE' : 'INACTIVE'})`);

    if (isActive) {
      // Clear any pending takeover timer
      if (this.owner.pendingTakeoverTimer) {
        clearTimeout(this.owner.pendingTakeoverTimer);
        this.owner.pendingTakeoverTimer = null;
        logger.debug(`🚫 Cancelled pending ViewBot takeover - real streamer is active`);
      }

      if (this.owner.currentLiveBot) {
        // Stop current ViewBot if a real streamer becomes active
        logger.debug(`🛑 Real streamer active - stopping ViewBot ${this.owner.currentLiveBot}`);
        this.owner.stopViewBotRotation();
      }
    } else {
      // Real streamer disconnected - schedule ViewBot takeover after delay
      logger.debug(`🔍 Checking takeover conditions: rotationEnabled=${this.owner.rotationEnabled}, currentLiveBot=${this.owner.currentLiveBot}`);

      // Only proceed if status actually changed from true to false
      if (previousStatus === true && isActive === false) {
        logger.debug(`📉 Real streamer status changed from ACTIVE to INACTIVE`);

        if (this.owner.rotationEnabled) {
          if (!this.owner.currentLiveBot) {
            logger.debug(`✅ No ViewBot currently live - scheduling takeover`);
            this.owner.scheduleViewBotTakeover();
          } else {
            logger.debug(`ℹ️ ViewBot ${this.owner.currentLiveBot} is already live - no takeover needed`);
          }
        } else {
          logger.debug(`❌ Rotation is disabled - no ViewBot takeover`);
        }
      } else if (previousStatus === false && isActive === false) {
        logger.debug(`ℹ️ Real streamer was already inactive - no action needed`);
        // But still check if we need to maintain presence
        setTimeout(() => this.owner.maintainViewBotPresence(), 2000);
      }
    }

    return { success: true, realStreamerActive: this.owner.realStreamerActive };
  }

  /**
   * Validates and auto-corrects real streamer status based on actual stream state
   * This ensures the flag is always accurate and prevents orphaned states
   */
  validateRealStreamerStatus() {
    if (!this.owner.realStreamerActive) {
      return; // If already inactive, no validation needed
    }

    // Get current streamer from the main services
    const currentStreamer = this.streamService ? this.streamService.getCurrentStreamer() :
                           this.mediasoupService ? this.mediasoupService.getCurrentStreamer() : null;

    if (!currentStreamer) {
      // No active streamer at all - clear the real streamer flag
      logger.debug(`🔍 VALIDATION: No active streamer found, clearing real streamer flag`);
      this.owner.realStreamerActive = false;
      return;
    }

    // Check if current streamer is a ViewBot
    const isViewbot = this.viewbotService ? this.viewbotService.isViewbotStream(currentStreamer) :
                     currentStreamer.includes('viewbot-') || currentStreamer.includes('bot-');

    if (isViewbot && this.owner.realStreamerActive) {
      // Current streamer is a ViewBot but real streamer flag is active - this is inconsistent
      logger.debug(`🔍 VALIDATION: Current streamer ${currentStreamer} is ViewBot, clearing real streamer flag`);
      this.owner.realStreamerActive = false;
      return;
    }

    // If we get here and realStreamerActive is true, there should be a real user streaming
    logger.debug(`🔍 VALIDATION: Real streamer flag validated - current streamer: ${currentStreamer.substring(0, 12)}...`);
  }

  /**
   * Auto-validation that runs periodically to ensure real streamer status accuracy
   */
  startAutoValidation() {
    // Run validation every 30 seconds
    if (this.owner.validationTimer) {
      clearInterval(this.owner.validationTimer);
    }

    this.owner.validationTimer = setInterval(() => {
      this.validateRealStreamerStatus();

      // CRITICAL: Also check if we need to maintain ViewBot presence
      this.owner.maintainViewBotPresence();
    }, 30000); // 30 seconds

    logger.debug(`🔍 VALIDATION: Auto-validation started (30s intervals)`);
  }

  /**
   * Stop auto-validation timer
   */
  stopAutoValidation() {
    if (this.owner.validationTimer) {
      clearInterval(this.owner.validationTimer);
      this.owner.validationTimer = null;
      logger.debug(`🔍 VALIDATION: Auto-validation stopped`);
    }
  }
}

module.exports = RealStreamerGuard;
