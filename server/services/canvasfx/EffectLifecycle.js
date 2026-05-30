/**
 * EffectLifecycle — resource/lifecycle + socket cleanup for CanvasFxService.
 *
 * Extracted verbatim from CanvasFxService (cleanup, cancel, clear-all, and the
 * per-socket force cleanup). ALL state stays on the owning service: methods
 * read/write owner.activeEffects, owner.buffSyncedEffects, owner.effectStats,
 * and fan out via owner.io / owner.emit where the original used `this.`.
 * The service keeps thin delegators with identical signatures.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'CanvasFxService' });

class EffectLifecycle {
    constructor(owner) {
        this.owner = owner;
    }

    // Cleanup an effect
    cleanupEffect(effectId) {
        const owner = this.owner;
        const effect = owner.activeEffects.get(effectId);
        if (effect) {
            owner.activeEffects.delete(effectId);
            owner.effectStats.activeCount = owner.activeEffects.size;

            // Remove from buff-synced tracking if needed
            owner.buffSyncedEffects.delete(effectId);

            // Notify clients
            if (owner.io) {
                owner.io.emit('canvas-effect-complete', { effectId });
            }

            // Emit local event
            owner.emit('effect-completed', effect);

            logger.debug(`🧹 CANVASFX: Cleaned up effect ${effectId}`);
        }
    }

    // Cancel an effect immediately (used for buff expiry or streamer switching)
    async cancelEffect(effectId, reason = 'cancelled') {
        const owner = this.owner;
        const effect = owner.activeEffects.get(effectId);
        if (effect) {
            owner.activeEffects.delete(effectId);
            owner.effectStats.activeCount = owner.activeEffects.size;

            // Remove from buff-synced tracking if needed
            owner.buffSyncedEffects.delete(effectId);

            // Notify clients to immediately cancel the effect
            if (owner.io) {
                owner.io.emit('canvas-effect-cancelled', {
                    effectId,
                    reason,
                    itemName: effect.itemName
                });

                // For smoke bomb effects, send additional force clear to ensure cleanup
                if (effect.itemName === 'smoke_bomb') {
                    owner.io.emit('canvas-effect-force-clear-item', {
                        itemName: 'smoke_bomb',
                        reason: reason,
                        effectId: effectId
                    });
                    logger.debug(`📡 CANVASFX: Sent additional smoke bomb force clear for ${effectId}`);
                }
            }

            // Emit local event
            owner.emit('effect-cancelled', { ...effect, reason });

            logger.debug(`🚫 CANVASFX: Cancelled effect ${effectId} (${effect.itemName}) - ${reason}`);
            return true;
        }
        return false;
    }

    // Clear all active effects
    clearAllEffects() {
        const owner = this.owner;
        const effectIds = Array.from(owner.activeEffects.keys());
        effectIds.forEach(id => owner.cleanupEffect(id));

        if (owner.io) {
            owner.io.emit('canvas-effects-clear');
        }

        logger.debug('🧹 CANVASFX: Cleared all active effects');
    }

    // Force clear smoke bomb effects for a specific socket (e.g., former streamer)
    forceCleanupForSocket(socketId, reason = 'manual') {
        const owner = this.owner;
        logger.debug(`🎨 CANVASFX: Force cleaning up effects for socket ${socketId} - ${reason}`);

        if (owner.io && socketId) {
            // Send multiple cleanup events to ensure the client clears the effects
            owner.io.to(socketId).emit('canvas-effects-clear');
            owner.io.to(socketId).emit('canvas-effects-clear-buff-synced');
            owner.io.to(socketId).emit('canvas-effect-force-clear', {
                reason: reason,
                effects: ['smoke_bomb'],
                forceComplete: true
            });

            logger.debug(`📡 CANVASFX: Sent comprehensive cleanup to socket ${socketId}`);
        }
    }
}

module.exports = EffectLifecycle;
