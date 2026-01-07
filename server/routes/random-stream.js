/**
 * Random Stream Rotation API Routes
 *
 * Endpoints for managing random Twitch stream rotation
 */

const express = require('express');

/**
 * Create random stream router
 * @param {RandomStreamRotationService} rotationService - The rotation service
 */
module.exports = function(rotationService) {
  const router = express.Router();

  // ==================== STATUS ====================

  /**
   * GET /api/random-stream/status
   * Get current rotation status
   */
  router.get('/status', (req, res) => {
    try {
      const status = rotationService.getStatus();
      res.json(status);
    } catch (error) {
      console.error('Error getting random stream status:', error);
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // ==================== CONTROL ====================

  /**
   * POST /api/random-stream/start
   * Start the random stream rotation
   */
  router.post('/start', async (req, res) => {
    try {
      const result = await rotationService.start();

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        message: 'Random stream rotation started',
        stream: result.stream
      });

    } catch (error) {
      console.error('Error starting random stream rotation:', error);
      res.status(500).json({ error: error.message || 'Failed to start rotation' });
    }
  });

  /**
   * POST /api/random-stream/stop
   * Stop the random stream rotation
   */
  router.post('/stop', async (req, res) => {
    try {
      const result = await rotationService.stop();

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        message: 'Random stream rotation stopped'
      });

    } catch (error) {
      console.error('Error stopping random stream rotation:', error);
      res.status(500).json({ error: 'Failed to stop rotation' });
    }
  });

  /**
   * POST /api/random-stream/rotate
   * Force rotate to next stream immediately
   */
  router.post('/rotate', async (req, res) => {
    try {
      const result = await rotationService.forceRotate();

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        message: 'Rotated to new stream',
        stream: result.stream
      });

    } catch (error) {
      console.error('Error forcing rotation:', error);
      res.status(500).json({ error: 'Failed to rotate' });
    }
  });

  // ==================== SETTINGS ====================

  /**
   * GET /api/random-stream/settings
   * Get current settings
   */
  router.get('/settings', (req, res) => {
    try {
      const status = rotationService.getStatus();
      res.json(status.settings);
    } catch (error) {
      console.error('Error getting settings:', error);
      res.status(500).json({ error: 'Failed to get settings' });
    }
  });

  /**
   * PUT /api/random-stream/settings
   * Update settings
   */
  router.put('/settings', (req, res) => {
    try {
      const {
        minRotationMinutes,
        maxRotationMinutes,
        language,
        minViewers,
        maxViewers,
        blockedCategories,
        platforms,
        platformWeight
      } = req.body;

      const updates = {};

      if (minRotationMinutes !== undefined) {
        updates.minRotationMinutes = Math.max(1, Math.min(60, parseInt(minRotationMinutes)));
      }
      if (maxRotationMinutes !== undefined) {
        updates.maxRotationMinutes = Math.max(1, Math.min(120, parseInt(maxRotationMinutes)));
      }
      if (language !== undefined) {
        updates.language = language;
      }
      if (minViewers !== undefined) {
        updates.minViewers = Math.max(0, parseInt(minViewers));
      }
      if (maxViewers !== undefined) {
        updates.maxViewers = Math.max(1, parseInt(maxViewers));
      }
      if (blockedCategories !== undefined && Array.isArray(blockedCategories)) {
        updates.blockedCategories = blockedCategories;
      }
      if (platforms !== undefined && Array.isArray(platforms)) {
        // Validate platforms - only allow 'twitch' and 'kick'
        const validPlatforms = platforms.filter(p => ['twitch', 'kick'].includes(p));
        if (validPlatforms.length > 0) {
          updates.platforms = validPlatforms;
        }
      }
      if (platformWeight !== undefined && typeof platformWeight === 'object') {
        updates.platformWeight = {
          twitch: Math.max(0, Math.min(100, parseInt(platformWeight.twitch) || 50)),
          kick: Math.max(0, Math.min(100, parseInt(platformWeight.kick) || 50))
        };
      }

      const newSettings = rotationService.updateSettings(updates);
      res.json({
        success: true,
        settings: newSettings
      });

    } catch (error) {
      console.error('Error updating settings:', error);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // ==================== HISTORY ====================

  /**
   * GET /api/random-stream/history
   * Get stream history
   */
  router.get('/history', (req, res) => {
    try {
      const history = rotationService.getHistory();
      res.json(history);
    } catch (error) {
      console.error('Error getting history:', error);
      res.status(500).json({ error: 'Failed to get history' });
    }
  });

  /**
   * DELETE /api/random-stream/history
   * Clear history and stats
   */
  router.delete('/history', (req, res) => {
    try {
      rotationService.clearStats();
      res.json({ success: true, message: 'History cleared' });
    } catch (error) {
      console.error('Error clearing history:', error);
      res.status(500).json({ error: 'Failed to clear history' });
    }
  });

  // ==================== TEST ENDPOINTS ====================

  /**
   * POST /api/random-stream/test/find-streamer
   * Test finding a random streamer without connecting
   * Supports platform query param: 'twitch', 'kick', or 'any' (default)
   */
  router.post('/test/find-streamer', async (req, res) => {
    try {
      const platform = req.body.platform || 'any';
      let streamer = null;

      if (platform === 'twitch' || platform === 'any') {
        if (rotationService.twitchService.isConfigured()) {
          streamer = await rotationService.twitchService.findRandomStreamer({
            language: req.body.language || 'en',
            minViewers: req.body.minViewers || 1,
            maxViewers: req.body.maxViewers || 999999
          });
        }
      }

      if (!streamer && (platform === 'kick' || platform === 'any')) {
        streamer = await rotationService.kickService.findRandomStreamer({
          minViewers: req.body.minViewers || 1,
          maxViewers: req.body.maxViewers || 999999
        });
      }

      if (!streamer) {
        return res.status(404).json({ error: 'No suitable streamer found' });
      }

      // Generate an animal name for preview
      const animalName = rotationService.generateAnimalName();

      res.json({
        success: true,
        streamer,
        suggestedName: animalName
      });

    } catch (error) {
      console.error('Error testing find streamer:', error);
      res.status(500).json({ error: error.message || 'Failed to find streamer' });
    }
  });

  /**
   * POST /api/random-stream/test/find-kick-streamer
   * Test finding a random Kick streamer specifically
   */
  router.post('/test/find-kick-streamer', async (req, res) => {
    try {
      const streamer = await rotationService.kickService.findRandomStreamer({
        minViewers: req.body.minViewers || 1,
        maxViewers: req.body.maxViewers || 999999
      });

      if (!streamer) {
        return res.status(404).json({ error: 'No suitable Kick streamer found' });
      }

      // Generate an animal name for preview
      const animalName = rotationService.generateAnimalName();

      res.json({
        success: true,
        streamer,
        suggestedName: animalName
      });

    } catch (error) {
      console.error('Error testing find Kick streamer:', error);
      res.status(500).json({ error: error.message || 'Failed to find Kick streamer' });
    }
  });

  /**
   * GET /api/random-stream/test/generate-name
   * Generate a random animal name
   */
  router.get('/test/generate-name', (req, res) => {
    try {
      const name = rotationService.generateAnimalName();
      res.json({ name });
    } catch (error) {
      console.error('Error generating name:', error);
      res.status(500).json({ error: 'Failed to generate name' });
    }
  });

  /**
   * GET /api/random-stream/current-channel
   * Get info about the currently playing random channel
   * Used by !channel command
   */
  router.get('/current-channel', (req, res) => {
    try {
      const status = rotationService.getStatus();

      if (!status.enabled || !status.currentStream) {
        return res.json({
          success: false,
          active: false,
          message: 'Random rotation is not currently active'
        });
      }

      const stream = status.currentStream;
      const platformIcon = stream.platform === 'kick' ? '🟢' : '🟣';
      const platformName = stream.platform === 'kick' ? 'Kick' : 'Twitch';

      res.json({
        success: true,
        active: true,
        channel: {
          displayName: stream.displayName,
          streamerUsername: stream.streamerUsername,
          streamerDisplayName: stream.streamerDisplayName,
          platform: stream.platform,
          platformName: platformName,
          platformIcon: platformIcon,
          url: stream.url,
          game: stream.game,
          startedAt: stream.startedAt
        }
      });
    } catch (error) {
      console.error('Error getting current channel:', error);
      res.status(500).json({ error: 'Failed to get current channel' });
    }
  });

  return router;
};
