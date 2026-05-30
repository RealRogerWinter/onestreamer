/**
 * BuffEffectBridge — buff lifecycle + streamer-change monitoring for
 * CanvasFxService.
 *
 * Extracted verbatim from CanvasFxService (buff applied/expired handlers,
 * streamer monitoring loop, and the went-live / switched / ended branches that
 * re-apply or cancel buff-synced effects). ALL state stays on the owning
 * service: owner.currentStreamer, owner.streamerCheckInterval,
 * owner.activeEffects, owner.buffSyncedEffects, owner.effectStats are all
 * read/written here. Internal cross-calls route through owner.<method> so
 * jest.spyOn on the service still fires. The service keeps thin delegators with
 * identical signatures and binds these handlers in setDependencies.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'CanvasFxService' });

class BuffEffectBridge {
    constructor(owner) {
        this.owner = owner;
    }

    // Handle buff applied event from BuffDebuffService
    async handleBuffApplied(buffData) {
        const owner = this.owner;
        logger.debug(`🎨 CANVASFX: handleBuffApplied called with buffData:`, JSON.stringify(buffData, null, 2));

        // Check if this is a resumed buff (streamer coming back online with active buff)
        if (buffData.isResumed) {
            logger.debug(`🎨 CANVASFX: This is a RESUMED buff for ${buffData.item_name} - re-applying visual effect`);
        }

        try {
            // Check if this buff has visual effects
            const item = await owner.itemService.getItemById(buffData.item_id);
            logger.debug(`🎨 CANVASFX: Retrieved item:`, item ? item.name : 'null');
            if (item && owner.hasVisualEffect(item)) {
                logger.debug(`🎨 CANVASFX: Triggering visual effect for ${item.name}`);
                logger.debug(`🎨 CANVASFX: Buff data for ${item.name}:`, JSON.stringify(buffData, null, 2));
                const buffDuration = buffData.remaining_seconds || buffData.duration_seconds || 60;
                logger.debug(`🎨 CANVASFX: Using buff duration ${buffDuration}s for ${item.name}`);

                const effect = await owner.triggerItemEffect(
                    buffData.user_id,
                    buffData.item_id,
                    buffData.stream_id,
                    {
                        triggeredByBuff: true,
                        buffId: buffData.id,
                        buffDuration: buffDuration
                    }
                );

                // Track buff-synced effects (like smoke bomb)
                if (effect && owner.isBuffSyncedEffect(item)) {
                    if (effect.isMultiPhase) {
                        // For multi-phase effects, we need to track all phases
                        const phaseEffects = Array.from(owner.activeEffects.values()).filter(e =>
                            e.mainEffectId === effect.id || e.id.startsWith(effect.id + '_phase')
                        );
                        for (const phaseEffect of phaseEffects) {
                            owner.buffSyncedEffects.set(phaseEffect.id, buffData.id);
                        }
                        logger.debug(`🎨 CANVASFX: Tracking multi-phase buff-synced effect ${effect.id} (${phaseEffects.length} phases) with buff ${buffData.id}`);
                    } else {
                        owner.buffSyncedEffects.set(effect.id, buffData.id);
                        logger.debug(`🎨 CANVASFX: Tracking buff-synced effect ${effect.id} with buff ${buffData.id}`);
                    }
                }
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling buff visual effect:', error);
        }
    }

    // Handle buff expired event from BuffDebuffService
    async handleBuffExpired(buffData) {
        const owner = this.owner;
        try {
            // Find any effects that are synced to this buff
            const effectsToCancel = [];
            owner.buffSyncedEffects.forEach((buffId, effectId) => {
                if (buffId === buffData.id) {
                    effectsToCancel.push(effectId);
                }
            });

            // Cancel the synced effects
            for (const effectId of effectsToCancel) {
                await owner.cancelEffect(effectId, 'buff-expired');
                owner.buffSyncedEffects.delete(effectId);
            }

            if (effectsToCancel.length > 0) {
                logger.debug(`🎨 CANVASFX: Cancelled ${effectsToCancel.length} buff-synced effects for expired buff ${buffData.id}`);
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling buff expiry:', error);
        }
    }

    // Start monitoring for streamer changes
    startStreamerMonitoring() {
        const owner = this.owner;
        // Initialize current streamer
        owner.currentStreamer = owner.streamService.getCurrentStreamer();
        logger.debug(`🎨 CANVASFX: Started streamer monitoring - Initial streamer: ${owner.currentStreamer}`);

        // Check for streamer changes every 2 seconds
        owner.streamerCheckInterval = setInterval(async () => {
            await owner.checkStreamerChange();
        }, 2000);
    }

    // Check for streamer changes and handle them
    async checkStreamerChange() {
        const owner = this.owner;
        try {
            const newStreamer = owner.streamService.getCurrentStreamer();

            // Log every change for debugging
            if (owner.currentStreamer !== newStreamer) {
                logger.debug(`🎨 CANVASFX: Streamer change detected - Previous: ${owner.currentStreamer}, New: ${newStreamer}`);
            }

            // Streamer changed or went offline
            if (owner.currentStreamer !== newStreamer) {
                const previousStreamer = owner.currentStreamer;
                owner.currentStreamer = newStreamer;

                logger.debug(`🎨 CANVASFX: DEBUG - Conditions: prev=${previousStreamer}, new=${newStreamer}, prev&&!new=${previousStreamer && !newStreamer}, prev&&new&&different=${previousStreamer && newStreamer && previousStreamer !== newStreamer}, !prev&&new=${!previousStreamer && newStreamer}`);

                if (previousStreamer && !newStreamer) {
                    // Stream ended
                    logger.debug(`🎨 CANVASFX: BRANCH: Stream ended`);
                    await owner.handleStreamEnded();
                    logger.debug(`🎨 CANVASFX: Stream ended, previous streamer was ${previousStreamer}`);
                } else if (previousStreamer && newStreamer && previousStreamer !== newStreamer) {
                    // Streamer switched
                    logger.debug(`🎨 CANVASFX: BRANCH: Streamer switched`);
                    logger.debug(`🎨 CANVASFX: ABOUT TO CALL handleStreamerChanged(${previousStreamer}, ${newStreamer})`);
                    try {
                        await owner.handleStreamerChanged(previousStreamer, newStreamer);
                        logger.debug(`🎨 CANVASFX: COMPLETED handleStreamerChanged call`);
                    } catch (error) {
                        logger.error(`❌ CANVASFX: ERROR in handleStreamerChanged:`, error);
                    }
                    logger.debug(`🎨 CANVASFX: Streamer changed from ${previousStreamer} to ${newStreamer}`);
                } else if (!previousStreamer && newStreamer) {
                    // New streamer went live
                    logger.debug(`🎨 CANVASFX: BRANCH: New streamer went live`);
                    // New streamer went live - but check if this might be a takeover
                    logger.debug(`🎨 CANVASFX: NEW STREAMER DETECTED - calling handleStreamerWentLive(${newStreamer})`);

                    // Clear any existing buff-synced effects first (in case this is actually a takeover)
                    const existingEffects = Array.from(owner.buffSyncedEffects.keys());
                    if (existingEffects.length > 0) {
                        logger.debug(`🎨 CANVASFX: Clearing ${existingEffects.length} existing buff-synced effects before new streamer`);
                        for (const effectId of existingEffects) {
                            await owner.cancelEffect(effectId, 'new-streamer-cleanup');
                            owner.buffSyncedEffects.delete(effectId);
                        }

                        // Send cleanup to all clients
                        if (owner.io) {
                            owner.io.emit('canvas-effects-clear-buff-synced');
                            logger.debug(`📡 CANVASFX: Sent buff-synced effects clear before new streamer`);
                        }
                    }

                    await owner.handleStreamerWentLive(newStreamer);
                    logger.debug(`🎨 CANVASFX: New streamer went live: ${newStreamer}`);
                }
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error checking streamer change:', error);
        }
    }

    // Handle streamer change
    async handleStreamerChanged(previousStreamer, newStreamer) {
        const owner = this.owner;
        logger.debug(`🎨 CANVASFX: ENTERED handleStreamerChanged method - ${previousStreamer} -> ${newStreamer}`);
        try {
            logger.debug(`🎨 CANVASFX: Handling streamer switch from ${previousStreamer} to ${newStreamer}`);
            logger.debug(`🎨 CANVASFX: DEBUG - Starting STEP 1: Clear existing effects`);

            // STEP 1: Clear all existing buff-synced effects from previous streamer
            const effectsToCancel = [];

            owner.buffSyncedEffects.forEach((buffId, effectId) => {
                // Cancel all buff-synced effects on streamer switch
                effectsToCancel.push(effectId);
                logger.debug(`🎨 CANVASFX: Marking buff-synced effect ${effectId} for cancellation`);
            });

            logger.debug(`🎨 CANVASFX: DEBUG - Found ${effectsToCancel.length} effects to cancel`);

            // Cancel all found effects
            for (const effectId of effectsToCancel) {
                await owner.cancelEffect(effectId, 'streamer-switched');
                owner.buffSyncedEffects.delete(effectId);
            }

            // Also clear any remaining active effects that might be lingering
            const remainingEffects = [];
            owner.activeEffects.forEach((effect, effectId) => {
                if (owner.isBuffSyncedEffect({ name: effect.itemName })) {
                    remainingEffects.push(effectId);
                }
            });

            logger.debug(`🎨 CANVASFX: DEBUG - Found ${remainingEffects.length} remaining effects to cleanup`);

            for (const effectId of remainingEffects) {
                if (!effectsToCancel.includes(effectId)) {
                    await owner.cancelEffect(effectId, 'streamer-switched-cleanup');
                }
            }

            if (effectsToCancel.length > 0) {
                logger.debug(`🎨 CANVASFX: Cancelled ${effectsToCancel.length} buff-synced effects from previous streamer`);
            }

            // Send cleanup broadcast to all clients
            if (owner.io) {
                owner.io.emit('canvas-effects-clear-buff-synced');
                logger.debug(`📡 CANVASFX: Sent buff-synced effects clear to all clients`);
            }

            // Force cleanup for the previous streamer specifically
            if (previousStreamer) {
                owner.forceCleanupForSocket(previousStreamer, 'streamer-switched');
            }

            logger.debug(`🎨 CANVASFX: DEBUG - Starting STEP 2: Check new streamer buffs`);

            // STEP 2: Check if NEW streamer has active smoke bomb buffs and trigger them
            logger.debug(`🎨 CANVASFX: Calling handleStreamerWentLive for new streamer ${newStreamer}`);
            await owner.handleStreamerWentLive(newStreamer);
            logger.debug(`🎨 CANVASFX: Completed handleStreamerWentLive for new streamer ${newStreamer}`);

            logger.debug(`🎨 CANVASFX: DEBUG - Completed streamer switch handling`);

        } catch (error) {
            logger.error('❌ CANVASFX: Error handling streamer change:', error);
            logger.error('❌ CANVASFX: Error stack:', error.stack);
        }
    }

    // Handle streamer going live
    async handleStreamerWentLive(newStreamerSocketId) {
        const owner = this.owner;
        try {
            // Map socket ID to user ID
            if (!owner.sessionService) {
                logger.warn('⚠️ CANVASFX: SessionService not available for mapping streamer socket to user');
                return;
            }

            const session = owner.sessionService.getSessionBySocketId(newStreamerSocketId);
            if (!session || !session.userId) {
                logger.debug(`🎨 CANVASFX: No session found for new streamer socketId ${newStreamerSocketId}`);
                return;
            }

            const streamerId = session.userId;
            logger.debug(`🎨 CANVASFX: Checking for existing buffs for new streamer userId ${streamerId}`);

            // Check for active smoke bomb debuffs on this streamer
            if (owner.buffDebuffService) {
                const activeBuffs = await owner.buffDebuffService.getActiveBuffsForUser(streamerId);

                // Find smoke bomb buffs
                const smokeBombBuffs = activeBuffs.filter(buff =>
                    buff.itemName === 'smoke_bomb' && buff.remainingSeconds > 0
                );

                if (smokeBombBuffs.length > 0) {
                    logger.debug(`🎨 CANVASFX: Found ${smokeBombBuffs.length} active smoke bomb buff(s) on new streamer`);

                    // For each smoke bomb buff, trigger the persistent smoke phase
                    for (const buff of smokeBombBuffs) {
                        const item = await owner.itemService.getItemById(buff.itemId);
                        if (item) {
                            logger.debug(`🎨 CANVASFX: Triggering existing smoke bomb animation for streamer (${buff.remainingSeconds}s remaining)`);

                            // Calculate remaining duration in milliseconds
                            const remainingDurationMs = buff.remainingSeconds * 1000;

                            // Create persistent smoke effect (skip initial puff since buff is already active)
                            const persistentSmokeEffect = {
                                id: `fx_live_smoke_${buff.itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                userId: streamerId,
                                itemId: buff.itemId,
                                streamId: null, // Current stream
                                itemName: item.name,
                                displayName: item.display_name,
                                emoji: item.emoji,
                                type: 'overlay',
                                duration: remainingDurationMs,
                                config: {
                                    phaseName: 'persistent_smoke',
                                    phaseIndex: 1,
                                    totalPhases: 2,
                                    color: 'rgba(100, 100, 100, 0.6)',
                                    animation: 'smoke-fill',
                                    spread: true,
                                    opacity: 0.6,
                                    width: 'full',
                                    height: 'full',
                                    fadeIn: true,
                                    fadeInDuration: 2000, // Quick fade-in since buff is already active
                                    persistent: true,
                                    waveEffect: true,
                                    density: 0.7,
                                    triggeredByBuff: true,
                                    buffId: buff.id,
                                    buffDuration: buff.remainingSeconds,
                                    streamerWentLive: true // Flag to indicate this was triggered by streamer going live
                                },
                                startTime: Date.now(),
                                position: { x: 0.5, y: 0.5 }, // Center screen
                                buffId: buff.id,
                                isMultiPhase: false // This is just the persistent phase
                            };

                            // Store active effect
                            owner.activeEffects.set(persistentSmokeEffect.id, persistentSmokeEffect);
                            owner.effectStats.totalTriggered++;
                            owner.effectStats.activeCount = owner.activeEffects.size;

                            // Track as buff-synced effect
                            owner.buffSyncedEffects.set(persistentSmokeEffect.id, buff.id);

                            // Broadcast to all viewers immediately
                            if (owner.io) {
                                owner.io.emit('canvas-effect-trigger', persistentSmokeEffect);
                                logger.debug(`📡 CANVASFX: Broadcasted existing smoke bomb effect for new streamer (${remainingDurationMs}ms remaining)`);
                            }

                            // Emit local event
                            owner.emit('effect-triggered', persistentSmokeEffect);

                            logger.debug(`✅ CANVASFX: Activated persistent smoke for streamer with existing buff (${buff.remainingSeconds}s remaining)`);
                        }
                    }
                } else {
                    logger.debug(`🎨 CANVASFX: No active smoke bomb buffs found for new streamer userId ${streamerId}`);
                }
            } else {
                logger.warn('⚠️ CANVASFX: BuffDebuffService not available for checking existing buffs');
            }

        } catch (error) {
            logger.error('❌ CANVASFX: Error handling streamer went live:', error);
        }
    }

    // Handle stream ending
    async handleStreamEnded() {
        const owner = this.owner;
        try {
            logger.debug(`🎨 CANVASFX: Handling stream end - cleaning up all buff-synced effects`);

            // Cancel all buff-synced effects when stream ends
            const effectsToCancel = Array.from(owner.buffSyncedEffects.keys());

            for (const effectId of effectsToCancel) {
                await owner.cancelEffect(effectId, 'stream-ended');
                owner.buffSyncedEffects.delete(effectId);
            }

            // Also clean up any remaining smoke bomb effects in active effects
            const remainingEffects = [];
            owner.activeEffects.forEach((effect, effectId) => {
                if (owner.isBuffSyncedEffect({ name: effect.itemName })) {
                    remainingEffects.push(effectId);
                }
            });

            for (const effectId of remainingEffects) {
                if (!effectsToCancel.includes(effectId)) {
                    await owner.cancelEffect(effectId, 'stream-ended-cleanup');
                }
            }

            // Force a complete cleanup broadcast
            if (owner.io) {
                owner.io.emit('canvas-effects-clear-buff-synced');
                logger.debug(`📡 CANVASFX: Sent complete buff-synced effects clear to all clients (stream ended)`);
            }

            if (effectsToCancel.length > 0 || remainingEffects.length > 0) {
                logger.debug(`🎨 CANVASFX: Cancelled ${effectsToCancel.length} buff-synced effects + ${remainingEffects.length} remaining effects due to stream ending`);
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling stream end:', error);
        }
    }
}

module.exports = BuffEffectBridge;
