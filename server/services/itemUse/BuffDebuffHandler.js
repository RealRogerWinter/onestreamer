const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });

// server/services/itemUse/BuffDebuffHandler.js
//
// Buff/debuff items targeting the current streamer — resolve the target,
// consume, apply the effect, and broadcast. Extracted verbatim from
// ItemUseService.
//
// NOTE — KNOWN LATENT BUG PRESERVED AS-IS: the inventory-update forEach below
// references a bare `buffNotifier` that is neither a parameter nor carried on
// ctx, so it throws a synchronous ReferenceError whenever this branch reaches
// it (io AND sessionService both present). This matches the original handler
// and MUST NOT be fixed here.

class BuffDebuffHandler {
    constructor(owner) {
        this.owner = owner;
    }

    async _applyBuffOrDebuff(ctx) {
        const { user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage } = ctx;
        const { inventoryService, itemService, streamService } = services;

        logger.debug(`🎭 ITEMS: Taking buff/debuff path for ${item.display_name}`);
        // Handle buff/debuff items
        const buffDebuffService = services.buffDebuffService;
        if (!buffDebuffService) {
            return { ok: false, kind: 'service-unavailable', service: 'buffDebuffService' };
        }

        // Get the current streamer to determine target
        // Try StreamService first (works for MediaSoup and synced LiveKit)
        let currentStreamerSocketId = streamService.getCurrentStreamer();

        // LIVEKIT FIX: Fallback to mediasoupService/webrtcAdapter if StreamService has no streamer
        const mediasoupService = services.mediasoupService;
        if (!currentStreamerSocketId && mediasoupService) {
            currentStreamerSocketId = mediasoupService.getCurrentStreamer();
            if (currentStreamerSocketId) {
                logger.debug(`🎭 ITEMS: Using mediasoupService/webrtcAdapter fallback for streamer: ${currentStreamerSocketId}`);
            }
        }

        let targetUserId = null;

        if (currentStreamerSocketId && sessionService) {
            const session = sessionService.getSessionBySocketId(currentStreamerSocketId);
            if (session && session.userId) {
                // Accept any user ID, including negative IDs for anonymous/viewbot users
                targetUserId = session.userId;
                if (targetUserId < 0) {
                    logger.debug(`🎭 ITEMS: Found anonymous/viewbot streamer with synthetic ID: ${targetUserId}`);
                } else {
                    logger.debug(`🎭 ITEMS: Found current streamer userId: ${targetUserId}`);
                }
            } else {
                logger.debug(`🎭 ITEMS: No session found for current streamer ${currentStreamerSocketId}`);
            }
        } else {
            logger.debug(`🎭 ITEMS: No current streamer or session service unavailable`);
        }

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
