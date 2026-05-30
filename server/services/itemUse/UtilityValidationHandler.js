const logger = require('../../bootstrap/logger').child({ svc: 'ItemUseService' });

// server/services/itemUse/UtilityValidationHandler.js
//
// Shared validate-only path for TTS / soundboard / summon-bot items — three
// near-identical branches that defer consumption to a follow-up request once
// the client gathers user input. Extracted verbatim from ItemUseService.

class UtilityValidationHandler {
    constructor(owner) {
        this.owner = owner;
    }

    /**
     * `opts` controls the small per-type differences:
     *   - `mode` log label (e.g. 'tts')
     *   - `flag` extra response flag (e.g. 'ttsMode')
     *   - `message` response.message string
     *   - `includeCooldownRemaining` summon-bot returns `cooldownRemaining`
     *     in the 429 body; tts / soundboard do not. (Matches the original
     *     handler exactly.)
     */
    async _applyUtilityValidation(ctx, opts) {
        const { userId, itemId, item, services } = ctx;
        const { inventoryService, itemService } = services;

        logger.debug(`🎯 ITEMS: Taking ${opts.mode} path for ${item.display_name}`);

        const inventoryItem = await inventoryService.getInventoryItem(userId, itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return { ok: false, kind: 'not-in-inventory' };
        }

        // Validate item usage (cooldown check)
        const validation = await itemService.validateItemUsage(userId, itemId);
        if (!validation.valid) {
            const result = {
                ok: false,
                kind: 'validation-failed',
                error: validation.error || 'Cannot use item'
            };
            if (opts.includeCooldownRemaining) {
                result.cooldownRemaining = validation.cooldownRemaining;
            }
            return result;
        }

        // Special-case for summon_bot: log line matches the original handler
        if (opts.mode === 'summon-bot') {
            // Already covered by the top-of-method log; nothing more to add.
        }

        const body = {
            success: true,
            item: {
                id: item.id,
                name: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: item.item_type
                // Don't include cooldown - it should only be applied when item is actually used
            },
            remainingQuantity: inventoryItem.quantity,
            [opts.flag]: true,
            message: opts.message
        };

        return { ok: true, body };
    }
}

module.exports = UtilityValidationHandler;
