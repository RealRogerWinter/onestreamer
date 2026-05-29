const logger = require('../../bootstrap/logger').child({ svc: 'ViewBotClientService' });

/**
 * RotationController - the ViewBot rotation state machine, extracted VERBATIM from
 * ViewBotClientService.
 *
 * Design contract (behavior-preserving):
 *   - This controller holds NO rotation state. ALL rotation state lives on the
 *     ViewBotClientService instance (the `owner`): currentLiveBot,
 *     currentLiveBotSetTime, rotationEnabled, realStreamerActive, rotationLock,
 *     rotationTimer, rotationProcessTimer, rotationQueueWindow, pendingTakeoverTimer,
 *     isStartingEmergencyBot, recoveryAttempts, etc. The controller reads/writes
 *     them as owner.<field>.
 *   - When a rotation method calls ANOTHER of the 12 rotation methods, it routes
 *     through owner.<method>() (the service delegator) so the exact call path the
 *     characterization tests spy on is preserved.
 *   - All non-rotation dependencies (selectViewBotWithCooldown, ensureBotConnected,
 *     applyBotCooldown, startBotStreaming, dbService, activeBots,
 *     rotationRequestQueue, cooldownTracker, etc.) are accessed via owner.<x>.
 */
class RotationController {
  constructor({ owner }) {
    this.owner = owner;
  }

  /**
   * Restarts rotation after system restore
   * CRITICAL FIX: Ensures rotation continues after server restart
   */
  async restartRotationAfterRestore() {
    const owner = this.owner;
    logger.debug(`🔄 VIEWBOT CLIENT: Checking rotation restart conditions`);

    // CRITICAL: Only start ONE bot for rotation
    // Don't connect multiple bots at once

    // Check if there's a current live bot that needs to continue
    if (owner.currentLiveBot) {
      logger.debug(`🔄 VIEWBOT CLIENT: Found previous bot: ${owner.currentLiveBot}`);

      // Get the bot (might be a placeholder)
      let bot = owner.activeBots.get(owner.currentLiveBot);
      if (!bot) {
        logger.debug(`🔄 VIEWBOT CLIENT: Previous bot not found, starting fresh`);
        owner.currentLiveBot = null;
        await owner.startViewBotRotation();
        return;
      }

      // Ensure it's connected (converts placeholder to real instance)
      const connectResult = await owner.ensureBotConnected(owner.currentLiveBot);
      if (!connectResult.success) {
        logger.error(`❌ Failed to connect previous bot ${owner.currentLiveBot}`);
        owner.currentLiveBot = null;
        await owner.startViewBotRotation();
        return;
      }

      // Get the real bot instance after connection
      bot = owner.activeBots.get(owner.currentLiveBot);

      // CRITICAL: After server restart, we need to handle the case where
      // GStreamer processes are already running from before the restart

      // Check if GStreamer processes are already running
      const { execSync } = require('child_process');
      let gstreamerRunning = false;
      try {
        const psOutput = execSync('ps aux | grep -E "gst-launch.*filesrc" | grep -v grep', { encoding: 'utf8' });
        gstreamerRunning = psOutput.trim().length > 0;
        if (gstreamerRunning) {
          logger.debug(`🎬 VIEWBOT CLIENT: Detected existing GStreamer processes running`);
        }
      } catch (e) {
        // No processes found
        gstreamerRunning = false;
      }

      if (gstreamerRunning) {
        // GStreamer is already running - just set up the bot state properly
        logger.debug(`✅ VIEWBOT CLIENT: Media already streaming - setting up rotation system`);

        // Mark bot as streaming
        bot.streaming = true;
        bot.isStartingStream = false;

        // Start rotation check timer
        bot.startRotationCheckTimer();

        // Set up failsafe timer if video file is configured
        if (bot.config && bot.config.videoFile) {
          await bot.setupDurationBasedRotation(bot.config.videoFile);
        }

        logger.debug(`✅ VIEWBOT CLIENT: Rotation system restored for ${owner.currentLiveBot}`);
      } else {
        // No media running - start streaming normally
        try {
          logger.debug(`🎬 VIEWBOT CLIENT: Starting fresh stream for ${owner.currentLiveBot}`);
          const result = await bot.startStreaming();

          if (result.success) {
            // Start rotation check timer after successful start
            bot.startRotationCheckTimer();
            logger.debug(`✅ VIEWBOT CLIENT: Stream started with rotation timer`);
          } else if (!result.success && result.message === 'Already streaming') {
            // Bot thinks it's streaming but GStreamer isn't running - fix the state
            logger.debug(`🔧 VIEWBOT CLIENT: Fixing inconsistent state - bot thinks it's streaming but it's not`);
            bot.streaming = false;
            bot.isStartingStream = false;

            // Try starting again
            const retryResult = await bot.startStreaming();
            if (retryResult.success) {
              bot.startRotationCheckTimer();
              logger.debug(`✅ VIEWBOT CLIENT: Stream started after state fix`);
            }
          }
        } catch (error) {
          logger.error(`❌ VIEWBOT CLIENT: Failed to restart ${owner.currentLiveBot}:`, error);
          owner.currentLiveBot = null;
          await owner.startViewBotRotation();
        }
      }
    } else {
      logger.debug(`🔄 VIEWBOT CLIENT: No previous bot, starting fresh rotation`);
      await owner.startViewBotRotation();
    }
  }

  /**
   * Starts the ViewBot rotation system by selecting and starting the first ViewBot
   */
  async startViewBotRotation() {
    const owner = this.owner;
    // CRITICAL: Don't start rotation during initialization
    if (owner.initializationInProgress) {
      logger.debug(`⏳ ViewBot rotation deferred - initialization in progress`);
      return;
    }

    // CRITICAL: Prevent concurrent rotation starts
    if (owner.currentLiveBot) {
      logger.debug(`⚠️ ViewBot rotation already active with ${owner.currentLiveBot} - skipping`);
      return;
    }

    if (owner.realStreamerActive) {
      logger.debug(`🛑 Cannot start ViewBot rotation - real streamer is active`);
      return;
    }

    // Find available ViewBots (including placeholders)
    const availableBots = Array.from(owner.activeBots.values()).filter(bot =>
      !bot.streaming && (bot.isConnected || bot.lazyLoad || bot.isPlaceholder)
    );

    if (availableBots.length === 0) {
      logger.debug(`⚠️ No available ViewBots for rotation`);
      return;
    }

    // No need to reset anything for probability-based rotation

    // Select a ViewBot with weighted probability based on cooldowns
    let firstBot = owner.selectViewBotWithCooldown(availableBots);

    // Ensure bot is connected (handle placeholders and lazy loading)
    if (!firstBot.isConnected || firstBot.isPlaceholder) {
      logger.debug(`🔌 Connecting bot ${firstBot.botId} for rotation start...`);
      const connectResult = await owner.ensureBotConnected(firstBot.botId);
      if (!connectResult.success) {
        logger.error(`❌ Failed to connect bot ${firstBot.botId} for rotation start`);
        return;
      }
      // Get the real bot instance after connection
      firstBot = owner.activeBots.get(firstBot.botId);
    }

    // Set currentLiveBot BEFORE starting to prevent concurrent starts
    owner.currentLiveBot = firstBot.botId;
    owner.currentLiveBotSetTime = Date.now(); // Track when it was set

    try {
      await firstBot.startStreaming();
      // Apply cooldown to the bot that just started
      owner.applyBotCooldown(firstBot.botId);
      // Start rotation check timer for the bot
      firstBot.startRotationCheckTimer();
      logger.debug(`🔄 ViewBot rotation started with: ${firstBot.botId}`);
    } catch (error) {
      logger.error(`❌ Failed to start initial ViewBot rotation:`, error);
      // Clear currentLiveBot on failure
      owner.currentLiveBot = null;
    }
  }

  /**
   * Ensures a ViewBot is always streaming when rotation is enabled and no real streamer is active
   * This provides proactive presence maintenance rather than just reactive
   */
  async maintainViewBotPresence() {
    const owner = this.owner;
    // Skip if rotation is disabled
    if (!owner.rotationEnabled) {
      return;
    }

    // Skip if real streamer is active
    if (owner.realStreamerActive) {
      return;
    }

    // CRITICAL: Skip if we're already starting an emergency bot
    if (owner.isStartingEmergencyBot) {
      logger.debug('⏳ PRESENCE: Already starting emergency bot, skipping duplicate attempt');
      return;
    }

    // Check if any ViewBot is currently live
    if (owner.currentLiveBot) {
      // Verify the bot is actually streaming
      const bot = owner.activeBots.get(owner.currentLiveBot);

      // Debug logging to understand the state
      if (!bot) {
        logger.debug(`🔍 PRESENCE CHECK: currentLiveBot=${owner.currentLiveBot} - bot not found in activeBots`);
        logger.debug(`🔧 PRESENCE: Clearing non-existent currentLiveBot: ${owner.currentLiveBot}`);
        owner.currentLiveBot = null;
      } else {
        const isStreaming = typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming;
        const isStarting = bot.isStartingStream;
        logger.debug(`🔍 PRESENCE CHECK: currentLiveBot=${owner.currentLiveBot}, streaming=${isStreaming}, isStartingStream=${isStarting}`);

        if (isStreaming || isStarting) {
          // All good - ViewBot is live or starting
          logger.debug(`✅ PRESENCE: Bot ${owner.currentLiveBot} is ${isStreaming ? 'streaming' : 'starting'} - no action needed`);
          return;
        } else {
          // Bot exists but not streaming and not starting - check if it was recently selected
          // Give the bot 30 seconds to start streaming before clearing (increased from 10s)
          const now = Date.now();
          if (!owner.currentLiveBotSetTime) {
            owner.currentLiveBotSetTime = now;
          }

          const timeSinceSet = now - owner.currentLiveBotSetTime;
          const gracePeriod = 30000; // Increased to 30 seconds

          if (timeSinceSet > gracePeriod) {
            logger.debug(`🔧 PRESENCE: Clearing non-streaming currentLiveBot after ${gracePeriod/1000}s timeout: ${owner.currentLiveBot}`);
            owner.currentLiveBot = null;
            owner.currentLiveBotSetTime = null;
          } else {
            logger.debug(`⏳ PRESENCE: Bot ${owner.currentLiveBot} not streaming yet, waiting ${(gracePeriod - timeSinceSet)/1000}s more`);
            return;
          }
        }
      }
    }

    // CRITICAL: Check if rotation is already being processed
    if (owner.rotationLock) {
      logger.debug(`🔒 PRESENCE: Rotation is already being processed - skipping presence maintenance`);
      return;
    }

    // Also check if there's a pending rotation in the queue
    if (owner.rotationRequestQueue.length > 0) {
      logger.debug(`📋 PRESENCE: Rotation queue has ${owner.rotationRequestQueue.length} pending requests - skipping presence maintenance`);
      return;
    }

    // At this point: rotation enabled, no real streamer, no ViewBot streaming
    logger.debug('⚠️ PRESENCE: No one is streaming but rotation is enabled - need emergency start');

    // Check if we have available bots (including lazy-loaded ones)
    const availableBots = Array.from(owner.activeBots.values()).filter(bot => {
      const isStreaming = typeof bot.isStreaming === 'function' ? bot.isStreaming() : bot.streaming;
      return !isStreaming && (bot.isConnected || bot.lazyLoad);
    });

    if (availableBots.length === 0) {
      logger.debug('❌ PRESENCE: No available ViewBots to start');
      return;
    }

    // CRITICAL FIX: Don't bypass rotation system with startViewBotRotation()
    // Instead, pick a random bot and start it directly, then let rotation timers handle switching
    logger.debug('🚀 PRESENCE: Emergency start - picking a random bot to maintain presence');

    // CRITICAL: Only pick one bot and set it as current immediately to prevent duplicates
    const randomBot = availableBots[Math.floor(Math.random() * availableBots.length)];

    // Set as current IMMEDIATELY to prevent other presence checks from starting another bot
    owner.currentLiveBot = randomBot.botId;
    owner.currentLiveBotSetTime = Date.now();
    logger.debug(`🔒 PRESENCE: Pre-emptively set currentLiveBot to ${randomBot.botId} to prevent duplicates`);

    // Set flag to prevent duplicate starts
    owner.isStartingEmergencyBot = true;

    try {
      // Start the bot streaming using the service method (which handles all the setup)
      logger.debug(`🎯 PRESENCE: Starting bot ${randomBot.botId} for emergency presence`);
      const result = await owner.startBotStreaming(randomBot.botId);

      if (result && result.success) {
        logger.debug(`✅ PRESENCE: Emergency bot ${randomBot.botId} started successfully`);
      } else {
        logger.debug(`❌ PRESENCE: Failed to start emergency bot ${randomBot.botId}:`, result?.message);
      }
    } finally {
      // Clear the flag after attempt
      owner.isStartingEmergencyBot = false;
    }

    // The startBotStreaming method already starts the rotation timer when rotation is enabled
    // No need to manually start it here
  }

  /**
   * Queues a rotation request to prevent race conditions
   * This is the new entry point for all rotation requests
   */
  queueRotationRequest(botId, reason) {
    const owner = this.owner;
    const result = owner.rotationRequestQueue.enqueue(botId, reason, {
      rotationEnabled: owner.rotationEnabled,
      realStreamerActive: owner.realStreamerActive,
    });

    // Start the processing timer only when a request was actually queued.
    if (result.queued && !owner.rotationProcessTimer) {
      owner.rotationProcessTimer = setTimeout(() => {
        owner.processRotationQueue();
      }, owner.rotationQueueWindow);
    }

    return { success: result.success, message: result.message };
  }

  /**
   * Processes the rotation queue, ensuring only one rotation happens
   */
  async processRotationQueue() {
    const owner = this.owner;
    // Clear the timer
    owner.rotationProcessTimer = null;

    // Check if already processing a rotation
    if (owner.rotationLock) {
      logger.debug(`🔒 Rotation processor locked - deferring queue processing`);
      // Reschedule processing
      owner.rotationProcessTimer = setTimeout(() => {
        owner.processRotationQueue();
      }, owner.rotationQueueWindow);
      return;
    }

    // Get all pending requests
    const requests = owner.rotationRequestQueue.drain();

    if (requests.length === 0) {
      logger.debug(`📭 Rotation queue empty - nothing to process`);
      return;
    }

    logger.debug(`🔄 Processing ${requests.length} rotation requests`);

    // Filter out requests from bots that are no longer streaming
    const validRequests = requests.filter(req => {
      const bot = owner.activeBots.get(req.botId);
      return bot && bot.streaming;
    });

    if (validRequests.length === 0) {
      logger.debug(`❌ No valid rotation requests after filtering`);
      return;
    }

    // Select ONE request to process (could use various strategies)
    // Strategy: Use the first valid request (FIFO)
    const selectedRequest = validRequests[0];

    logger.debug(`✅ Selected rotation request from ${selectedRequest.botId} (${selectedRequest.reason})`);
    logger.debug(`⏭️ Discarding ${validRequests.length - 1} other requests`);

    // Acquire lock and process the selected rotation
    owner.rotationLock = true;

    try {
      await owner.handleRotationRequest(selectedRequest.botId, selectedRequest.reason);
    } catch (error) {
      logger.error(`❌ Rotation processing failed:`, error);
    } finally {
      // Release lock
      owner.rotationLock = false;
      logger.debug(`🔓 Rotation lock released`);

      // Check if more requests came in while processing
      if (owner.rotationRequestQueue.length > 0 && !owner.rotationProcessTimer) {
        logger.debug(`📬 New requests in queue - scheduling next processing`);
        owner.rotationProcessTimer = setTimeout(() => {
          owner.processRotationQueue();
        }, owner.rotationQueueWindow);
      }
    }
  }

  /**
   * Handle rotation request from ViewbotService when video ends
   * This is called by ViewbotService.handleVideoEnd
   */
  handleRotation(botId) {
    const owner = this.owner;
    logger.debug(`🎬 ViewBotClientService: Handling rotation for bot ${botId} after video end`);

    // Queue the rotation request to go through the normal rotation process
    owner.queueRotationRequest(botId, 'video-end');
  }

  /**
   * Handles ViewBot rotation requests (now called only from processRotationQueue)
   */
  async handleRotationRequest(botId, reason) {
    const owner = this.owner;
    if (!owner.rotationEnabled) {
      logger.debug(`🔄 Rotation request from ${botId} ignored - rotation disabled`);
      return { success: false, message: 'Rotation is disabled' };
    }

    if (owner.realStreamerActive) {
      logger.debug(`🔄 Rotation request from ${botId} ignored - real streamer active`);
      return { success: false, message: 'Real streamer is active' };
    }

    logger.debug(`🔄 Processing rotation request from ${botId} (reason: ${reason})`);

    // Clean up any orphaned GStreamer processes before rotation
    try {
      const { execSync } = require('child_process');
      const orphanedCount = execSync('pgrep -f gst-launch | wc -l', { encoding: 'utf8' }).trim();
      if (parseInt(orphanedCount) > 1) {
        logger.debug(`🧹 Cleaning up ${orphanedCount} orphaned GStreamer processes before rotation`);
        execSync('pkill -9 -f gst-launch 2>/dev/null || true', { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore errors
    }

    // Find the next available ViewBot to rotate to
    // Include placeholders and lazy-loaded bots
    const availableBots = Array.from(owner.activeBots.values()).filter(bot =>
      bot.botId !== botId && !bot.streaming && (bot.isConnected || bot.lazyLoad || bot.isPlaceholder)
    );

    if (availableBots.length === 0) {
      logger.debug(`🔄 No available ViewBots for rotation - stopping rotation`);
      owner.currentLiveBot = null;
      return { success: false, message: 'No available ViewBots for rotation' };
    }

    // Select a ViewBot with weighted probability based on cooldowns
    let nextBot = owner.selectViewBotWithCooldown(availableBots);

    // Ensure the selected bot is connected (handle placeholders and lazy loading)
    if (!nextBot.isConnected || nextBot.isPlaceholder) {
      logger.debug(`🔌 Connecting bot ${nextBot.botId} for rotation...`);
      const connectResult = await owner.ensureBotConnected(nextBot.botId);
      if (!connectResult.success) {
        logger.error(`❌ Failed to connect bot ${nextBot.botId} for rotation`);
        return { success: false, message: `Failed to connect next bot: ${connectResult.message}` };
      }
      // Get the real bot instance after connection
      nextBot = owner.activeBots.get(nextBot.botId);
    }

    try {
      // Stop current bot
      const currentBot = owner.activeBots.get(botId);
      logger.debug(`🔄🔄🔄 ROTATION: Stopping current bot ${botId}`, {
        found: !!currentBot,
        isPlaceholder: currentBot?.isPlaceholder,
        hasStopStreaming: !!(currentBot?.stopStreaming),
        hasCleanup: !!(currentBot?.cleanupGStreamerProcesses)
      });

      // CRITICAL: Even if it's a placeholder, we need to check for orphaned processes
      if (currentBot) {
        if (!currentBot.isPlaceholder && currentBot.stopStreaming) {
          logger.debug(`🛑🛑🛑 ROTATION: Calling stopStreaming() on real bot ${botId}...`);
          await currentBot.stopStreaming();
          logger.debug(`✅ ROTATION: stopStreaming() completed for ${botId}`);
        } else if (currentBot.cleanupGStreamerProcesses) {
          // If it has cleanup method but is a placeholder, still cleanup!
          logger.debug(`⚠️⚠️⚠️ ROTATION: Bot ${botId} is placeholder but has cleanup method - cleaning up orphaned processes`);
          currentBot.cleanupGStreamerProcesses();
        } else {
          logger.debug(`❌❌❌ ROTATION: Bot ${botId} is placeholder with no cleanup - ORPHANED PROCESSES LIKELY!`);
        }

        // CRITICAL: Disconnect the bot to free resources
        // This prevents accumulation of connected bots
        if (currentBot.socket) {
          logger.debug(`🔌 Disconnecting ViewBot ${botId} after rotation`);
          currentBot.socket.disconnect();
          currentBot.isConnected = false;
        }
      } else {
        logger.debug(`⚠️ ROTATION: Current bot ${botId} is placeholder or not found, skipping stop`);
      }

      // Add delay to ensure MediaSoup cleanup completes
      logger.debug(`⏳ ViewBot rotation: Waiting for cleanup before starting next bot...`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start next bot with probability-based rotation
      await nextBot.startStreaming();
      // Apply cooldown to the bot that just started
      owner.applyBotCooldown(nextBot.botId);
      nextBot.startRotationCheckTimer();

      owner.currentLiveBot = nextBot.botId;
      owner.currentLiveBotSetTime = Date.now();

      logger.debug(`🔄 ViewBot rotation completed: ${botId} → ${nextBot.botId}`);

      // Record rotation in database
      if (owner.dbInitialized) {
        try {
          await owner.dbService.recordRotation({
            fromBotId: botId,
            toBotId: nextBot.botId,
            reason: reason,
            rotationType: 'automatic',
            durationBeforeRotation: currentBot ? (Date.now() - currentBot.sessionStartTime) : null,
            metadata: {
              availableBotsCount: availableBots.length,
              rotationEnabled: owner.rotationEnabled
            }
          });
        } catch (dbError) {
          logger.error('⚠️ VIEWBOT CLIENT: Failed to record rotation in database:', dbError);
        }
      }

      return {
        success: true,
        previousBot: botId,
        newBot: nextBot.botId,
        reason: reason
      };
    } catch (error) {
      logger.error(`❌ ViewBot rotation failed:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Stops ViewBot rotation system
   */
  stopViewBotRotation() {
    const owner = this.owner;
    if (owner.currentLiveBot) {
      const currentBot = owner.activeBots.get(owner.currentLiveBot);
      if (currentBot) {
        currentBot.stopStreaming();
      }
      // CRITICAL: Clear the current live bot reference
      const wasLiveBot = owner.currentLiveBot;
      owner.currentLiveBot = null;
      logger.debug(`🛑 Stopped ViewBot rotation - cleared currentLiveBot: ${wasLiveBot}`);
    }

    if (owner.rotationTimer) {
      clearTimeout(owner.rotationTimer);
      owner.rotationTimer = null;
    }
  }

  /**
   * Manually trigger ViewBot takeover (admin function)
   */
  async manualTriggerTakeover() {
    const owner = this.owner;
    logger.debug(`🎮 MANUAL: Triggering ViewBot takeover`);

    // Check conditions
    if (!owner.rotationEnabled) {
      return { success: false, message: 'Rotation is disabled' };
    }

    if (owner.realStreamerActive) {
      return { success: false, message: 'Real streamer is active' };
    }

    if (owner.currentLiveBot) {
      return { success: false, message: `ViewBot ${owner.currentLiveBot} is already live` };
    }

    // Start a ViewBot
    await owner.startViewBotRotation();

    return {
      success: true,
      message: 'ViewBot takeover triggered',
      currentLiveBot: owner.currentLiveBot
    };
  }

  /**
   * Schedules a ViewBot takeover after real streamer disconnects
   */
  scheduleViewBotTakeover() {
    const owner = this.owner;
    // Clear any existing timer
    if (owner.pendingTakeoverTimer) {
      clearTimeout(owner.pendingTakeoverTimer);
    }

    // Random delay between 5-10 seconds
    const delay = Math.floor(Math.random() * 5000) + 5000;

    logger.debug(`⏱️ Scheduling ViewBot takeover in ${delay/1000} seconds...`);

    owner.pendingTakeoverTimer = setTimeout(async () => {
      owner.pendingTakeoverTimer = null;

      // Double-check that no real streamer started in the meantime
      if (!owner.realStreamerActive && owner.rotationEnabled && !owner.currentLiveBot) {
        logger.debug(`🚀 Executing ViewBot takeover after real streamer disconnect`);
        await owner.startViewBotRotation();
      } else {
        logger.debug(`🚫 ViewBot takeover cancelled - conditions changed`);
      }
    }, delay);
  }

  /**
   * Handles video end event from a ViewBot
   */
  async handleVideoEnd(botId) {
    const owner = this.owner;
    logger.debug(`🎬 ViewBot ${botId}: Video file ended`);

    const bot = owner.activeBots.get(botId);
    if (!bot || !bot.streaming) {
      return;
    }

    // Stop the current bot first and ensure cleanup
    logger.debug(`🧹 ViewBot ${botId}: Stopping and cleaning up before rotation`);
    await bot.stopStreaming();

    // Clear current live bot immediately
    if (owner.currentLiveBot === botId) {
      owner.currentLiveBot = null;
    }

    if (owner.rotationEnabled && !owner.realStreamerActive) {
      // CRITICAL: Wait for GStreamer cleanup to fully complete (2.5s for SIGKILL + reference clearing)
      const cleanupDelay = 3000; // 3 second delay to ensure processes are killed and references cleared
      logger.debug(`⏳ Waiting ${cleanupDelay}ms for complete cleanup before rotation...`);

      setTimeout(async () => {
        // Double-check conditions after delay
        if (owner.rotationEnabled && !owner.realStreamerActive && !owner.currentLiveBot) {
          logger.debug(`🔄 Starting rotation after video end cleanup delay`);

          // Find any available bot to start (queue will handle selection)
          const availableBots = Array.from(owner.activeBots.values()).filter(b =>
            b.isConnected && !b.streaming
          );

          if (availableBots.length > 0) {
            logger.debug(`🎯 Starting new viewbot after video end`);

            try {
              // Just start the rotation system - it will pick the best bot
              await owner.startViewBotRotation();
              logger.debug(`✅ Post-video rotation started`);

              // Rotation will be recorded by startViewBotRotation
            } catch (error) {
              logger.error(`❌ Failed to rotate after video end:`, error);
            }
          } else {
            logger.debug(`⚠️ No available bots for rotation after video end`);
          }
        } else {
          logger.debug(`⏸️ Rotation cancelled after delay (conditions changed)`);
        }
      }, cleanupDelay);
    } else {
      // Just stop streaming
      logger.debug(`⏹️ ViewBot stopped after video end (rotation disabled or real streamer active)`);
    }
  }

  /**
   * Force rotation (admin command)
   */
  async forceRotation() {
    const owner = this.owner;
    if (!owner.rotationEnabled) {
      return { success: false, message: 'Rotation is disabled' };
    }

    if (!owner.currentLiveBot) {
      return { success: false, message: 'No ViewBot currently streaming' };
    }

    logger.debug(`💪 Force rotation requested`);

    // Use the queue to prevent race conditions
    const result = owner.queueRotationRequest(owner.currentLiveBot, 'forced');

    return result;
  }
}

module.exports = RotationController;
