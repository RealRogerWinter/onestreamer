/**
 * Admin transcription HTTP surface — extracted from `server/index.js` as
 * part of Phase 15B.3.i. 10 routes:
 *
 *   POST   /admin/transcription/start
 *   POST   /admin/transcription/stop/:sessionId
 *   POST   /admin/transcription/timed
 *   POST   /admin/transcription/instant
 *   POST   /admin/transcription/config
 *   GET    /admin/transcription/status
 *   GET    /api/transcription/:sessionId
 *   GET    /api/transcriptions/active
 *   GET    /api/transcriptions/history
 *   DELETE /admin/transcriptions/old
 *
 * Auth: `authenticateAdmin` (JWT) on every route.
 *
 * `transcriptionService` is lazily assigned inside `startServer()` —
 * accessed via the `getTranscriptionService()` getter to preserve the
 * pre-PR closure-resolved-at-request-handler-time pattern. Same
 * factory shape PR 15B.3.e/h established.
 *
 * Body byte-equivalent except for:
 *   - `app.X(...)` → `router.X(...)` at line starts
 *   - `transcriptionService` → `getTranscriptionService()` at each
 *     reference site
 *
 * Other deps (`authenticateAdmin`, `streamService`, `webrtcService`,
 * `io`, `logger`) destructured from the factory args bag and used verbatim.
 */

const express = require('express');

function createAdminTranscriptionRouter(deps) {
    const {
        authenticateAdmin,
        streamService,
        webrtcService,
        io,
        logger,
        getTranscriptionService,
    } = deps;

    const router = express.Router();

    router.post('/admin/transcription/start', authenticateAdmin, async (req, res) => {
      try {
        const { streamerId, options } = req.body;
    
        if (!streamerId) {
          return res.status(400).json({ error: 'streamerId is required' });
        }
    
        logger.info(`🎙️ ADMIN: Starting transcription for ${streamerId}`);
        logger.info({ options }, `🎙️ ADMIN: Options`);
        logger.info({ currentStreamer: streamService.getCurrentStreamer() }, `🎙️ ADMIN: Current active streamer`);
        logger.info({ streamType: streamService.getStreamType() }, `🎙️ ADMIN: Stream type`);
    
        const result = await getTranscriptionService().startTranscription(streamerId, options);
    
        logger.info({ result }, `🎙️ ADMIN: Transcription start result`);
    
        if (result.success) {
          // Forward to WebSocket clients
          io.emit('transcription-started', {
            sessionId: result.sessionId,
            streamerId: streamerId,
            startTime: result.startTime
          });
        }
    
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to start transcription');
        res.status(500).json({ error: 'Failed to start transcription' });
      }
    });

    router.post('/admin/transcription/stop/:sessionId', authenticateAdmin, async (req, res) => {
      try {
        const { sessionId } = req.params;
    
        logger.info(`🛑 ADMIN: Stopping transcription ${sessionId}`);
        const result = await getTranscriptionService().stopTranscription(sessionId);
    
        if (result.success) {
          // Forward to WebSocket clients
          io.emit('transcription-stopped', {
            sessionId: sessionId,
            duration: result.duration,
            wordCount: result.wordCount
          });
        }
    
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to stop transcription');
        res.status(500).json({ error: 'Failed to stop transcription' });
      }
    });

    router.post('/admin/transcription/timed', authenticateAdmin, async (req, res) => {
      try {
        const { streamerId, duration = 30, options } = req.body;
    
        if (!streamerId) {
          return res.status(400).json({ error: 'streamerId is required' });
        }
    
        logger.info(`⏱️ ADMIN: Timed transcription requested for ${streamerId} (${duration}s)`);
    
        // Verify stream is active
        const currentStreamer = webrtcService.getCurrentStreamer();
        if (!currentStreamer || currentStreamer !== streamerId) {
          return res.status(400).json({ 
            success: false, 
            error: 'Stream is not active or streamer mismatch' 
          });
        }
    
        // Start timed transcription (will auto-stop after duration)
        const result = await getTranscriptionService().startTimedTranscription(streamerId, duration, options);
    
        if (result.success) {
          logger.info(`✅ ADMIN: Timed transcription started: ${result.sessionId}`);
      
          // Emit to WebSocket clients
          io.emit('transcription-started', {
            sessionId: result.sessionId,
            streamerId: streamerId,
            startTime: result.startTime,
            duration: duration,
            timed: true
          });
        }
    
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to start timed transcription');
        res.status(500).json({ error: 'Failed to start timed transcription' });
      }
    });

    // Keep the instant endpoint for backward compatibility
    router.post('/admin/transcription/instant', authenticateAdmin, async (req, res) => {
      // Redirect to timed endpoint
      req.body.duration = req.body.duration || 30;
      return app._router.handle(Object.assign(req, { 
        url: '/admin/transcription/timed',
        originalUrl: '/admin/transcription/timed' 
      }), res);
    });

    router.get('/api/transcription/:sessionId', authenticateAdmin, async (req, res) => {
      try {
        const { sessionId } = req.params;
        const transcription = await getTranscriptionService().getTranscription(sessionId);
    
        if (!transcription) {
          return res.status(404).json({ error: 'Transcription not found' });
        }
    
        res.json(transcription);
      } catch (error) {
        logger.error({ err: error }, '❌ API: Failed to get transcription');
        res.status(500).json({ error: 'Failed to get transcription' });
      }
    });

    router.get('/api/transcriptions/active', authenticateAdmin, async (req, res) => {
      try {
        const activeTranscriptions = await getTranscriptionService().getActiveTranscriptions();
        res.json({ 
          success: true, 
          transcriptions: activeTranscriptions 
        });
      } catch (error) {
        logger.error({ err: error }, '❌ API: Failed to get active transcriptions');
        res.status(500).json({ error: 'Failed to get active transcriptions' });
      }
    });

    router.post('/admin/transcription/config', authenticateAdmin, async (req, res) => {
      try {
        const { enable, autoStart, model, language, chunkDuration, bufferDuration } = req.body;
    
        // Update main enable/disable state
        if (enable !== undefined) {
          if (enable) {
            getTranscriptionService().enableTranscription();
          } else {
            getTranscriptionService().disableTranscription();
            // Stop all active transcriptions when disabling
            const activeSessions = await getTranscriptionService().getActiveTranscriptions();
            for (const session of activeSessions) {
              await getTranscriptionService().stopTranscription(session.id);
            }
          }
        }
    
        // Update auto-start setting
        if (autoStart !== undefined) {
          getTranscriptionService().config.autoStart = autoStart;
        }
    
        // Update model
        if (model) {
          getTranscriptionService().setModel(model);
        }
    
        // Update language
        if (language !== undefined) {
          getTranscriptionService().setLanguage(language);
        }
    
        // Update chunk duration (processing interval)
        if (chunkDuration !== undefined) {
          getTranscriptionService().config.chunkDuration = chunkDuration;
        }
    
        // Update buffer duration
        if (bufferDuration !== undefined && getTranscriptionService().audioBufferService) {
          getTranscriptionService().audioBufferService.config.bufferDuration = bufferDuration;
        }
    
        res.json({ 
          success: true, 
          config: getTranscriptionService().config 
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to update transcription config');
        res.status(500).json({ error: 'Failed to update configuration' });
      }
    });

    router.get('/admin/transcription/status', authenticateAdmin, async (req, res) => {
      try {
        const active = await getTranscriptionService().getActiveTranscriptions();
        const config = getTranscriptionService().config;
    
        // Get buffer status for active sessions
        const activeSessions = active.map(session => {
          const bufferInfo = getTranscriptionService().audioBufferService ? 
            getTranscriptionService().audioBufferService.getSessionInfo(session.id) : null;
      
          return {
            ...session,
            bufferStatus: bufferInfo ? {
              size: bufferInfo.bytesWritten,
              duration: bufferInfo.duration,
              isActive: bufferInfo.isActive
            } : null
          };
        });
    
        res.json({
          success: true,
          status: {
            enabled: config.enableTranscription,
            autoStart: config.autoStart || false,
            model: config.model,
            language: config.language,
            chunkDuration: config.chunkDuration,
            bufferDuration: getTranscriptionService().audioBufferService ? 
              getTranscriptionService().audioBufferService.config.bufferDuration : 60,
            activeCount: active.length,
            activeSessions: activeSessions
          }
        });
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get transcription status');
        res.status(500).json({ error: 'Failed to get status' });
      }
    });

    router.get('/api/transcriptions/history', authenticateAdmin, async (req, res) => {
      try {
        const { limit = 50, offset = 0, status, streamerId, startDate, endDate } = req.query;
    
        const filters = {};
        if (status) filters.status = status;
        if (streamerId) filters.streamerId = streamerId;
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;
    
        const result = await getTranscriptionService().getTranscriptionHistory(
          parseInt(limit),
          parseInt(offset),
          filters
        );
    
        res.json({
          success: true,
          ...result
        });
      } catch (error) {
        logger.error({ err: error }, '❌ API: Failed to get transcription history');
        res.status(500).json({ error: 'Failed to get history' });
      }
    });

    // /api/stream/active moved to server/routes/media.js (PR-G3).

    router.delete('/admin/transcriptions/old', authenticateAdmin, async (req, res) => {
      try {
        const { days = 30 } = req.query;
    
        const result = await getTranscriptionService().deleteOldTranscriptions(parseInt(days));
    
        res.json(result);
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to delete old transcriptions');
        res.status(500).json({ error: 'Failed to delete old transcriptions' });
      }
    });

    return router;
}

module.exports = createAdminTranscriptionRouter;
