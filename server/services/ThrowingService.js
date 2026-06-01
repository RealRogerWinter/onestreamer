const logger = require('../bootstrap/logger').child({ svc: 'ThrowingService' });

// server/services/ThrowingService.js
//
// Stateless orchestrator for the throw-item flow extracted from
// server/routes/items.js (PR-J2). Mirrors the DrawingService pattern
// from PR-J: composes the existing inventory / item / canvas-fx /
// stream / buff-debuff / session services and the items.js-local
// `sendSystemMessage` helper. Routes pass dependencies in per-call so
// the service stays a thin re-usable seam; HTTP status / response shape
// stays in the route handler.
//
// NOTE: the throw logic embedded inside `inventory/use/:itemId` is NOT
// covered here — that lives in the mega-handler and is deferred to a
// future PR (PR-J3). This service only owns the `inventory/throw` route.

class ThrowingService {
    /**
     * Throw `item` at coordinates (x, y) on behalf of `user`.
     *
     * Returns one of:
     *   { ok: true, item, effect, displayMessage, remainingQuantity }
     *   { ok: false, kind: 'missing-params' }
     *   { ok: false, kind: 'no-active-stream' }
     *   { ok: false, kind: 'cooldown', message }
     *   { ok: false, kind: 'no-canvas-fx' }
     *   { ok: false, kind: 'effect-failed' }
     *   { ok: false, kind: 'error', message, cause }
     *
     * The route handler maps these to HTTP status codes and JSON bodies so
     * we don't bake express semantics into the service.
     *
     * @param {object} opts
     * @param {object} opts.user                 req.user (must have userId|id and username)
     * @param {object} opts.body                 req.body — expects { x, y, item, username }
     * @param {object} opts.services
     * @param {object} opts.services.inventoryService
     * @param {object} opts.services.canvasFxService
     * @param {object} opts.services.itemService
     * @param {object} opts.services.streamService
     * @param {object} [opts.services.buffDebuffService]
     * @param {object} [opts.services.webrtcService]
     * @param {object} [opts.io]                 socket.io server (optional — events skipped if absent)
     * @param {object} [opts.sessionService]     used to look up the current streamer's userId and to
     *                                           fan inventory-updated out to the thrower's sockets
     * @param {Function} opts.sendSystemMessage  async (message, username?) -> void
     */
    async startThrow({ user, body, services, io, sessionService, sendSystemMessage, buffNotifier }) {
        const userId = user.userId || user.id;
        logger.debug(`🎯 THROW ENDPOINT HIT: User ${user.username} throwing item`, body);

        const { x, y, item, username } = body || {};

        if (x === undefined || x === null || y === undefined || y === null || !item || !username) {
            return { ok: false, kind: 'missing-params' };
        }

        const {
            inventoryService,
            canvasFxService,
            itemService,
            streamService,
            buffDebuffService,
            webrtcService
        } = services;

        const streamStatus = streamService.getStreamStatus();
        const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;

        // Check if there's an active stream (required for throwing items)
        if (!streamStatus.hasActiveStream) {
            logger.debug(`❌ THROW: No active stream to throw item at`);
            return { ok: false, kind: 'no-active-stream' };
        }

        logger.debug(`🎯 THROW DEBUG: Throwing item ${item.name} for user ${user.username}`);

        let result;
        try {
            // First, consume the item from inventory
            result = await inventoryService.useItem(
                userId,
                item.id,
                streamId
            );
        } catch (error) {
            logger.error('Error throwing item:', error);
            if (error.message && error.message.includes('cooldown')) {
                return { ok: false, kind: 'cooldown', message: error.message };
            }
            return { ok: false, kind: 'error', message: error.message || 'Failed to throw item', cause: error };
        }

        try {
            // Check if this is a buff/debuff item that needs special handling after throwing
            const fullItem = await itemService.getItemById(item.id);
            const isBuffDebuffItem = itemService.isBuffOrDebuffItem(fullItem);

            // For buff/debuff items like smoke_bomb, apply the buff first to get duration
            let buffDuration = null;
            if (isBuffDebuffItem) {
                logger.debug(`🎯 THROW: Item ${fullItem.name} is a buff/debuff, applying after throw`);

                if (buffDebuffService) {
                    // Get the current streamer to determine target
                    // Try StreamService first (works for MediaSoup and synced LiveKit)
                    let currentStreamerSocketId = streamService.getCurrentStreamer();

                    // LIVEKIT FIX: Fallback to webrtcService/webrtcAdapter if StreamService has no streamer
                    // This handles LiveKit mode where LiveKitService tracks currentStreamer but StreamService might not be synced
                    if (!currentStreamerSocketId && webrtcService) {
                        currentStreamerSocketId = webrtcService.getCurrentStreamer();
                        if (currentStreamerSocketId) {
                            logger.debug(`🎯 THROW: Using webrtcService/webrtcAdapter fallback for streamer: ${currentStreamerSocketId}`);
                        }
                    }

                    let targetUserId = null;

                    if (currentStreamerSocketId && sessionService) {
                        const session = sessionService.getSessionBySocketId(currentStreamerSocketId);
                        if (session && session.userId) {
                            targetUserId = session.userId;
                            logger.debug(`🎯 THROW: Found current streamer userId: ${targetUserId}`);
                        }
                    }

                    if (targetUserId) {
                        try {
                            const buffResult = await itemService.applyBuffDebuffItem(
                                targetUserId,
                                item.id,
                                userId,
                                buffDebuffService,
                                true, // Skip cooldown validation since we already consumed the item
                                streamId
                            );
                            logger.debug(`🎯 THROW: Applied ${fullItem.display_name} buff/debuff to streamer after throw`);
                            result.buffResult = buffResult;

                            // Get the buff duration for the effect
                            if (fullItem.duration_seconds) {
                                buffDuration = fullItem.duration_seconds;
                                logger.debug(`🎯 THROW: Buff duration is ${buffDuration} seconds`);
                            }
                        } catch (buffError) {
                            logger.error('Error applying buff/debuff after throw:', buffError);
                        }
                    }
                }
            }

            // Trigger the visual effect at specific coordinates for ALL viewers
            // For buff items, pass the buff duration to ensure proper effect duration
            if (!canvasFxService) {
                return { ok: false, kind: 'no-canvas-fx' };
            }

            const effectParams = { username: user.username };
            if (buffDuration) {
                effectParams.buffDuration = buffDuration;
                effectParams.triggeredByThrow = true;
                logger.debug(`🎯 THROW: Passing buff duration ${buffDuration}s to effect`);
            }

            const effect = await canvasFxService.triggerItemEffectAtPosition(
                userId,
                item.id,
                streamId,
                { x: parseFloat(x), y: parseFloat(y) },
                effectParams
            );

            if (!effect) {
                return { ok: false, kind: 'effect-failed' };
            }

            logger.debug(`🎯 ITEMS: ${user.username} threw ${item.displayName} at (${x}, ${y})`);

            // Send configurable StreamBot chat message
            const interactionConfig = canvasFxService.getInteractionConfig({ name: item.name });
            const chatMessage = interactionConfig?.chatMessage?.replace('{username}', user.username)
                || `${user.username} threw ${item.displayName}!`;

            await sendSystemMessage(chatMessage);

            // Check if this is an interactive item to suppress UI notifications
            const isInteractiveItem = canvasFxService && canvasFxService.isInteractiveItem(item);

            // Emit socket events for inventory update and item usage
            if (io) {
                // Always emit item-used for cooldown tracking, but flag interactive items
                io.emit('item-used', {
                    userId: userId,
                    username: user.username,
                    item: result.item,
                    streamId,
                    thrown: true, // Flag to indicate this was thrown
                    suppressNotification: isInteractiveItem // Flag to suppress notifications for interactive items
                });

                if (isInteractiveItem) {
                    logger.debug(`🔇 THROW: Flagged interactive item for notification suppression: ${item.display_name}`);
                }

                // Specific inventory update for the user
                if (sessionService) {
                    const userSocketIds = sessionService.getSocketsByUserId(userId);
                    userSocketIds.forEach(socketId => {
                        if (buffNotifier) {
                            buffNotifier.inventoryUpdated({
                                toSocketId: socketId,
                                action: 'throw',
                                itemId: item.id,
                                quantity: 1,
                                remainingQuantity: result.remainingQuantity,
                            });
                        } else {
                            io.to(socketId).emit('inventory-updated', {
                                action: 'throw',
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
                item: result.item, // Include the full item with cooldown
                effect,
                displayMessage: `${item.displayName} thrown successfully!`,
                remainingQuantity: result.remainingQuantity
            };
        } catch (error) {
            logger.error('Error throwing item:', error);

            // If the error occurred after consuming the item, we might need to refund it
            // For now, we'll just return the error - this should be rare

            if (error.message && error.message.includes('cooldown')) {
                return { ok: false, kind: 'cooldown', message: error.message };
            }

            return { ok: false, kind: 'error', message: error.message || 'Failed to throw item', cause: error };
        }
    }
}

module.exports = ThrowingService;
