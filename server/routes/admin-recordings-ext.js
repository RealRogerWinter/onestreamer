/**
 * Admin recordings + continuous-recordings HTTP surface — extracted from
 * `server/index.js` as part of Phase 15B.3.h. 19 routes spanning:
 *
 *   /admin/recordings/{start,stop/:id,status,status/:id,list,stream/:filename,
 *                       all,download/:id,:id,active,system-status,cleanup,
 *                       settings,:id/compress}
 *   /admin/recordings/continuous/{enable,disable,status,check-and-start,
 *                                  history/:sessionId}
 *
 * Auth: `authenticateAdmin` (JWT, from `middleware/auth.js`) for every
 * route. Lazy services (`recordingService`, `continuousRecordingService`)
 * are assigned inside `startServer()` and accessed via the
 * `getRecordingService()` / `getContinuousRecordingService()` getter
 * functions — same pattern PR 15B.3.e's `routes/viewbot-admin.js` used.
 *
 * `__dirname` path resolution: the pre-PR cluster used
 * `path.join(__dirname, '../recordings', …)` four times. From
 * `server/index.js`, `__dirname` is `<repo>/server`, so the paths
 * resolved to `<repo>/recordings/{active,completed,archived,…}`. From
 * `server/routes/admin-recordings-ext.js`, `__dirname` would be
 * `<repo>/server/routes` and the relative path would be wrong. Fix:
 * the factory accepts `recordingsDir` as an already-resolved absolute
 * path, and the four `__dirname`-relative `path.join` calls in the
 * body become `path.join(recordingsDir, …)`. `index.js` passes
 * `recordingsDir: path.join(__dirname, '..', 'recordings')` so the
 * computed location is identical to pre-PR.
 *
 * Body byte-equivalent except for:
 *   - `app.X(...)` → `router.X(...)` at line starts
 *   - `recordingService` / `continuousRecordingService` → `getX()`
 *   - `path.join(__dirname, '../recordings'` → `path.join(recordingsDir`
 *
 * Other deps (`authenticateAdmin`, `database`, `path`, `fs`, `logger`,
 * `io`) destructured from the factory args bag and used verbatim.
 */

const express = require('express');

function createAdminRecordingsRouter(deps) {
    const {
        authenticateAdmin,
        database,
        path,
        fs,
        logger,
        io,
        recordingsDir,
        getRecordingService,
        getContinuousRecordingService,
    } = deps;

    const router = express.Router();

    router.post('/admin/recordings/start', authenticateAdmin, async (req, res) => {
      try {
        const { streamerId, quality } = req.body;
    
        if (!streamerId) {
          return res.status(400).json({ error: 'streamerId is required' });
        }
    
        logger.info(`🎬 ADMIN: Starting recording for streamer ${streamerId} with quality ${quality}`);
    
        const result = await getRecordingService().startRecording(streamerId, { quality });
    
        if (result.success) {
          res.json({
            success: true,
            message: 'Recording started successfully',
            recordingId: result.recordingId,
            quality: result.quality,
            startTime: result.startTime
          });
        } else {
          res.status(400).json({ 
            success: false, 
            error: result.error 
          });
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to start recording');
        res.status(500).json({ error: 'Failed to start recording' });
      }
    });

    // Stop recording
    router.post('/admin/recordings/stop/:recordingId', authenticateAdmin, async (req, res) => {
      try {
        const { recordingId } = req.params;
        const userId = req.user?.id || 'admin';
    
        logger.info(`🛑 ADMIN: Stopping recording ${recordingId}`);
    
        const result = await getRecordingService().stopRecording(recordingId, userId);
    
        if (result.success) {
          res.json({
            success: true,
            message: 'Recording stopped successfully',
            recordingId: result.recordingId,
            duration: result.duration
          });
        } else {
          res.status(400).json({ 
            success: false, 
            error: result.error 
          });
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to stop recording');
        res.status(500).json({ error: 'Failed to stop recording' });
      }
    });

    // Get all recordings status
    router.get('/admin/recordings/status', authenticateAdmin, (req, res) => {
      try {
        const activeRecordings = getRecordingService().getActiveRecordings();
    
        res.json({
          success: true,
          status: {
            activeRecordings: activeRecordings.length,
            recordings: activeRecordings
          }
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get recordings status');
        res.status(500).json({ error: 'Failed to get recordings status' });
      }
    });

    // Get specific recording status
    router.get('/admin/recordings/status/:recordingId', authenticateAdmin, (req, res) => {
      try {
        const { recordingId } = req.params;
        const status = getRecordingService().getRecordingStatus(recordingId);
    
        res.json({
          success: true,
          status: status
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get recording status');
        res.status(500).json({ error: 'Failed to get recording status' });
      }
    });

    // List recordings
    router.get('/admin/recordings/list', authenticateAdmin, async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const status = req.query.status;
    
        let recordings = await getRecordingService().getRecordingsList(limit, offset);
    
        // Filter by status if provided
        if (status) {
          recordings = recordings.filter(r => r.status === status);
        }
    
        // Add username for each recording
        for (const recording of recordings) {
          if (recording.streamer_id) {
            try {
              const user = await userRepository.getUsernameById(recording.streamer_id);
              recording.username = user ? user.username : `User${recording.streamer_id}`;
            } catch (err) {
              recording.username = `User${recording.streamer_id}`;
            }
          } else {
            recording.username = 'Unknown';
          }
        }
    
        res.json({
          success: true,
          recordings: recordings,
          pagination: {
            limit,
            offset,
            count: recordings.length
          }
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to list recordings');
        res.status(500).json({ error: 'Failed to list recordings' });
      }
    });

    // Download recording
    // Stream recording for playback
    router.get('/admin/recordings/stream/:filename', authenticateAdmin, async (req, res) => {
      try {
        const { filename } = req.params;
    
        // Search for the file in all recording directories
        const directories = ['active', 'completed', 'archived'];
        let filePath = null;
    
        for (const dir of directories) {
          const testPath = path.join(recordingsDir, dir, filename);
          if (fs.existsSync(testPath)) {
            filePath = testPath;
            break;
          }
        }
    
        if (!filePath) {
          return res.status(404).json({ error: 'Recording file not found' });
        }
    
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;
    
        if (range) {
          // Support for video seeking
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunksize = (end - start) + 1;
          const file = fs.createReadStream(filePath, { start, end });
          const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/webm',
          };
          res.writeHead(206, head);
          file.pipe(res);
        } else {
          const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/webm',
          };
          res.writeHead(200, head);
          fs.createReadStream(filePath).pipe(res);
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Error streaming recording');
        res.status(500).json({ error: 'Failed to stream recording' });
      }
    });

    // Get all recordings with details
    router.get('/admin/recordings/all', authenticateAdmin, async (req, res) => {
      try {
        const directories = {
          active: path.join(__dirname, '../recordings/active'),
          completed: path.join(__dirname, '../recordings/completed'),
          archived: path.join(__dirname, '../recordings/archived')
        };
    
        const recordings = [];
    
        for (const [status, dirPath] of Object.entries(directories)) {
          if (fs.existsSync(dirPath)) {
            const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.webm'));
        
            for (const file of files) {
              const filePath = path.join(dirPath, file);
              const stats = fs.statSync(filePath);
          
              // Parse filename for metadata
              const match = file.match(/recording_(.+?)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(\w+)\.webm/);
              const streamerId = match ? match[1] : 'unknown';
              const timestamp = match ? match[2].replace(/T/, ' ').replace(/-/g, ':') : '';
              const quality = match ? match[3] : 'unknown';
          
              // Get username for the streamerId
              let username = 'Unknown';
              if (streamerId && streamerId !== 'unknown') {
                try {
                  const user = await userRepository.getUsernameById(streamerId);
                  username = user ? user.username : `User${streamerId}`;
                } catch (err) {
                  username = `User${streamerId}`;
                }
              }
          
              recordings.push({
                filename: file,
                path: filePath,
                status: status,
                streamerId: streamerId,
                username: username,
                timestamp: timestamp,
                quality: quality,
                size: stats.size,
                sizeFormatted: formatFileSize(stats.size),
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime,
                isRecording: status === 'active' && (Date.now() - stats.mtimeMs) < 5000 // Active if modified in last 5 seconds
              });
            }
          }
        }
    
        // Sort by creation date, newest first
        recordings.sort((a, b) => b.createdAt - a.createdAt);
    
        res.json({
          success: true,
          recordings: recordings,
          count: recordings.length
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Error fetching recordings');
        res.status(500).json({ error: 'Failed to fetch recordings' });
      }
    });

    // Helper function to format file size
    function formatFileSize(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    router.get('/admin/recordings/download/:recordingId', authenticateAdmin, async (req, res) => {
      try {
        const { recordingId } = req.params;
    
        // Get recording info from database
        const query = 'SELECT * FROM recordings WHERE id = ?';
        const recording = await database.get(query, [recordingId]);
    
        if (!recording) {
          return res.status(404).json({ error: 'Recording not found' });
        }
    
        if (!recording.file_path || !fs.existsSync(recording.file_path)) {
          return res.status(404).json({ error: 'Recording file not found' });
        }
    
        // Log download event
        await recordingStorageService.logStorageEvent(recordingId, 'downloaded', {
          userId: req.user?.id || 'admin',
          downloadedAt: new Date().toISOString()
        });
    
        const fileName = path.basename(recording.file_path);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
    
        logger.info(`📥 ADMIN: Downloading recording ${recordingId} - ${fileName}`);
    
        // Stream the file
        const fileStream = fs.createReadStream(recording.file_path);
        fileStream.pipe(res);
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to download recording');
        res.status(500).json({ error: 'Failed to download recording' });
      }
    });

    // Delete recording (supports both recordingId and filename)
    router.delete('/admin/recordings/:recordingId', authenticateAdmin, async (req, res) => {
      try {
        const { recordingId } = req.params;
        const userId = req.user?.id || 'admin';
    
        logger.info(`🗑️ ADMIN: Deleting recording ${recordingId}`);
    
        // Check if this is a filename (contains .webm) or a recording ID
        if (recordingId.endsWith('.webm')) {
          // This is a filename, handle file-based deletion
          const filename = recordingId;
      
          // Delete from file system
          const directories = ['active', 'completed', 'archived'];
          let fileDeleted = false;
      
          for (const dir of directories) {
            const filePath = path.join(recordingsDir, dir, filename);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              fileDeleted = true;
              logger.info(`🗑️ ADMIN: Deleted file: ${filePath}`);
              break;
            }
          }
      
          // Also try to delete from database based on filename
          try {
            // Extract recording info from filename to find in database
            const match = filename.match(/recording_(.+?)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(\w+)\.webm/);
            if (match) {
              const streamerId = match[1];
              // Try to find and delete database record
              const deleteQuery = 'DELETE FROM recordings WHERE file_path LIKE ?';
              await database.run(deleteQuery, [`%${filename}%`]);
              logger.info(`🗑️ ADMIN: Deleted database record for file: ${filename}`);
            }
          } catch (dbError) {
            logger.info({ err: dbError }, 'Note: Could not delete database record for file');
          }
      
          if (fileDeleted) {
            res.json({
              success: true,
              message: 'Recording deleted successfully'
            });
          } else {
            res.status(404).json({ 
              success: false, 
              error: 'Recording file not found' 
            });
          }
        } else {
          // This is a recording ID, use the existing storage service
          const result = await recordingStorageService.deleteRecording(recordingId, userId);
      
          if (result.success) {
            res.json({
              success: true,
              message: 'Recording deleted successfully'
            });
          } else {
            res.status(400).json({ 
              success: false, 
              error: result.error 
            });
          }
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to delete recording');
        res.status(500).json({ error: 'Failed to delete recording' });
      }
    });

    // Get active recordings
    router.get('/admin/recordings/active', authenticateAdmin, (req, res) => {
      try {
        const activeRecordings = getRecordingService().getActiveRecordings();
    
        res.json({
          success: true,
          activeRecordings: activeRecordings,
          count: activeRecordings.length
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get active recordings');
        res.status(500).json({ error: 'Failed to get active recordings' });
      }
    });

    // Get system status
    router.get('/admin/recordings/system-status', authenticateAdmin, async (req, res) => {
      try {
        const recordingStatus = getRecordingService().getSystemStatus();
        const compressionStatus = fileCompressionService.getQueueStatus();
        const storageStats = await recordingStorageService.getStorageStatistics();
    
        res.json({
          success: true,
          recording: recordingStatus,
          compression: compressionStatus,
          storage: storageStats
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get system status');
        res.status(500).json({ error: 'Failed to get system status' });
      }
    });

    // Manual cleanup
    router.post('/admin/recordings/cleanup', authenticateAdmin, async (req, res) => {
      try {
        logger.info('🧹 ADMIN: Starting manual cleanup');
    
        const result = await recordingStorageService.cleanupOldRecordings();
    
        if (result.success) {
          res.json({
            success: true,
            message: 'Cleanup completed successfully',
            cleaned: result.cleanedCount,
            archived: result.archivedCount,
            orphaned: result.orphanedCount
          });
        } else {
          res.status(500).json({ 
            success: false, 
            error: result.error 
          });
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to run cleanup');
        res.status(500).json({ error: 'Failed to run cleanup' });
      }
    });

    // Update recording settings
    router.post('/admin/recordings/settings', authenticateAdmin, async (req, res) => {
      try {
        const { settings } = req.body;
    
        if (!settings || typeof settings !== 'object') {
          return res.status(400).json({ error: 'Invalid settings provided' });
        }
    
        // Update storage service configuration
        recordingStorageService.updateConfig(settings);
    
        res.json({
          success: true,
          message: 'Recording settings updated successfully',
          settings: recordingStorageService.getConfig()
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to update settings');
        res.status(500).json({ error: 'Failed to update settings' });
      }
    });

    // Compress recording manually
    router.post('/admin/recordings/:recordingId/compress', authenticateAdmin, async (req, res) => {
      try {
        const { recordingId } = req.params;
        const { profile, priority } = req.body;
    
        // Get recording info
        const query = 'SELECT * FROM recordings WHERE id = ?';
        const recording = await database.get(query, [recordingId]);
    
        if (!recording) {
          return res.status(404).json({ error: 'Recording not found' });
        }
    
        if (!recording.file_path || !fs.existsSync(recording.file_path)) {
          return res.status(404).json({ error: 'Recording file not found' });
        }
    
        logger.info(`🗜️ ADMIN: Adding recording ${recordingId} to compression queue`);
    
        const result = await fileCompressionService.addToCompressionQueue(
          recordingId, 
          recording.file_path, 
          { profile, priority }
        );
    
        if (result.success) {
          res.json({
            success: true,
            message: 'Recording added to compression queue',
            queuePosition: result.queuePosition
          });
        } else {
          res.status(400).json({ 
            success: false, 
            error: result.error 
          });
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to queue compression');
        res.status(500).json({ error: 'Failed to queue compression' });
      }
    });

    // ================================
    // CONTINUOUS RECORDING ENDPOINTS
    // ================================

    // Enable continuous recording
    router.post('/admin/recordings/continuous/enable', authenticateAdmin, async (req, res) => {
      try {
        const { quality } = req.body;
    
        logger.info(`🔄 ADMIN: Enabling continuous recording (${quality || '720p'})`);
    
        const result = await getRecordingService().enableContinuousRecording(quality);
    
        if (result.success) {
          res.json({
            success: true,
            message: 'Continuous recording enabled',
            sessionId: result.sessionId
          });
        } else {
          res.status(400).json({ 
            success: false, 
            error: result.error 
          });
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to enable continuous recording');
        res.status(500).json({ error: 'Failed to enable continuous recording' });
      }
    });

    // Disable continuous recording
    router.post('/admin/recordings/continuous/disable', authenticateAdmin, async (req, res) => {
      try {
        logger.info('🛑 ADMIN: Disabling continuous recording');
    
        const result = await getRecordingService().disableContinuousRecording();
    
        if (result.success) {
          res.json({
            success: true,
            message: 'Continuous recording disabled'
          });
        } else {
          res.status(400).json({ 
            success: false, 
            error: result.error 
          });
        }
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to disable continuous recording');
        res.status(500).json({ error: 'Failed to disable continuous recording' });
      }
    });

    // Get continuous recording status
    router.get('/admin/recordings/continuous/status', authenticateAdmin, (req, res) => {
      try {
        const status = getRecordingService().getContinuousRecordingStatus();
    
        res.json({
          success: true,
          status: status
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get continuous recording status');
        res.status(500).json({ error: 'Failed to get continuous recording status' });
      }
    });

    // Manually check and start continuous recording if stream is active
    router.post('/admin/recordings/continuous/check-and-start', authenticateAdmin, async (req, res) => {
      try {
        logger.info('🔍 ADMIN: Manually checking for active streams to start continuous recording');
    
        const result = await getRecordingService().checkAndStartContinuousRecording();
    
        res.json({
          success: result.success,
          message: result.success ? 'Recording started or already active' : result.error,
          recordingId: result.recordingId
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to check and start continuous recording');
        res.status(500).json({ error: 'Failed to check and start continuous recording' });
      }
    });

    // Get continuous recording history
    router.get('/admin/recordings/continuous/history/:sessionId', authenticateAdmin, async (req, res) => {
      try {
        const { sessionId } = req.params;
    
        const recordings = await getRecordingService().getContinuousRecordingHistory(sessionId);
    
        res.json({
          success: true,
          recordings: recordings,
          count: recordings.length
        });
    
      } catch (error) {
        logger.error({ err: error }, '❌ ADMIN: Failed to get continuous recording history');
        res.status(500).json({ error: 'Failed to get continuous recording history' });
      }
    });

    return router;
}

module.exports = createAdminRecordingsRouter;
