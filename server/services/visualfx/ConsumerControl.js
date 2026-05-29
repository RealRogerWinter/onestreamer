const logger = require('../../bootstrap/logger').child({ svc: 'VisualFxService' });

/**
 * Owns the MediaSoup consumer degrade/reset loops (bitrate "potato" effect,
 * resolution/bitrate reset) and the stream->consumers lookup. Extracted
 * verbatim from VisualFxService; reads service state (mediasoupService,
 * activeBitrateLimit) via `owner`.
 *
 * NOTE: `applyBitrateEffect`/`resetBitrate` iterate `mediasoupService.consumers`
 * as a flat `[consumerId, consumer]` Map, whereas `getStreamConsumers`/
 * `resetResolution` treat each value as a Set. This pre-existing shape
 * difference is preserved intentionally (not reconciled).
 */
class ConsumerControl {
    constructor(owner) {
        this.owner = owner;
    }

    // Shared flat iteration over mediasoupService.consumers as [consumerId, consumer].
    async _forEachConsumer(fn) {
        const owner = this.owner;
        if (owner.mediasoupService && owner.mediasoupService.consumers) {
            for (const [consumerId, consumer] of owner.mediasoupService.consumers) {
                await fn(consumerId, consumer);
            }
        }
    }

    async applyBitrateEffect(streamId, parameters) {
        const owner = this.owner;
        logger.debug(`🥔 VISUALFX: Applying POTATO QUALITY effect to stream ${streamId}`);
        logger.debug(`🥔 VISUALFX: Parameters:`, parameters);

        if (!owner.mediasoupService) {
            logger.error('❌ VISUALFX: MediaSoup service not available');
            logger.debug('🥔 VISUALFX: Effect will be client-side only');
            return;
        }

        logger.debug(`🥔 VISUALFX: Using MediaSoup best practices for quality degradation`);

        try {
            const targetBitrate = parameters.videoBitrate || 30000;
            let videoConsumerCount = 0;
            let audioConsumerCount = 0;
            let simulcastConsumerCount = 0;

            // Store affected consumers for potential restoration
            const affectedConsumers = [];

            // Get all consumers and apply safe degradation
            await this._forEachConsumer(async (consumerId, consumer) => {
                try {
                    if (consumer.closed) return;

                    if (consumer.kind === 'video') {
                        // Store original state for restoration
                        affectedConsumers.push({
                            consumerId,
                            consumer,
                            originalPriority: consumer.priority || 1
                        });

                        // BEST PRACTICE 1: Set consumer priority for bandwidth distribution
                        // Priority 255 = lowest, gets bandwidth last
                        if (consumer.setPriority) {
                            await consumer.setPriority(255);
                            logger.debug(`🥔 VISUALFX: Set consumer ${consumerId} to priority 255 (lowest)`);
                        }

                        // BEST PRACTICE 2: Use setPreferredLayers for simulcast streams
                        // This is the recommended way to control quality
                        try {
                            // For potato effect, use lowest possible quality
                            await consumer.setPreferredLayers({
                                spatialLayer: 0,    // Lowest spatial layer (quarter resolution)
                                temporalLayer: 0    // Lowest temporal layer (reduced framerate)
                            });
                            logger.debug(`🥔 VISUALFX: Consumer ${consumerId} set to layers S0:T0 (lowest quality)`);
                            simulcastConsumerCount++;

                            // Request keyframe for immediate effect
                            if (consumer.requestKeyFrame) {
                                await consumer.requestKeyFrame();
                            }
                        } catch (e) {
                            // Consumer doesn't support simulcast - this is fine
                            logger.debug(`🥔 VISUALFX: Consumer ${consumerId} is not simulcast (single stream)`);
                        }

                        videoConsumerCount++;
                    } else if (consumer.kind === 'audio') {
                        // Audio priority adjustment
                        if (consumer.setPriority) {
                            await consumer.setPriority(255);
                            logger.debug(`🥔 VISUALFX: Set audio consumer ${consumerId} to lowest priority`);
                        }
                        audioConsumerCount++;
                    }
                } catch (err) {
                    logger.warn(`⚠️ VISUALFX: Failed to degrade consumer ${consumerId}:`, err.message);
                }
            });

            logger.debug(`✅ VISUALFX: POTATO EFFECT APPLIED!`);
            logger.debug(`   - Video consumers affected: ${videoConsumerCount}`);
            logger.debug(`   - Simulcast consumers switched to low quality: ${simulcastConsumerCount}`);
            logger.debug(`   - Audio consumers affected: ${audioConsumerCount}`);
            logger.debug(`   - All consumers set to priority 255 (lowest)`);
            logger.debug(`   - Target bitrate: ${targetBitrate} bps`);

            // Store the effect parameters for new viewers
            owner.activeBitrateLimit = {
                streamId: streamId,
                bitrate: targetBitrate,
                parameters: parameters,
                throttleActive: true
            };

        } catch (error) {
            logger.error(`❌ VISUALFX: Failed to apply bitrate effect:`, error);
            throw error;
        }
    }

    async resetResolution(streamId) {
        const owner = this.owner;
        const consumers = owner.getStreamConsumers(streamId);

        for (const consumer of consumers) {
            try {
                // Reset to highest quality
                await consumer.setPreferredLayers({
                    spatialLayer: 2,
                    temporalLayer: 2
                });
            } catch (error) {
                logger.error(`❌ VISUALFX: Failed to reset resolution:`, error);
            }
        }
    }

    async resetBitrate(streamId) {
        const owner = this.owner;
        logger.debug(`🥔 VISUALFX: Resetting quality for all consumers`);

        try {
            let resetCount = 0;

            // Reset all consumers
            await this._forEachConsumer(async (consumerId, consumer) => {
                try {
                    // Reset priority to normal
                    if (consumer.setPriority) {
                        await consumer.setPriority(1); // Normal priority
                        logger.debug(`🥔 VISUALFX: Reset consumer ${consumerId} to normal priority`);
                    }

                    // Try to reset layers to max quality (if simulcast)
                    if (consumer.kind === 'video' && !consumer.closed) {
                        try {
                            await consumer.setPreferredLayers({
                                spatialLayer: 2,
                                temporalLayer: 2
                            });
                            logger.debug(`🥔 VISUALFX: Reset consumer ${consumerId} to max quality layers`);
                        } catch (e) {
                            // Not simulcast, ignore
                        }
                        resetCount++;
                    }
                } catch (err) {
                    logger.warn(`⚠️ VISUALFX: Failed to reset consumer ${consumerId}:`, err.message);
                }
            });

            // Clear the stored limit
            owner.activeBitrateLimit = null;

            logger.debug(`✅ VISUALFX: Reset bitrate for ${resetCount} viewer transports`);
        } catch (error) {
            logger.error(`❌ VISUALFX: Failed to reset bitrate:`, error);
        }
    }

    // Helper methods to get MediaSoup objects
    getStreamConsumers(streamId) {
        const owner = this.owner;
        if (!owner.mediasoupService) return [];

        // Get all consumers that are consuming from this stream's producers
        const consumers = [];
        const producerMap = owner.mediasoupService.producers.get(streamId);

        if (producerMap) {
            // Iterate through all consumer entries
            for (const [consumerId, consumerSet] of owner.mediasoupService.consumers.entries()) {
                for (const consumer of consumerSet) {
                    // Check if this consumer is consuming from our stream's producers
                    for (const producer of producerMap.values()) {
                        if (consumer.producerId === producer.id) {
                            consumers.push(consumer);
                        }
                    }
                }
            }
        }

        return consumers;
    }
}

module.exports = ConsumerControl;
