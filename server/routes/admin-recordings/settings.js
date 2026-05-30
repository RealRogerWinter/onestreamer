/**
 * Admin Recording Review — review-system settings + overall status.
 *
 * Routes: GET/PUT settings and GET status. Handler bodies moved verbatim
 * from server/routes/admin-recordings.js; the only mechanical change is
 * reading the runtime services through the shared `services` holder from
 * ./context (injected after mount).
 */

const express = require('express');

const { authenticateAdmin } = require('../../middleware/auth');
const {
    logger,
    recordingRepository,
    adminReviewSettingsRepository,
    b2Storage,
    services,
} = require('./context');

const router = express.Router();

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
        if (services.cleanupScheduler) {
            const cleanupStatus = await services.cleanupScheduler.getStatus();
            settingsObj.cleanupStatus = cleanupStatus;
        }

        if (services.uploadScheduler) {
            settingsObj.uploadStatus = services.uploadScheduler.getStatus();
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

        const chatStatus = services.chatCaptureService ? services.chatCaptureService.getStatus() : { activeSessions: [], sessionCount: 0 };

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

module.exports = router;
