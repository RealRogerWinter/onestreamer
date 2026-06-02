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

    // Live remaining seconds for an in-memory buff. Unlike DB buffs (whose
    // remaining_seconds is decremented each second by the streaming-gated
    // updateBuffDurations monitor — which never sees this cache), anonymous
    // buffs belong to sessionless relay/viewbot streamers that run continuously,
    // so we decay them by wall-clock time since applied_at. This is what makes
    // the Status-Effects countdown tick down instead of freezing at full.
    _remainingSeconds(buff) {
        const appliedMs = Date.parse(buff.applied_at);
        if (Number.isNaN(appliedMs)) return Number(buff.remaining_seconds) || 0;
        const elapsed = Math.floor((Date.now() - appliedMs) / 1000);
        return Math.max(0, (Number(buff.duration_seconds) || 0) - elapsed);
    }

    // Expire (remove + emit buff-expired) every anonymous buff whose wall-clock
    // duration has elapsed. Without this the buff would persist forever and
    // keep re-applying its effect to every new/reloading viewer ("not
    // resetting"). Mirrors removeBuff('expired') for DB buffs. Called on read.
    _expireElapsed() {
        const owner = this.owner;
        const expiredIds = [];
        for (const buffs of owner.anonymousBuffsCache.values()) {
            for (const buff of buffs) {
                if (buff.is_active && this._remainingSeconds(buff) <= 0) {
                    expiredIds.push(buff.id);
                }
            }
        }
        for (const id of expiredIds) {
            this.removeBuff(id, 'expired');
        }
        // Drop now-empty user entries so rotated-away relay/viewbot streams
        // don't leave empty arrays accumulating in the cache.
        for (const [userId, buffs] of owner.anonymousBuffsCache.entries()) {
            if (buffs.length === 0) owner.anonymousBuffsCache.delete(userId);
        }
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
            this._remainingSeconds(buff) > 0
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
        // Drop any anonymous buffs whose wall-clock duration has elapsed first.
        this._expireElapsed();
        const anonymousBuffs = owner.anonymousBuffsCache.get(userId) || [];
        // Enrich with item details + refresh remaining_seconds to the live value
        // so the client shows an accurate, ticking countdown.
        const enrichedBuffs = await Promise.all(anonymousBuffs
            .filter(buff => buff.is_active && this._remainingSeconds(buff) > 0)
            .map(async (buff) => {
                buff.remaining_seconds = this._remainingSeconds(buff);
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
