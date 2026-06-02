/**
 * resolveCurrentStreamerUserId — shared current-streamer → userId resolution.
 *
 * Extracted verbatim from the duplicated blocks in
 * server/services/itemUse/BuffDebuffHandler.js and
 * server/services/ThrowingService.js (both resolved the streamer-target
 * userId the same way). Centralising keeps the resolution order + fallbacks
 * in one place.
 *
 * Resolution order (unchanged):
 *   1. streamService.getCurrentStreamer()                    — primary
 *   2. webrtcService.getCurrentStreamer()                    — LiveKit fallback
 *   3. sessionService.getSessionBySocketId(socketId).userId  — socket → userId
 *
 * Returns the streamer's userId (including negative/synthetic IDs for
 * anonymous/viewbot streamers), or null when no streamer/session is found.
 * Any service may be absent; missing services short-circuit to null exactly
 * as the original inline code did.
 *
 * @param {object}   deps
 * @param {object}   deps.streamService    must expose getCurrentStreamer()
 * @param {object}  [deps.webrtcService]   optional LiveKit fallback, getCurrentStreamer()
 * @param {object}  [deps.sessionService]  must expose getSessionBySocketId(socketId)
 * @param {object}  [deps.logger]          optional logger for debug parity with the originals
 * @returns {number|null} targetUserId or null
 */
function resolveCurrentStreamerUserId({ streamService, webrtcService, sessionService, logger } = {}) {
    // Get the current streamer to determine target
    // Try StreamService first (the synced source of truth)
    let currentStreamerSocketId = streamService ? streamService.getCurrentStreamer() : null;

    // Fallback to the LiveKit WebRTC service if StreamService has no streamer.
    // This handles the case where LiveKitService tracks currentStreamer but
    // StreamService might not be synced yet.
    if (!currentStreamerSocketId && webrtcService) {
        currentStreamerSocketId = webrtcService.getCurrentStreamer();
        if (currentStreamerSocketId && logger) {
            logger.debug(`🎭 ITEMS: Using LiveKit WebRTC fallback for streamer: ${currentStreamerSocketId}`);
        }
    }

    let targetUserId = null;

    if (currentStreamerSocketId && sessionService) {
        const session = sessionService.getSessionBySocketId(currentStreamerSocketId);
        if (session && session.userId) {
            // Accept any user ID, including negative IDs for anonymous/viewbot users
            targetUserId = session.userId;
            if (logger) {
                if (targetUserId < 0) {
                    logger.debug(`🎭 ITEMS: Found anonymous/viewbot streamer with synthetic ID: ${targetUserId}`);
                } else {
                    logger.debug(`🎭 ITEMS: Found current streamer userId: ${targetUserId}`);
                }
            }
        } else if (logger) {
            logger.debug(`🎭 ITEMS: No session found for current streamer ${currentStreamerSocketId}`);
        }
    } else if (logger) {
        logger.debug(`🎭 ITEMS: No current streamer or session service unavailable`);
    }

    return targetUserId;
}

module.exports = resolveCurrentStreamerUserId;
