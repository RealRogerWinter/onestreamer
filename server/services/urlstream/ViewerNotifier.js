/**
 * ViewerNotifier.js - Viewer-switch notifications for URL streams, extracted
 * from ViewBotURLService.
 *
 * Waits for a LiveKit participant to publish tracks (or a max-wait timeout),
 * then registers the URL stream as the current streamer and broadcasts the
 * new-streamer / stream-started events. Reads owner.io, owner.activeStreams,
 * owner.backend, owner.livekitService, owner.streamService via the `owner`
 * back-reference; registration goes through owner._registerAsCurrentStreamer
 * so behavior is identical to the in-service form.
 *
 * Deps: { owner, logger }.
 */

class ViewerNotifier {
  constructor(owner, logger) {
    this.owner = owner;
    this.logger = logger;
  }

  /**
   * Wait for stream to be ready, then notify viewers
   * Polls LiveKit to check if participant has published tracks
   */
  async notifyWhenReady(urlId, streamEntry, validation) {
    const owner = this.owner;
    const logger = this.logger;
    if (!owner.io) {
      logger.warn('⚠️ URL STREAM: Socket.IO not available - viewers may not auto-switch');
      return;
    }

    const maxWaitTime = 15000; // Max 15 seconds to wait
    const pollInterval = 1000; // Check every 1 second
    const startTime = Date.now();

    logger.debug(`⏳ URL STREAM: Waiting for stream ${urlId} to be ready for viewers...`);

    const checkStreamReady = async () => {
      // Check if stream is still active
      if (!owner.activeStreams.has(urlId)) {
        logger.debug(`⚠️ URL STREAM: Stream ${urlId} ended before becoming ready`);
        return;
      }

      // If using LiveKit, check if participant has tracks
      if (owner.backend === 'livekit' && owner.livekitService) {
        try {
          const { RoomServiceClient } = require('livekit-server-sdk');
          const webrtcConfig = require('../../config/webrtc.config');
          const config = webrtcConfig.livekit;
          const host = config.host.startsWith('http') ? config.host : `http://${config.host}`;
          const roomClient = new RoomServiceClient(host, config.apiKey, config.apiSecret);

          const participants = await roomClient.listParticipants(config.roomName);
          const urlParticipant = participants.find(p => p.identity === urlId);

          if (urlParticipant && urlParticipant.tracks && urlParticipant.tracks.length > 0) {
            logger.debug(`✅ URL STREAM: Stream ${urlId} is now live with ${urlParticipant.tracks.length} tracks`);
            this.broadcastNewStreamer(urlId, streamEntry, validation);
            return;
          }
        } catch (err) {
          logger.warn(`⚠️ URL STREAM: Error checking participant status: ${err.message}`);
        }
      }

      // Check if we've waited long enough
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitTime) {
        logger.debug(`⏰ URL STREAM: Max wait time reached, notifying viewers anyway`);
        this.broadcastNewStreamer(urlId, streamEntry, validation);
        return;
      }

      // Continue polling
      setTimeout(checkStreamReady, pollInterval);
    };

    // Start polling after initial delay (let FFmpeg establish connection)
    setTimeout(checkStreamReady, 2000);
  }

  /**
   * Broadcast new-streamer event to all viewers
   */
  broadcastNewStreamer(urlId, streamEntry, validation) {
    const owner = this.owner;
    const logger = this.logger;
    if (!owner.io) return;

    // CRITICAL: Register the URL stream as the current streamer
    // This ensures viewers switch to consuming from the URL stream
    owner._registerAsCurrentStreamer(urlId, {
      streamerLog: `📢 URL STREAM: Registering ${urlId} as current streamer`,
      mediasoupLog: `📢 URL STREAM: Setting MediaSoup currentStreamer to ${urlId}`,
    });

    logger.debug('📢 URL STREAM: Broadcasting new-streamer event to all viewers');
    owner.io.emit('new-streamer', {
      streamer: {
        odyseeId: urlId,
        odysee_username: streamEntry.displayName || validation.title || 'URL Stream',
        userId: urlId,
        isUrlStream: true,
        platform: validation.platform
      }
    });

    // Also emit stream-started event for any listeners
    owner.io.emit('stream-started', {
      streamerId: urlId,
      streamerName: streamEntry.displayName || validation.title || 'URL Stream',
      isUrlStream: true
    });
  }
}

module.exports = ViewerNotifier;
