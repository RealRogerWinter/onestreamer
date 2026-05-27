/**
 * Viewbot username cache + per-stream username generator.
 *
 * Extracted from `server/index.js` as part of Phase 15B.2.b. The pre-PR
 * shape had three module-scope state holders (`VIEWBOT_ANIMALS` array,
 * `viewbotUsernameCache` Map, `viewbotSocketIds` Set) and two helpers
 * (`cleanupViewbotUsername`, `generateViewbotUsername`) sharing the
 * state via closure. The post-PR shape is a factory that returns an
 * object exposing both the helpers AND the underlying caches — the
 * caches are still consumed externally by:
 *
 *   - `server/index.js` itself (passes them into `getStreamerDisplayName`,
 *     into `enrichStreamStatus`, and into socket-handler deps bags)
 *   - `server/routes/internal.js` (via `req.app.locals.viewbot{Username
 *     Cache,SocketIds}`, set at module-load time in index.js)
 *
 * Externally-mutated state stays accessible as `.cache` / `.socketIds`
 * on the returned object so existing callers don't need to change shape.
 * The animals array is module-private (only used internally by
 * `generate`); the chat-service-side copy at `chat-service/index.js`
 * is intentionally kept separate (different module boundary; matching
 * lists is the operator's call, not load-bearing here).
 */

const logger = require('../../bootstrap/logger').child({ svc: 'UsernameCache' });

const VIEWBOT_ANIMALS = [
    'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
    'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
    'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
    'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
    'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary',
];

function createUsernameCache() {
    const cache = new Map();
    const socketIds = new Set();

    const cleanup = (streamerId) => {
        if (cache.has(streamerId)) {
            const username = cache.get(streamerId);
            cache.delete(streamerId);
            logger.info(`🧹 VIEWBOT: Cleaned up username "${username}" for viewbot stream ${streamerId}`);
        }
        if (socketIds.has(streamerId)) {
            socketIds.delete(streamerId);
            logger.info(`🧹 VIEWBOT: Removed socket ID ${streamerId} from ViewBot tracking`);
        }
    };

    const generate = (streamerId) => {
        if (cache.has(streamerId)) {
            const cachedUsername = cache.get(streamerId);
            logger.info(`🤖 VIEWBOT: Using cached username "${cachedUsername}" for viewbot stream ${streamerId}`);
            return cachedUsername;
        }

        const animal = VIEWBOT_ANIMALS[Math.floor(Math.random() * VIEWBOT_ANIMALS.length)];
        const number = Math.floor(Math.random() * 9999) + 1;
        const username = `${animal}${number}`;

        cache.set(streamerId, username);

        const isSocketTracked = socketIds.has(streamerId);
        logger.info(`🤖 VIEWBOT: Generated fresh username "${username}" for ${isSocketTracked ? 'ViewBot socket' : 'viewbot stream'} ${streamerId}`);

        return username;
    };

    return { cache, socketIds, cleanup, generate };
}

module.exports = { createUsernameCache };
