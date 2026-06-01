const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });

// server/services/itemUse/RegularHandler.js
//
// Regular consumed items (incl. kill_switch and the fart-from-regular-path) —
// consume, trigger the visual effect, broadcast item-used, and handle the
// kill-switch force-disconnect. Extracted verbatim from ItemUseService.
//
// NOTE — KNOWN LATENT BUG PRESERVED AS-IS: the inventory-update forEach blocks
// below reference a bare `buffNotifier` that is neither a parameter nor carried
// on ctx, so they throw a synchronous ReferenceError whenever reached (the
// kill-switch path, and the regular path when io AND sessionService are both
// present). MUST NOT be fixed here.

class RegularHandler {
    constructor(owner) {
        this.owner = owner;
    }

    async _applyRegular(ctx) {
        const {
            user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage
        } = ctx;
        const { inventoryService, canvasFxService, streamService, soundFxService } = services;

        logger.debug(`🎯 ITEMS: Taking regular item path for ${item.display_name}`);
        // For non-interactive, non-cooldown-modifier items, use the original flow
        logger.debug(`🔍 ITEMS DEBUG: About to call inventoryService.useItem for ${item.display_name}`);
        const result = await inventoryService.useItem(userId, itemId, streamId);
        logger.debug(`🔍 ITEMS DEBUG: inventoryService.useItem completed for ${item.display_name}, result:`, result);

        // Special handling for Fart item (automatic sound + visual)
        if (item.name === 'fart') {
            logger.debug(`💨 ITEMS: Fart item activated by ${user.username}`);

            // Trigger the sound effect automatically
            if (soundFxService) {
                try {
                    await soundFxService.queue101Soundboard(
                        userId,
                        user.username,
                        'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                        { streamId }
                    );
                    logger.debug(`🔊 ITEMS: Fart sound effect queued`);
                } catch (error) {
                    logger.error('❌ ITEMS: Failed to play fart sound:', error);
                }
            }

            // Wait 2 seconds then trigger the visual effect
            setTimeout(() => {
                if (canvasFxService) {
                    canvasFxService.triggerItemEffect(
                        userId,
                        result.item.id,
                        streamId,
                        {
                            position: { x: 0.5, y: 0.7 } // Center-bottom of screen
                        }
                    ).then(() => {
                        logger.debug(`💨 ITEMS: Fart visual effect triggered (after 2 second delay)`);
                    }).catch(error => {
                        logger.error('❌ ITEMS: Failed to trigger fart visual:', error);
                    });
                }
            }, 2000); // 2 second delay to sync with sound

            // Send chat message
            await sendSystemMessage(`💨 ${user.username} let one rip!`, '🤖 StreamBot');
        }

        // Special handling for Kill Switch after item consumption
        if (item.name === 'kill_switch') {
            logger.debug(`💥 ITEMS: Kill Switch activated by ${user.username} (user ${userId}) in regular path`);

            if (!streamService || !sessionService || !io) {
                logger.error('❌ KILL SWITCH: Required services not available');
                return { ok: false, kind: 'killswitch-failed' };
            }

            // Get current streamer
            let currentStreamerSocketId = streamService.getCurrentStreamer();

            // LIVEKIT FIX: Fallback to webrtcService/webrtcAdapter if StreamService has no streamer
            const webrtcServiceForKillSwitch = services.webrtcService;
            if (!currentStreamerSocketId && webrtcServiceForKillSwitch) {
                currentStreamerSocketId = webrtcServiceForKillSwitch.getCurrentStreamer();
                if (currentStreamerSocketId) {
                    logger.debug(`💥 KILL SWITCH: Using webrtcService/webrtcAdapter fallback for streamer: ${currentStreamerSocketId}`);
                }
            }

            if (!currentStreamerSocketId) {
                logger.debug('❌ KILL SWITCH: No active streamer to disconnect');
                return { ok: false, kind: 'no-active-streamer-killswitch' };
            }

            logger.debug(`💥 KILL SWITCH: Current streamer socket: ${currentStreamerSocketId}`);

            // Get streamer's session info for logging
            const streamerSession = sessionService.getSessionBySocketId(currentStreamerSocketId);
            const streamerUsername = streamerSession?.username || 'Unknown';
            logger.debug(`💥 KILL SWITCH: Disconnecting streamer "${streamerUsername}" (socket: ${currentStreamerSocketId})`);

            // Force disconnect the current streamer
            try {
                // Send disconnect message to the streamer
                io.to(currentStreamerSocketId).emit('force-disconnect', {
                    reason: 'Kill Switch activated',
                    activatedBy: user.username,
                    message: '💥 Kill Switch has been activated! You have been disconnected.'
                });

                // Broadcast to all viewers that Kill Switch was used
                io.emit('kill-switch-activated', {
                    activatedBy: user.username,
                    targetStreamer: streamerUsername,
                    message: `💥 ${user.username} activated the Kill Switch! Stream disconnected.`
                });

                // Actually disconnect the socket after a brief delay
                setTimeout(() => {
                    const socket = io.sockets.sockets.get(currentStreamerSocketId);
                    if (socket) {
                        logger.debug(`💥 KILL SWITCH: Force disconnecting socket ${currentStreamerSocketId}`);
                        socket.disconnect(true);
                    }
                }, 1000); // 1 second delay to allow messages to be sent

                logger.debug(`✅ KILL SWITCH: Successfully activated by ${user.username}, disconnecting ${streamerUsername}`);

            } catch (error) {
                logger.error('❌ KILL SWITCH: Error during force disconnect:', error);
                return { ok: false, kind: 'killswitch-failed' };
            }

            // Update inventory for the user (item already consumed)
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

            return {
                ok: true,
                body: {
                    ...result,
                    killSwitchActivated: true,
                    targetStreamer: streamerUsername,
                    message: `💥 Kill Switch activated! ${streamerUsername} has been disconnected.`
                }
            };
        }

        // Trigger visual effect immediately for non-interactive items
        if (canvasFxService && result.item) {
            const effect = await canvasFxService.triggerItemEffect(
                userId,
                result.item.id,
                streamId,
                { username: user.username }
            );

            if (effect) {
                logger.debug(`🎨 ITEMS: Triggered visual effect for ${result.item.displayName}`);
            }
        }

        // Emit socket events for non-interactive items only
        if (io) {
            // Global event for all users to see item effects
            io.emit('item-used', {
                userId: userId,
                username: user.username,
                item: result.item,
                streamId
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

module.exports = RegularHandler;
