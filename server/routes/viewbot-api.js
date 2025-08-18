const express = require('express');
const router = express.Router();
const ViewBotClientService = require('../services/ViewBotClientService');
const ViewBotDatabaseService = require('../services/ViewBotDatabaseService');
const { authenticateToken, isAdmin } = require('../middleware/auth');

// Initialize services
const viewBotClientService = new ViewBotClientService();
const viewBotDatabaseService = new ViewBotDatabaseService();

// Middleware for all viewbot routes
router.use(authenticateToken);
router.use(isAdmin);

// Get all viewbots with enhanced data
router.get('/viewbots', async (req, res) => {
  try {
    const viewBots = await viewBotDatabaseService.getAllViewBots();
    
    // Enhance with runtime metrics
    const enhancedBots = viewBots.map(bot => {
      const client = viewBotClientService.getClient(bot.id);
      
      return {
        ...bot,
        status: client ? client.status : 'idle',
        metrics: client ? client.getMetrics() : null,
        settings: {
          quality: bot.quality || 'medium',
          volume: bot.volume || 50,
          ffmpegParams: bot.ffmpeg_params || ''
        }
      };
    });
    
    res.json(enhancedBots);
  } catch (error) {
    console.error('Failed to fetch viewbots:', error);
    res.status(500).json({ error: 'Failed to fetch viewbots' });
  }
});

// Get single viewbot by ID
router.get('/viewbots/:id', async (req, res) => {
  try {
    const viewBot = await viewBotDatabaseService.getViewBot(req.params.id);
    
    if (!viewBot) {
      return res.status(404).json({ error: 'ViewBot not found' });
    }
    
    const client = viewBotClientService.getClient(viewBot.id);
    
    res.json({
      ...viewBot,
      status: client ? client.status : 'idle',
      metrics: client ? client.getMetrics() : null,
      settings: {
        quality: viewBot.quality || 'medium',
        volume: viewBot.volume || 50,
        ffmpegParams: viewBot.ffmpeg_params || ''
      }
    });
  } catch (error) {
    console.error('Failed to fetch viewbot:', error);
    res.status(500).json({ error: 'Failed to fetch viewbot' });
  }
});

// Create new viewbot
router.post('/viewbots', async (req, res) => {
  try {
    const viewBotData = {
      name: req.body.name || `ViewBot ${Date.now()}`,
      content_type: req.body.contentType || 'video',
      content_url: req.body.contentUrl || '',
      stream_name: req.body.streamName,
      viewer_name: req.body.viewerName || `Viewer${Math.floor(Math.random() * 10000)}`,
      connection_type: req.body.connectionType || 'WebRTC',
      is_audio_enabled: req.body.isAudioEnabled !== false,
      tags: req.body.tags || [],
      description: req.body.description || '',
      quality: req.body.quality || 'medium',
      volume: req.body.volume || 50,
      ffmpeg_params: req.body.ffmpegParams || ''
    };
    
    const newViewBot = await viewBotDatabaseService.createViewBot(viewBotData);
    res.status(201).json(newViewBot);
  } catch (error) {
    console.error('Failed to create viewbot:', error);
    res.status(500).json({ error: 'Failed to create viewbot' });
  }
});

// Update viewbot
router.patch('/viewbots/:id', async (req, res) => {
  try {
    const updates = {};
    
    // Only update provided fields
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.contentType !== undefined) updates.content_type = req.body.contentType;
    if (req.body.contentUrl !== undefined) updates.content_url = req.body.contentUrl;
    if (req.body.streamName !== undefined) updates.stream_name = req.body.streamName;
    if (req.body.viewerName !== undefined) updates.viewer_name = req.body.viewerName;
    if (req.body.connectionType !== undefined) updates.connection_type = req.body.connectionType;
    if (req.body.isAudioEnabled !== undefined) updates.is_audio_enabled = req.body.isAudioEnabled;
    if (req.body.tags !== undefined) updates.tags = req.body.tags;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.quality !== undefined) updates.quality = req.body.quality;
    if (req.body.volume !== undefined) updates.volume = req.body.volume;
    if (req.body.ffmpegParams !== undefined) updates.ffmpeg_params = req.body.ffmpegParams;
    
    const updatedViewBot = await viewBotDatabaseService.updateViewBot(req.params.id, updates);
    
    if (!updatedViewBot) {
      return res.status(404).json({ error: 'ViewBot not found' });
    }
    
    res.json(updatedViewBot);
  } catch (error) {
    console.error('Failed to update viewbot:', error);
    res.status(500).json({ error: 'Failed to update viewbot' });
  }
});

// Delete viewbot
router.delete('/viewbots/:id', async (req, res) => {
  try {
    // Stop the bot if it's running
    const client = viewBotClientService.getClient(req.params.id);
    if (client) {
      await viewBotClientService.stopViewBot(req.params.id);
    }
    
    const success = await viewBotDatabaseService.deleteViewBot(req.params.id);
    
    if (!success) {
      return res.status(404).json({ error: 'ViewBot not found' });
    }
    
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete viewbot:', error);
    res.status(500).json({ error: 'Failed to delete viewbot' });
  }
});

// Start viewbot
router.post('/viewbots/:id/start', async (req, res) => {
  try {
    const viewBot = await viewBotDatabaseService.getViewBot(req.params.id);
    
    if (!viewBot) {
      return res.status(404).json({ error: 'ViewBot not found' });
    }
    
    await viewBotClientService.startViewBot(viewBot);
    res.json({ success: true, message: 'ViewBot started' });
  } catch (error) {
    console.error('Failed to start viewbot:', error);
    res.status(500).json({ error: 'Failed to start viewbot' });
  }
});

// Stop viewbot
router.post('/viewbots/:id/stop', async (req, res) => {
  try {
    await viewBotClientService.stopViewBot(req.params.id);
    res.json({ success: true, message: 'ViewBot stopped' });
  } catch (error) {
    console.error('Failed to stop viewbot:', error);
    res.status(500).json({ error: 'Failed to stop viewbot' });
  }
});

// Get viewbot metrics
router.get('/viewbots/:id/metrics', async (req, res) => {
  try {
    const client = viewBotClientService.getClient(req.params.id);
    
    if (!client) {
      return res.status(404).json({ error: 'ViewBot not running' });
    }
    
    const metrics = client.getMetrics();
    res.json(metrics);
  } catch (error) {
    console.error('Failed to get viewbot metrics:', error);
    res.status(500).json({ error: 'Failed to get viewbot metrics' });
  }
});

// Bulk operations
router.post('/viewbots/bulk/start', async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'IDs must be an array' });
    }
    
    const results = [];
    
    for (const id of ids) {
      try {
        const viewBot = await viewBotDatabaseService.getViewBot(id);
        if (viewBot) {
          await viewBotClientService.startViewBot(viewBot);
          results.push({ id, success: true });
        } else {
          results.push({ id, success: false, error: 'Not found' });
        }
      } catch (error) {
        results.push({ id, success: false, error: error.message });
      }
    }
    
    res.json({ results });
  } catch (error) {
    console.error('Failed to bulk start viewbots:', error);
    res.status(500).json({ error: 'Failed to bulk start viewbots' });
  }
});

router.post('/viewbots/bulk/stop', async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'IDs must be an array' });
    }
    
    const results = [];
    
    for (const id of ids) {
      try {
        await viewBotClientService.stopViewBot(id);
        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, error: error.message });
      }
    }
    
    res.json({ results });
  } catch (error) {
    console.error('Failed to bulk stop viewbots:', error);
    res.status(500).json({ error: 'Failed to bulk stop viewbots' });
  }
});

// ViewBot templates
router.get('/viewbot-templates', async (req, res) => {
  try {
    const templates = await viewBotDatabaseService.getTemplates();
    res.json(templates);
  } catch (error) {
    console.error('Failed to fetch templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

router.post('/viewbot-templates', async (req, res) => {
  try {
    const template = await viewBotDatabaseService.createTemplate(req.body);
    res.status(201).json(template);
  } catch (error) {
    console.error('Failed to create template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.delete('/viewbot-templates/:id', async (req, res) => {
  try {
    await viewBotDatabaseService.deleteTemplate(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = router;