/**
 * URL Stream API Routes
 *
 * Endpoints for managing URL stream viewbots
 */

const express = require('express');
const URLStreamDatabaseService = require('../services/URLStreamDatabaseService');

/**
 * Create URL stream router
 * @param {ViewBotURLService} viewBotURLService - The URL viewbot service
 * @param {URLStreamHealthService} healthService - Optional health service
 */
module.exports = function(viewBotURLService, healthService = null) {
  const router = express.Router();
  const dbService = new URLStreamDatabaseService();

  // Initialize database
  dbService.initialize().catch(err => {
    console.error('Failed to initialize URL stream database:', err);
  });

  // ==================== STREAM MANAGEMENT ====================

  /**
   * POST /api/url-stream
   * Start a new URL stream
   */
  router.post('/', async (req, res) => {
    try {
      const { url, quality, displayName, autoReconnect } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      // Start the stream
      const result = await viewBotURLService.startURLStream(url, {
        quality: quality || 'best',
        displayName,
        autoReconnect: autoReconnect !== false
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Save to database
      try {
        await dbService.createURLStream({
          urlId: result.urlId,
          sourceUrl: url,
          platform: result.platform,
          quality: quality || 'best',
          displayName: displayName || result.title,
          autoReconnect: autoReconnect !== false
        });

        await dbService.addLog(result.urlId, 'started', 'URL stream started', {
          platform: result.platform,
          quality: quality || 'best'
        });
      } catch (dbErr) {
        console.error('Failed to save URL stream to database:', dbErr);
        // Continue anyway - stream is running
      }

      res.json({
        success: true,
        urlId: result.urlId,
        platform: result.platform,
        title: result.title,
        qualities: result.qualities
      });

    } catch (error) {
      console.error('Error starting URL stream:', error);
      res.status(500).json({ error: 'Failed to start URL stream' });
    }
  });

  /**
   * GET /api/url-stream
   * Get all active URL streams
   */
  router.get('/', async (req, res) => {
    try {
      const activeStreams = viewBotURLService.getAllStreams();

      // Add health info if available
      if (healthService) {
        for (const stream of activeStreams) {
          stream.health = healthService.getHealthSummary(stream.urlId);
        }
      }

      res.json({
        active: activeStreams,
        count: activeStreams.length
      });

    } catch (error) {
      console.error('Error getting URL streams:', error);
      res.status(500).json({ error: 'Failed to get streams' });
    }
  });

  // ==================== VALIDATION ====================

  /**
   * POST /api/url-stream/validate
   * Validate a URL before starting stream
   */
  router.post('/validate', async (req, res) => {
    try {
      const { url } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      const result = await viewBotURLService.validateURL(url);

      res.json(result);

    } catch (error) {
      console.error('Error validating URL:', error);
      res.status(500).json({ error: 'Failed to validate URL' });
    }
  });

  // ==================== HISTORY ====================

  /**
   * GET /api/url-stream/history
   * Get URL stream history
   */
  router.get('/history', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const history = await dbService.getRecentURLStreams(limit);

      res.json(history);

    } catch (error) {
      console.error('Error getting URL stream history:', error);
      res.status(500).json({ error: 'Failed to get history' });
    }
  });

  // ==================== ADAPTIVE ENCODING ====================

  /**
   * GET /api/url-stream/adaptive
   * Get current adaptive encoding configuration
   */
  router.get('/adaptive', (req, res) => {
    try {
      const config = viewBotURLService.getAdaptiveConfig();
      res.json({
        success: true,
        config,
        modes: ['performance', 'balanced', 'quality'],
        description: {
          enabled: 'Enable/disable adaptive encoding (true/false)',
          mode: 'Encoding mode: performance (fast), balanced (default), quality (best)',
          maxWidth: 'Maximum output width in pixels',
          maxHeight: 'Maximum output height in pixels',
          maxVideoBitrate: 'Maximum video bitrate in kbps',
          maxFps: 'Maximum output framerate',
          probeTimeout: 'Stream probe timeout in milliseconds'
        }
      });
    } catch (error) {
      console.error('Error getting adaptive config:', error);
      res.status(500).json({ error: 'Failed to get adaptive config' });
    }
  });

  /**
   * PUT /api/url-stream/adaptive
   * Update adaptive encoding configuration
   */
  router.put('/adaptive', (req, res) => {
    try {
      const validKeys = ['enabled', 'mode', 'maxWidth', 'maxHeight', 'maxVideoBitrate', 'maxFps', 'probeTimeout'];
      const validModes = ['performance', 'balanced', 'quality'];

      // Validate input
      const updates = {};
      for (const key of validKeys) {
        if (req.body[key] !== undefined) {
          if (key === 'enabled') {
            updates[key] = Boolean(req.body[key]);
          } else if (key === 'mode') {
            if (!validModes.includes(req.body[key])) {
              return res.status(400).json({
                error: `Invalid mode. Must be one of: ${validModes.join(', ')}`
              });
            }
            updates[key] = req.body[key];
          } else {
            // Numeric values
            const num = parseInt(req.body[key]);
            if (isNaN(num) || num < 0) {
              return res.status(400).json({
                error: `Invalid value for ${key}. Must be a positive number.`
              });
            }
            updates[key] = num;
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          error: 'No valid configuration keys provided',
          validKeys
        });
      }

      const newConfig = viewBotURLService.setAdaptiveConfig(updates);
      res.json({
        success: true,
        config: newConfig,
        updated: Object.keys(updates)
      });
    } catch (error) {
      console.error('Error updating adaptive config:', error);
      res.status(500).json({ error: 'Failed to update adaptive config' });
    }
  });

  /**
   * POST /api/url-stream/probe
   * Probe a URL to get stream properties without starting it
   */
  router.post('/probe', async (req, res) => {
    try {
      const { url, quality } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      const props = await viewBotURLService.probeStreamSource(url, quality || 'best');

      // Also calculate what encoding settings would be used
      let recommendedSettings = null;
      if (viewBotURLService.adaptiveSettings) {
        recommendedSettings = viewBotURLService.adaptiveSettings.calculate(props);
      }

      res.json({
        success: true,
        sourceProperties: {
          width: props.width,
          height: props.height,
          fps: props.fps,
          videoBitrate: Math.round(props.videoBitrate / 1000),
          audioBitrate: Math.round(props.audioBitrate / 1000),
          hasAudio: props.hasAudio,
          hasVideo: props.hasVideo,
          videoCodec: props.videoCodec,
          audioCodec: props.audioCodec
        },
        recommendedSettings: recommendedSettings ? {
          width: recommendedSettings.width,
          height: recommendedSettings.height,
          fps: recommendedSettings.fps,
          videoBitrate: recommendedSettings.videoBitrate,
          audioBitrate: recommendedSettings.audioBitrate,
          preset: recommendedSettings.preset || recommendedSettings.cpuUsed,
          profile: recommendedSettings.profile
        } : null,
        probeNote: props.probeNote || null
      });
    } catch (error) {
      console.error('Error probing stream:', error);
      res.status(500).json({
        error: 'Failed to probe stream',
        details: error.message
      });
    }
  });

  // ==================== STREAM DETAILS (Parameterized routes MUST be last) ====================

  /**
   * GET /api/url-stream/:urlId/logs
   * Get logs for a URL stream
   */
  router.get('/:urlId/logs', async (req, res) => {
    try {
      const { urlId } = req.params;
      const limit = parseInt(req.query.limit) || 50;

      const logs = await dbService.getLogs(urlId, limit);

      res.json(logs);

    } catch (error) {
      console.error('Error getting URL stream logs:', error);
      res.status(500).json({ error: 'Failed to get logs' });
    }
  });

  // ==================== PRESETS ====================

  /**
   * GET /api/url-stream/presets
   * Get all presets
   */
  router.get('/presets', async (req, res) => {
    try {
      const presets = await dbService.getAllPresets();
      res.json(presets);
    } catch (error) {
      console.error('Error getting presets:', error);
      res.status(500).json({ error: 'Failed to get presets' });
    }
  });

  /**
   * POST /api/url-stream/presets
   * Create a new preset
   */
  router.post('/presets', async (req, res) => {
    try {
      const { name, sourceUrl, platform, quality, displayName, autoReconnect } = req.body;

      if (!name || !sourceUrl) {
        return res.status(400).json({ error: 'Name and sourceUrl are required' });
      }

      const result = await dbService.createPreset({
        name,
        sourceUrl,
        platform,
        quality: quality || 'best',
        displayName,
        autoReconnect: autoReconnect !== false
      });

      res.json({ success: true, id: result.id });

    } catch (error) {
      console.error('Error creating preset:', error);
      res.status(500).json({ error: 'Failed to create preset' });
    }
  });

  /**
   * POST /api/url-stream/presets/:id/start
   * Start stream from preset
   */
  router.post('/presets/:id/start', async (req, res) => {
    try {
      const preset = await dbService.getPreset(req.params.id);

      if (!preset) {
        return res.status(404).json({ error: 'Preset not found' });
      }

      // Start stream using preset config
      const result = await viewBotURLService.startURLStream(preset.source_url, {
        quality: preset.quality,
        displayName: preset.display_name,
        autoReconnect: preset.auto_reconnect
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Update preset usage
      await dbService.updatePresetUsage(req.params.id);

      // Save to database
      try {
        await dbService.createURLStream({
          urlId: result.urlId,
          sourceUrl: preset.source_url,
          platform: result.platform,
          quality: preset.quality,
          displayName: preset.display_name,
          autoReconnect: preset.auto_reconnect
        });
      } catch (dbErr) {
        console.error('Failed to save URL stream to database:', dbErr);
      }

      res.json({
        success: true,
        urlId: result.urlId,
        platform: result.platform,
        title: result.title
      });

    } catch (error) {
      console.error('Error starting preset:', error);
      res.status(500).json({ error: 'Failed to start preset' });
    }
  });

  /**
   * DELETE /api/url-stream/presets/:id
   * Delete a preset
   */
  router.delete('/presets/:id', async (req, res) => {
    try {
      await dbService.deletePreset(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting preset:', error);
      res.status(500).json({ error: 'Failed to delete preset' });
    }
  });

  // ==================== TOOLS ====================

  /**
   * GET /api/url-stream/tools/status
   * Check if required tools are available
   */
  router.get('/tools/status', async (req, res) => {
    try {
      const tools = await viewBotURLService.testTools();
      res.json(tools);
    } catch (error) {
      console.error('Error checking tools:', error);
      res.status(500).json({ error: 'Failed to check tools' });
    }
  });

  /**
   * POST /api/url-stream/stop-all
   * Stop all URL streams
   */
  router.post('/stop-all', async (req, res) => {
    try {
      await viewBotURLService.stopAllURLStreams();
      res.json({ success: true });
    } catch (error) {
      console.error('Error stopping all streams:', error);
      res.status(500).json({ error: 'Failed to stop all streams' });
    }
  });

  // ==================== PARAMETERIZED ROUTES (Must be last!) ====================

  /**
   * DELETE /api/url-stream/:urlId
   * Stop a URL stream
   */
  router.delete('/:urlId', async (req, res) => {
    try {
      const { urlId } = req.params;

      const result = await viewBotURLService.stopURLStream(urlId);

      if (!result.success) {
        return res.status(404).json({ error: result.error || 'Stream not found' });
      }

      // Update database
      try {
        await dbService.updateURLStreamStatus(urlId, 'stopped', 'manual_stop');
        await dbService.addLog(urlId, 'stopped', 'URL stream stopped manually');
      } catch (dbErr) {
        console.error('Failed to update URL stream in database:', dbErr);
      }

      res.json({ success: true });

    } catch (error) {
      console.error('Error stopping URL stream:', error);
      res.status(500).json({ error: 'Failed to stop URL stream' });
    }
  });

  /**
   * GET /api/url-stream/:urlId
   * Get status of a specific URL stream
   */
  router.get('/:urlId', async (req, res) => {
    try {
      const { urlId } = req.params;

      const status = viewBotURLService.getStreamStatus(urlId);

      if (!status) {
        // Check database for historical data
        const dbRecord = await dbService.getURLStream(urlId);
        if (dbRecord) {
          return res.json({
            ...dbRecord,
            isActive: false
          });
        }
        return res.status(404).json({ error: 'Stream not found' });
      }

      // Add health info if available
      let health = null;
      if (healthService) {
        health = healthService.getHealthSummary(urlId);
      }

      res.json({
        ...status,
        health,
        isActive: true
      });

    } catch (error) {
      console.error('Error getting URL stream status:', error);
      res.status(500).json({ error: 'Failed to get stream status' });
    }
  });

  return router;
};
