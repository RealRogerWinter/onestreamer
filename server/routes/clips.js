const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticateToken, optionalAuth, authenticateAdmin } = require('../middleware/auth');

/**
 * Clips API Routes
 * Handles clip creation, retrieval, streaming, and management
 */

// ==================== PUBLIC ENDPOINTS ====================

/**
 * GET /api/clips/status
 * Get clipping availability status (whether clips can be created right now)
 * Also includes rate limit info for the current user/IP
 */
router.get('/status', optionalAuth, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const userId = req.user ? (req.user.id || req.user.userId) : null;
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

    const status = await clipService.getClippingStatus();
    const rateLimit = clipService.getRateLimitStatus(userId, ipAddress);

    res.json({
      success: true,
      ...status,
      rateLimit
    });
  } catch (error) {
    console.error('Error getting clipping status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * GET /api/clips
 * List all public clips (paginated, with optional search)
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { page = 1, limit = 20, sort = 'recent', search = '' } = req.query;

    const result = await clipService.listClips({
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50), // Max 50 per page
      sort,
      search: search.substring(0, 100), // Limit search length
      publicOnly: true,
      status: 'ready'
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error listing clips:', error);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

/**
 * GET /api/clips/:clipId
 * Get single clip details
 */
router.get('/:clipId', optionalAuth, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { clipId } = req.params;

    const clip = await clipService.getClip(clipId);

    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    // Check if clip is public or user owns it
    if (!clip.is_public && (!req.user || clip.user_id !== req.user.id)) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    // Record view (async, don't wait)
    clipService.recordView(clipId, req.user?.id || req.user?.userId, req.ip).catch(err => {
      console.error('Error recording view:', err);
    });

    res.json({
      success: true,
      clip
    });
  } catch (error) {
    console.error('Error fetching clip:', error);
    res.status(500).json({ error: 'Failed to fetch clip' });
  }
});

/**
 * GET /api/clips/:clipId/stream
 * Stream clip video with range support
 */
router.get('/:clipId/stream', optionalAuth, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const clipStorageService = req.app.get('clipStorageService');
    const { clipId } = req.params;

    const clip = await clipService.getClip(clipId);

    if (!clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    // Check if clip is public or user owns it
    if (!clip.is_public && (!req.user || clip.user_id !== req.user.id)) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    // Check if clip is ready
    if (clip.status !== 'ready') {
      return res.status(404).json({ error: 'Clip is not ready yet' });
    }

    const clipPath = clipStorageService.getClipPath(clipId);

    if (!fs.existsSync(clipPath)) {
      console.error(`Clip file not found: ${clipPath}`);
      return res.status(404).json({ error: 'Clip file not found' });
    }

    const stat = fs.statSync(clipPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Handle range request for seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const file = fs.createReadStream(clipPath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=86400'
      });

      file.pipe(res);
    } else {
      // Full file request
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });

      fs.createReadStream(clipPath).pipe(res);
    }
  } catch (error) {
    console.error('Error streaming clip:', error);
    res.status(500).json({ error: 'Failed to stream clip' });
  }
});

/**
 * GET /api/clips/:clipId/thumbnail
 * Get clip thumbnail
 */
router.get('/:clipId/thumbnail', async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const clipStorageService = req.app.get('clipStorageService');
    const { clipId } = req.params;

    const clip = await clipService.getClip(clipId);

    if (!clip || !clip.is_public) {
      // Return default thumbnail for missing/private clips
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    const thumbnailPath = clipStorageService.getThumbnailPath(clipId);

    if (!fs.existsSync(thumbnailPath)) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
    fs.createReadStream(thumbnailPath).pipe(res);
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).json({ error: 'Failed to fetch thumbnail' });
  }
});

/**
 * GET /api/clips/user/:userId
 * Get clips by user ID
 */
router.get('/user/:userId', optionalAuth, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { userId } = req.params;

    // Only show public clips unless viewing own profile
    const publicOnly = !req.user || req.user.id !== parseInt(userId);

    const clips = await clipService.getUserClips(parseInt(userId), { publicOnly });

    res.json({
      success: true,
      clips
    });
  } catch (error) {
    console.error('Error fetching user clips:', error);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

// ==================== AUTHENTICATED ENDPOINTS ====================

/**
 * GET /api/clips/my/all
 * Get current user's clips
 */
router.get('/my/all', authenticateToken, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const userId = req.user.id || req.user.userId;

    const clips = await clipService.getUserClips(userId, { publicOnly: false });

    res.json({
      success: true,
      clips
    });
  } catch (error) {
    console.error('Error fetching user clips:', error);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

/**
 * POST /api/clips
 * Create a new clip from a recording
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { recordingId, startMs, endMs, title, description } = req.body;
    const userId = req.user.id || req.user.userId;

    // Validate required fields
    if (!recordingId || startMs === undefined || endMs === undefined || !title) {
      return res.status(400).json({
        error: 'Missing required fields: recordingId, startMs, endMs, title'
      });
    }

    const result = await clipService.createClip({
      userId,
      recordingId,
      startMs: parseInt(startMs),
      endMs: parseInt(endMs),
      title,
      description: description || ''
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error creating clip:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/clips/live
 * Create a clip from live stream (last N seconds)
 * Open to all users (authenticated or anonymous)
 * Rate limited by IP and user account
 */
router.post('/live', optionalAuth, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { duration = 30, title, description } = req.body;
    const userId = req.user ? (req.user.id || req.user.userId) : null;
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

    // Validate
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Basic input sanitization
    const sanitizedTitle = title.trim().substring(0, 100);
    const sanitizedDescription = (description || '').trim().substring(0, 500);

    const durationSeconds = parseInt(duration);
    if (isNaN(durationSeconds) || durationSeconds < 30 || durationSeconds > 120) {
      return res.status(400).json({ error: 'Duration must be between 30 and 120 seconds' });
    }

    const result = await clipService.createLiveClip({
      userId,
      ipAddress,
      durationSeconds,
      title: sanitizedTitle,
      description: sanitizedDescription
    });

    // Include rate limit info in response
    const rateLimit = clipService.getRateLimitStatus(userId, ipAddress);

    res.json({
      success: true,
      ...result,
      rateLimit
    });
  } catch (error) {
    console.error('Error creating live clip:', error);

    // Return 429 for rate limit errors
    const statusCode = error.message.includes('wait') ||
                       error.message.includes('limit') ||
                       error.message.includes('Too many')
      ? 429
      : 400;

    res.status(statusCode).json({ error: error.message });
  }
});

/**
 * PATCH /api/clips/:clipId
 * Update clip metadata
 */
router.patch('/:clipId', authenticateToken, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { clipId } = req.params;
    const { title, description, is_public } = req.body;
    const userId = req.user.id || req.user.userId;

    await clipService.updateClip(clipId, userId, { title, description, is_public });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating clip:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * DELETE /api/clips/:clipId
 * Delete a clip
 */
router.delete('/:clipId', authenticateToken, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { clipId } = req.params;
    const userId = req.user.id || req.user.userId;

    // Check if user is admin
    const isAdmin = req.userRecord?.is_admin || false;

    await clipService.deleteClip(clipId, userId, isAdmin);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting clip:', error);
    res.status(400).json({ error: error.message });
  }
});

// ==================== ADMIN ENDPOINTS ====================

/**
 * GET /api/clips/admin/stats
 * Get clip statistics (admin only)
 */
router.get('/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const clipProcessorService = req.app.get('clipProcessorService');

    const stats = await clipService.getStats();
    const processorStatus = clipProcessorService.getStatus();

    res.json({
      success: true,
      stats,
      processorStatus
    });
  } catch (error) {
    console.error('Error fetching clip stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/clips/admin/queue
 * Get processing queue (admin only)
 */
router.get('/admin/queue', authenticateAdmin, async (req, res) => {
  try {
    const clipProcessorService = req.app.get('clipProcessorService');

    const queue = clipProcessorService.getQueue();
    const status = clipProcessorService.getStatus();

    res.json({
      success: true,
      queue,
      status
    });
  } catch (error) {
    console.error('Error fetching queue:', error);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

/**
 * GET /api/clips/admin/all
 * List all clips including private (admin only)
 */
router.get('/admin/all', authenticateAdmin, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { page = 1, limit = 50, status } = req.query;

    const result = await clipService.listClips({
      page: parseInt(page),
      limit: parseInt(limit),
      publicOnly: false,
      status: status || null
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error listing all clips:', error);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

/**
 * DELETE /api/clips/admin/:clipId
 * Force delete any clip (admin only)
 */
router.delete('/admin/:clipId', authenticateAdmin, async (req, res) => {
  try {
    const clipService = req.app.get('clipService');
    const { clipId } = req.params;

    await clipService.deleteClip(clipId, null, true);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting clip:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
