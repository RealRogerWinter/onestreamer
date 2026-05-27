/**
 * Admin Recording Review API Routes
 *
 * Provides endpoints for:
 * - Listing and viewing recording sessions
 * - Getting signed URLs for video playback
 * - Getting chat messages for session playback
 * - Creating clips from sessions
 * - Managing retention settings
 */

const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'admin-recordings' });

const router = express.Router();
const { authenticateAdmin } = require('../middleware/auth');
const { runAsync, getAsync, allAsync } = require('../database/database');
const ContinuousRecordingRepository = require('../database/repository/ContinuousRecordingRepository');
const SessionChatMessageRepository = require('../database/repository/SessionChatMessageRepository');
const AdminReviewSettingsRepository = require('../database/repository/AdminReviewSettingsRepository');
const b2Storage = require('../services/B2StorageService');
const path = require('path');
const fs = require('fs');

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

// These will be set by the server when mounting the routes
let uploadScheduler = null;
let cleanupScheduler = null;
let chatCaptureService = null;
let clipService = null;

/**
 * Set service references (called from server/index.js)
 */
router.setServices = function(services) {
    uploadScheduler = services.uploadScheduler;
    cleanupScheduler = services.cleanupScheduler;
    chatCaptureService = services.chatCaptureService;
    clipService = services.clipService;
};

/**
 * GET /admin/review/sessions
 * List all recording sessions with pagination and filtering
 */
router.get('/sessions', authenticateAdmin, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            streamer,
            dateFrom,
            dateTo
        } = req.query;

        const filters = {
            status: status || undefined,
            streamer: streamer || undefined,
            dateFromMs: dateFrom ? new Date(dateFrom).getTime() : undefined,
            dateToMs: dateTo ? new Date(dateTo).getTime() : undefined,
        };

        const countResult = await recordingRepository.countSessionsForAdmin(filters);
        const totalCount = countResult?.count || 0;

        const sessions = await recordingRepository.listSessionsForAdmin({
            ...filters,
            limit: parseInt(limit),
            offset: (parseInt(page) - 1) * parseInt(limit),
        });

        // Format response
        const formattedSessions = sessions.map(s => ({
            sessionId: s.session_id,
            streamerIdentity: s.streamer_identity,
            streamerUsername: s.streamer_username,
            startTime: s.start_time,
            endTime: s.end_time,
            durationMs: s.duration_ms,
            status: s.status,
            segmentCount: s.segment_count,
            chatMessageCount: s.chat_message_count,
            fileSizeBytes: s.file_size_bytes,
            hasB2Upload: !!s.b2_file_id,
            createdAt: s.created_at
        }));

        res.json({
            success: true,
            sessions: formattedSessions,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / parseInt(limit))
            }
        });
    } catch (error) {
        logger.error('Error listing sessions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/sessions/:sessionId
 * Get details for a single recording session
 */
router.get('/sessions/:sessionId', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;

        const session = await recordingRepository.getSessionById(sessionId);

        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        res.json({
            success: true,
            session: {
                sessionId: session.session_id,
                streamerIdentity: session.streamer_identity,
                streamerUsername: session.streamer_username,
                streamerUserId: session.streamer_user_id,
                startTime: session.start_time,
                endTime: session.end_time,
                durationMs: session.duration_ms,
                status: session.status,
                localPath: session.local_path,
                b2FileId: session.b2_file_id,
                b2FileName: session.b2_file_name,
                fileSizeBytes: session.file_size_bytes,
                segmentCount: session.segment_count,
                chatMessageCount: session.chat_message_count,
                metadata: session.metadata_json ? JSON.parse(session.metadata_json) : null,
                createdAt: session.created_at,
                updatedAt: session.updated_at
            }
        });
    } catch (error) {
        logger.error('Error getting session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/sessions/:sessionId/video
 * Get a signed URL for video playback
 */
router.get('/sessions/:sessionId/video', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;

        const session = await recordingRepository.getSessionById(sessionId);

        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        // Check if uploaded to B2
        if (session.b2_file_name && b2Storage.isEnabled()) {
            const result = await b2Storage.getSignedUrl(session.b2_file_name, 14400); // 4 hour expiry

            if (result.success) {
                return res.json({
                    success: true,
                    source: 'b2',
                    url: result.url,
                    expiresAt: result.expiresAt
                });
            }
        }

        // Fall back to local file if available
        if (session.local_path && fs.existsSync(session.local_path)) {
            // Check for any HLS files
            const files = fs.readdirSync(session.local_path);
            const hasHls = files.some(f => f.endsWith('.m3u8') || f.endsWith('.ts'));

            if (hasHls) {
                return res.json({
                    success: true,
                    source: 'local',
                    url: `/admin/review/sessions/${sessionId}/stream`,
                    format: 'hls'
                });
            }
        }

        res.status(404).json({ success: false, error: 'Video file not available' });
    } catch (error) {
        logger.error('Error getting video URL:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/sessions/:sessionId/stream
 * Stream local video file with range support
 */
router.get('/sessions/:sessionId/stream', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { file } = req.query; // Optional: request specific segment file

        const session = await recordingRepository.getSessionById(sessionId);

        if (!session || !session.local_path) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const sessionDir = session.local_path;

        // If requesting a specific segment file
        if (file) {
            const segmentPath = path.join(sessionDir, file);
            if (!fs.existsSync(segmentPath)) {
                return res.status(404).json({ success: false, error: 'Segment not found' });
            }
            const contentType = file.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
            res.setHeader('Content-Type', contentType);
            return fs.createReadStream(segmentPath).pipe(res);
        }

        // Generate and serve master playlist
        const continuousRecordingService = req.app.get('continuousRecordingService');
        if (continuousRecordingService) {
            await continuousRecordingService.generateMasterPlaylist(sessionId);
        }

        const masterPath = path.join(sessionDir, 'master.m3u8');
        if (!fs.existsSync(masterPath)) {
            // Fallback: try to find any playlist
            const files = fs.readdirSync(sessionDir);
            const playlist = files.find(f => f.endsWith('.m3u8'));
            if (playlist) {
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                return fs.createReadStream(path.join(sessionDir, playlist)).pipe(res);
            }
            return res.status(404).json({ success: false, error: 'No playlist found' });
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        fs.createReadStream(masterPath).pipe(res);
    } catch (error) {
        logger.error('Error streaming video:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/sessions/:sessionId/chat
 * Get chat messages for a session
 */
router.get('/sessions/:sessionId/chat', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { fromMs, toMs } = req.query;

        const messages = await sessionChatMessageRepository.listBySession(sessionId, {
            fromMs: fromMs ? parseInt(fromMs) : undefined,
            toMs: toMs ? parseInt(toMs) : undefined,
        });

        res.json({
            success: true,
            sessionId,
            messages: messages.map(m => ({
                id: m.id,
                username: m.username,
                message: m.message,
                color: m.color,
                relative_time_ms: m.relative_time_ms,
                absolute_time_ms: m.absolute_time_ms,
                isSystem: m.is_system === 1,
                isContext: m.relative_time_ms < 0
            })),
            count: messages.length
        });
    } catch (error) {
        logger.error('Error getting session chat:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /admin/review/sessions/:sessionId/clip
 * Create a clip from a recording session
 */
router.post('/sessions/:sessionId/clip', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { startMs, endMs, title, description } = req.body;

        if (!startMs || !endMs) {
            return res.status(400).json({ success: false, error: 'startMs and endMs are required' });
        }

        const session = await recordingRepository.getSessionById(sessionId);

        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        // Calculate absolute times
        const absoluteStartMs = session.start_time + parseInt(startMs);
        const absoluteEndMs = session.start_time + parseInt(endMs);

        // Use ClipService if available
        if (clipService) {
            const result = await clipService.createClipFromRecording({
                startMs: absoluteStartMs,
                endMs: absoluteEndMs,
                title: title || `Clip from ${session.streamer_username || 'stream'}`,
                description: description || '',
                userId: req.user?.id,
                sessionId: sessionId
            });

            return res.json(result);
        }

        // Fallback: return info for manual clip creation
        res.json({
            success: true,
            message: 'Clip creation queued',
            clipInfo: {
                sessionId,
                startMs: absoluteStartMs,
                endMs: absoluteEndMs,
                durationMs: absoluteEndMs - absoluteStartMs,
                title,
                description
            }
        });
    } catch (error) {
        logger.error('Error creating clip:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /admin/review/sessions/:sessionId
 * Delete a recording session
 */
router.delete('/sessions/:sessionId', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!cleanupScheduler) {
            return res.status(500).json({ success: false, error: 'Cleanup scheduler not initialized' });
        }

        const result = await cleanupScheduler.deleteSessionById(sessionId);
        res.json(result);
    } catch (error) {
        logger.error('Error deleting session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /admin/review/sessions/:sessionId/upload
 * Force upload a session to B2
 */
router.post('/sessions/:sessionId/upload', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!uploadScheduler) {
            return res.status(500).json({ success: false, error: 'Upload scheduler not initialized' });
        }

        const result = await uploadScheduler.forceUpload(sessionId);
        res.json(result);
    } catch (error) {
        logger.error('Error uploading session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/settings
 * Get review system settings
 */
router.get('/settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = await adminReviewSettingsRepository.listAll();

        const settingsObj = {};
        for (const s of settings) {
            settingsObj[s.key] = s.value;
        }

        // Add B2 status
        settingsObj.b2Enabled = b2Storage.isEnabled();
        settingsObj.b2BucketName = process.env.B2_BUCKET_NAME || null;

        // Add scheduler status if available
        if (cleanupScheduler) {
            const cleanupStatus = await cleanupScheduler.getStatus();
            settingsObj.cleanupStatus = cleanupStatus;
        }

        if (uploadScheduler) {
            settingsObj.uploadStatus = uploadScheduler.getStatus();
        }

        res.json({
            success: true,
            settings: settingsObj
        });
    } catch (error) {
        logger.error('Error getting settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /admin/review/settings
 * Update review system settings
 */
router.put('/settings', authenticateAdmin, async (req, res) => {
    try {
        const { retention_days, upload_enabled, local_buffer_hours } = req.body;

        if (retention_days !== undefined) {
            const days = Math.max(1, Math.min(7, parseInt(retention_days)));
            await adminReviewSettingsRepository.upsertSetting('retention_days', days.toString());
        }

        if (upload_enabled !== undefined) {
            await adminReviewSettingsRepository.upsertSetting('upload_enabled', upload_enabled.toString());
        }

        if (local_buffer_hours !== undefined) {
            const hours = Math.max(1, Math.min(24, parseInt(local_buffer_hours)));
            await adminReviewSettingsRepository.upsertSetting('local_buffer_hours', hours.toString());
        }

        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        logger.error('Error updating settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
/**
 * GET /admin/review/status
 * Get overall system status
 */
router.get('/status', authenticateAdmin, async (req, res) => {
    try {
        const totalSessions = await recordingRepository.countAllSessions();
        const activeSessions = await recordingRepository.countSessionsByStatus('recording');
        const uploadedSessions = await recordingRepository.countSessionsByStatus('uploaded');

        const chatStatus = chatCaptureService ? chatCaptureService.getStatus() : { activeSessions: [], sessionCount: 0 };

        res.json({
            success: true,
            status: {
                totalSessions: totalSessions?.count || 0,
                activeSessions: activeSessions?.count || 0,
                uploadedSessions: uploadedSessions?.count || 0,
                b2Enabled: b2Storage.isEnabled(),
                chatCapture: chatStatus
            }
        });
    } catch (error) {
        logger.error('Error getting status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/timeline
 * Get stream events for timeline visualization
 * Returns stream segment data captured during recording (accurate data)
 */
router.get('/timeline', authenticateAdmin, async (req, res) => {
    try {
        // ?days=N caps how far back the timeline reaches. With 28k+ segments
        // accumulated and per-row display-name lookups, the unbounded query
        // returned ~23 MB and timed out the UI. Default 30 covers recent
        // activity; pass days=9999 for the full historical view.
        const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 9999));
        const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

        // First, get the recording session boundaries
        const recordingSessions = await recordingRepository.listSessionsWithLocalPathBasic();

        if (recordingSessions.length === 0) {
            return res.json({
                success: true,
                timeline: {
                    startTime: Date.now() - 24 * 60 * 60 * 1000,
                    endTime: Date.now(),
                    events: [],
                    recordings: []
                }
            });
        }

        // Calculate actual recording time range from segment files - NO PADDING
        // Timeline should exactly match where video data exists
        const recordingStartTime = Math.min(...recordingSessions.map(r => r.start_time));

        // Count actual segments to get real duration
        let totalSegments = 0;
        for (const session of recordingSessions) {
            if (session.local_path && fs.existsSync(session.local_path)) {
                const files = fs.readdirSync(session.local_path);
                totalSegments += files.filter(f => f.endsWith('.ts')).length;
            }
        }

        // Calculate end time from segments (4 seconds per segment)
        const SEGMENT_DURATION_MS = 4000;
        const totalDurationMs = totalSegments * SEGMENT_DURATION_MS;
        const recordingEndTime = recordingStartTime + totalDurationMs;

        // Use exact recording boundaries - no padding beyond actual data
        const timelineStart = recordingStartTime;
        const timelineEnd = recordingEndTime;

        // Get stream segments from the recording_stream_segments table (accurate data captured during recording)
        const streamSegments = await recordingRepository.listStreamSegmentsSince(sinceMs);

        // Batch-prefetch display names for all url_streams referenced by these
        // segments. The previous inline N+1 (one or two SELECTs per segment)
        // dominated request time for large windows.
        const urlSet = new Set();
        const channelSet = new Set();
        const channelToUrls = new Map();
        const streamIdentitiesNeedingName = new Set();
        for (const seg of streamSegments) {
            if (seg.source_url) {
                urlSet.add(seg.source_url);
                if (seg.source_url.includes('live-video.net')) {
                    const m = seg.source_url.match(/channel\.([A-Za-z0-9]+)\.m3u8/);
                    if (m) {
                        channelSet.add(m[1]);
                        if (!channelToUrls.has(m[1])) channelToUrls.set(m[1], []);
                        channelToUrls.get(m[1]).push(seg.source_url);
                    }
                }
            }
            if (seg.stream_type === 'real_streamer'
                && seg.display_name && seg.display_name.length > 15
                && /^[a-zA-Z0-9_-]+$/.test(seg.display_name)) {
                streamIdentitiesNeedingName.add(seg.stream_identity);
            }
        }

        const displayByUrl = new Map();
        if (urlSet.size > 0) {
            const placeholders = Array.from(urlSet, () => '?').join(',');
            const rows = await allAsync(
                `SELECT source_url, display_name FROM url_streams WHERE source_url IN (${placeholders})`,
                Array.from(urlSet)
            );
            for (const r of rows) {
                if (r.display_name && r.display_name !== 'Unknown') {
                    displayByUrl.set(r.source_url, r.display_name.replace(/\s*\([^)]+\)\s*$/, '').trim());
                }
            }
        }

        // For IVS channel-id matches, do a single LIKE-per-channel batched lookup
        if (channelSet.size > 0) {
            for (const channelId of channelSet) {
                if (channelToUrls.get(channelId).some(u => displayByUrl.has(u))) continue;
                const row = await getAsync(
                    `SELECT display_name FROM url_streams WHERE source_url LIKE ? ORDER BY id DESC LIMIT 1`,
                    [`%channel.${channelId}%`]
                );
                if (row && row.display_name && row.display_name !== 'Unknown') {
                    const clean = row.display_name.replace(/\s*\([^)]+\)\s*$/, '').trim();
                    for (const u of channelToUrls.get(channelId)) {
                        if (!displayByUrl.has(u)) displayByUrl.set(u, clean);
                    }
                }
            }
        }

        const streamerNameById = new Map();
        if (streamIdentitiesNeedingName.size > 0) {
            const placeholders = Array.from(streamIdentitiesNeedingName, () => '?').join(',');
            const rows = await allAsync(
                `SELECT streamer_id, streamer_name FROM streaming_logs
                 WHERE streamer_id IN (${placeholders})
                 GROUP BY streamer_id`,
                Array.from(streamIdentitiesNeedingName)
            );
            for (const r of rows) {
                if (r.streamer_name) streamerNameById.set(r.streamer_id, r.streamer_name);
            }
        }

        // Build events from stream segments
        const events = [];
        const colorMap = {
            'url_stream': '#2196F3',    // Blue
            'real_streamer': '#4CAF50', // Green
            'viewbot': '#FF9800'        // Orange
        };

        for (const seg of streamSegments) {
            const startTime = seg.started_at;
            const endTime = seg.ended_at || Date.now();
            const isActive = !seg.ended_at;

            // Determine display name based on stream type
            let displayName = seg.display_name || seg.stream_identity;

            if (seg.stream_type === 'url_stream' && seg.source_url) {
                // For URL streams, try to extract the actual username from the source URL
                const extractedUsername = extractUsernameFromUrl(seg.source_url);
                if (extractedUsername) {
                    displayName = extractedUsername;
                } else {
                    const looked = displayByUrl.get(seg.source_url);
                    if (looked) {
                        displayName = looked;
                    } else if (seg.source_url.includes('live-video.net')) {
                        displayName = 'Kick';
                    } else if (seg.platform && seg.platform !== 'unknown' && seg.platform !== 'direct') {
                        displayName = seg.platform;
                    }
                }
            } else if (seg.stream_type === 'real_streamer') {
                if (displayName && displayName.length > 15 && /^[a-zA-Z0-9_-]+$/.test(displayName)) {
                    const looked = streamerNameById.get(seg.stream_identity);
                    if (looked) displayName = looked;
                }
            }

            events.push({
                id: `seg-${seg.id}`,
                type: seg.stream_type,
                name: displayName,
                platform: seg.platform,
                sourceUrl: seg.source_url,
                startTime: startTime,
                endTime: endTime,
                duration: endTime - startTime,
                isActive: isActive,
                color: colorMap[seg.stream_type] || '#9E9E9E'
            });
        }

        // Sort by start time
        events.sort((a, b) => a.startTime - b.startTime);

        res.json({
            success: true,
            timeline: {
                startTime: timelineStart,
                endTime: timelineEnd,
                events: events,
                recordings: recordingSessions.map(r => ({
                    sessionId: r.session_id,
                    startTime: r.start_time,
                    endTime: r.end_time || Date.now(),
                    hasVideo: !!r.local_path,
                    status: r.status
                }))
            }
        });
    } catch (error) {
        logger.error('Error getting timeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/playback
 * Get unified playback info for all available recordings
 * Returns a combined master playlist URL and metadata
 */
router.get('/playback', authenticateAdmin, async (req, res) => {
    try {
        // Get all recording sessions with local files
        const sessions = await recordingRepository.listSessionsWithLocalPathFull();

        if (sessions.length === 0) {
            return res.json({
                success: true,
                hasRecordings: false,
                message: 'No recordings available'
            });
        }

        // Calculate total duration from ACTUAL segment files (not database which may be stale)
        let totalSegments = 0;
        let earliestStart = Infinity;
        let latestEnd = 0;

        for (const session of sessions) {
            if (session.start_time < earliestStart) earliestStart = session.start_time;

            // Count actual segments on disk
            if (session.local_path && fs.existsSync(session.local_path)) {
                const files = fs.readdirSync(session.local_path);
                const segmentCount = files.filter(f => f.endsWith('.ts')).length;
                totalSegments += segmentCount;
            }
        }

        // Calculate duration: segments * 4 seconds per segment
        const SEGMENT_DURATION_MS = 4000; // 4 seconds
        const totalDurationMs = totalSegments * SEGMENT_DURATION_MS;
        latestEnd = earliestStart + totalDurationMs;

        // Get total chat message count
        const chatCount = await sessionChatMessageRepository.countBySessionIds(sessions.map(s => s.session_id));

        res.json({
            success: true,
            hasRecordings: true,
            playback: {
                sessionIds: sessions.map(s => s.session_id),
                sessionCount: sessions.length,
                earliestRecording: earliestStart,
                latestRecording: latestEnd,
                totalDurationMs: totalDurationMs,
                totalSegments: totalSegments,
                totalChatMessages: chatCount?.count || 0,
                streamUrl: '/admin/review/master-stream'
            }
        });
    } catch (error) {
        logger.error('Error getting playback info:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/master-stream
 * Serve a combined HLS playlist spanning all recording sessions
 * Only includes segments that actually exist on disk
 * Adds #EXT-X-DISCONTINUITY tags between different source playlists
 */
router.get('/master-stream', authenticateAdmin, async (req, res) => {
    try {
        // Get all sessions with local paths
        const sessions = await recordingRepository.listSessionsWithLocalPathIdsOnly();

        if (sessions.length === 0) {
            return res.status(404).json({ success: false, error: 'No recordings available' });
        }

        // Generate combined VOD playlist with path-based segment URLs
        // Only include segments that actually exist on disk
        // Use version 4 for better compatibility with discontinuities
        // Add INDEPENDENT-SEGMENTS and DISCONTINUITY-SEQUENCE for better player handling
        // Add EXT-X-START to tell player to start at time 0 and reset timeline
        // This helps with segments that have high PTS values from source streams
        let masterContent = '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-DISCONTINUITY-SEQUENCE:0\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n';

        let isFirstSegment = true;
        let lastPlaylistId = null;

        for (const session of sessions) {
            const sessionDir = session.local_path;
            if (!fs.existsSync(sessionDir)) continue;

            // Get all files in this session directory
            const allFiles = fs.readdirSync(sessionDir);

            // Build a Set of existing segment files for fast lookup
            const existingSegments = new Set(allFiles.filter(f => f.endsWith('.ts')));

            // Find all playlist files in this session
            const playlists = allFiles
                .filter(f => f.startsWith('playlist_') && f.endsWith('.m3u8'))
                .sort((a, b) => {
                    const tsA = parseInt(a.match(/playlist_(\d+)\.m3u8/)?.[1] || '0');
                    const tsB = parseInt(b.match(/playlist_(\d+)\.m3u8/)?.[1] || '0');
                    return tsA - tsB;
                });

            for (const playlist of playlists) {
                const playlistId = playlist.match(/playlist_(\d+)\.m3u8/)?.[1];
                const playlistPath = path.join(sessionDir, playlist);
                const content = fs.readFileSync(playlistPath, 'utf8');
                const lines = content.split('\n');

                // Check if this playlist has its first segment (00000)
                // If not, skip it entirely - incomplete playlists have wrong PTS timestamps
                // that cause MediaSource to fail when switching between playlists
                const firstSegmentName = `seg_${playlistId}_00000.ts`;
                if (!existingSegments.has(firstSegmentName)) {
                    // Skip this incomplete playlist - it would cause PTS discontinuity issues
                    continue;
                }

                let pendingExtinf = null;
                let addedSegmentFromThisPlaylist = false;

                for (const line of lines) {
                    if (line.startsWith('#EXTM3U') || line.startsWith('#EXT-X-VERSION') ||
                        line.startsWith('#EXT-X-TARGETDURATION') || line.startsWith('#EXT-X-MEDIA-SEQUENCE') ||
                        line.startsWith('#EXT-X-ENDLIST') || line.startsWith('#EXT-X-PLAYLIST-TYPE') ||
                        line.startsWith('#EXT-X-ALLOW-CACHE') || line.trim() === '') {
                        continue;
                    }

                    // Store EXTINF for the next segment
                    if (line.startsWith('#EXTINF:')) {
                        // Parse duration and skip very short segments (< 2s) that can cause issues
                        const durationMatch = line.match(/#EXTINF:([0-9.]+)/);
                        const duration = durationMatch ? parseFloat(durationMatch[1]) : 4;
                        if (duration < 2.0) {
                            // Skip this segment - it's too short and might cause discontinuity issues
                            pendingExtinf = null;
                            continue;
                        }
                        pendingExtinf = line;
                        continue;
                    }

                    // Skip other tags like #EXT-X-PROGRAM-DATE-TIME
                    if (line.startsWith('#')) {
                        continue;
                    }

                    // Check if this is a segment file and it exists
                    if (line.endsWith('.ts')) {
                        // Skip if we don't have a pending EXTINF (segment was filtered)
                        if (!pendingExtinf) {
                            continue;
                        }

                        if (existingSegments.has(line)) {
                            // Add discontinuity tag when switching to a new source playlist
                            // (but not before the very first segment)
                            if (!isFirstSegment && lastPlaylistId !== playlistId && !addedSegmentFromThisPlaylist) {
                                masterContent += '#EXT-X-DISCONTINUITY\n';
                            }

                            // Segment exists - include EXTINF and segment URL
                            masterContent += pendingExtinf + '\n';
                            masterContent += `segment/${session.session_id}/${line}\n`;

                            isFirstSegment = false;
                            addedSegmentFromThisPlaylist = true;
                        }
                        pendingExtinf = null;
                    }
                }

                // Update lastPlaylistId only if we added segments from this playlist
                if (addedSegmentFromThisPlaylist) {
                    lastPlaylistId = playlistId;
                }
            }
        }

        masterContent += '#EXT-X-ENDLIST\n';

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(masterContent);
    } catch (error) {
        logger.error('Error generating master stream:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/segment/:sessionId/:filename
 * Serve individual video segments
 */
router.get('/segment/:sessionId/:filename', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId, filename } = req.params;

        const session = await recordingRepository.getSessionLocalPath(sessionId);

        if (!session || !session.local_path) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        const segmentPath = path.join(session.local_path, filename);
        if (!fs.existsSync(segmentPath)) {
            return res.status(404).json({ success: false, error: 'Segment not found' });
        }

        const stat = fs.statSync(segmentPath);
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000');

        fs.createReadStream(segmentPath).pipe(res);
    } catch (error) {
        logger.error('Error serving segment:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /admin/review/chat-stream
 * Get chat messages for a specific time range (for progressive loading)
 */
router.get('/chat-stream', authenticateAdmin, async (req, res) => {
    try {
        const { fromMs, toMs, limit = 100 } = req.query;

        let sql = `
            SELECT
                m.*,
                r.start_time as session_start_time
            FROM session_chat_messages m
            JOIN recording_sessions r ON m.session_id = r.session_id
            WHERE 1=1
        `;
        const params = [];

        if (fromMs) {
            sql += ' AND m.absolute_time_ms >= ?';
            params.push(parseInt(fromMs));
        }

        if (toMs) {
            sql += ' AND m.absolute_time_ms <= ?';
            params.push(parseInt(toMs));
        }

        sql += ' ORDER BY m.absolute_time_ms ASC LIMIT ?';
        params.push(parseInt(limit));

        const messages = await allAsync(sql, params);

        res.json({
            success: true,
            messages: messages.map(m => ({
                id: m.id,
                sessionId: m.session_id,
                username: m.username,
                message: m.message,
                color: m.color,
                timestamp: m.absolute_time_ms,
                relativeMs: m.relative_time_ms,
                isSystem: m.is_system === 1
            })),
            count: messages.length
        });
    } catch (error) {
        logger.error('Error getting chat stream:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
