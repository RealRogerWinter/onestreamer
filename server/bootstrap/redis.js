/**
 * Redis client initializer.
 *
 * Extracted from `server/index.js` as part of Phase 15B.2.b. The pre-PR
 * shape mutated a module-scope `let redisClient` in `index.js`; the
 * post-PR shape returns the connected client (or `null` when the env var
 * is absent / connection fails) so the caller does the assignment. This
 * is a small signature change — the only caller is `startServer()` —
 * but it isolates the Redis bootstrapping concern in one file and
 * unblocks future Redis-aware modules from re-using the same connect
 * recipe.
 *
 * Behaviour preserved end-to-end:
 *   - `process.env.REDIS_URL` absent       → returns `null`, no warning
 *   - `process.env.REDIS_URL` set + connect ok → returns the client
 *   - `process.env.REDIS_URL` set + connect throws → logs warn, returns
 *     `null` (in-memory storage path)
 */

const { createClient } = require('redis');

const logger = require('./logger').child({ svc: 'bootstrap.redis' });

async function initializeRedis() {
    if (!process.env.REDIS_URL) {
        logger.info('No Redis URL provided, using in-memory storage');
        return null;
    }
    const client = createClient({ url: process.env.REDIS_URL });
    try {
        await client.connect();
        logger.info('Connected to Redis');
        return client;
    } catch (error) {
        logger.warn({ err: error }, 'Redis connection failed, using in-memory storage');
        return null;
    }
}

module.exports = { initializeRedis };
