/**
 * Shared context for the admin-recordings sub-route modules.
 *
 * This module owns the singletons and helpers that the original
 * server/routes/admin-recordings.js instantiated at module scope, so the
 * extracted sub-routers can read them verbatim. The four runtime services
 * are injected once via setServices() (called from server/index.js through
 * the parent router) and exposed through a single mutable `services` holder
 * so every sub-router observes the same wiring.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'admin-recordings' });

const { runAsync, getAsync, allAsync } = require('../../database/database');
const ContinuousRecordingRepository = require('../../database/repository/ContinuousRecordingRepository');
const SessionChatMessageRepository = require('../../database/repository/SessionChatMessageRepository');
const AdminReviewSettingsRepository = require('../../database/repository/AdminReviewSettingsRepository');
const b2Storage = require('../../services/B2StorageService');

// PR 10.1 (Phase 10): module-scoped repositories own the single-table
// SQL surface for the recording/settings/chat tables this route hits.
// The cross-domain reads (`url_streams`, `streaming_logs`) and the
// `session_chat_messages ⋈ recording_sessions` JOIN below intentionally
// stay inline — single-domain repos don't reach across tables, per the
// convention set in PR 6.3.
const recordingRepository = new ContinuousRecordingRepository({ getAsync, runAsync, allAsync });
const sessionChatMessageRepository = new SessionChatMessageRepository({ getAsync, runAsync, allAsync });
const adminReviewSettingsRepository = new AdminReviewSettingsRepository({ getAsync, runAsync, allAsync });

/**
 * Extract username from a streaming platform URL
 * @param {string} sourceUrl - The source URL (e.g., https://twitch.tv/xqc)
 * @returns {string|null} The extracted username or null if not found
 */
function extractUsernameFromUrl(sourceUrl) {
    if (!sourceUrl) return null;

    try {
        // Handle Twitch URLs
        const twitchMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i);
        if (twitchMatch) return twitchMatch[1];

        // Handle Kick URLs
        const kickMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)/i);
        if (kickMatch) return kickMatch[1];

        // Handle YouTube URLs
        const youtubeMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9_-]+)/i);
        if (youtubeMatch) return youtubeMatch[1];

        // For AWS IVS URLs (Kick backend), can't extract username
        if (sourceUrl.includes('live-video.net') || sourceUrl.includes('playback.')) {
            return null;
        }

        // Generic fallback: try to get the last path segment
        try {
            const url = new URL(sourceUrl);
            const pathParts = url.pathname.split('/').filter(Boolean);
            if (pathParts.length > 0) {
                const lastPart = pathParts[pathParts.length - 1];
                if (/^[a-zA-Z0-9_-]+$/.test(lastPart) && !lastPart.includes('.')) {
                    return lastPart;
                }
            }
        } catch (e) {
            // URL parsing failed
        }

        return null;
    } catch (error) {
        return null;
    }
}

// Runtime services set by the server when mounting the routes
// (server/index.js → parent router setServices → here). The single holder is
// shared by every sub-router so they all read the same instances.
const services = {
    uploadScheduler: null,
    cleanupScheduler: null,
    chatCaptureService: null,
    clipService: null,
};

function setServices(injected) {
    services.uploadScheduler = injected.uploadScheduler;
    services.cleanupScheduler = injected.cleanupScheduler;
    services.chatCaptureService = injected.chatCaptureService;
    services.clipService = injected.clipService;
}

module.exports = {
    logger,
    allAsync,
    getAsync,
    recordingRepository,
    sessionChatMessageRepository,
    adminReviewSettingsRepository,
    b2Storage,
    extractUsernameFromUrl,
    services,
    setServices,
};
