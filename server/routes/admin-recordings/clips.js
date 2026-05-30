/**
 * Admin Recording Review — clip creation from a recording session.
 *
 * Handler body moved verbatim from server/routes/admin-recordings.js; the
 * only mechanical change is reading clipService through the shared `services`
 * holder from ./context (it is injected after mount).
 */

const express = require('express');

const { authenticateAdmin } = require('../../middleware/auth');
const {
    logger,
    recordingRepository,
    services,
} = require('./context');

const router = express.Router();

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
        if (services.clipService) {
            const result = await services.clipService.createClipFromRecording({
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

module.exports = router;
