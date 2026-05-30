/**
 * Admin Recording Review — recording sessions + media serving.
 *
 * Routes: session list/detail, signed video URL, local HLS streaming,
 * per-session chat, delete, force-upload, and raw segment serving.
 *
 * Handler bodies are moved verbatim from server/routes/admin-recordings.js;
 * the only mechanical change is that the four runtime services (set after
 * mount) are read through the shared `services` holder from ./context.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const { authenticateAdmin } = require('../../middleware/auth');
const {
    logger,
    recordingRepository,
    sessionChatMessageRepository,
    b2Storage,
    services,
} = require('./context');

const router = express.Router();

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
 * DELETE /admin/review/sessions/:sessionId
 * Delete a recording session
 */
router.delete('/sessions/:sessionId', authenticateAdmin, async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!services.cleanupScheduler) {
            return res.status(500).json({ success: false, error: 'Cleanup scheduler not initialized' });
        }

        const result = await services.cleanupScheduler.deleteSessionById(sessionId);
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

        if (!services.uploadScheduler) {
            return res.status(500).json({ success: false, error: 'Upload scheduler not initialized' });
        }

        const result = await services.uploadScheduler.forceUpload(sessionId);
        res.json(result);
    } catch (error) {
        logger.error('Error uploading session:', error);
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

module.exports = router;
