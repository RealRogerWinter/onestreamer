const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'visualfx' });

const router = express.Router();

// Get all available visual effects
router.get('/effects', async (req, res) => {
  try {
    const visualFxService = req.app.get('visualFxService');
    const effects = visualFxService.getEffectRegistry();
    
    res.json({
      success: true,
      effects: effects,
      totalEffects: effects.length
    });
  } catch (error) {
    logger.error('❌ VISUALFX API: Error getting effects:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get active effects for a specific stream
router.get('/active/:streamId?', async (req, res) => {
  try {
    const visualFxService = req.app.get('visualFxService');
    const streamService = req.app.get('streamService');
    
    let streamId = req.params.streamId;
    
    // If no streamId provided, use current streamer
    if (!streamId) {
      streamId = streamService.getCurrentStreamer();
      if (!streamId) {
        return res.json({
          success: true,
          activeEffects: [],
          streamId: null,
          message: 'No active stream'
        });
      }
    }
    
    const activeEffects = visualFxService.getActiveEffects(streamId);
    
    res.json({
      success: true,
      activeEffects: activeEffects,
      streamId: streamId,
      count: activeEffects.length
    });
  } catch (error) {
    logger.error('❌ VISUALFX API: Error getting active effects:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Apply a visual effect
router.post('/apply', async (req, res) => {
  try {
    const { effectId, streamId, options = {} } = req.body;
    
    if (!effectId) {
      return res.status(400).json({
        success: false,
        error: 'effectId is required'
      });
    }
    
    const visualFxService = req.app.get('visualFxService');
    const streamService = req.app.get('streamService');
    
    // Use provided streamId or current streamer
    const targetStreamId = streamId || streamService.getCurrentStreamer();
    
    if (!targetStreamId) {
      return res.status(400).json({
        success: false,
        error: 'No active stream found'
      });
    }
    
    // Apply the effect
    const effect = await visualFxService.applyEffect(targetStreamId, effectId, {
      ...options,
      requestedViaAPI: true,
      requestTime: new Date().toISOString()
    });
    
    if (effect) {
      // Broadcast to connected clients
      const io = req.app.get('io');
      io.emit('visual-effect-applied', {
        effectId: effectId,
        effectName: effect.config.name,
        duration: effect.duration,
        streamId: targetStreamId,
        source: 'api'
      });
      
      res.json({
        success: true,
        effect: effect,
        message: `Applied effect "${effect.config.name}" to stream ${targetStreamId}`
      });
    } else {
      res.status(429).json({
        success: false,
        error: 'Effect could not be applied due to resource limits'
      });
    }
    
  } catch (error) {
    logger.error('❌ VISUALFX API: Error applying effect:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Remove a specific effect instance
router.delete('/remove/:effectInstanceId', async (req, res) => {
  try {
    const { effectInstanceId } = req.params;
    const { streamId } = req.query;
    
    if (!effectInstanceId) {
      return res.status(400).json({
        success: false,
        error: 'effectInstanceId is required'
      });
    }
    
    const visualFxService = req.app.get('visualFxService');
    const streamService = req.app.get('streamService');
    
    // Use provided streamId or current streamer
    const targetStreamId = streamId || streamService.getCurrentStreamer();
    
    if (!targetStreamId) {
      return res.status(400).json({
        success: false,
        error: 'No active stream found'
      });
    }
    
    await visualFxService.removeEffect(targetStreamId, effectInstanceId);
    
    // Broadcast to connected clients
    const io = req.app.get('io');
    io.emit('visual-effect-removed', {
      effectInstanceId,
      streamId: targetStreamId,
      source: 'api'
    });
    
    res.json({
      success: true,
      message: `Removed effect instance ${effectInstanceId} from stream ${targetStreamId}`
    });
    
  } catch (error) {
    logger.error('❌ VISUALFX API: Error removing effect:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clear all effects from a stream
router.delete('/clear/:streamId?', async (req, res) => {
  try {
    const visualFxService = req.app.get('visualFxService');
    const streamService = req.app.get('streamService');
    
    let streamId = req.params.streamId;
    
    // If no streamId provided, use current streamer
    if (!streamId) {
      streamId = streamService.getCurrentStreamer();
      if (!streamId) {
        return res.status(400).json({
          success: false,
          error: 'No active stream found'
        });
      }
    }
    
    // Get active effects to clear
    const activeEffects = visualFxService.getActiveEffects(streamId);
    
    // Remove each effect
    for (const effect of activeEffects) {
      await visualFxService.removeEffect(streamId, effect.id);
    }
    
    // Broadcast to connected clients
    const io = req.app.get('io');
    io.emit('visual-effects-cleared', {
      streamId: streamId,
      clearedCount: activeEffects.length,
      source: 'api'
    });
    
    res.json({
      success: true,
      message: `Cleared ${activeEffects.length} effects from stream ${streamId}`,
      clearedEffects: activeEffects.length
    });
    
  } catch (error) {
    logger.error('❌ VISUALFX API: Error clearing effects:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get service statistics
router.get('/stats', async (req, res) => {
  try {
    const visualFxService = req.app.get('visualFxService');
    const stats = visualFxService.getStats();
    
    res.json({
      success: true,
      stats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ VISUALFX API: Error getting stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed effect information
router.get('/effect/:effectId', async (req, res) => {
  try {
    const { effectId } = req.params;
    const visualFxService = req.app.get('visualFxService');
    
    const effects = visualFxService.getEffectRegistry();
    const effect = effects.find(e => e.id === effectId);
    
    if (!effect) {
      return res.status(404).json({
        success: false,
        error: `Effect "${effectId}" not found`
      });
    }
    
    res.json({
      success: true,
      effect: effect
    });
  } catch (error) {
    logger.error('❌ VISUALFX API: Error getting effect details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Apply preset effect combinations
router.post('/preset/:presetName', async (req, res) => {
  try {
    const { presetName } = req.params;
    const { streamId, options = {} } = req.body;
    
    const visualFxService = req.app.get('visualFxService');
    const streamService = req.app.get('streamService');
    
    // Define preset combinations
    const presets = {
      'chaos_mode': [
        { effectId: 'packet_loss_severe', delay: 0 },
        { effectId: 'resolution_240p', delay: 2000 },
        { effectId: 'static_noise', delay: 4000 },
        { effectId: 'glitch', delay: 6000 }
      ],
      'retro_mode': [
        { effectId: 'pixelate', delay: 0 },
        { effectId: 'sepia', delay: 1000 },
        { effectId: 'framerate_cinematic', delay: 2000 }
      ],
      'lag_fest': [
        { effectId: 'packet_loss_mild', delay: 0 },
        { effectId: 'jitter', delay: 3000 },
        { effectId: 'stutter', delay: 6000 }
      ],
      'artistic': [
        { effectId: 'blur', delay: 0 },
        { effectId: 'grayscale', delay: 5000 }
      ],
      'comedy_hour': [
        { effectId: 'audio_pitch_high', delay: 0 },
        { effectId: 'pixelate', delay: 2000 },
        { effectId: 'freeze_frame', delay: 10000 }
      ]
    };
    
    const preset = presets[presetName];
    if (!preset) {
      return res.status(404).json({
        success: false,
        error: `Preset "${presetName}" not found`,
        availablePresets: Object.keys(presets)
      });
    }
    
    // Use provided streamId or current streamer
    const targetStreamId = streamId || streamService.getCurrentStreamer();
    
    if (!targetStreamId) {
      return res.status(400).json({
        success: false,
        error: 'No active stream found'
      });
    }
    
    const appliedEffects = [];
    
    // Apply each effect in the preset with delays
    for (const effectConfig of preset) {
      setTimeout(async () => {
        try {
          const effect = await visualFxService.applyEffect(
            targetStreamId, 
            effectConfig.effectId, 
            {
              ...options,
              preset: presetName,
              requestedViaAPI: true
            }
          );
          
          if (effect) {
            appliedEffects.push(effect);
            
            // Broadcast effect application
            const io = req.app.get('io');
            io.emit('visual-effect-applied', {
              effectId: effectConfig.effectId,
              effectName: effect.config.name,
              duration: effect.duration,
              streamId: targetStreamId,
              source: 'preset',
              preset: presetName
            });
          }
        } catch (error) {
          logger.error(`❌ VISUALFX: Error applying preset effect ${effectConfig.effectId}:`, error);
        }
      }, effectConfig.delay);
    }
    
    res.json({
      success: true,
      preset: presetName,
      effectsScheduled: preset.length,
      streamId: targetStreamId,
      message: `Applied preset "${presetName}" to stream ${targetStreamId}`
    });
    
  } catch (error) {
    logger.error('❌ VISUALFX API: Error applying preset:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get available presets
router.get('/presets', (req, res) => {
  const presets = {
    'chaos_mode': {
      name: 'Chaos Mode',
      description: 'Maximum chaos with packet loss, low resolution, static, and glitches',
      effects: ['packet_loss_severe', 'resolution_240p', 'static_noise', 'glitch'],
      duration: '~10 seconds'
    },
    'retro_mode': {
      name: 'Retro Mode',
      description: 'Nostalgic pixelated sepia-toned cinematic experience',
      effects: ['pixelate', 'sepia', 'framerate_cinematic'],
      duration: '~30 seconds'
    },
    'lag_fest': {
      name: 'Lag Festival',
      description: 'Network simulation nightmare with packet loss, jitter, and stuttering',
      effects: ['packet_loss_mild', 'jitter', 'stutter'],
      duration: '~20 seconds'
    },
    'artistic': {
      name: 'Artistic Vision',
      description: 'Blur and grayscale for an artistic film look',
      effects: ['blur', 'grayscale'],
      duration: '~25 seconds'
    },
    'comedy_hour': {
      name: 'Comedy Hour',
      description: 'Chipmunk voice with pixelation and freeze frames for maximum comedy',
      effects: ['audio_pitch_high', 'pixelate', 'freeze_frame'],
      duration: '~25 seconds'
    }
  };
  
  res.json({
    success: true,
    presets: presets,
    totalPresets: Object.keys(presets).length
  });
});

module.exports = router;
