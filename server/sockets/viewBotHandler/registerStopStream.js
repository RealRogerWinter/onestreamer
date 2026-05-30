/**
 * viewBotHandler/registerStopStream
 *
 * Sub-handler module split out of ViewBotHandler.js. Registers the
 * ViewBot-rotation-specific `stop-stream` event (NOT the user-facing
 * stop-streaming, which lives in StreamHandler). Body is a VERBATIM copy of
 * the original inline handler.
 *
 * Same (io, socket, deps) signature as the parent.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'ViewBotHandler' });

module.exports = function registerStopStream(io, socket, deps) {
  const {
    mediasoupService,
    streamService,
    plainTransportService,
    notifyViewersStreamEnded,
    streamNotifier,
  } = deps;

  // Handle stop-stream event (used by ViewBots during rotation)
  socket.on('stop-stream', async (data) => {
    logger.info(`🛑 STOP-STREAM: Received from ${socket.id} (ViewBot: ${data?.isViewBot}, BotId: ${data?.botId})`);

    // Clean up MediaSoup resources immediately
    if (mediasoupService) {
      logger.info(`🧹 MEDIASOUP: Cleaning up resources for ${socket.id} on stop-stream`);
      await mediasoupService.cleanupSocketResources(socket.id);
    }

    // Clean up Plain Transport resources for ViewBots
    if (data?.isViewBot && data?.botId && plainTransportService) {
      logger.info(`🧹 PLAIN TRANSPORT: Cleaning up resources for ViewBot ${data.botId}`);
      await plainTransportService.cleanup(data.botId);
    }

    // If this is the current streamer, clear it
    if (streamService.getCurrentStreamer() === socket.id) {
      streamService.clearStreamer();
      mediasoupService.currentStreamer = null;

      // Only emit stream-ended if it's not a ViewBot rotation
      if (!data?.isViewBot) {
        streamNotifier.streamEnded({ reason: 'stop_stream_request', previousStreamer: socket.id });
        notifyViewersStreamEnded();
      }

      logger.info(`📺 STOP-STREAM: Cleared streamer ${socket.id} from services`);
    }
  });
};
