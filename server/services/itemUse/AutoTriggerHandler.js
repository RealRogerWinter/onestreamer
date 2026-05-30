const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });

// server/services/itemUse/AutoTriggerHandler.js
//
// Auto-trigger items (fart, thunderstorm) — consume immediately and fire the
// sound + delayed visual effect. Extracted verbatim from ItemUseService;
// `owner` is the ItemUseService back-reference (all state stays on it).

class AutoTriggerHandler {
    constructor(owner) {
        this.owner = owner;
    }

    async _applyAutoTrigger(ctx) {
        const { user, userId, itemId, item, streamId, services, sendSystemMessage } = ctx;
        const { inventoryService, canvasFxService, soundFxService } = services;

        logger.debug(`🔥 ITEMS: Auto-trigger item ${item.display_name} - consuming immediately`);

        // Consume the item
        const usageResult = await inventoryService.useItem(userId, itemId, streamId);

        // Special handling for Fart item
        if (item.name === 'fart') {
            logger.debug(`💨 ITEMS: Fart item auto-triggered by ${user.username}`);

            // Queue the sound effect first
            if (soundFxService) {
                soundFxService.queue101Soundboard(
                    userId,
                    user.username,
                    'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                    { streamId }
                ).then(() => {
                    logger.debug(`🔊 ITEMS: Fart sound effect queued`);
                }).catch(error => {
                    logger.error('❌ ITEMS: Failed to play fart sound:', error);
                });
            }

            // Delay the visual effect by 1 second to sync with sound
            setTimeout(() => {
                if (canvasFxService) {
                    canvasFxService.triggerItemEffect(
                        userId,
                        usageResult.item.id,
                        streamId,
                        {
                            position: { x: 0.5, y: 0.7 } // Center-bottom of screen
                        }
                    ).then(() => {
                        logger.debug(`💨 ITEMS: Fart visual effect triggered (after 1000ms delay)`);
                    }).catch(error => {
                        logger.error('❌ ITEMS: Failed to trigger fart visual:', error);
                    });
                }
            }, 2000); // 2 second delay to sync with sound

            // Send chat message
            await sendSystemMessage(`💨 ${user.username} let one rip!`, '🤖 StreamBot');
        }

        // Special handling for Thunderstorm item
        if (item.name === 'thunderstorm') {
            logger.debug(`⛈️ ITEMS: Thunderstorm item auto-triggered by ${user.username}`);

            if (soundFxService) {
                soundFxService.queue101Soundboard(
                    userId,
                    user.username,
                    'https://www.101soundboards.com/sounds/74377-thunderstorm',
                    { streamId }
                ).then(() => {
                    logger.debug(`🔊 ITEMS: Thunderstorm sound effect queued`);
                }).catch(error => {
                    logger.error('❌ ITEMS: Failed to play thunderstorm sound:', error);
                });
            }

            setTimeout(() => {
                if (canvasFxService) {
                    canvasFxService.triggerItemEffect(
                        userId,
                        usageResult.item.id,
                        streamId,
                        {
                            position: { x: 0.5, y: 0.5 } // Center of screen
                        }
                    ).then(() => {
                        logger.debug(`⛈️ ITEMS: Thunderstorm visual effect triggered (after 2 second delay)`);
                    }).catch(error => {
                        logger.error('❌ ITEMS: Failed to trigger thunderstorm visual:', error);
                    });
                }
            }, 2000); // 2 second delay to sync with sound

            await sendSystemMessage(`⛈️ ${user.username} summoned a thunderstorm!`, '🤖 StreamBot');
        }

        // Get interaction config for response
        const interactionConfig = canvasFxService ? canvasFxService.getInteractionConfig(item) : null;

        return {
            ok: true,
            body: {
                success: true,
                item: usageResult.item,
                remainingQuantity: usageResult.remainingQuantity,
                interactionMode: 'auto-trigger',
                interactionConfig,
                message: 'Auto-trigger item activated'
            }
        };
    }
}

module.exports = AutoTriggerHandler;
