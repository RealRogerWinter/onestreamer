/**
 * viewBotHandler/registerRotationAndCleanup
 *
 * Sub-handler module split out of ViewBotHandler.js. Registers the final
 * contiguous block of ViewBot lifecycle events — bodies are VERBATIM copies of
 * the original inline handlers, same order, same emit targets:
 *    9. viewbot-stream-ready        Stream-ready emit + dedup.
 *   10. viewbot-rotation-request    Pass-through to viewBotClientService.
 *   11. viewbot-video-ended         Force rotation via global.viewBotRotation.
 *   12. viewbot-cleanup-transports  Explicit transport/producer teardown.
 *
 * Same (io, socket, deps) signature as the parent. Reads
 * `global.viewBotRotation` directly, identical to the inline original.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'ViewBotHandler' });

module.exports = function registerRotationAndCleanup(io, socket, deps) {
  const {
    mediasoupService,
    streamService,
    lastEmittedStreamReady,
    getViewBotClientService,
  } = deps;

  // ViewBot stream ready notification
  socket.on('viewbot-stream-ready', async (data) => {
    logger.info(`📺 SERVER: ViewBot ${data.botId} reports stream ready, triggering stream switch`);

    try {
      // Lazy-resolve viewbot client service — see top-of-file note.
      const viewBotClientService = getViewBotClientService();

      // CRITICAL: Check if a real user is currently streaming
      // Don't emit stream-ready for viewbots if real streamer is active
      if (viewBotClientService && viewBotClientService.realStreamerActive) {
        logger.info(`⛔ STREAM-READY: Blocking viewbot ${data.botId} stream-ready - real streamer is active`);
        return;
      }

      // Check if another non-viewbot streamer is active (e.g., URL stream)
      const currentStreamer = streamService.getCurrentStreamer();
      if (currentStreamer && currentStreamer !== socket.id && currentStreamer.startsWith('url-stream-')) {
        logger.info(`⛔ STREAM-READY: Blocking viewbot ${data.botId} stream-ready - URL stream ${currentStreamer} is active`);
        return;
      }

      const emitTimestamp = Date.now();

      // DEDUP: Check if we already emitted for this stream recently
      if (lastEmittedStreamReady.streamerId === socket.id &&
          (emitTimestamp - lastEmittedStreamReady.timestamp) < 2000) {
        logger.info(`⏭️ STREAM-READY: Skipping duplicate viewbot-stream-ready emission for ${socket.id}`);
        return;
      }

      // Emit stream-ready to trigger viewer consumption
      io.emit('stream-ready', {
        streamerId: socket.id,
        isViewBot: true,
        streamType: 'viewbot',
        botId: data.botId,
        timestamp: emitTimestamp
      });

      lastEmittedStreamReady.streamerId = socket.id;
      lastEmittedStreamReady.timestamp = emitTimestamp;
      logger.info(`✅ SERVER: Stream-ready notification sent for ViewBot ${data.botId}`);

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to handle ViewBot stream ready for ${data.botId}`);
    }
  });

  // ViewBot rotation request handler
  socket.on('viewbot-rotation-request', async (data) => {
    logger.info(`🔄 SERVER: ViewBot rotation request from ${data.botId} (reason: ${data.reason})`);

    // Lazy-resolve viewbot client service — see top-of-file note.
    const viewBotClientService = getViewBotClientService();

    if (!viewBotClientService) {
      logger.error(`❌ SERVER: ViewBotClientService not available for rotation request`);
      return;
    }

    // CRITICAL FIX: Check if rotation is enabled before processing request
    if (!viewBotClientService.rotationEnabled) {
      logger.info(`🚫 SERVER: ViewBot rotation request ignored - rotation system disabled`);
      return;
    }

    try {
      const result = await viewBotClientService.handleRotationRequest(data.botId, data.reason);

      if (result.success) {
        logger.info(`✅ SERVER: ViewBot rotation completed: ${result.previousBot} → ${result.newBot}`);

        // Notify all admins about the rotation
        io.emit('viewbot-rotation-completed', {
          previousBot: result.previousBot,
          newBot: result.newBot,
          reason: data.reason,
          timestamp: Date.now()
        });
      } else {
        logger.info(`⚠️ SERVER: ViewBot rotation failed: ${result.message}`);
      }

    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Failed to handle ViewBot rotation request from ${data.botId}`);
    }
  });

  // Handle when a ViewBot video file ends naturally
  socket.on('viewbot-video-ended', async (data) => {
    logger.info(`🎬 SERVER: ViewBot ${data.botId} video file ended: ${data.videoFile}`);

    // Use the global viewBotRotation service
    if (!global.viewBotRotation) {
      logger.error(`❌ SERVER: ViewBotRotation service not available for video-ended event`);
      return;
    }

    // Only trigger rotation if rotation is enabled
    if (!global.viewBotRotation.enabled) {
      logger.info(`🚫 SERVER: ViewBot video ended but rotation is disabled`);
      return;
    }

    try {
      // Force a rotation to the next video
      logger.info(`🔄 SERVER: Triggering rotation after video ended for ViewBot ${data.botId}`);
      await global.viewBotRotation.rotateToNextBot();

      logger.info(`✅ SERVER: Rotation triggered successfully after video end`);

      // Notify admins
      io.emit('viewbot-rotation-after-video-end', {
        previousBot: data.botId,
        previousVideo: data.videoFile,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error({ err: error }, `❌ SERVER: Error handling video-ended event`);
    }
  });

  // ViewBot explicit transport cleanup request
  socket.on('viewbot-cleanup-transports', (data) => {
    logger.info(`🧹 SERVER: ViewBot ${data.botId} requesting transport cleanup for socket ${data.socketId}`);

    // Use the socketId from data, not socket.id (they're different!)
    const targetSocketId = data.socketId || socket.id;

    logger.info(`🔍 DEBUG: Cleanup requested by socket ${socket.id} for target ${targetSocketId}`);
    logger.info({ transportKeys: Array.from(mediasoupService.transports?.keys() || []) }, `🔍 DEBUG: Current transport keys`);

    // Try to find transports by socket ID or by bot ID
    let transportEntry = null;
    let transportKey = null;

    if (mediasoupService.transports?.has(targetSocketId)) {
      transportEntry = mediasoupService.transports.get(targetSocketId);
      transportKey = targetSocketId;
    } else {
      // If not found by socket ID, search by bot ID
      for (const [key, value] of mediasoupService.transports?.entries() || []) {
        if (value.botId === data.botId) {
          logger.info(`🔍 DEBUG: Found transport by botId ${data.botId} under socket ${key}`);
          transportEntry = value;
          transportKey = key;
          break;
        }
      }
    }

    // Clean up transports immediately
    if (transportEntry) {
      try {
        if (transportEntry.video && transportEntry.audio) {
          // Close both video and audio transports
          if (!transportEntry.video.closed) {
            transportEntry.video.close();
            logger.info(`✅ Closed video transport for ViewBot ${data.botId}`);
          }
          if (!transportEntry.audio.closed) {
            transportEntry.audio.close();
            logger.info(`✅ Closed audio transport for ViewBot ${data.botId}`);
          }
        } else if (typeof transportEntry.close === 'function' && !transportEntry.closed) {
          transportEntry.close();
          logger.info(`✅ Closed transport for ViewBot ${data.botId}`);
        }
      } catch (e) {
        logger.error({ err: e }, `❌ Error closing transports for ViewBot ${data.botId}`);
      }
      mediasoupService.transports.delete(transportKey);
      logger.info(`✅ SERVER: Cleaned up transports for ViewBot ${data.botId}`);
    } else {
      logger.info(`⚠️ SERVER: No transports found for socket ${targetSocketId}`);
    }

    // Also clean up producers if they exist
    if (mediasoupService.producers?.has(transportKey || targetSocketId)) {
      const producers = mediasoupService.producers.get(transportKey || targetSocketId);
      if (producers) {
        for (const [kind, producer] of producers) {
          if (!producer.closed) {
            producer.close();
            logger.info(`✅ Closed ${kind} producer for ViewBot ${data.botId}`);
          }
        }
      }
      mediasoupService.producers.delete(transportKey || targetSocketId);
    }
  });
};
