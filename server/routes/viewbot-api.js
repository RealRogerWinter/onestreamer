const express = require('express');
const ViewBotDatabaseService = require('../services/ViewBotDatabaseService');
const { authenticateToken, authenticateAdmin } = require('../middleware/auth');

// Create router factory function that accepts service instances
module.exports = function(viewBotClientService) {
  const router = express.Router();
  const viewBotDatabaseService = new ViewBotDatabaseService();

// Middleware for all viewbot routes
// Temporarily disabled for testing - REMOVE IN PRODUCTION
// router.use(authenticateToken);
// router.use(authenticateAdmin);

// Get all viewbots with enhanced data
router.get('/viewbots', async (req, res) => {
  try {
    const viewBots = await viewBotDatabaseService.loadAllViewBots();
    
    // Enhance with runtime metrics
    const enhancedBots = viewBots.map(bot => {
      const client = viewBotClientService ? viewBotClientService.getBotStatus(bot.botId) : null;
      
      return {
        ...bot,
        status: client ? (client.streaming ? 'streaming' : 'connected') : 'idle',
        metrics: client ? client.metrics : null,
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
    const viewBot = await viewBotDatabaseService.loadViewBot(req.params.id);
    
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
    
    // Generate bot ID
    const botId = `viewbot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Save to database
    const result = await viewBotDatabaseService.saveViewBot({
      botId,
      name: viewBotData.name,
      config: {
        contentType: viewBotData.content_type,
        contentUrl: viewBotData.content_url,
        streamName: viewBotData.stream_name,
        viewerName: viewBotData.viewer_name,
        connectionType: viewBotData.connection_type,
        isAudioEnabled: viewBotData.is_audio_enabled,
        quality: viewBotData.quality,
        volume: viewBotData.volume,
        ffmpegParams: viewBotData.ffmpeg_params
      },
      contentType: viewBotData.content_type,
      isEnabled: true,
      autoStart: false
    });
    
    res.status(201).json({ 
      id: botId,
      ...viewBotData,
      created: true 
    });
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
    
    // Update in database
    await viewBotDatabaseService.saveViewBot({
      botId: req.params.id,
      ...updates
    });
    
    const updatedViewBot = await viewBotDatabaseService.loadViewBot(req.params.id);
    
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
      await viewBotClientService.stopBotStreaming(req.params.id);
    }
    
    const success = await viewBotDatabaseService.disableViewBot(req.params.id);
    
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
    const viewBot = await viewBotDatabaseService.loadViewBot(req.params.id);
    
    if (!viewBot) {
      return res.status(404).json({ error: 'ViewBot not found' });
    }
    
    // Create the bot first
    const bot = await viewBotClientService.createBot({
      botId: viewBot.botId,
      ...viewBot.config
    });
    
    // Then start streaming
    await viewBotClientService.startBotStreaming(viewBot.botId);
    res.json({ success: true, message: 'ViewBot started' });
  } catch (error) {
    console.error('Failed to start viewbot:', error);
    res.status(500).json({ error: 'Failed to start viewbot' });
  }
});

// Stop viewbot
router.post('/viewbots/:id/stop', async (req, res) => {
  try {
    await viewBotClientService.stopBotStreaming(req.params.id);
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
        const viewBot = await viewBotDatabaseService.loadViewBot(id);
        if (viewBot) {
          await viewBotClientService.createBot({
            botId: viewBot.botId,
            ...viewBot.config
          });
          await viewBotClientService.startBotStreaming(viewBot.botId);
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

// Get rotation settings
router.get('/rotation-settings', async (req, res) => {
  try {
    const settings = viewBotClientService.getRotationSettings();
    res.json(settings);
  } catch (error) {
    console.error('Failed to fetch rotation settings:', error);
    res.status(500).json({ error: 'Failed to fetch rotation settings' });
  }
});

// Update rotation settings
router.post('/rotation-settings', async (req, res) => {
  try {
    const { rotationProbability, rotationCheckIntervalMin, rotationCheckIntervalMax } = req.body;
    
    const settings = {
      rotationProbability: rotationProbability !== undefined ? rotationProbability : viewBotClientService.rotationProbability,
      rotationCheckIntervalMin: rotationCheckIntervalMin !== undefined ? rotationCheckIntervalMin : viewBotClientService.rotationCheckIntervalMin,
      rotationCheckIntervalMax: rotationCheckIntervalMax !== undefined ? rotationCheckIntervalMax : viewBotClientService.rotationCheckIntervalMax
    };
    
    viewBotClientService.updateRotationSettings(settings);
    
    res.json({ 
      success: true, 
      settings: viewBotClientService.getRotationSettings() 
    });
  } catch (error) {
    console.error('Failed to update rotation settings:', error);
    res.status(500).json({ error: 'Failed to update rotation settings' });
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

  return router;
};