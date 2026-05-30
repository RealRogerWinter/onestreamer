const logger = require('../../bootstrap/logger').child({ svc: 'BuffDebuffService' });

/**
 * Owns the anonymous / viewbot (negative-userId) in-memory buff branches that
 * were scattered as `if (userId < 0)` / `if (buffId.startsWith('anon_'))` arms
 * across BuffDebuffService. All state stays on the service: this collaborator
 * reads/writes owner.anonymousBuffsCache and reads owner.itemRepository via the
 * `owner` back-reference. Bodies are verbatim from the former inline arms with
 * `this.` rewritten to `owner.`; the service's public methods keep their
 * regular-user path and delegate the anonymous arm here.
 */
class AnonymousBuffStore {
    constructor(owner) {
        this.owner = owner;
    }

    isAnonymousUser(userId) {
        return userId < 0;
    }

    isAnonymousBuffId(buffId) {
        return typeof buffId === 'string' && buffId.startsWith('anon_');
    }

    // createNewBuff anonymous arm
    createNewBuff(userId, itemId, appliedByUserId, buffType, duration, metadata) {
        const owner = this.owner;
        logger.debug(`🎭 BUFF: Creating in-memory buff for anonymous user ${userId}`);

        // Create a synthetic buff ID for anonymous users
        const buffId = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store in anonymous cache
        const anonymousBuff = {
            id: buffId,
            user_id: userId,
            item_id: itemId,
            applied_by_user_id: appliedByUserId,
            buff_type: buffType,
            duration_seconds: duration,
            remaining_seconds: duration,
            applied_at: new Date().toISOString(),
            is_active: true,
            metadata: metadata
        };

        // Add to anonymous cache
        if (!owner.anonymousBuffsCache.has(userId)) {
            owner.anonymousBuffsCache.set(userId, []);
        }
        owner.anonymousBuffsCache.get(userId).push(anonymousBuff);

        logger.debug(`🎭 BUFF: Successfully created anonymous buff with ID: ${buffId}`);
        return buffId;
    }

    // updateBuffDuration anonymous arm
    updateBuffDuration(buffId, newRemainingSeconds) {
        const owner = this.owner;
        // Update anonymous buff in cache
        for (const [userId, buffs] of owner.anonymousBuffsCache.entries()) {
            const buff = buffs.find(b => b.id === buffId);
            if (buff) {
                buff.remaining_seconds = newRemainingSeconds;
                buff.last_updated = new Date().toISOString();
                return;
            }
        }
    }

    // getActiveBuffByItemForUser anonymous arm
    getActiveBuffByItemForUser(userId, itemId) {
        const owner = this.owner;
        const anonymousBuffs = owner.anonymousBuffsCache.get(userId) || [];
        return anonymousBuffs.find(buff =>
            buff.item_id === itemId &&
            buff.is_active &&
            buff.remaining_seconds > 0
        ) || null;
    }

    // getBuffById anonymous arm
    async getBuffById(buffId) {
        const owner = this.owner;
        // Search for anonymous buff in cache
        for (const [userId, buffs] of owner.anonymousBuffsCache.entries()) {
            const buff = buffs.find(b => b.id === buffId);
            if (buff) {
                // Get item details to enrich the buff data
                const item = await owner.itemRepository.getByIdIncludingInactive(buff.item_id);
                if (item) {
                    buff.item_name = item.name;
                    buff.display_name = item.display_name;
                    buff.emoji = item.emoji;
                    buff.effect_data = item.effect_data;
                }
                return buff;
            }
        }
        return null;
    }

    // getActiveBuffsForUser anonymous arm
    async getActiveBuffsForUser(userId) {
        const owner = this.owner;
        const anonymousBuffs = owner.anonymousBuffsCache.get(userId) || [];
        // Enrich with item details
        const enrichedBuffs = await Promise.all(anonymousBuffs
            .filter(buff => buff.is_active && buff.remaining_seconds > 0)
            .map(async (buff) => {
                const item = await owner.itemRepository.getByIdIncludingInactive(buff.item_id);
                if (item) {
                    buff.item_name = item.name;
                    buff.display_name = item.display_name;
                    buff.emoji = item.emoji;
                    buff.effect_data = item.effect_data;
                }
                return buff;
            }));
        return enrichedBuffs.map(buff => owner.formatBuffForClient(buff));
    }

    // removeBuff anonymous arm
    removeBuff(buffId, reason = 'manual') {
        const owner = this.owner;
        // Remove anonymous buff from cache
        for (const [userId, buffs] of owner.anonymousBuffsCache.entries()) {
            const buffIndex = buffs.findIndex(b => b.id === buffId);
            if (buffIndex !== -1) {
                const buff = buffs[buffIndex];
                buff.is_active = false;
                buff.remaining_seconds = 0;
                buffs.splice(buffIndex, 1);

                // Emit expiry event for anonymous buff
                owner.emit('buff-expired', { ...buff, reason });

                // Send real-time update for anonymous users
                if (owner.io) {
                    owner.io.emit('buff-expired', {
                        buffId: buffId,
                        userId: buff.user_id,
                        reason: reason
                    });
                }

                return true;
            }
        }
        return false;
    }
}

module.exports = AnonymousBuffStore;
