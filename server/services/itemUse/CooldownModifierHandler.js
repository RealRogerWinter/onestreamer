const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });

// server/services/itemUse/CooldownModifierHandler.js
//
// Cooldown-modifier items (guard / weapon) — consume, apply the global/individual
// cooldown effects via takeoverService, and broadcast a cooldown-status update.
// Extracted verbatim from ItemUseService.
//
// NOTE — KNOWN LATENT BUG PRESERVED AS-IS: the inventory-update forEach below
// references a bare `buffNotifier` that is neither a parameter nor carried on
// ctx, so it throws a synchronous ReferenceError whenever this branch reaches
// it (io AND sessionService both present). MUST NOT be fixed here.

class CooldownModifierHandler {
    constructor(owner) {
        this.owner = owner;
    }

    async _applyCooldownModifier(ctx) {
        const { user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage } = ctx;
        const { inventoryService, itemService } = services;

        logger.debug(`🛡️⚔️ ITEMS: Taking cooldown modifier path for ${item.display_name}`);
        // Handle cooldown modifier items
        const takeoverService = services.takeoverService;
        if (!takeoverService) {
            return { ok: false, kind: 'service-unavailable', service: 'takeoverService' };
        }

        // Consume the item from inventory
        const result = await inventoryService.useItem(userId, itemId, streamId);

        // Apply the cooldown modification
        try {
            const cooldownResult = await itemService.applyCooldownModifierItem(
                userId,
                itemId,
                userId,
                takeoverService,
                true // Skip cooldown validation since we already consumed the item
            );

            // Add the cooldown effects to the result
            result.cooldownEffects = cooldownResult.effects;
            result.message = `${result.item.displayName} used successfully! ${cooldownResult.effects.map(e => e.message).join(', ')}`;

            logger.debug(`🛡️⚔️ ITEMS: Applied ${result.item.displayName} cooldown effects:`, cooldownResult.effects);

            // CRITICAL DEBUG: Check cooldown immediately after modification
            const immediateCheck = await takeoverService.getGlobalCooldownRemaining();
            logger.debug(`🔍 CRITICAL DEBUG: Cooldown remaining immediately after modification: ${immediateCheck}s`);

            // Send system message about the effect
            const effectMessages = cooldownResult.effects.map(effect => {
                if (effect.type === 'global_cooldown_increase') {
                    return `${user.username} used ${result.item.displayName} - Global cooldown extended by ${effect.amount}s!`;
                } else if (effect.type === 'global_cooldown_decrease') {
                    return `${user.username} used ${result.item.displayName} - Global cooldown reduced by ${effect.amount}s!`;
                } else if (effect.type === 'reset_individual_cooldowns') {
                    return `${user.username} used ${result.item.displayName} - Reset ${effect.count} individual cooldowns!`;
                } else if (effect.type === 'freeze_individual_cooldowns') {
                    return `${user.username} used ${result.item.displayName} - Froze ${effect.count} individual cooldowns for ${effect.duration}s!`;
                }
                return effect.message;
            });

            for (const message of effectMessages) {
                logger.debug(`📨 ITEMS: Sending cooldown modifier chat message: "${message}"`);
                await sendSystemMessage(message);
            }

        } catch (cooldownError) {
            logger.error('Error applying cooldown effect:', cooldownError);
            result.message = `${result.item.displayName} used but cooldown effect failed: ${cooldownError.message}`;
        }

        // Emit socket events for cooldown modifier items
        if (io) {
            io.emit('item-used', {
                userId: userId,
                username: user.username,
                item: result.item,
                streamId,
                cooldownEffects: result.cooldownEffects
            });

            // Broadcast cooldown status update to all users
            const globalCooldownInfo = await itemService.getGlobalCooldownInfo(takeoverService);
            io.emit('cooldown-status-update', {
                globalCooldown: globalCooldownInfo,
                timestamp: Date.now()
            });

            // Specific inventory update for the user
            if (sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    if (buffNotifier) {
                        buffNotifier.inventoryUpdated({
                            toSocketId: socketId,
                            action: 'use',
                            itemId,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity,
                        });
                    } else {
                        io.to(socketId).emit('inventory-updated', {
                            action: 'use',
                            itemId,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity
                        });
                    }
                });
            }
        }

        return { ok: true, body: result };
    }
}

module.exports = CooldownModifierHandler;
