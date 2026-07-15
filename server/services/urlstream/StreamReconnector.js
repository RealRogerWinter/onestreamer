/**
 * StreamReconnector.js - Error/end/reconnect lifecycle for URL streams,
 * extracted from ViewBotURLService.
 *
 * Owns the reconnect mutex flow, Kick 403 token-refresh + restart, and the
 * natural-end teardown. Reads/mutates owner state (activeStreams,
 * _reconnecting, _startingStream, backend, livekitService, kickService,
 * streamService, streamNotifier, io) via the `owner` back-reference; pipeline
 * start, process stop, ingress teardown, current-streamer registration and
 * viewbot resume are all delegated to owner helpers so behavior is identical
 * to the in-service form.
 *
 * Deps: { owner, logger }.
 */

class StreamReconnector {
  constructor(owner, logger) {
    this.owner = owner;
    this.logger = logger;
  }

  /**
   * Handle stream errors with optional reconnection
   * CRITICAL: Uses mutex to prevent multiple simultaneous reconnect attempts
   */
  async handleStreamError(urlId, source, error) {
    const owner = this.owner;
    const logger = this.logger;
    const streamEntry = owner.activeStreams.get(urlId);
    if (!streamEntry) return;

    logger.error({ source, errMsg: error && error.message, errName: error && error.name }, `❌ Stream error for ${urlId}`);

    // CRITICAL: Check if already reconnecting to prevent race conditions
    // Multiple error events (FFmpeg error, streamlink exit, etc.) could fire simultaneously
    if (owner._reconnecting) {
      logger.debug(`⏳ URL STREAM: Ignoring error for ${urlId} - reconnect already in progress`);
      return;
    }

    // CRITICAL: Check if a new stream is starting (mutex check)
    if (owner._startingStream) {
      logger.debug(`⏳ URL STREAM: Ignoring error for ${urlId} - new stream is starting`);
      return;
    }

    // CRITICAL: For HTTP 4xx errors (403 Forbidden, 404 Not Found, etc.)
    // For Kick streams with 403 (token expired), try to refresh the token
    // For other platforms or non-refreshable errors, end stream immediately
    const httpError = streamEntry._httpError;
    if (httpError && httpError >= 400 && httpError < 500) {
      streamEntry._httpError = null; // Clear the flag

      // Special handling for Kick 403 errors - try token refresh
      if (httpError === 403 && streamEntry.platform === 'kick' && streamEntry.kickUsername) {
        if (streamEntry.tokenRefreshAttempts < streamEntry.maxTokenRefreshAttempts) {
          logger.debug(`🔄 KICK TOKEN: HTTP 403 detected - attempting token refresh for ${streamEntry.kickUsername} (attempt ${streamEntry.tokenRefreshAttempts + 1}/${streamEntry.maxTokenRefreshAttempts})`);

          // Try to refresh token and restart stream
          const refreshed = await this.refreshKickTokenAndRestart(urlId, streamEntry);
          if (refreshed) {
            return; // Successfully refreshed, don't end stream
          }
          // If refresh failed, fall through to end stream
          logger.debug(`❌ KICK TOKEN: Token refresh failed, ending stream`);
        } else {
          logger.debug(`🚫 KICK TOKEN: Max token refresh attempts (${streamEntry.maxTokenRefreshAttempts}) reached for ${urlId}`);
        }
      }

      logger.debug(`🚫 URL STREAM: HTTP ${httpError} error - ending stream immediately`);
      this.handleStreamEnd(urlId, 'http_error');
      return;
    }

    if (streamEntry.autoReconnect && streamEntry.reconnectAttempts < streamEntry.maxReconnectAttempts) {
      // CRITICAL: Set reconnecting mutex BEFORE any async operations
      owner._reconnecting = true;

      // CRITICAL: Clear health data so reconnected stream gets fresh grace period
      // Without this, the old stale timestamp persists and triggers immediate reconnect loops
      if (global.urlStreamHealthService) {
        logger.debug(`🏥 Clearing health data for ${urlId} before reconnect`);
        global.urlStreamHealthService.clearHealthData(urlId);
      }

      try {
        streamEntry.reconnectAttempts++;
        streamEntry.status = 'reconnecting';

        logger.debug(`🔄 Attempting reconnect ${streamEntry.reconnectAttempts}/${streamEntry.maxReconnectAttempts} for ${urlId}`);

        // Stop current processes
        await owner._stopProcesses(streamEntry);

        // Clean up LiveKit ingress before reconnect (critical to prevent "Publish failed" errors)
        if (streamEntry.ingressInfo && owner.livekitService) {
          try {
            logger.debug(`🧹 Cleaning up old LiveKit ingress ${streamEntry.ingressInfo.ingressId} before reconnect`);
            await owner._teardownIngress(streamEntry);
          } catch (err) {
            logger.error(`⚠️ Error cleaning up old ingress for ${urlId}:`, err.message);
          }
        }

        // Wait before reconnecting (exponential backoff)
        const delay = Math.min(5000 * Math.pow(2, streamEntry.reconnectAttempts - 1), 30000);
        logger.debug(`⏳ Waiting ${delay/1000}s before reconnect attempt for ${urlId}`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Verify stream is still in activeStreams (could have been stopped during delay)
        if (!owner.activeStreams.has(urlId)) {
          logger.debug(`⚠️ URL STREAM: Stream ${urlId} was removed during reconnect delay, aborting`);
          return;
        }

        // V3: a takeover may have installed a real streamer during the
        // stop/teardown/backoff span — stand down instead of restarting
        // a relay over the human.
        const supersededBeforeRestart = owner._supersededByRealStreamer(urlId);
        if (supersededBeforeRestart) {
          logger.warn(`⏸️ URL STREAM: Not reconnecting ${urlId} - ${supersededBeforeRestart}`);
          await this.handleStreamEnd(urlId, 'superseded_by_real_streamer');
          return;
        }

        // Attempt restart
        try {
          await owner._startPipeline(urlId, streamEntry);
          streamEntry.status = 'streaming';
          streamEntry.reconnectAttempts = 0; // Reset on success
          logger.debug(`✅ Reconnected successfully: ${urlId}`);

          // CRITICAL: Re-register as current streamer after reconnect
          // This ensures status indicator stays correct
          // V3: registration re-checks the gate; on refusal, tear the
          // freshly-restarted relay back down and skip viewer notification.
          const reRegistered = owner._registerAsCurrentStreamer(urlId, {
            streamerLog: `📢 URL STREAM: Re-registering ${urlId} as current streamer after reconnect`,
          });
          if (!reRegistered) {
            logger.warn(`⏸️ URL STREAM: ${urlId} superseded during reconnect restart - ending`);
            await this.handleStreamEnd(urlId, 'superseded_by_real_streamer');
            return;
          }

          // Notify viewers about the reconnected stream
          if (owner.io) {
            owner.io.emit('stream-reconnected', {
              streamerId: urlId,
              streamerName: streamEntry.displayName,
              isUrlStream: true
            });
          }
        } catch (reconnectError) {
          logger.error(`❌ Reconnect failed for ${urlId}:`, reconnectError.message);
          this.handleStreamEnd(urlId, 'reconnect_failed');
        }
      } finally {
        // CRITICAL: Always release the reconnect mutex
        owner._reconnecting = false;
      }
    } else {
      this.handleStreamEnd(urlId, 'error');
    }
  }

  /**
   * Handle stream ending
   */
  async handleStreamEnd(urlId, reason) {
    const owner = this.owner;
    const logger = this.logger;
    const streamEntry = owner.activeStreams.get(urlId);
    if (!streamEntry) return;

    logger.debug(`🛑 URL stream ended: ${urlId} (reason: ${reason})`);

    // Stop all processes
    await owner._stopProcesses(streamEntry);

    // Clean up LiveKit ingress if exists
    if (streamEntry.ingressInfo && owner.livekitService) {
      try {
        logger.debug(`🧹 Cleaning up LiveKit ingress ${streamEntry.ingressInfo.ingressId} for ${urlId}`);
        await owner._teardownIngress(streamEntry);
      } catch (err) {
        logger.error(`⚠️ Error cleaning up LiveKit ingress for ${urlId}:`, err.message);
      }
    }

    // Update status
    streamEntry.status = 'ended';
    streamEntry.endedAt = Date.now();
    streamEntry.endReason = reason;

    // Remove from active streams
    owner.activeStreams.delete(urlId);

    // CRITICAL: Clear the currentStreamer if this was the active streamer
    // This ensures other systems know no stream is active
    if (owner.streamService) {
      const currentStreamer = owner.streamService.getCurrentStreamer();
      if (currentStreamer === urlId) {
        logger.debug(`🧹 URL STREAM: Clearing currentStreamer (was ${urlId})`);
        owner.streamService.clearStreamer();
      }
    }

    // Emit event
    owner.emit('url-stream-ended', {
      urlId,
      reason,
      sourceUrl: streamEntry.sourceUrl,
      duration: streamEntry.endedAt - streamEntry.startedAt
    });

    // Notify viewers that URL stream has ended
    // PR 3.1: routed through StreamNotifier (single chokepoint). Same null-
    // guard preserves the MediaSoup-branch behavior where setStreamNotifier
    // is not called and the emit is suppressed.
    if (owner.streamNotifier) {
      logger.debug('📢 URL STREAM: Broadcasting stream-ended event (natural end)');
      owner.streamNotifier.streamEnded({
        reason: `url_stream_${reason}`,
        streamerId: urlId,
        isUrlStream: true,
      });
    }

    // Resume viewbot rotation if no more URL streams are active
    if (owner.activeStreams.size === 0) {
      await owner._resumeViewBots();
    }
  }

  /**
   * Refresh Kick token and restart stream with new playback URL
   * Used when a Kick stream gets 403 Forbidden (token expired)
   * @returns {boolean} true if refresh succeeded, false otherwise
   */
  async refreshKickTokenAndRestart(urlId, streamEntry) {
    const owner = this.owner;
    const logger = this.logger;
    try {
      // V3: a real streamer may have taken over since the 403 fired —
      // returning false falls through to the caller's handleStreamEnd.
      const superseded = owner._supersededByRealStreamer(urlId);
      if (superseded) {
        logger.warn(`⏸️ KICK TOKEN: Not refreshing ${urlId} - ${superseded}`);
        return false;
      }

      streamEntry.tokenRefreshAttempts++;
      streamEntry.status = 'refreshing_token';

      logger.debug(`🔑 KICK TOKEN: Getting fresh playback URL for ${streamEntry.kickUsername}...`);

      // Get fresh playback URL from Kick
      const playbackInfo = await owner.kickService.getPlaybackUrl(streamEntry.kickUsername);

      if (!playbackInfo || !playbackInfo.playback_url) {
        logger.error(`❌ KICK TOKEN: Failed to get fresh playback URL for ${streamEntry.kickUsername}`);
        return false;
      }

      const newPlaybackUrl = playbackInfo.playback_url;
      logger.debug(`✅ KICK TOKEN: Got fresh playback URL for ${streamEntry.kickUsername}`);

      // Stop current FFmpeg/streamlink processes
      logger.debug(`🛑 KICK TOKEN: Stopping current processes for ${urlId}...`);
      await owner._stopProcesses(streamEntry);

      // Clean up LiveKit ingress before restart
      if (streamEntry.ingressInfo && owner.livekitService) {
        try {
          logger.debug(`🧹 KICK TOKEN: Cleaning up old LiveKit ingress ${streamEntry.ingressInfo.ingressId}`);
          await owner._teardownIngress(streamEntry);
        } catch (err) {
          logger.error(`⚠️ KICK TOKEN: Error cleaning up old ingress:`, err.message);
        }
      }

      // Clear health data for fresh grace period
      if (global.urlStreamHealthService) {
        logger.debug(`🏥 KICK TOKEN: Clearing health data for ${urlId}`);
        global.urlStreamHealthService.clearHealthData(urlId);
      }

      // Update stream entry with new URL
      streamEntry.sourceUrl = newPlaybackUrl;

      // Update streamInfo for direct HLS playback. Field names must match
      // _startLiveKitStream's reader contract ({ pipeMode, streamUrl } from
      // URLStreamExtractorService.getStreamURL) — the fresh playback URL is
      // a direct .m3u8, so FFmpeg reads it without streamlink.
      streamEntry.streamInfo = {
        ...streamEntry.streamInfo,
        streamUrl: newPlaybackUrl,
        tool: 'direct',
        pipeMode: false,
        isHLS: true
      };

      // Small delay to let cleanup complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify stream is still in activeStreams
      if (!owner.activeStreams.has(urlId)) {
        logger.debug(`⚠️ KICK TOKEN: Stream ${urlId} was removed during token refresh, aborting`);
        return false;
      }

      // Restart the stream with fresh URL
      logger.debug(`🚀 KICK TOKEN: Restarting stream with fresh URL...`);

      try {
        await owner._startPipeline(urlId, streamEntry);

        streamEntry.status = 'streaming';
        logger.debug(`✅ KICK TOKEN: Successfully refreshed and restarted stream ${urlId}`);

        // Re-register as current streamer
        // V3: refusal means a takeover landed mid-refresh — report failure
        // so the caller's fall-through handleStreamEnd tears the relay down.
        const reRegistered = owner._registerAsCurrentStreamer(urlId, {
          streamerLog: `📢 KICK TOKEN: Re-registering ${urlId} as current streamer`,
        });
        if (!reRegistered) {
          logger.warn(`⏸️ KICK TOKEN: ${urlId} superseded during token refresh - ending stream`);
          return false;
        }

        return true;
      } catch (restartError) {
        logger.error(`❌ KICK TOKEN: Failed to restart stream: ${restartError.message}`);
        return false;
      }
    } catch (error) {
      logger.error(`❌ KICK TOKEN: Error during token refresh: ${error.message}`);
      return false;
    }
  }
}

module.exports = StreamReconnector;
