/**
 * StreamHandler sub-module: stream lifecycle (voluntary stop).
 *
 * Registers `stop-streaming` — the active streamer voluntarily ends their
 * session. Persists disconnect time, ends log + time-tracking sessions,
 * applies individual cooldown, broadcasts stream-ended, clears viewbot
 * protection, and (after a delay) restarts viewbot rotation.
 *
 * Handler body is VERBATIM from the original StreamHandler.js; this is a pure
 * extraction with no logic change. Takes the same `(io, socket, deps)`.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'StreamHandler' });

module.exports = function registerLifecycle(io, socket, deps) {
  const {
    streamService,
    sessionService,
    takeoverService,
    mediasoupService,
    timeTrackingService,
    streamingLogsService,
    recordingService,
    SimpleViewBotRotation,
    IPBanService,
    notifyViewersStreamEnded,
    runAsync,
    streamNotifier,
    viewerCountNotifier,
    buffNotifier,
  } = deps;

  socket.on('stop-streaming', async () => {
    if (streamService.getCurrentStreamer() === socket.id) {
      // Update streamer connection disconnect time
      try {
        const clientIP = IPBanService.getIPFromSocket(socket);
        const result = await runAsync(`
          UPDATE streamer_connections
          SET disconnected_at = datetime('now'),
              stream_duration = (strftime('%s', 'now') - strftime('%s', connected_at)),
              disconnect_reason = 'voluntary_stop'
          WHERE streamer_id = ? AND disconnected_at IS NULL
        `, [socket.id]);
        logger.info(`📝 IP TRACKING: Updated disconnect for streamer ${socket.id}`);
      } catch (error) {
        logger.error({ err: error }, '❌ IP TRACKING: Failed to update disconnect');
      }

      // End streaming log session
      await streamingLogsService.endSession(socket.id, 'voluntary_stop');

      // End streaming time tracking if user is authenticated
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);
      if (session && session.userId) {
        await timeTrackingService.endStreamingSession(session.userId);
        logger.info(`📊 TIME: Ended streaming time tracking for user ${session.userId}`);
      }

      // Apply individual cooldown when streamer voluntarily stops
      await takeoverService.setSocketCooldown(socket.id, 'voluntary_stream_end');
      logger.info(`🔒 COOLDOWN: Applied individual cooldown to ${socket.id} for voluntary stream end`);

      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;

      // Handle continuous recording for stream end
      if (recordingService) {
        recordingService.handleStreamEnd(socket.id).catch(error => {
          logger.error({ err: error }, '❌ RECORDING: Error handling stream end');
        });
      }

      // Clear streamer buff display when streaming ends
      logger.info(`🎭 BUFF: Clearing streamer buffs display (streaming ended)`);
      buffNotifier.streamerBuffsUpdate({ buffs: [] });
      logger.info(`🧹 VOLUNTARY STOP: Cleared ${socket.id} from both services`);

      socket.leave('streamer');
      socket.join('viewers');

      streamNotifier.streamEnded({ reason: 'user_stopped_streaming', previousStreamer: socket.id });
      notifyViewersStreamEnded();
      notifyViewersStreamEnded();
      viewerCountNotifier.broadcast();

      logger.info(`Stream ended by: ${socket.id}`);

      // CRITICAL: Restart viewbot rotation after real user stops streaming
      // Check if this was a real user (not a viewbot)
      const userId = sessionService.getUserIdBySocketId(socket.id);
      const isViewbot = userId && userId < 0;
      const isLiveKitViewBot = socket.id.startsWith('viewbot-');

      if (!isViewbot && !isLiveKitViewBot) {
        // Restart viewbot rotation after real user voluntarily stops
        setTimeout(async () => {
          logger.info(`🔄 RESTART: Attempting to restart viewbot rotation after voluntary stop`);

          if (SimpleViewBotRotation && SimpleViewBotRotation.startRotation) {
            try {
              logger.info(`🚀 RESTART: Restarting SimpleViewBotRotation`);
              await SimpleViewBotRotation.startRotation();
            } catch (e) {
              logger.error({ err: e }, `❌ RESTART: Failed to restart SimpleViewBotRotation`);
            }
          }
        }, 3000);
      }
    }
  });
};
