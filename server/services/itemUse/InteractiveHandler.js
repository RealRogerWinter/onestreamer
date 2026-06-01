const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });

// server/services/itemUse/InteractiveHandler.js
//
// Interactive items (click-to-throw / click-to-draw) — validate only and emit
// a canvas-effect-mode socket event; consumption is deferred to a follow-up
// request. Extracted verbatim from ItemUseService.

class InteractiveHandler {
    constructor(owner) {
        this.owner = owner;
    }

    async _applyInteractiveValidation(ctx) {
        const { user, userId, itemId, item, streamId, streamStatus, services, io, sessionService } = ctx;
        const { inventoryService, itemService, canvasFxService } = services;

        logger.debug(`🎯 ITEMS: Taking interactive item path for ${item.display_name}`);

        // Check if there's an active stream for interactive items
        // Allow anonymous streamers too - check both hasActiveStream and MediaSoup
        const webrtcService = services.webrtcService;
        const hasMediaSoupStreamer = webrtcService && webrtcService.currentStreamer;

        if (!streamStatus.hasActiveStream && !hasMediaSoupStreamer) {
            logger.debug(`❌ ITEMS: No active stream for interactive item ${item.display_name}`);
            logger.debug(`   StreamService hasActiveStream: ${streamStatus.hasActiveStream}`);
            logger.debug(`   MediasoupService currentStreamer: ${hasMediaSoupStreamer}`);
            return { ok: false, kind: 'no-active-stream' };
        } else if (!streamStatus.hasActiveStream && hasMediaSoupStreamer) {
            logger.debug(`⚠️ ITEMS: StreamService says no stream but MediaSoup has streamer - allowing for anonymous`);
        }

        // For interactive items, only validate but don't consume the item yet
        const inventoryItem = await inventoryService.getInventoryItem(userId, itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return { ok: false, kind: 'not-in-inventory' };
        }

        // Validate item usage (cooldown check)
        const validation = await itemService.validateItemUsage(userId, itemId);
        if (!validation.valid) {
            return {
                ok: false,
                kind: 'validation-failed',
                error: validation.error || 'Cannot use item',
                cooldownRemaining: validation.cooldownRemaining
            };
        }

        // Get interaction config for the item
        const interactionConfig = canvasFxService.getInteractionConfig(item);

        // Return success with interaction mode - client should enable click-to-throw UI
        const result = {
            success: true,
            item: {
                id: item.id,
                name: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: item.item_type
            },
            remainingQuantity: inventoryItem.quantity,
            interactionMode: interactionConfig?.mode || 'click-to-throw',
            interactionConfig: interactionConfig,
            message: 'Interaction mode activated'
        };

        // Create a unique interaction ID for tracking
        const interactionId = `interact_${userId}_${item.id}_${Date.now()}`;
        result.interactionId = interactionId;

        // For drawing items, the interaction mode is different
        if (interactionConfig && interactionConfig.mode === 'click-to-draw') {
            result.message = 'Drawing mode activated';
        }

        // Notify the specific user's socket to enable interaction mode
        if (io && sessionService) {
            const userSocketIds = sessionService.getSocketsByUserId(userId);
            userSocketIds.forEach(socketId => {
                io.to(socketId).emit('canvas-effect-mode', {
                    mode: interactionConfig?.mode || 'click-to-throw',
                    item: result.item,
                    interactionConfig: interactionConfig,
                    userId: userId,
                    username: user.username,
                    streamId,
                    interactionId: interactionId
                });
            });
        }

        return { ok: true, body: result };
    }
}

module.exports = InteractiveHandler;
