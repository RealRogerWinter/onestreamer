/**
 * StreamHandler sub-module: viewer management.
 *
 * Registers `join-as-viewer` — a client opts in to receive the stream. Adds
 * to the viewers room, emits stream-status + rotation/cooldown hints, starts
 * time-tracking, etc.
 *
 * Handler body is VERBATIM from the original StreamHandler.js; this is a pure
 * extraction with no logic change. Takes the same `(io, socket, deps)`.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'StreamHandler' });

module.exports = function registerViewers(io, socket, deps) {
  const {
    streamService,
    sessionService,
    takeoverService,
    timeTrackingService,
    enrichStreamStatus,
    viewerCountNotifier,
  } = deps;

  socket.on('join-as-viewer', async () => {
    streamService.addViewer(socket.id);
    socket.join('viewers');

    // Get stream status with duration
    const status = streamService.getStreamStatus();
    // Override viewer count with IP-based count
    status.viewerCount = sessionService.getUniqueViewerCount();
    // Enrich with streamer display name
    const enrichedStatus = await enrichStreamStatus(status);
    socket.emit('stream-status', enrichedStatus);

    // Send random rotation status if active
    if (global.randomStreamRotationService) {
      const rotationStatus = global.randomStreamRotationService.getStatus();
      if (rotationStatus.enabled && rotationStatus.currentStream) {
        socket.emit('random-rotation-status', {
          enabled: true,
          currentStream: rotationStatus.currentStream,
          rotationTiming: rotationStatus.rotationTiming ? {
            nextRotationAt: rotationStatus.rotationTiming.nextRotationAt,
            currentRotationDuration: rotationStatus.rotationTiming.currentRotationDuration,
            serverTime: Date.now()
          } : null
        });

        // Send lock state if rotation is locked
        const lockStatus = global.randomStreamRotationService.getLockStatus();
        if (lockStatus.isLocked) {
          socket.emit('rotation-locked', {
            locked: true,
            remainingMs: lockStatus.remainingTimeWhenLocked,
            currentStream: rotationStatus.currentStream
          });
        }
      }
    }

    // Visual effects sync temporarily disabled to debug rotate_90 issue
    // try {
    //   const activeVisualEffects = await getActiveVisualEffects();
    //   if (activeVisualEffects.length > 0) {
    //     logger.info(`🎨 VISUAL FX: Sending ${activeVisualEffects.length} active effects to new viewer ${socket.id}`);
    //
    //     // Send each effect to the viewer with a small delay to prevent overwhelming
    //     activeVisualEffects.forEach((buff, index) => {
    //       setTimeout(() => {
    //         socket.emit('visual-effect-sync', {
    //           effectId: buff.item_name,
    //           itemName: buff.item_name,
    //           displayName: buff.display_name,
    //           duration: buff.remaining_seconds * 1000,
    //           remainingSeconds: buff.remaining_seconds,
    //           effectData: buff.effect_data,
    //           isSyncEvent: true
    //         });
    //       }, index * 100); // 100ms between each effect
    //     });
    //   }
    // } catch (error) {
    //   logger.error({ err: error }, `❌ VISUAL FX: Error sending effects to viewer ${socket.id}`);
    // }

    // Emit unique viewer count based on IPs (PR 3.2 chokepoint).
    viewerCountNotifier.broadcast();

    // Start time tracking for viewing session if user is authenticated
    const ip = sessionService.getIpAddress(socket);
    const session = sessionService.getSessionByIp(ip);
    logger.info(`📊 TIME DEBUG: join-as-viewer - IP: ${ip}, session: ${JSON.stringify(session)}, hasActiveStream: ${status.hasActiveStream}`);
    if (session && session.userId) {
      const hasActiveStream = status.hasActiveStream;
      timeTrackingService.startViewingSession(session.userId, socket.id, hasActiveStream);
      logger.info(`📊 TIME: Started viewing time tracking for user ${session.userId}, active stream: ${hasActiveStream}`);
    } else {
      logger.info(`📊 TIME DEBUG: No authenticated user found for socket ${socket.id} (IP: ${ip})`);
    }

    // Check if user has an active cooldown and send it to them
    const canTakeOver = await takeoverService.canTakeOver(socket.id);
    if (!canTakeOver.allowed) {
      logger.info(`🔒 COOLDOWN: New viewer ${socket.id} has active cooldown (${canTakeOver.reason}: ${canTakeOver.cooldownRemaining}s)`);
      socket.emit('global-cooldown', {
        cooldownRemaining: canTakeOver.cooldownRemaining,
        reason: canTakeOver.reason
      });
    }
  });
};
