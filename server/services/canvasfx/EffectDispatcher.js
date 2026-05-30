/**
 * EffectDispatcher — effect application/dispatch for CanvasFxService.
 *
 * Extracted verbatim from CanvasFxService (single-phase trigger, positioned
 * trigger, multi-phase trigger). ALL state stays on the owning service.
 * Internal cross-calls route through owner.<method> (getEffectConfig,
 * getRandomPosition, isBuffSyncedEffect, cleanupEffect, triggerMultiPhaseEffect)
 * so jest.spyOn on the service still fires. Resource checks and stats use
 * owner.activeEffects / owner.effectStats; broadcast via owner.io / owner.emit.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'CanvasFxService' });

class EffectDispatcher {
    constructor(owner) {
        this.owner = owner;
    }

    // Trigger visual effect from item usage
    async triggerItemEffect(userId, itemId, streamId, effectParams = {}) {
        const owner = this.owner;
        try {
            logger.debug(`🎨 CANVASFX: === TRIGGERING ITEM EFFECT ===`);
            logger.debug(`🎨 CANVASFX DEBUG: triggerItemEffect called - userId: ${userId}, itemId: ${itemId}, streamId: ${streamId}`);
            logger.debug(`🎨 CANVASFX DEBUG: effectParams:`, JSON.stringify(effectParams, null, 2));

            // Check concurrent effect limit
            if (owner.activeEffects.size >= owner.config.maxConcurrentEffects) {
                logger.warn('⚠️ CANVASFX: Max concurrent effects reached, dropping effect');
                owner.effectStats.droppedEffects++;
                return null;
            }

            const item = await owner.itemService.getItemById(itemId);
            if (!item) {
                logger.error('❌ CANVASFX: Item not found:', itemId);
                return null;
            }

            logger.debug(`🎨 CANVASFX DEBUG: Item found - name: ${item.name}, display_name: ${item.display_name}`);

            const effectConfig = owner.getEffectConfig(item);
            logger.debug(`🎨 CANVASFX DEBUG: Effect config retrieved:`, effectConfig);

            // Handle buff-duration effects specially
            let effectDuration = effectConfig.duration;
            if (effectConfig.duration === 'buff-duration' && effectParams.buffDuration) {
                effectDuration = effectParams.buffDuration * 1000; // Convert seconds to milliseconds
                logger.debug(`🎨 CANVASFX: Using buff duration of ${effectParams.buffDuration}s for ${item.name}`);
            }

            // Handle multi-phase effects
            if (effectConfig.type === 'multi-phase') {
                return await owner.triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, effectDuration, effectParams);
            }

            // Create single-phase effect instance
            const effect = {
                id: `fx_${userId}_${itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                userId,
                itemId,
                streamId,
                itemName: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: effectConfig.type,
                duration: effectDuration,
                config: { ...effectConfig.config, ...effectParams },
                startTime: Date.now(),
                position: owner.getRandomPosition(),
                buffId: effectParams.buffId || null
            };

            // Store active effect
            owner.activeEffects.set(effect.id, effect);
            owner.effectStats.totalTriggered++;
            owner.effectStats.activeCount = owner.activeEffects.size;

            // Broadcast to all viewers
            if (owner.io) {
                logger.debug(`📡 CANVASFX: About to broadcast canvas-effect-trigger for ${item.display_name}`);
                logger.debug(`📡 CANVASFX: Effect data being sent:`, JSON.stringify(effect, null, 2));
                owner.io.emit('canvas-effect-trigger', effect);
                logger.debug(`📡 CANVASFX: Broadcasted effect ${effect.type} for item ${item.display_name}`);
            } else {
                logger.error(`❌ CANVASFX: No io instance available to broadcast effect!`);
            }

            // Emit local event
            owner.emit('effect-triggered', effect);

            // Auto-cleanup after duration (but only for non-buff-synced effects)
            if (!owner.isBuffSyncedEffect(item)) {
                setTimeout(() => {
                    owner.cleanupEffect(effect.id);
                }, effectDuration);
            } else {
                logger.debug(`🎨 CANVASFX: Buff-synced effect ${effect.id} will be managed by buff lifecycle`);
            }

            return effect;

        } catch (error) {
            logger.error('❌ CANVASFX: Error triggering item effect:', error);
            return null;
        }
    }

    // Trigger visual effect at specific position (for click-to-throw functionality)
    async triggerItemEffectAtPosition(userId, itemId, streamId, position, effectParams = {}) {
        const owner = this.owner;
        try {
            // Check concurrent effect limit
            if (owner.activeEffects.size >= owner.config.maxConcurrentEffects) {
                logger.warn('⚠️ CANVASFX: Max concurrent effects reached, dropping effect');
                owner.effectStats.droppedEffects++;
                return null;
            }

            const item = await owner.itemService.getItemById(itemId);
            if (!item) {
                logger.error('❌ CANVASFX: Item not found:', itemId);
                return null;
            }

            const effectConfig = owner.getEffectConfig(item);

            // Handle buff-duration effects specially
            let effectDuration = effectConfig.duration;
            if (effectConfig.duration === 'buff-duration' && effectParams.buffDuration) {
                effectDuration = effectParams.buffDuration * 1000; // Convert seconds to milliseconds
                logger.debug(`🎨 CANVASFX: Using buff duration of ${effectParams.buffDuration}s for positioned ${item.name}`);
            }

            // Handle multi-phase effects
            if (effectConfig.type === 'multi-phase') {
                // For positioned multi-phase effects, pass the position to all phases
                return await owner.triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, effectDuration, {
                    ...effectParams,
                    position: {
                        x: Math.max(0, Math.min(1, position.x)), // Clamp between 0 and 1
                        y: Math.max(0, Math.min(1, position.y))  // Clamp between 0 and 1
                    }
                });
            }

            // Create single-phase effect instance with specified position
            const effect = {
                id: `fx_throw_${userId}_${itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                userId,
                itemId,
                streamId,
                itemName: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: effectConfig.type,
                duration: effectDuration,
                config: { ...effectConfig.config, ...effectParams },
                startTime: Date.now(),
                position: {
                    x: Math.max(0, Math.min(1, position.x)), // Clamp between 0 and 1
                    y: Math.max(0, Math.min(1, position.y))  // Clamp between 0 and 1
                }
            };

            // Store active effect
            owner.activeEffects.set(effect.id, effect);
            owner.effectStats.totalTriggered++;
            owner.effectStats.activeCount = owner.activeEffects.size;

            // Broadcast to all viewers
            if (owner.io) {
                owner.io.emit('canvas-effect-trigger', effect);
                logger.debug(`📡 CANVASFX: Broadcasted positioned effect ${effect.type} for item ${item.display_name} at (${position.x}, ${position.y})`);
            }

            // Emit local event
            owner.emit('effect-triggered', effect);

            // Auto-cleanup after duration (but only for non-buff-synced effects)
            if (!owner.isBuffSyncedEffect(item)) {
                setTimeout(() => {
                    owner.cleanupEffect(effect.id);
                }, effectDuration);
            } else {
                logger.debug(`🎨 CANVASFX: Buff-synced positioned effect ${effect.id} will be managed by buff lifecycle`);
            }

            return effect;

        } catch (error) {
            logger.error('❌ CANVASFX: Error triggering positioned item effect:', error);
            return null;
        }
    }

    // Trigger multi-phase effect (like smoke bomb with initial puff + persistent smoke)
    async triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, totalDuration, effectParams) {
        const owner = this.owner;
        try {
            logger.debug(`🎨 CANVASFX: Triggering multi-phase effect for ${item.name} with total duration ${totalDuration}ms`);

            const mainEffectId = `fx_multi_${userId}_${itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const phaseEffects = [];

            for (const [phaseIndex, phase] of effectConfig.config.phases.entries()) {
                const phaseId = `${mainEffectId}_phase${phaseIndex}`;
                const phaseStartTime = Date.now() + (phase.delay || 0);

                // Calculate phase duration
                let phaseDuration = phase.duration;
                if (phase.duration === 'remaining-duration') {
                    // Calculate remaining duration after initial phases
                    const usedTime = (phase.delay || 0) + 2000; // Account for initial puff + delay
                    phaseDuration = Math.max(1000, totalDuration - usedTime); // At least 1 second
                }

                const phaseEffect = {
                    id: phaseId,
                    mainEffectId: mainEffectId,
                    userId,
                    itemId,
                    streamId,
                    itemName: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: phase.type,
                    duration: phaseDuration,
                    config: {
                        ...phase.config,
                        ...effectParams,
                        phaseName: phase.name,
                        phaseIndex: phaseIndex,
                        totalPhases: effectConfig.config.phases.length
                    },
                    startTime: phaseStartTime,
                    position: effectParams.position || owner.getRandomPosition(),
                    buffId: effectParams.buffId || null,
                    isMultiPhase: true,
                    delay: phase.delay || 0
                };

                phaseEffects.push(phaseEffect);

                // Store phase effect in active effects
                owner.activeEffects.set(phaseEffect.id, phaseEffect);

                // Schedule the phase to start
                setTimeout(async () => {
                    if (owner.activeEffects.has(phaseEffect.id)) {
                        // Broadcast phase to all viewers
                        if (owner.io) {
                            owner.io.emit('canvas-effect-trigger', phaseEffect);
                            logger.debug(`📡 CANVASFX: Broadcasted phase "${phase.name}" of ${item.display_name} (${phaseDuration}ms)`);
                        }

                        // Auto-cleanup after phase duration (only for non-buff-synced phases or last phase)
                        if (!owner.isBuffSyncedEffect(item) || phaseIndex === effectConfig.config.phases.length - 1) {
                            setTimeout(() => {
                                owner.cleanupEffect(phaseEffect.id);
                            }, phaseDuration);
                        } else {
                            logger.debug(`🎨 CANVASFX: Phase "${phase.name}" will be managed by buff lifecycle`);
                        }
                    }
                }, phase.delay || 0);
            }

            // Update stats
            owner.effectStats.totalTriggered++;
            owner.effectStats.activeCount = owner.activeEffects.size;

            // Emit local event for main effect
            const mainEffect = {
                id: mainEffectId,
                userId,
                itemId,
                streamId,
                itemName: item.name,
                displayName: item.display_name,
                type: 'multi-phase',
                phases: phaseEffects.length,
                totalDuration,
                isMultiPhase: true
            };
            owner.emit('effect-triggered', mainEffect);

            logger.debug(`✅ CANVASFX: Multi-phase effect "${item.name}" scheduled with ${phaseEffects.length} phases`);

            // Return the main effect for tracking
            return mainEffect;

        } catch (error) {
            logger.error('❌ CANVASFX: Error triggering multi-phase effect:', error);
            return null;
        }
    }
}

module.exports = EffectDispatcher;
