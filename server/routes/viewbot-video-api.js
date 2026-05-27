const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'viewbot-video-api' });

const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    // Ensure uploads directory exists
    try {
      await fs.mkdir(uploadDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create uploads directory:', error);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename and preserve extension
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const name = path.basename(sanitized, path.extname(sanitized));
    const ext = path.extname(sanitized);
    cb(null, `${name}_${timestamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max
  },
  fileFilter: (req, file, cb) => {
    // Only allow video files
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Get list of videos
router.get('/videos', async (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    // Ensure directory exists
    try {
      await fs.access(uploadsDir);
    } catch {
      await fs.mkdir(uploadsDir, { recursive: true });
    }
    
    // Read all files
    const files = await fs.readdir(uploadsDir);
    
    // Filter for video files and get details
    const videos = [];
    for (const file of files) {
      if (file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.avi')) {
        const filePath = path.join(uploadsDir, file);
        const stats = await fs.stat(filePath);
        
        // Check if this video is currently active
        const currentBot = global.viewBotRotation?.currentBot;
        const isActive = currentBot && currentBot.mediaFile === filePath;
        
        videos.push({
          filename: file,
          path: filePath,
          size: stats.size,
          uploadDate: stats.birthtime.toISOString(),
          isActive
        });
      }
    }
    
    // Sort by upload date (newest first)
    videos.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));
    
    res.json({ 
      success: true, 
      videos,
      count: videos.length 
    });
    
  } catch (error) {
    logger.error('Failed to get videos:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve videos' 
    });
  }
});

// Upload video
router.post('/videos/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No video file provided' 
      });
    }
    
    logger.debug(`📹 Uploaded video: ${req.file.filename} (${req.file.size} bytes)`);
    
    // Reinitialize rotation service to include new video
    if (global.viewBotRotation) {
      await global.viewBotRotation.initialize();
      logger.debug('🔄 Reinitialized ViewBot rotation with new video');
    }
    
    res.json({ 
      success: true, 
      filename: req.file.filename,
      size: req.file.size,
      message: 'Video uploaded successfully' 
    });
    
  } catch (error) {
    logger.error('Upload failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Upload failed' 
    });
  }
});

// Delete video
router.delete('/videos/delete', async (req, res) => {
  try {
    const { filename } = req.body;
    
    if (!filename) {
      return res.status(400).json({ 
        success: false, 
        error: 'Filename required' 
      });
    }
    
    // Validate filename (prevent directory traversal)
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid filename' 
      });
    }
    
    const filePath = path.join(__dirname, '..', 'uploads', filename);
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ 
        success: false, 
        error: 'Video not found' 
      });
    }
    
    // Check if video is currently active
    const currentBot = global.viewBotRotation?.currentBot;
    if (currentBot && currentBot.mediaFile === filePath) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete currently active video' 
      });
    }
    
    // Delete the file
    await fs.unlink(filePath);
    logger.debug(`🗑️ Deleted video: ${filename}`);
    
    // Reinitialize rotation service
    if (global.viewBotRotation) {
      await global.viewBotRotation.initialize();
      logger.debug('🔄 Reinitialized ViewBot rotation after deletion');
    }
    
    res.json({ 
      success: true, 
      message: 'Video deleted successfully' 
    });
    
  } catch (error) {
    logger.error('Delete failed:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete video' 
    });
  }
});

// Get rotation status
router.get('/rotation/status', (req, res) => {
  try {
    const rotation = global.viewBotRotation;
    
    if (!rotation) {
      return res.json({ 
        success: true,
        status: {
          enabled: false,
          settings: {
            minRotationInterval: 60000,
            maxRotationInterval: 360000,
            cooldownDuration: 600000
          }
        }
      });
    }
    
    const status = {
      enabled: rotation.enabled,
      currentBot: rotation.currentBot?.id,
      settings: rotation.settings,
      totalVideos: rotation.bots ? rotation.bots.length : 0
    };
    
    // Calculate next rotation time if active
    if (rotation.rotationTimer && rotation.currentBot) {
      // This is approximate since we don't track exact timer start
      status.nextRotationIn = rotation.settings.minRotationInterval;
    }
    
    res.json({ 
      success: true, 
      status 
    });
    
  } catch (error) {
    logger.error('Failed to get status:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get rotation status' 
    });
  }
});

// Start rotation
router.post('/rotation/start', async (req, res) => {
  try {
    if (!global.viewBotRotation) {
      return res.status(503).json({ 
        success: false, 
        error: 'ViewBot rotation service not initialized' 
      });
    }
    
    if (global.viewBotRotation.enabled) {
      return res.json({ 
        success: true, 
        message: 'Rotation already active' 
      });
    }
    
    await global.viewBotRotation.startRotation();
    
    res.json({ 
      success: true, 
      message: 'Rotation started' 
    });
    
  } catch (error) {
    logger.error('Failed to start rotation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to start rotation' 
    });
  }
});

// Stop rotation
router.post('/rotation/stop', async (req, res) => {
  try {
    if (!global.viewBotRotation) {
      return res.status(503).json({ 
        success: false, 
        error: 'ViewBot rotation service not initialized' 
      });
    }
    
    await global.viewBotRotation.stopRotation();
    
    res.json({ 
      success: true, 
      message: 'Rotation stopped' 
    });
    
  } catch (error) {
    logger.error('Failed to stop rotation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to stop rotation' 
    });
  }
});

// Force rotation to next video
router.post('/rotation/force', async (req, res) => {
  try {
    if (!global.viewBotRotation) {
      return res.status(503).json({ 
        success: false, 
        error: 'ViewBot rotation service not initialized' 
      });
    }
    
    if (!global.viewBotRotation.enabled) {
      return res.status(400).json({ 
        success: false, 
        error: 'Rotation is not active' 
      });
    }
    
    await global.viewBotRotation.forceRotation();
    
    res.json({ 
      success: true, 
      message: 'Forced rotation to next video' 
    });
    
  } catch (error) {
    logger.error('Failed to force rotation:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to force rotation' 
    });
  }
});

module.exports = router;
