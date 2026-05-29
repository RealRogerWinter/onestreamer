const logger = require('../../bootstrap/logger').child({ svc: 'VisualFxService' });

const { BUFF_EFFECT_MAP } = require('./buffEffectMap');

/**
 * Bridges BuffDebuffService events to visual effects. Extracted verbatim from
 * VisualFxService; reads service state (streamService, sessionService,
 * mediasoupService, io, activeEffects) and effect dispatch via `owner`.
 */
class BuffBridge {
    constructor(owner) {
        this.owner = owner;
    }

    async handleBuffApplied(buffData) {
        const owner = this.owner;
        logger.debug(`🎬 VISUALFX: ===== BUFF APPLIED EVENT RECEIVED =====`);

        // Check if this is a resumed buff (streamer coming back online with active buff)
        if (buffData.isResumed) {
            logger.debug(`🎬 VISUALFX: This is a RESUMED buff for ${buffData.item_name} - re-applying visual effect`);
        }

        logger.debug(`🥔 VISUALFX: handleBuffApplied called with buffData:`, {
            item_name: buffData.item_name,
            stream_id: buffData.stream_id,
            user_id: buffData.user_id,
            duration_seconds: buffData.duration_seconds,
            isResumed: buffData.isResumed || false
        });
        logger.debug(`🥔 VISUALFX: CRITICAL DEBUG - io availability: ${!!owner.io}`);
        if (owner.io) {
            logger.debug(`🥔 VISUALFX: io.engine.clientsCount: ${owner.io.engine?.clientsCount || 'unknown'}`);
        }

        // Check if this buff should trigger a visual effect
        const effectMapping = BUFF_EFFECT_MAP;

        const effectId = effectMapping[buffData.item_name];
        logger.debug(`🥔 VISUALFX: Mapped item_name '${buffData.item_name}' to effectId '${effectId}'`);

        if (effectId) {
            try {
                // Get the current streamer's stream ID
                let streamId = buffData.stream_id;
                logger.debug(`🥔 VISUALFX: Initial streamId from buffData: ${streamId}`);

                // Primary approach: Always check if buff is for current streamer first
                if (owner.streamService && owner.sessionService) {
                    const currentStreamerSocketId = owner.streamService.getCurrentStreamer();
                    logger.debug(`🥔 VISUALFX: Current streamer socketId: ${currentStreamerSocketId}`);

                    if (currentStreamerSocketId) {
                        // Get the userId for the current streamer
                        const session = owner.sessionService.getSessionBySocketId(currentStreamerSocketId);
                        if (session && session.userId) {
                            logger.debug(`🥔 VISUALFX: Current streamer userId: ${session.userId}, buff userId: ${buffData.user_id}`);

                            // Check if the buff is for the current streamer (handle both positive and negative IDs for viewbots)
                            const streamerUserId = session.userId.toString();
                            const buffUserId = buffData.user_id.toString();

                            if (streamerUserId === buffUserId ||
                                Math.abs(parseInt(streamerUserId)) === Math.abs(parseInt(buffUserId))) {
                                streamId = currentStreamerSocketId;
                                logger.debug(`🥔 VISUALFX: Buff is for current streamer, using socketId: ${streamId}`);
                            }
                        }
                    }
                }

                // Fallback approach: If streamId not set and not current streamer, try to find user's sockets
                if (!streamId && owner.sessionService) {
                    const userSockets = owner.sessionService.getSocketsByUserId(buffData.user_id);
                    logger.debug(`🥔 VISUALFX: Found ${userSockets ? userSockets.length : 0} sockets for user ${buffData.user_id}`);

                    if (userSockets && userSockets.length > 0) {
                        // Check if any of these sockets have an active transport (meaning they're streaming)
                        for (const socketId of userSockets) {
                            if (owner.mediasoupService && owner.mediasoupService.transports.has(socketId)) {
                                streamId = socketId;
                                logger.debug(`🥔 VISUALFX: Found active transport for socket ${socketId}, using as streamId`);
                                break;
                            }
                        }

                        // If no active transport found, use first socket as fallback
                        if (!streamId) {
                            streamId = userSockets[0];
                            logger.debug(`🥔 VISUALFX: No active transport found, using first socket as streamId: ${streamId}`);
                        }
                    }
                }

                if (streamId) {
                    logger.debug(`🥔 VISUALFX: Final streamId determined: ${streamId}`);
                    logger.debug(`🥔 VISUALFX: StreamId type: ${typeof streamId}, length: ${streamId.length}`);

                    // DEBUG: Check if this streamId exists in MediaSoup
                    if (owner.mediasoupService && owner.mediasoupService.transports) {
                        const hasTransport = owner.mediasoupService.transports.has(streamId);
                        logger.debug(`🔍 VISUALFX: DEBUG - StreamId "${streamId}" has transport: ${hasTransport}`);
                        logger.debug(`🔍 VISUALFX: DEBUG - Available transport keys:`, Array.from(owner.mediasoupService.transports.keys()));

                        // Check for similar keys
                        const similarKeys = Array.from(owner.mediasoupService.transports.keys()).filter(key =>
                            key.includes(streamId) || streamId.includes(key)
                        );
                        if (similarKeys.length > 0) {
                            logger.debug(`🔍 VISUALFX: DEBUG - Similar transport keys found:`, similarKeys);
                        }
                    }

                    // Apply the effect with error handling
                    try {
                        await owner.applyEffect(streamId, effectId, {
                            duration: (buffData.duration_seconds || buffData.remainingSeconds || 35) * 1000,
                            triggeredByBuff: true,
                            buffId: buffData.id
                        });
                        logger.debug(`✅ VISUALFX: Successfully applied ${effectId} effect for buff ${buffData.item_name} to stream ${streamId}`);
                    } catch (effectError) {
                        logger.error(`❌ VISUALFX: Effect application failed:`, effectError);
                        logger.error(`❌ VISUALFX: Error name: ${effectError.name}`);
                        logger.error(`❌ VISUALFX: Error message: ${effectError.message}`);

                        // Don't re-throw - let the buff work even if effect fails
                        logger.debug(`⚠️ VISUALFX: Continuing without visual effect for ${buffData.item_name}`);
                    }
                } else {
                    logger.debug(`⚠️ VISUALFX: Could not determine stream ID for buff ${buffData.item_name}, effect will be client-side only`);
                }
            } catch (error) {
                logger.error('⚠️ VISUALFX: Error in handleBuffApplied, continuing without visual effect:', error);
                // Don't re-throw - let the buff still work even if visual effect fails
            }
        }
    }

    async handleBuffExpired(buffData) {
        const owner = this.owner;
        // Remove any effects associated with this buff
        for (const [streamId, effects] of owner.activeEffects.entries()) {
            for (const effect of effects) {
                if (effect.options.buffId === buffData.id) {
                    await owner.removeEffect(streamId, effect.id);
                }
            }
        }
    }
}

module.exports = BuffBridge;
