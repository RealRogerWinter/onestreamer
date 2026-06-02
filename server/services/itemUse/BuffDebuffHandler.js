const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });
const resolveCurrentStreamerUserId = require('../item/resolveCurrentStreamerUserId');

// server/services/itemUse/BuffDebuffHandler.js
//
// Buff/debuff items targeting the current streamer — resolve the target,
// consume, apply the effect, and broadcast. Extracted verbatim from
// ItemUseService.

/**
 * Pull the client-renderable visual-filter effect id (e.g. 'flip_vertical',
 * 'mirror', 'grayscale') out of an item's effect_data, or null when the item is
 * not a visual-filter effect (or its effect_data is absent/malformed).
 * effect_data is persisted as a JSON string; an already-parsed object is
 * tolerated too.
 */
function readVisualEffect(item) {
    if (!item || !item.effect_data) return null;
    try {
        const data = typeof item.effect_data === 'string'
            ? JSON.parse(item.effect_data)
            : item.effect_data;
        if (data && data.effect_type === 'visual_filter' && data.visual_effect) {
            return data.visual_effect;
        }
    } catch (_) {
        // Malformed effect_data → treat as a non-visual item.
    }
    return null;
}

class BuffDebuffHandler {
    constructor(owner) {
        this.owner = owner;
    }

    async _applyBuffOrDebuff(ctx) {
        const { user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage, buffNotifier } = ctx;
        const { inventoryService, itemService, streamService } = services;

        logger.debug(`🎭 ITEMS: Taking buff/debuff path for ${item.display_name}`);
        // Handle buff/debuff items
        const buffDebuffService = services.buffDebuffService;
        if (!buffDebuffService) {
            return { ok: false, kind: 'service-unavailable', service: 'buffDebuffService' };
        }

        // Resolve the current streamer's userId (StreamService → webrtcService
        // fallback → session lookup). Shared with ThrowingService.
        const targetUserId = resolveCurrentStreamerUserId({
            streamService,
            webrtcService: services.webrtcService,
            sessionService,
            logger,
        });

        if (!targetUserId) {
            return { ok: false, kind: 'no-streamer-target' };
        }

        // Consume the item from inventory
        const result = await inventoryService.useItem(userId, itemId, streamId);

        // Apply the buff/debuff
        try {
            logger.debug(`🎭 ITEMS: About to call applyBuffDebuffItem with params:`, {
                targetUserId,
                itemId,
                appliedByUserId: userId,
                hasBuffDebuffService: !!buffDebuffService,
                streamId
            });

            const buffResult = await itemService.applyBuffDebuffItem(
                targetUserId,
                itemId,
                userId,
                buffDebuffService,
                true, // Skip cooldown validation since we already consumed the item
                streamId // Pass the stream ID for visual effects
            );

            logger.debug(`🎭 ITEMS: applyBuffDebuffItem returned:`, buffResult);

            // Add the buff result to the response
            result.buffResult = buffResult;
            result.targetUserId = targetUserId;
            result.message = `${result.item.displayName} applied to streamer successfully!`;

            logger.debug(`🎭 ITEMS: Applied ${result.item.displayName} buff/debuff to user ${targetUserId}`);

            // Send system message about the effect
            const effectMessage = `${user.username} used ${result.item.displayName} on the streamer!`;
            logger.debug(`📨 ITEMS: Sending buff/debuff chat message: "${effectMessage}"`);
            await sendSystemMessage(effectMessage);

        } catch (buffError) {
            logger.error('Error applying buff/debuff effect:', buffError);
            result.message = `${result.item.displayName} used but buff/debuff effect failed: ${buffError.message}`;
        }

        // Emit socket events for buff/debuff items
        if (io) {
            // Visual-filter items (upside-down, mirror, grayscale, …) re-skin the
            // stream by composing CSS onto every viewer's <video>. Broadcast the
            // effect so clients render it. It is stream-type agnostic (all viewers
            // share the same <video>), so it covers webcam AND URL-relay streams —
            // relay resolves a synthetic streamer id above, so this buff path is
            // reached for them too.
            const visualEffect = readVisualEffect(item);
            if (visualEffect) {
                io.emit('visual-effect-applied', {
                    effectId: visualEffect,
                    durationSeconds: Number(item.duration_seconds) || 20,
                    itemName: result.item.displayName,
                    username: user.username,
                });
            }

            io.emit('item-used', {
                userId: userId,
                username: user.username,
                item: result.item,
                targetUserId: targetUserId,
                streamId,
                buffResult: result.buffResult
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

module.exports = BuffDebuffHandler;
