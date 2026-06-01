/**
 * Admin continuous-recording control surface.
 *
 *   /admin/recordings/continuous/{enable,disable,status}
 *
 * History: this file used to host a 19-route cluster (the MediaSoup-era
 * `RecordingService` recorder + `RecordingStorageService` + `FileCompression`
 * surface over the never-written `recordings` table). That whole pipeline was
 * retired with ADR-0024 (LiveKit-only); the live recording surface is the
 * LiveKit egress path (`recording_sessions` table, served by
 * `routes/admin-recordings.js` at `/admin/review/*`). The dead routes were
 * removed and the three surviving continuous-recording controls now point at
 * `getContinuousRecordingService()` (LiveKit egress) instead of the dead
 * `getRecordingService()`.
 *
 * In LiveKit mode continuous recording is automatic — the egress recorder
 * polls the room and records whenever a publisher is present
 * (`ContinuousRecordingService.checkAndAutoRecord`). `enable`/`disable`
 * therefore map to a manual `startRecording()`/`stopRecording()` nudge, and
 * `status` reports the live egress state from `getStatus()`.
 *
 * Auth: `authenticateAdmin` (JWT, from `middleware/auth.js`) for every route.
 * The service is resolved lazily via the `getContinuousRecordingService()`
 * getter (assigned inside `startServer()`), matching the original pattern.
 */

const express = require('express');

function createAdminRecordingsRouter(deps) {
    const {
        authenticateAdmin,
        logger,
        getContinuousRecordingService,
    } = deps;

    const router = express.Router();

    // ================================
    // CONTINUOUS RECORDING ENDPOINTS (LiveKit egress)
    // ================================

    // Enable continuous recording — nudge the egress recorder to start now.
    router.post('/admin/recordings/continuous/enable', authenticateAdmin, async (req, res) => {
      try {
        logger.info('🔄 ADMIN: Enabling continuous recording (LiveKit egress)');

        const service = getContinuousRecordingService();
        if (!service) {
          return res.status(500).json({ success: false, error: 'Continuous recording service unavailable' });
        }

        // In LiveKit mode recording is automatic; this kicks an immediate
        // start so the operator doesn't have to wait for the next poll tick.
        const result = await service.startRecording();
        const status = service.getStatus();

        res.json({
          success: result?.success !== false,
          message: 'Continuous recording enabled',
          sessionId: status.sessionId
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to enable continuous recording');
        res.status(500).json({ error: 'Failed to enable continuous recording' });
      }
    });

    // Disable continuous recording — stop the active egress.
    router.post('/admin/recordings/continuous/disable', authenticateAdmin, async (req, res) => {
      try {
        logger.info('🛑 ADMIN: Disabling continuous recording (LiveKit egress)');

        const service = getContinuousRecordingService();
        if (!service) {
          return res.status(500).json({ success: false, error: 'Continuous recording service unavailable' });
        }

        await service.stopRecording();

        res.json({
          success: true,
          message: 'Continuous recording disabled'
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to disable continuous recording');
        res.status(500).json({ error: 'Failed to disable continuous recording' });
      }
    });

    // Get continuous recording status — live egress state.
    router.get('/admin/recordings/continuous/status', authenticateAdmin, (req, res) => {
      try {
        const service = getContinuousRecordingService();
        if (!service) {
          return res.status(500).json({ success: false, error: 'Continuous recording service unavailable' });
        }

        const status = service.getStatus();

        res.json({
          success: true,
          status: {
            // Continuous recording is automatic in LiveKit mode, so the
            // recorder is always "enabled" once the service is up.
            enabled: true,
            isRecording: status.isRecording,
            sessionId: status.sessionId,
            startTime: status.startTime,
            duration: status.duration,
            recordingTarget: status.recordingTarget,
            isParticipantEgress: status.isParticipantEgress
          }
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get continuous recording status');
        res.status(500).json({ error: 'Failed to get continuous recording status' });
      }
    });

    return router;
}

module.exports = createAdminRecordingsRouter;
