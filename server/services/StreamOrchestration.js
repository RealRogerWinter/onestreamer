const logger = require('../bootstrap/logger').child({ svc: 'StreamOrchestration' });

/**
 * StreamOrchestration — cross-service glue extracted from `server/index.js`
 * as part of Phase 15B.2.a. Three helpers that coordinate across two or more
 * domain services live here, rather than being scattered across domain
 * services (which would force cross-imports between services that today
 * don't know about each other).
 *
 *   broadcastGlobalCooldown   coordinates TakeoverService + Socket.IO
 *   enrichStreamStatus        reads display name (UserService surface) and
 *                             returns enriched status
 *   verifyAndEmitStreamReady  coordinates MediasoupService (via the adapter
 *                             interface — `verifyParticipantTracks` /
 *                             `isLiveKit`) + UserService display name +
 *                             Socket.IO emit + module-scope dedup state
 *
 * The helpers were inline in `server/index.js` at the Phase 15B.1 close —
 * at lines 915 (broadcastGlobalCooldown), 1095 (enrichStreamStatus), and
 * 1116 (verifyAndEmitStreamReady), with the PR-15B.1 inventory-comment block
 * pointing at the *pre-15A* line ranges. (The drift is harmless — the
 * inventory comment's purpose is the destination mapping, not exact
 * positions; this docstring now records the actual pre-extraction line
 * numbers for future archaeology.) Phase 15B's plan defaults to extraction;
 * the alternative was keeping them inline with a section header, and that
 * call is documented in ADR drafting status (see CHANGELOG 15B.2.a entry).
 *
 * Lazy-service hazard (per the PR-15B.1 closure audit): `enrichStreamStatus`
 * and `verifyAndEmitStreamReady` both transitively close over
 * `getStreamerDisplayName`, which itself reads three lazy-init services
 * (`global.randomStreamRotationService`, `global.viewBotURLService`, and
 * `viewbotService`). Those services are assigned inside `startServer()`
 * at roughly `server/index.js:5018+`. The factory below preserves that
 * indirection: `getStreamerDisplayName` is passed in as a function and
 * called at runtime, so the lazy reads happen exactly when they did
 * pre-extraction — at call time, after `startServer()` has wired the
 * lazy services. No constructor-time access to any lazy service.
 *
 * `lastEmittedStreamReady` (the dedup state for verifyAndEmitStreamReady)
 * stays module-scope in `index.js` and is passed in by reference; the
 * `StreamHandler`, `MediaSoupHandler`, and `ViewBotHandler` socket modules
 * also receive the same reference (deps bag entries near
 * `index.js:4737 / :4769 / :4796` at the 15B.2.a-closing tree). Moving
 * ownership to this
 * module would force a second reference path through socket-handler
 * deps, so the shared-by-reference shape is preserved here.
 */
function createStreamOrchestration({
  io,
  takeoverService,
  mediasoupService,
  getStreamerDisplayName,
  lastEmittedStreamReady,
}) {
  if (!io) throw new Error('StreamOrchestration requires `io`');
  if (!takeoverService) throw new Error('StreamOrchestration requires `takeoverService`');
  if (!mediasoupService) throw new Error('StreamOrchestration requires `mediasoupService`');
  if (typeof getStreamerDisplayName !== 'function') {
    throw new Error('StreamOrchestration requires `getStreamerDisplayName` function');
  }
  if (!lastEmittedStreamReady || typeof lastEmittedStreamReady !== 'object') {
    throw new Error('StreamOrchestration requires `lastEmittedStreamReady` shared-state object');
  }

  /**
   * Broadcast the global takeover cooldown to every connected socket except
   * the new streamer. Fires after a successful takeover so other clients see
   * the lockout window immediately.
   */
  const broadcastGlobalCooldown = async (currentStreamerId) => {
    try {
      const globalCooldownSeconds = takeoverService.globalCooldownSeconds;

      logger.info(`📡 COOLDOWN: Broadcasting global cooldown of ${globalCooldownSeconds}s to all users except ${currentStreamerId}`);

      io.sockets.sockets.forEach((socket) => {
        if (socket.id !== currentStreamerId) {
          socket.emit('global-cooldown', {
            cooldownRemaining: globalCooldownSeconds,
            reason: 'global_cooldown',
          });
        }
      });
    } catch (error) {
      logger.error({ err: error }, '❌ Failed to broadcast global cooldown');
    }
  };

  /**
   * Return a copy of `status` with `streamerDisplayName` resolved from the
   * UserService surface. Called from per-request response builders so client
   * payloads include a human-readable streamer name in addition to the
   * opaque socket id.
   */
  const enrichStreamStatus = async (status) => {
    const enriched = { ...status };
    logger.info({ streamerId: status.streamerId }, '🔍 ENRICH: Enriching stream status with streamerId');
    if (status.streamerId) {
      logger.info({ streamerId: status.streamerId }, '🔍 ENRICH: Getting streamer display name for');
      enriched.streamerDisplayName = await getStreamerDisplayName(status.streamerId);
      logger.info({ streamerDisplayName: enriched.streamerDisplayName }, '🔍 ENRICH: Got streamer display name');
    }
    return enriched;
  };

  /**
   * Verify tracks are publishing (for LiveKit) or skip verification
   * (MediaSoup, which is synchronous at producer-create time) and emit
   * `stream-ready` to every connected socket. Dedups within a 2-second
   * window per streamerId — shared `lastEmittedStreamReady` state with
   * `server/sockets/StreamHandler.js` so the two emit paths cooperate.
   * Critical fix from the inline era: prevents "black square" issues
   * during stream switches by ensuring tracks are ready before the
   * client tries to consume.
   */
  const verifyAndEmitStreamReady = async (streamerId, streamData = {}) => {
    // DEDUP: Prevent duplicate stream-ready emissions within 2 seconds
    const now = Date.now();
    if (lastEmittedStreamReady.streamerId === streamerId &&
        (now - lastEmittedStreamReady.timestamp) < 2000) {
      logger.info(`⏭️ STREAM-READY: Skipping duplicate emission for ${streamerId} (${now - lastEmittedStreamReady.timestamp}ms since last)`);
      return true;
    }
    logger.info(`🔍 STREAM-READY: Verifying tracks for ${streamerId} before emitting...`);

    const isLiveKit = mediasoupService.isLiveKit && mediasoupService.isLiveKit();

    if (isLiveKit && mediasoupService.verifyParticipantTracks) {
      try {
        const verification = await mediasoupService.verifyParticipantTracks(streamerId, {
          requireVideo: true,
          requireAudio: false,
          maxAttempts: 10,
          retryDelay: 500,
        });

        if (!verification.verified) {
          logger.error(`❌ STREAM-READY: Track verification failed for ${streamerId} after ${verification.attempt} attempts`);
          return false;
        }

        logger.info(`✅ STREAM-READY: Tracks verified for ${streamerId} (video: ${verification.hasVideo}, audio: ${verification.hasAudio}) after ${verification.attempt} attempts`);

        const streamerDisplayName = await getStreamerDisplayName(streamerId);
        const emitTimestamp = Date.now();
        io.emit('stream-ready', {
          streamerId,
          newStreamId: streamerId,
          isWebRTC: true,
          hasVideo: verification.hasVideo,
          hasAudio: verification.hasAudio,
          producerVerified: true,
          trackCount: verification.trackCount,
          timestamp: emitTimestamp,
          streamerDisplayName,
          ...streamData,
        });

        lastEmittedStreamReady.streamerId = streamerId;
        lastEmittedStreamReady.timestamp = emitTimestamp;
        logger.info(`📡 STREAM-READY: Emitted verified stream-ready for ${streamerId}`);
        return true;
      } catch (error) {
        logger.error({ err: error }, `❌ STREAM-READY: Error verifying tracks for ${streamerId}`);
        return false;
      }
    } else {
      // MediaSoup: producers are synchronous, ready when created
      const streamerDisplayName = await getStreamerDisplayName(streamerId);
      const emitTimestamp = Date.now();
      io.emit('stream-ready', {
        streamerId,
        newStreamId: streamerId,
        isWebRTC: true,
        producerVerified: true,
        timestamp: emitTimestamp,
        streamerDisplayName,
        ...streamData,
      });

      lastEmittedStreamReady.streamerId = streamerId;
      lastEmittedStreamReady.timestamp = emitTimestamp;
      logger.info(`📡 STREAM-READY: Emitted stream-ready for ${streamerId} (MediaSoup/no verification needed)`);
      return true;
    }
  };

  return {
    broadcastGlobalCooldown,
    enrichStreamStatus,
    verifyAndEmitStreamReady,
  };
}

module.exports = { createStreamOrchestration };
