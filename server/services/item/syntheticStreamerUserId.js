/**
 * syntheticStreamerUserId — derive a stable, negative "userId" for a sessionless
 * streamer socket id.
 *
 * URL-relay (`url-stream-…`) and viewbot (`viewbot-…`) streams are not real
 * browser sockets, so they have no SessionService entry and no real `users.id`.
 * Viewbots already work around this: the takeover path mints a synthetic
 * NEGATIVE userId (a hash of the socket id) via `linkUserToSocket`, and the buff
 * system routes negative ids to the in-memory `AnonymousBuffStore`, sidestepping
 * the `active_buffs.user_id → users(id)` foreign key.
 *
 * A URL-relay stream registers no such id at all, so streamer-targeted item
 * effects (buffs/debuffs, throw-attribution) had no target to resolve and bailed.
 * This helper gives those sessionless streamers the same kind of stable negative
 * id on demand — deterministically derived from the streamer id, so the same
 * relay stream always maps to the same id within its lifetime — without needing
 * any session/lifecycle bookkeeping.
 *
 * Returns a negative integer for `url-stream-…` / `viewbot-…` ids, or null for
 * anything else (real sockets resolve a real userId through SessionService and
 * must NOT be given a synthetic one).
 *
 * @param {string} streamerId  the current-streamer socket id
 * @returns {number|null}
 */
function syntheticStreamerUserId(streamerId) {
    if (typeof streamerId !== 'string') return null;
    if (!streamerId.startsWith('url-stream-') && !streamerId.startsWith('viewbot-')) {
        return null;
    }

    // Same hash the viewbot takeover path uses (server/sockets/streamHandler/
    // takeover.js) so the derivation is consistent across the codebase.
    let hash = 0;
    for (let i = 0; i < streamerId.length; i++) {
        hash = ((hash << 5) - hash) + streamerId.charCodeAt(i);
        hash = hash & hash; // force 32-bit int
    }

    // Guarantee a strictly-negative, non-zero id (AnonymousBuffStore keys off
    // `userId < 0`; -0 would be treated as a real user and hit the FK).
    return -Math.abs(hash) || -1;
}

module.exports = syntheticStreamerUserId;
