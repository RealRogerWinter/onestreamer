const path = require('path');
const fs = require('fs');

const logger = require('../../bootstrap/logger').child({ svc: 'RotationConfigStore' });

/**
 * RotationConfigStore - rotation-settings collaborator for ViewBotClientService.
 *
 * Owns load/save of viewbot-rotation-config.json plus the get/update of the
 * rotation scalar fields (rotationProbability, rotationCheckIntervalMin/Max).
 * Extracted verbatim from ViewBotClientService; behavior unchanged. The
 * rotation scalars remain the single source of truth on the owning service
 * instance, so this collaborator mutates `owner.<field>` directly (the
 * rotation state machine still reads/writes those same fields).
 *
 * @param {Object} deps
 * @param {Object} deps.owner - Back-reference to ViewBotClientService for live
 *   state (rotationProbability, rotationCheckIntervalMin/Max, activeBots,
 *   saveSystemState).
 */
class RotationConfigStore {
  constructor({ owner }) {
    this.owner = owner;
  }

  /**
   * Load rotation configuration from file
   */
  loadRotationConfig() {
    try {
      const configPath = path.join(__dirname, '../../../viewbot-rotation-config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        this.owner.rotationProbability = config.rotationProbability || 0.31;
        this.owner.rotationCheckIntervalMin = config.rotationCheckIntervalMin || 5000;
        this.owner.rotationCheckIntervalMax = config.rotationCheckIntervalMax || 10000;
        logger.debug(`📄 Loaded rotation config: ${(this.owner.rotationProbability * 100).toFixed(1)}% probability, ${this.owner.rotationCheckIntervalMin/1000}-${this.owner.rotationCheckIntervalMax/1000}s intervals`);
      }
    } catch (error) {
      logger.debug('⚠️ Could not load rotation config, using defaults:', error.message);
    }
  }

  /**
   * Save rotation configuration to file
   */
  saveRotationConfig() {
    try {
      const configPath = path.join(__dirname, '../../../viewbot-rotation-config.json');
      const config = {
        rotationProbability: this.owner.rotationProbability,
        rotationCheckIntervalMin: this.owner.rotationCheckIntervalMin,
        rotationCheckIntervalMax: this.owner.rotationCheckIntervalMax,
        comment: `Rotation settings: ${(this.owner.rotationProbability * 100).toFixed(1)}% probability, ${this.owner.rotationCheckIntervalMin/1000}-${this.owner.rotationCheckIntervalMax/1000} second intervals`
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      logger.debug(`💾 Saved rotation config to file`);
    } catch (error) {
      logger.error('❌ Could not save rotation config:', error.message);
    }
  }

  /**
   * Get current rotation settings
   */
  getRotationSettings() {
    return {
      rotationProbability: this.owner.rotationProbability,
      rotationCheckIntervalMin: this.owner.rotationCheckIntervalMin,
      rotationCheckIntervalMax: this.owner.rotationCheckIntervalMax
    };
  }

  /**
   * Update rotation settings
   */
  updateRotationSettings(settings) {
    if (settings.rotationProbability !== undefined) {
      this.owner.rotationProbability = settings.rotationProbability;
    }
    if (settings.rotationCheckIntervalMin !== undefined) {
      this.owner.rotationCheckIntervalMin = settings.rotationCheckIntervalMin;
    }
    if (settings.rotationCheckIntervalMax !== undefined) {
      this.owner.rotationCheckIntervalMax = settings.rotationCheckIntervalMax;
    }

    logger.debug(`🔄 Updated rotation settings: ${(this.owner.rotationProbability * 100).toFixed(1)}% probability, ${this.owner.rotationCheckIntervalMin/1000}-${this.owner.rotationCheckIntervalMax/1000}s intervals`);

    // Save to config file
    this.saveRotationConfig();

    // Restart rotation timers with new intervals if any bots are active.
    // `owner.activeBots` is the canonical map (PR 11.1's split surfaced three
    // typos here: the previous `this.viewBots` lookup TypeError'd, masking
    // both the broken `this.startRotationCheckTimer(bot.botId)` call below
    // — that method lives on ViewBotInstance and takes no args — and a
    // truthy-function-reference filter `bot.isStreaming` that never invoked
    // the method. `activeBots` can also contain placeholder objects from
    // `restoreViewBots`, hence the `typeof === 'function'` guard matching
    // the dominant pattern at lines 1514/1562 below.
    const activeBots = Array.from(this.owner.activeBots.values()).filter(
      (bot) => (typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming)
    );
    if (activeBots.length > 0) {
      logger.debug('🔄 Restarting rotation timers with new settings...');
      activeBots.forEach(bot => {
        if (bot.rotationCheckTimer) {
          clearTimeout(bot.rotationCheckTimer);
          bot.startRotationCheckTimer();
        }
      });
    }
  }

  /**
   * Updates the rotation probability (admin control)
   */
  updateRotationProbability(probability) {
    if (probability < 0 || probability > 1) {
      return { success: false, message: 'Probability must be between 0 and 1' };
    }

    this.owner.rotationProbability = probability;
    logger.debug(`🎲 Updated rotation probability to ${(probability * 100).toFixed(1)}%`);

    // Update all streaming bots with new probability
    for (const [botId, bot] of this.owner.activeBots.entries()) {
      if (bot.streaming && bot.rotationCheckTimer) {
        bot.updateRotationProbability(probability);
      }
    }

    // Save the new probability to config file and database
    this.saveRotationConfig();
    this.owner.saveSystemState();

    return { success: true, probability: this.owner.rotationProbability };
  }

  /**
   * Updates the rotation check interval (admin control)
   */
  updateRotationInterval(minInterval, maxInterval) {
    // Validate inputs
    if (!minInterval || !maxInterval) {
      return { success: false, message: 'Both minInterval and maxInterval are required' };
    }

    if (minInterval < 1000 || maxInterval > 300000) {
      return { success: false, message: 'Intervals must be between 1 second and 5 minutes' };
    }

    if (minInterval > maxInterval) {
      return { success: false, message: 'Min interval must be less than or equal to max interval' };
    }

    this.owner.rotationCheckIntervalMin = minInterval;
    this.owner.rotationCheckIntervalMax = maxInterval;

    logger.debug(`⏱️ Updated rotation check interval to ${minInterval/1000}-${maxInterval/1000} seconds`);

    // Update all streaming bots with new intervals
    for (const [botId, bot] of this.owner.activeBots.entries()) {
      if (bot.streaming && bot.rotationCheckTimer) {
        bot.updateRotationInterval(minInterval, maxInterval);
      }
    }

    // Save the new intervals to config file and database
    this.saveRotationConfig();
    this.owner.saveSystemState();

    return {
      success: true,
      minInterval: this.owner.rotationCheckIntervalMin,
      maxInterval: this.owner.rotationCheckIntervalMax
    };
  }
}

module.exports = RotationConfigStore;
