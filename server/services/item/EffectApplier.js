/**
 * EffectApplier.js - buff/debuff + cooldown-modifier item application extracted
 * from ItemService.
 *
 * Owns the type predicates (isBuffOrDebuffItem / isCooldownModifierItem) and
 * the apply paths that delegate to the injected BuffDebuffService /
 * TakeoverService. Internal cross-calls (validateItemUsage, getItemById,
 * applyItemCooldown, isCooldownModifierItem) route through `owner.` so that
 * spies/overrides on the service instance still fire. Only `this.`→`owner.`.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'ItemService' });

class EffectApplier {
    constructor(owner) {
        this.owner = owner;
    }

    // Apply buff/debuff item (requires BuffDebuffService to be injected)
    async applyBuffDebuffItem(userId, itemId, appliedByUserId, buffDebuffService, skipCooldownValidation = false, streamId = null) {
        const owner = this.owner;
        logger.debug(`📦 ITEM: applyBuffDebuffItem called with userId: ${userId}, itemId: ${itemId}, appliedByUserId: ${appliedByUserId}, streamId: ${streamId}`);

        try {
            // Validate item usage (cooldown, ownership, etc.) unless skipped
            if (!skipCooldownValidation) {
                const validationResult = await owner.validateItemUsage(userId, itemId);
                if (!validationResult.valid) {
                    throw new Error(validationResult.error);
                }
            }

            // Get item details
            const item = await owner.getItemById(itemId);
            if (!item) {
                throw new Error('Item not found');
            }

            logger.debug(`📦 ITEM: Found item - name: ${item.name}, display_name: ${item.display_name}, type: ${item.item_type}, duration: ${item.duration_seconds}`);

            if (!['buff', 'debuff'].includes(item.item_type)) {
                throw new Error('Item is not a buff or debuff');
            }

            // Apply the buff/debuff
            // Don't skip broadcasts completely for viewbots - we need streamer updates
            const skipBroadcasts = false;

            logger.debug(`📦 ITEM: Calling buffDebuffService.applyBuff with params:`, {
                userId,
                itemId,
                appliedByUserId,
                duration: item.duration_seconds,
                hasEffectData: !!item.effect_data,
                skipBroadcasts,
                streamId
            });

            const buffResult = await buffDebuffService.applyBuff(
                userId,
                itemId,
                appliedByUserId,
                item.duration_seconds,
                item.effect_data ? JSON.parse(item.effect_data) : null,
                skipBroadcasts,
                streamId
            );

            // Log the usage only if we're handling cooldown ourselves
            if (!skipCooldownValidation) {
                await owner.applyItemCooldown(userId, itemId);
            }

            logger.debug(`✅ ITEM: Applied ${item.item_type} "${item.display_name}" to user ${userId}`);
            return buffResult;

        } catch (error) {
            logger.error(`❌ ITEM: Error applying buff/debuff item ${itemId} to user ${userId}:`, error);
            throw error;
        }
    }

    // Check if item is a buff or debuff
    isBuffOrDebuffItem(item) {
        return item && ['buff', 'debuff'].includes(item.item_type);
    }

    // Check if item affects cooldowns
    isCooldownModifierItem(item) {
        return item && ['guard', 'weapon'].includes(item.item_type);
    }

    // Apply cooldown modifier item (requires TakeoverService to be injected)
    async applyCooldownModifierItem(userId, itemId, appliedByUserId, takeoverService, skipCooldownValidation = false) {
        const owner = this.owner;
        try {
            // Validate item usage (cooldown, ownership, etc.) unless skipped
            if (!skipCooldownValidation) {
                const validationResult = await owner.validateItemUsage(userId, itemId);
                if (!validationResult.valid) {
                    throw new Error(validationResult.error);
                }
            }

            // Get item details
            const item = await owner.getItemById(itemId);
            if (!item) {
                throw new Error('Item not found');
            }

            if (!owner.isCooldownModifierItem(item)) {
                throw new Error('Item is not a cooldown modifier');
            }

            // Parse effect data
            const effectData = item.effect_data ? JSON.parse(item.effect_data) : {};
            let result = { success: true, effects: [] };

            logger.debug(`🔧 ITEM: Applying cooldown modifier "${item.display_name}" for user ${userId}`);
            logger.debug(`🔧 ITEM: Effect data:`, effectData);

            // Apply global cooldown modifications
            if (effectData.global_cooldown_increase) {
                const success = await takeoverService.modifyGlobalCooldown(
                    effectData.global_cooldown_increase,
                    `${item.name}_guard`
                );
                if (success) {
                    result.effects.push({
                        type: 'global_cooldown_increase',
                        amount: effectData.global_cooldown_increase,
                        message: `Global cooldown increased by ${effectData.global_cooldown_increase} seconds`
                    });
                }
            }

            if (effectData.global_cooldown_decrease) {
                const success = await takeoverService.modifyGlobalCooldown(
                    -effectData.global_cooldown_decrease,
                    `${item.name}_attack`
                );
                if (success) {
                    result.effects.push({
                        type: 'global_cooldown_decrease',
                        amount: effectData.global_cooldown_decrease,
                        message: `Global cooldown decreased by ${effectData.global_cooldown_decrease} seconds`
                    });
                }
            }

            // Apply individual cooldown modifications
            if (effectData.reset_individual_cooldowns) {
                const count = await takeoverService.resetAllIndividualCooldowns(item.name);
                result.effects.push({
                    type: 'reset_individual_cooldowns',
                    count: count,
                    message: `Reset ${count} individual cooldowns`
                });
            }

            if (effectData.freeze_individual_cooldowns && item.duration_seconds) {
                const count = await takeoverService.freezeIndividualCooldowns(
                    item.duration_seconds,
                    item.name
                );
                result.effects.push({
                    type: 'freeze_individual_cooldowns',
                    duration: item.duration_seconds,
                    count: count,
                    message: `Froze ${count} individual cooldowns for ${item.duration_seconds} seconds`
                });
            }

            // Log the usage only if we're handling cooldown ourselves
            if (!skipCooldownValidation) {
                await owner.applyItemCooldown(userId, itemId);
            }

            logger.debug(`✅ ITEM: Applied cooldown modifier "${item.display_name}" with effects:`, result.effects);
            return result;

        } catch (error) {
            logger.error(`❌ ITEM: Error applying cooldown modifier item ${itemId} for user ${userId}:`, error);
            throw error;
        }
    }

    // Get current global cooldown info (requires TakeoverService)
    async getGlobalCooldownInfo(takeoverService) {
        try {
            logger.debug(`🔧 ITEMSERVICE: Getting global cooldown info...`);
            logger.debug(`🔧 ITEMSERVICE: takeoverService.lastStreamStartTime: ${takeoverService.lastStreamStartTime}`);
            logger.debug(`🔧 ITEMSERVICE: takeoverService.globalCooldownSeconds: ${takeoverService.globalCooldownSeconds}`);

            const remaining = await takeoverService.getGlobalCooldownRemaining();
            const result = {
                remainingSeconds: remaining,
                totalSeconds: takeoverService.globalCooldownSeconds,
                isActive: remaining > 0
            };

            logger.debug(`🔧 ITEMSERVICE: Global cooldown info result:`, result);
            return result;
        } catch (error) {
            logger.error('Error getting global cooldown info:', error);
            return { remainingSeconds: 0, totalSeconds: 30, isActive: false };
        }
    }
}

module.exports = EffectApplier;
