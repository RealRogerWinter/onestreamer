const logger = require('../bootstrap/logger').child({ svc: 'DrawingService' });

// server/services/DrawingService.js
//
// Stateless orchestrator for the standalone drawing-start flow extracted
// from server/routes/items.js (PR-J). Composes the existing inventory /
// canvas-fx / stream / session services and the items.js-local
// `sendSystemMessage` helper. Routes pass dependencies in per-call so the
// service stays a thin re-usable seam; HTTP status / response shape stays
// in the route handler.
//
// NOTE: the drawing logic embedded inside `inventory/use/:itemId` is NOT
// covered here — that lives in the mega-handler and is deferred to a
// future PR. This service only owns the `inventory/drawing-start` route.

class DrawingService {
    /**
     * Start a drawing session for `user` using `item`.
     *
     * Returns one of:
     *   { ok: true, item, remainingQuantity, displayMessage }
     *   { ok: false, kind: 'missing-item' }
     *   { ok: false, kind: 'no-active-stream' }
     *   { ok: false, kind: 'cooldown', message }
     *   { ok: false, kind: 'error', message, cause }
     *
     * The route handler maps these to HTTP status codes and JSON bodies so
     * we don't bake express semantics into the service.
     *
     * @param {object} opts
     * @param {object} opts.user                 req.user (must have userId|id and username)
     * @param {object} opts.item                 req.body.item
     * @param {object} opts.services
     * @param {object} opts.services.inventoryService
     * @param {object} opts.services.canvasFxService
     * @param {object} opts.services.streamService
     * @param {object} [opts.io]                 socket.io server (optional — events skipped if absent)
     * @param {object} [opts.sessionService]     used to fan inventory-updated out to the user's sockets
     * @param {Function} opts.sendSystemMessage  async (message, username?) -> void
     */
    async startDrawing({ user, item, services, io, sessionService, sendSystemMessage, buffNotifier }) {
        const userId = user.userId || user.id;
        logger.debug(`✏️ DRAWING START: User ${user.username} starting drawing`, { item });

        if (!item) {
            return { ok: false, kind: 'missing-item' };
        }

        const { inventoryService, canvasFxService, streamService } = services;

        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;

        // Drawing requires an active stream to draw on.
        if (!streamStatus.hasActiveStream) {
            logger.debug(`❌ DRAWING START: No active stream to draw on`);
            return { ok: false, kind: 'no-active-stream' };
        }

        logger.debug(`✏️ DRAWING START: Consuming marker item ${item.name} for user ${user.username}`);

        let result;
        try {
            result = await inventoryService.useItem(userId, item.id, streamId);
        } catch (error) {
            logger.error('Error starting drawing:', error);
            if (error.message && error.message.includes('cooldown')) {
                return { ok: false, kind: 'cooldown', message: error.message };
            }
            return { ok: false, kind: 'error', message: error.message || 'Failed to start drawing', cause: error };
        }

        // Trigger the multi-phase visual effect for all clients.
        if (canvasFxService && result.item) {
            try {
                const effect = await canvasFxService.triggerItemEffect(
                    userId,
                    result.item.id,
                    streamId,
                    { username: user.username }
                );

                logger.debug(`✏️ DRAWING START: triggerItemEffect returned:`, effect);

                if (effect) {
                    logger.debug(`✏️ DRAWING START: Triggered multi-phase drawing effect for ${result.item.displayName}`);
                } else {
                    logger.debug(`❌ DRAWING START: Failed to trigger effect for ${result.item.displayName} - null effect returned`);
                }
            } catch (error) {
                logger.error(`❌ DRAWING START: Error triggering effect for ${result.item.displayName}:`, error);
            }
        }

        // System chat broadcast.
        await sendSystemMessage(`${user.username} started drawing with ${item.displayName || item.display_name}!`);

        // Socket fan-out: global item-used + per-socket inventory-updated.
        if (io) {
            io.emit('item-used', {
                userId,
                username: user.username,
                item: result.item,
                streamId,
                drawingStarted: true
            });

            if (sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    if (buffNotifier) {
                        buffNotifier.inventoryUpdated({
                            toSocketId: socketId,
                            action: 'draw',
                            itemId: item.id,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity,
                        });
                    } else {
                        io.to(socketId).emit('inventory-updated', {
                            action: 'draw',
                            itemId: item.id,
                            quantity: 1,
                            remainingQuantity: result.remainingQuantity
                        });
                    }
                });
            }
        }

        return {
            ok: true,
            item: result.item,
            remainingQuantity: result.remainingQuantity,
            displayMessage: `Drawing started with ${item.displayName || item.display_name}!`
        };
    }
}

module.exports = DrawingService;
