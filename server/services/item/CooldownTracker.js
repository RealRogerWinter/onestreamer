/**
 * CooldownTracker.js - per-user item cooldown + usage logging extracted from
 * ItemService.
 *
 * Owns validateItemUsage, applyItemCooldown, the active-cooldown query, the
 * global/per-user resets, and item usage stats. Talks directly to the DB
 * primitives (runAsync/getAsync/allAsync) captured at module-require time —
 * exactly as the legacy in-service form did. Item lookups route back through
 * owner.getItemById so spies/overrides on the service still fire.
 * Only `this.`→`owner.`.
 */

const { runAsync, getAsync, allAsync } = require('../../database/database');
const logger = require('../../bootstrap/logger').child({ svc: 'ItemService' });

class CooldownTracker {
    constructor(owner) {
        this.owner = owner;
    }

    async validateItemUsage(userId, itemId) {
        const owner = this.owner;
        logger.debug(`🔍 ITEMSERVICE: Validating item usage for user ${userId}, item ${itemId}`);

        const item = await owner.getItemById(itemId);
        if (!item) {
            logger.debug(`❌ ITEMSERVICE: Item ${itemId} not found`);
            return { valid: false, error: 'Item not found' };
        }

        logger.debug(`🔍 ITEMSERVICE: Item ${item.name} has cooldown of ${item.cooldown_seconds}s`);

        if (item.cooldown_seconds > 0) {
            const lastUsage = await getAsync(
                `SELECT * FROM item_usage_log
                 WHERE user_id = ? AND item_id = ?
                 ORDER BY used_at DESC LIMIT 1`,
                [userId, itemId]
            );

            logger.debug(`🔍 ITEMSERVICE: Last usage for user ${userId}, item ${itemId}:`, lastUsage);

            if (lastUsage) {
                const cooldownEnd = new Date(lastUsage.used_at + 'Z').getTime() + (item.cooldown_seconds * 1000);
                const now = Date.now();

                logger.debug(`🔍 ITEMSERVICE: Cooldown check - now: ${now}, cooldownEnd: ${cooldownEnd}, remaining: ${cooldownEnd - now}ms`);

                if (now < cooldownEnd) {
                    const remainingSeconds = Math.ceil((cooldownEnd - now) / 1000);
                    logger.debug(`❌ ITEMSERVICE: Item on cooldown for ${remainingSeconds}s`);
                    return {
                        valid: false,
                        error: 'Item on cooldown',
                        cooldownRemaining: remainingSeconds
                    };
                }
            } else {
                logger.debug(`✅ ITEMSERVICE: No previous usage found - item can be used`);
            }
        }

        logger.debug(`✅ ITEMSERVICE: Item usage validation passed`);
        return { valid: true };
    }

    async applyItemCooldown(userId, itemId, streamId = null) {
        await runAsync(
            'INSERT INTO item_usage_log (user_id, item_id, stream_id) VALUES (?, ?, ?)',
            [userId, itemId, streamId]
        );
    }

    async getItemCooldowns(userId) {
        const cooldowns = await allAsync(
            `SELECT
                iul.item_id,
                iul.used_at,
                i.name,
                i.display_name,
                i.emoji,
                i.cooldown_seconds
             FROM item_usage_log iul
             JOIN items i ON iul.item_id = i.id
             WHERE iul.user_id = ?
               AND datetime(iul.used_at, '+' || i.cooldown_seconds || ' seconds') > datetime('now')
             ORDER BY iul.used_at DESC`,
            [userId]
        );

        return cooldowns.map(cd => {
            const cooldownEnd = new Date(cd.used_at + 'Z').getTime() + (cd.cooldown_seconds * 1000);
            const remainingSeconds = Math.max(0, Math.ceil((cooldownEnd - Date.now()) / 1000));

            return {
                itemId: cd.item_id,
                name: cd.name,
                displayName: cd.display_name,
                emoji: cd.emoji,
                cooldownRemaining: remainingSeconds,
                cooldownEnd: cooldownEnd
            };
        });
    }

    async resetAllItemCooldowns() {
        try {
            logger.debug(`🔄 ITEMSERVICE: Resetting all item cooldowns - checking current state...`);

            // First, check what's in the table before deletion
            const beforeCount = await getAsync('SELECT COUNT(*) as count FROM item_usage_log');
            logger.debug(`🔄 ITEMSERVICE: Found ${beforeCount.count} records in item_usage_log before reset`);

            // Show some sample records
            const sampleRecords = await allAsync('SELECT user_id, item_id, used_at FROM item_usage_log ORDER BY used_at DESC LIMIT 5');
            logger.debug(`🔄 ITEMSERVICE: Sample records before reset:`, sampleRecords);

            const result = await runAsync('DELETE FROM item_usage_log');
            const count = result.changes || 0;
            logger.debug(`🔄 ITEMSERVICE: Reset ${count} item usage cooldowns`);

            // Verify deletion
            const afterCount = await getAsync('SELECT COUNT(*) as count FROM item_usage_log');
            logger.debug(`🔄 ITEMSERVICE: Records remaining after reset: ${afterCount.count}`);

            return count;
        } catch (error) {
            logger.error('❌ ITEMSERVICE: Failed to reset item cooldowns:', error);
            throw error;
        }
    }

    async resetUserItemCooldowns(userId) {
        try {
            const result = await runAsync('DELETE FROM item_usage_log WHERE user_id = ?', [userId]);
            const count = result.changes || 0;
            logger.debug(`🔄 ITEMSERVICE: Reset ${count} item usage cooldowns for user ${userId}`);
            return count;
        } catch (error) {
            logger.error(`❌ ITEMSERVICE: Failed to reset item cooldowns for user ${userId}:`, error);
            throw error;
        }
    }

    async getItemStats() {
        const stats = await allAsync(
            `SELECT
                i.id,
                i.name,
                i.display_name,
                i.emoji,
                i.rarity,
                COUNT(DISTINCT iul.user_id) as unique_users,
                COUNT(iul.id) as total_uses,
                MAX(iul.used_at) as last_used
             FROM items i
             LEFT JOIN item_usage_log iul ON i.id = iul.item_id
             GROUP BY i.id
             ORDER BY total_uses DESC`
        );

        return stats;
    }
}

module.exports = CooldownTracker;
