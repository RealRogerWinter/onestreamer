const logger = require('../../bootstrap/logger').child({ svc: 'BuffDebuffService' });

/**
 * Owns the periodic active-buffs-cache sweep extracted from BuffDebuffService.
 * Reads/writes service state (activeBuffsCache, cacheTTL, cacheMaxSize, and the
 * cacheCleanupInterval handle) via `owner` — all state stays on the service.
 * Body is verbatim from the former BuffDebuffService.startCacheCleanup with
 * `this.` rewritten to `owner.`.
 */
class CacheCleaner {
    constructor(owner) {
        this.owner = owner;
    }

    // Periodic cache cleanup to prevent memory leaks
    startCacheCleanup() {
        const owner = this.owner;
        owner.cacheCleanupInterval = setInterval(() => {
            const now = Date.now();
            const entriesToDelete = [];

            // Remove stale entries
            for (const [key, value] of owner.activeBuffsCache.entries()) {
                if (value.timestamp && (now - value.timestamp) > owner.cacheTTL) {
                    entriesToDelete.push(key);
                }
            }

            // Delete stale entries
            entriesToDelete.forEach(key => owner.activeBuffsCache.delete(key));

            // Enforce max size by removing oldest entries
            if (owner.activeBuffsCache.size > owner.cacheMaxSize) {
                const sortedEntries = Array.from(owner.activeBuffsCache.entries())
                    .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));

                const toRemove = sortedEntries.slice(0, owner.activeBuffsCache.size - owner.cacheMaxSize);
                toRemove.forEach(([key]) => owner.activeBuffsCache.delete(key));
            }

            if (entriesToDelete.length > 0) {
                logger.debug(`🧹 BUFF: Cleaned ${entriesToDelete.length} stale cache entries`);
            }
        }, 60000); // Run every minute
    }
}

module.exports = CacheCleaner;
