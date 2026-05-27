/**
 * EffectHandler
 *
 * Registers visual-effect socket events on a per-connection basis.
 * Continuation of PR-H's socket-extraction pattern (see AdminHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - apply-visual-effect    Apply a visual effect to the current streamer's
 *                            stream and broadcast it to all viewers (plus a
 *                            dedicated emit to the streamer for view-switch).
 *   - remove-visual-effect   Remove an active effect instance from the current
 *                            stream and notify all clients.
 *   - get-visual-effects     Send the available effect registry + active
 *                            effects + stats to the caller.
 *   - get-visual-fx-stats    Send VisualFx stats + active effects + current
 *                            stream id to the caller.
 *
 * `deps` (all required):
 *   - io                Already provided as the first positional arg, kept on
 *                       this list for documentation only.
 *   - visualFxService   The VisualFxService singleton.
 *   - streamService     Used to look up the current streamer.
 *   - sessionService    Used to resolve the requester's session (for userId
 *                       attribution on apply-visual-effect).
 */
const logger = require('../bootstrap/logger').child({ svc: 'EffectHandler' });

module.exports = function registerEffectHandler(io, socket, deps) {
  const { visualFxService, streamService, sessionService } = deps;

  socket.on('apply-visual-effect', async (data) => {
    logger.info(`🎬🎬🎬 VISUALFX HANDLER CALLED: ${socket.id} requesting effect`);
    logger.info({ data }, `🎬 VISUALFX: Data received`);

    try {
      const { effectId, options } = data;

      // Check if user is authenticated (optional requirement)
      const ip = sessionService.getIpAddress(socket);
      const session = sessionService.getSessionByIp(ip);

      logger.info(`🎬 VISUALFX: Effect request from ${socket.id}: ${effectId}`);

      // Get current streamer
      const currentStreamer = streamService.getCurrentStreamer();
      if (!currentStreamer) {
        socket.emit('visual-effect-error', { error: 'No active stream' });
        return;
      }

      // Apply the effect
      const effect = await visualFxService.applyEffect(currentStreamer, effectId, {
        ...options,
        requestedBy: socket.id,
        userId: session?.userId
      });

      if (effect) {
        // Broadcast effect to all viewers
        io.emit('visual-effect-applied', {
          effectId: effectId,
          effectName: effect.config.name,
          duration: effect.duration,
          streamId: currentStreamer,
          applyToStreamer: true // New flag to indicate this should also affect streamer
        });

        // Also send directly to the streamer for view switching
        // Effects that require MediaSoup server-side stream processing (NOT client-side CSS)
        const effectsRequiringStreamProcessing = new Set([
          'resolution_240p', 'resolution_360p', 'resolution_480p',
          'bitrate_potato', 'bitrate_low', 'bitrate_throttle',
          'framerate_slideshow', 'framerate_choppy', 'framerate_cinematic',
          'packet_loss_mild', 'packet_loss_severe', 'jitter',
          'pixelate', 'static_noise', 'glitch',
          'audio_pitch_high', 'audio_pitch_low', 'audio_echo',
          'freeze_frame', 'stutter'
          // NOTE: The following are handled client-side with CSS filters:
          // blur, grayscale, sepia, invert, brightness_dark, brightness_bright,
          // contrast_low, contrast_high, saturate, desaturate, hue_rotate,
          // mirror, flip_vertical, rotate_90, vintage, thermal, vignette,
          // edge_detect, emboss, wave, wobble
        ]);

        io.to(currentStreamer).emit('visual-effect-applied', {
          effectId: effectId,
          effectName: effect.config.name,
          duration: effect.duration,
          streamId: currentStreamer,
          applyToStreamer: true,
          isStreamerPreview: true,
          requiresViewSwitch: effectsRequiringStreamProcessing.has(effectId)
        });

        socket.emit('visual-effect-success', { effect });
        logger.info(`✅ VISUALFX: Applied effect ${effectId} to stream ${currentStreamer} (including streamer preview)`);
      } else {
        socket.emit('visual-effect-error', { error: 'Effect could not be applied (resource limits)' });
      }

    } catch (error) {
      logger.error({ err: error }, '❌ VISUALFX: Error applying effect');
      socket.emit('visual-effect-error', { error: error.message });
    }
  });

  socket.on('remove-visual-effect', async (data) => {
    try {
      const { effectInstanceId } = data;

      // Check if user has permission (could add admin check here)
      const currentStreamer = streamService.getCurrentStreamer();
      if (!currentStreamer) {
        socket.emit('visual-effect-error', { error: 'No active stream' });
        return;
      }

      await visualFxService.removeEffect(currentStreamer, effectInstanceId);

      io.emit('visual-effect-removed', {
        effectInstanceId,
        streamId: currentStreamer
      });

      socket.emit('visual-effect-success', {
        message: 'Effect removed successfully'
      });

    } catch (error) {
      logger.error({ err: error }, '❌ VISUALFX: Error removing effect');
      socket.emit('visual-effect-error', { error: error.message });
    }
  });

  socket.on('get-visual-effects', async () => {
    try {
      const effects = visualFxService.getEffectRegistry();
      const currentStreamer = streamService.getCurrentStreamer();
      const activeEffects = currentStreamer ?
        visualFxService.getActiveEffects(currentStreamer) : [];

      socket.emit('visual-effects-list', {
        availableEffects: effects,
        activeEffects: activeEffects,
        stats: visualFxService.getStats()
      });

    } catch (error) {
      logger.error({ err: error }, '❌ VISUALFX: Error getting effects');
      socket.emit('visual-effect-error', { error: error.message });
    }
  });

  socket.on('get-visual-fx-stats', async () => {
    try {
      const stats = visualFxService.getStats();
      const currentStreamer = streamService.getCurrentStreamer();
      const activeEffects = currentStreamer ?
        visualFxService.getActiveEffects(currentStreamer) : [];

      socket.emit('visual-fx-stats', {
        stats,
        activeEffects,
        streamId: currentStreamer
      });

    } catch (error) {
      logger.error({ err: error }, '❌ VISUALFX: Error getting stats');
      socket.emit('visual-effect-error', { error: error.message });
    }
  });
};
