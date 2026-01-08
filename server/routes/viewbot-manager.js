/**
 * ViewBot Manager API Routes
 * 
 * Provides endpoints to control viewbot mode (WebRTC vs Plain RTP)
 */

const express = require('express');
const router = express.Router();

// This will be initialized by the server
let viewBotManager = null;

/**
 * Initialize router with ViewBotManager instance
 */
function initializeRoutes(manager) {
  viewBotManager = manager;
  console.log('✅ ViewBot Manager routes initialized');
  return router;
}

/**
 * Get current status
 */
router.get('/status', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    const status = viewBotManager.getStatus();
    res.json(status);
    
  } catch (error) {
    console.error('❌ Failed to get viewbot status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Toggle between WebRTC and Plain RTP mode
 */
router.post('/toggle-mode', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    const { useWebRTC } = req.body;
    
    if (typeof useWebRTC !== 'boolean') {
      return res.status(400).json({ 
        error: 'useWebRTC must be a boolean' 
      });
    }
    
    await viewBotManager.toggleMode(useWebRTC);
    
    res.json({ 
      success: true, 
      mode: useWebRTC ? 'WebRTC' : 'Plain RTP',
      message: `Switched to ${useWebRTC ? 'WebRTC (mobile compatible)' : 'Plain RTP (desktop only)'} mode`
    });
    
  } catch (error) {
    console.error('❌ Failed to toggle viewbot mode:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a new viewbot
 */
router.post('/create', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    const { botId, videoFile } = req.body;
    
    if (!botId) {
      return res.status(400).json({ 
        error: 'botId is required' 
      });
    }
    
    const bot = await viewBotManager.createBot(botId, videoFile);
    
    res.json({ 
      success: true, 
      botId,
      mode: viewBotManager.config.useWebRTC ? 'WebRTC' : 'Plain RTP'
    });
    
  } catch (error) {
    console.error('❌ Failed to create viewbot:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start a viewbot streaming
 */
router.post('/start/:botId', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    const { botId } = req.params;
    
    await viewBotManager.startBot(botId);
    
    res.json({ 
      success: true, 
      botId,
      message: 'ViewBot started streaming'
    });
    
  } catch (error) {
    console.error('❌ Failed to start viewbot:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stop a viewbot streaming
 */
router.post('/stop/:botId', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    const { botId } = req.params;
    
    await viewBotManager.stopBot(botId);
    
    res.json({ 
      success: true, 
      botId,
      message: 'ViewBot stopped streaming'
    });
    
  } catch (error) {
    console.error('❌ Failed to stop viewbot:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Destroy a viewbot
 */
router.delete('/:botId', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    const { botId } = req.params;
    
    await viewBotManager.destroyBot(botId);
    
    res.json({ 
      success: true, 
      botId,
      message: 'ViewBot destroyed'
    });
    
  } catch (error) {
    console.error('❌ Failed to destroy viewbot:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start rotation
 */
router.post('/rotation/start', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    viewBotManager.startRotation();
    
    res.json({ 
      success: true,
      message: 'Rotation started'
    });
    
  } catch (error) {
    console.error('❌ Failed to start rotation:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stop rotation
 */
router.post('/rotation/stop', async (req, res) => {
  try {
    if (!viewBotManager) {
      return res.status(503).json({ 
        error: 'ViewBot Manager not initialized' 
      });
    }
    
    viewBotManager.stopRotation();
    
    res.json({ 
      success: true,
      message: 'Rotation stopped'
    });
    
  } catch (error) {
    console.error('❌ Failed to stop rotation:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = initializeRoutes;