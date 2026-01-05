const { v4: uuidv4 } = require('uuid');
const ProfanityFilterService = require('./ProfanityFilterService');

/**
 * ClipService - Business logic for clip management
 * Updated to work with continuous room recording model
 *
 * Clips are created from a continuous recording of room activity,
 * allowing users to clip the last N seconds regardless of streamer changes.
 */
class ClipService {
  constructor(database, clipStorageService, clipProcessorService, continuousRecordingService) {
    this.database = database;
    this.db = database.db;
    this.runAsync = database.runAsync;
    this.getAsync = database.getAsync;
    this.allAsync = database.allAsync;
    this.storageService = clipStorageService;
    this.processorService = clipProcessorService;
    this.continuousRecordingService = continuousRecordingService;

    // Clip constraints
    this.MIN_DURATION_MS = 30000;  // 30 seconds
    this.MAX_DURATION_MS = 120000; // 2 minutes
    this.MAX_TITLE_LENGTH = 100;
    this.MAX_DESCRIPTION_LENGTH = 500;

    // Rate limiting
    this.RATE_LIMIT_AUTHENTICATED = 10;  // 10 clips per hour for logged-in users
    this.RATE_LIMIT_ANONYMOUS = 3;       // 3 clips per hour for anonymous users
    this.RATE_LIMIT_COOLDOWN_MS = 30000; // 30 second cooldown between clip requests
    this.MAX_PROCESSING_QUEUE = 20;      // Max clips in processing queue
    this.MAX_CLIPS_PER_IP_HOUR = 5;      // Max clips per IP per hour (regardless of auth)

    // Rate limit caches
    this.userRateLimitCache = new Map();   // userId -> { count, resetTime, lastRequest }
    this.ipRateLimitCache = new Map();     // ip -> { count, resetTime, lastRequest }

    // Profanity filter for clip titles and descriptions
    this.profanityFilter = new ProfanityFilterService();

    // Cleanup old entries periodically
    setInterval(() => this.cleanupRateLimitCaches(), 15 * 60 * 1000); // Every 15 minutes
  }

  /**
   * Cleanup expired rate limit entries
   */
  cleanupRateLimitCaches() {
    const now = Date.now();

    for (const [key, value] of this.userRateLimitCache) {
      if (now > value.resetTime) {
        this.userRateLimitCache.delete(key);
      }
    }

    for (const [key, value] of this.ipRateLimitCache) {
      if (now > value.resetTime) {
        this.ipRateLimitCache.delete(key);
      }
    }

    console.log(`🧹 CLIPS: Cleaned rate limit caches (users: ${this.userRateLimitCache.size}, ips: ${this.ipRateLimitCache.size})`);
  }

  /**
   * Create a clip from the last N seconds of site activity
   * This is the primary clip creation method for the continuous recording model
   * Uses HLS segments for low-latency clipping while stream is active
   *
   * @param {Object} params - Clip creation parameters
   * @param {number} params.userId - User creating the clip (null for anonymous)
   * @param {string} params.ipAddress - IP address of the requester
   * @param {number} params.durationSeconds - How many seconds to clip (30-120)
   * @param {string} params.title - Clip title
   * @param {string} [params.description] - Optional description
   * @returns {Object} Created clip info
   */
  async createLiveClip({ userId, ipAddress, durationSeconds, title, description = '' }) {
    // Validate duration
    const durationMs = durationSeconds * 1000;
    if (durationMs < this.MIN_DURATION_MS || durationMs > this.MAX_DURATION_MS) {
      throw new Error(`Clip duration must be between ${this.MIN_DURATION_MS / 1000} and ${this.MAX_DURATION_MS / 1000} seconds`);
    }

    // Validate title
    if (!title || title.trim().length === 0) {
      throw new Error('Title is required');
    }
    if (title.length > this.MAX_TITLE_LENGTH) {
      throw new Error(`Title must be under ${this.MAX_TITLE_LENGTH} characters`);
    }

    // Check title for profanity/offensive content
    const titleValidation = this.profanityFilter.validateClipTitle(title);
    if (!titleValidation.isValid) {
      throw new Error(titleValidation.error);
    }

    // Check description for profanity/offensive content (if provided)
    if (description) {
      const descValidation = this.profanityFilter.validateClipDescription(description);
      if (!descValidation.isValid) {
        throw new Error(descValidation.error);
      }
    }

    // Check processing queue limit
    if (this.processorService) {
      const queueStatus = this.processorService.getStatus();
      if (queueStatus.queueLength >= this.MAX_PROCESSING_QUEUE) {
        throw new Error('Too many clips are being processed. Please try again in a few minutes.');
      }
    }

    // Check rate limits (both IP and user-based)
    await this.checkRateLimits(userId, ipAddress);

    // Check if continuous recording is available
    if (!this.continuousRecordingService) {
      throw new Error('Recording service not available');
    }

    // Get clippable range
    const clippableRange = await this.continuousRecordingService.getClippableRange();
    if (!clippableRange.available) {
      throw new Error('No recordings available. The stream may not be active or recording.');
    }

    // Calculate clip time range (last N seconds)
    // Use the recording's actual end time, not Date.now(), since recording is slightly behind real-time
    const endTime = Math.min(Date.now(), clippableRange.end);
    const startTime = endTime - durationMs;

    console.log(`✂️ CLIP CREATE: clippableRange = ${JSON.stringify(clippableRange)}`);
    console.log(`✂️ CLIP CREATE: Calculated clip range: ${startTime} to ${endTime}`);

    // Ensure we have enough recording
    if (startTime < clippableRange.start) {
      const availableSeconds = Math.floor((clippableRange.end - clippableRange.start) / 1000);
      throw new Error(`Only ${availableSeconds} seconds of recording available. Requested ${durationSeconds} seconds.`);
    }

    // Find segments needed for this clip
    console.log(`✂️ CLIP CREATE: Calling findSegmentsForClip(${startTime}, ${endTime})`);
    const segmentInfo = await this.continuousRecordingService.findSegmentsForClip(startTime, endTime);
    console.log(`✂️ CLIP CREATE: Found ${segmentInfo.segments?.length || 0} segments`);

    if (!segmentInfo.segments || segmentInfo.segments.length === 0) {
      throw new Error('Could not find recording segments for the requested time range');
    }

    // Generate clip ID
    const clipId = uuidv4();

    // Get session ID from first segment for recording reference
    const recordingId = segmentInfo.segments[0].sessionId;

    // Insert clip record with processing status
    await this.runAsync(`
      INSERT INTO clips (
        clip_id, recording_id, user_id, streamer_user_id, title, description,
        start_time_ms, end_time_ms, duration_ms, status
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'processing')
    `, [
      clipId, recordingId, userId,
      title.trim(), description.trim(),
      startTime, endTime, durationMs
    ]);

    // Capture chat messages for clip creation time (not recording time)
    // We use current time because chat is ephemeral and recording timestamps may be old
    const clipCreationTime = Date.now();
    const chatEndTime = clipCreationTime;
    const chatStartTime = clipCreationTime - durationMs;

    this.captureChatForClip(clipId, chatStartTime, chatEndTime).catch(err => {
      console.error(`⚠️ CLIPS: Failed to capture chat for clip ${clipId}:`, err.message);
    });

    // Queue for processing with segment info
    if (this.processorService) {
      this.processorService.queueClip({
        clipId,
        segments: segmentInfo.segments,
        clipStartMs: startTime,
        clipEndMs: endTime,
        clipDurationMs: durationMs
      });
    }

    // Increment rate limit counters
    this.incrementRateLimits(userId, ipAddress);

    console.log(`✂️ CLIPS: Created clip ${clipId} (${durationSeconds}s) from ${segmentInfo.segments.length} segments`);

    return {
      clipId,
      status: 'processing',
      durationMs,
      segmentCount: segmentInfo.segments.length
    };
  }

  /**
   * Create a clip from a specific recording with explicit time range
   * Useful for admin/manual clip creation from archived recordings
   */
  async createClipFromRecording({ userId, recordingPath, startMs, endMs, title, description = '' }) {
    // Validate inputs
    const durationMs = endMs - startMs;
    if (durationMs < this.MIN_DURATION_MS || durationMs > this.MAX_DURATION_MS) {
      throw new Error(`Clip duration must be between ${this.MIN_DURATION_MS / 1000} and ${this.MAX_DURATION_MS / 1000} seconds`);
    }

    if (!title || title.trim().length === 0) {
      throw new Error('Title is required');
    }

    // Check rate limit
    await this.checkRateLimit(userId);

    // Generate clip ID
    const clipId = uuidv4();

    // Insert clip record
    await this.runAsync(`
      INSERT INTO clips (
        clip_id, recording_id, user_id, title, description,
        start_time_ms, end_time_ms, duration_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing')
    `, [
      clipId, recordingPath, userId,
      title.trim(), description.trim(),
      startMs, endMs, durationMs
    ]);

    // Queue for processing
    if (this.processorService) {
      this.processorService.queueClip({
        clipId,
        recordingPath,
        startMs,
        endMs
      });
    }

    this.incrementRateLimit(userId);

    return { clipId, status: 'processing', durationMs };
  }

  /**
   * Get clip by ID
   */
  async getClip(clipId) {
    return await this.getAsync(`
      SELECT
        c.*,
        u.username as creator_username
      FROM clips c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.clip_id = ?
    `, [clipId]);
  }

  /**
   * List clips with pagination and optional search
   */
  async listClips(options = {}) {
    const {
      page = 1,
      limit = 20,
      sort = 'recent',
      publicOnly = true,
      status = 'ready',
      search = ''
    } = options;

    const offset = (page - 1) * limit;

    let orderBy = 'c.created_at DESC';
    if (sort === 'views') {
      orderBy = 'c.view_count DESC, c.created_at DESC';
    }

    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('c.status = ?');
      params.push(status);
    }

    if (publicOnly) {
      conditions.push('c.is_public = 1');
    }

    // Add search filter for title and description
    if (search && search.trim()) {
      const searchTerm = `%${search.trim()}%`;
      conditions.push('(c.title LIKE ? OR c.description LIKE ?)');
      params.push(searchTerm, searchTerm);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.getAsync(`
      SELECT COUNT(*) as total FROM clips c ${whereClause}
    `, params);

    const clips = await this.allAsync(`
      SELECT
        c.clip_id, c.title, c.description, c.duration_ms, c.view_count,
        c.thumbnail_path, c.status, c.is_public, c.created_at,
        u.username as creator_username
      FROM clips c
      LEFT JOIN users u ON c.user_id = u.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return {
      clips,
      pagination: {
        page,
        limit,
        total: countResult.total,
        totalPages: Math.ceil(countResult.total / limit)
      }
    };
  }

  /**
   * Get user's clips
   */
  async getUserClips(userId, options = {}) {
    const { publicOnly = false, limit = 50 } = options;
    const publicClause = publicOnly ? 'AND c.is_public = 1' : '';

    return await this.allAsync(`
      SELECT
        c.clip_id, c.title, c.description, c.duration_ms, c.view_count,
        c.thumbnail_path, c.status, c.is_public, c.created_at,
        u.username as creator_username
      FROM clips c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.user_id = ? ${publicClause}
      ORDER BY c.created_at DESC
      LIMIT ?
    `, [userId, limit]);
  }

  /**
   * Update clip metadata
   */
  async updateClip(clipId, userId, updates) {
    const clip = await this.getClip(clipId);
    if (!clip) throw new Error('Clip not found');
    if (clip.user_id !== userId) throw new Error('Not authorized');

    const allowedFields = ['title', 'description', 'is_public'];
    const setClauses = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key) && value !== undefined) {
        if (key === 'title') {
          if (!value || value.length > this.MAX_TITLE_LENGTH) {
            throw new Error(`Title must be 1-${this.MAX_TITLE_LENGTH} characters`);
          }
          // Check title for profanity/offensive content
          const titleValidation = this.profanityFilter.validateClipTitle(value);
          if (!titleValidation.isValid) {
            throw new Error(titleValidation.error);
          }
        }
        if (key === 'description' && value) {
          // Check description for profanity/offensive content
          const descValidation = this.profanityFilter.validateClipDescription(value);
          if (!descValidation.isValid) {
            throw new Error(descValidation.error);
          }
        }
        setClauses.push(`${key} = ?`);
        params.push(key === 'is_public' ? (value ? 1 : 0) : value);
      }
    }

    if (setClauses.length === 0) return false;

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(clipId);

    await this.runAsync(`UPDATE clips SET ${setClauses.join(', ')} WHERE clip_id = ?`, params);
    return true;
  }

  /**
   * Delete clip
   */
  async deleteClip(clipId, userId, isAdmin = false) {
    const clip = await this.getClip(clipId);
    if (!clip) throw new Error('Clip not found');
    if (!isAdmin && clip.user_id !== userId) throw new Error('Not authorized');

    this.storageService.deleteClip(clipId);
    await this.runAsync('DELETE FROM clip_views WHERE clip_id = ?', [clipId]);
    await this.runAsync('DELETE FROM clips WHERE clip_id = ?', [clipId]);

    console.log(`🗑️ CLIPS: Deleted clip ${clipId}`);
    return true;
  }

  /**
   * Record a view
   */
  async recordView(clipId, userId = null, ipAddress = null) {
    const recentView = await this.getAsync(`
      SELECT id FROM clip_views
      WHERE clip_id = ? AND (user_id = ? OR ip_address = ?)
        AND viewed_at > datetime('now', '-1 hour')
      LIMIT 1
    `, [clipId, userId, ipAddress]);

    if (!recentView) {
      await this.runAsync(`INSERT INTO clip_views (clip_id, user_id, ip_address) VALUES (?, ?, ?)`,
        [clipId, userId, ipAddress]);
      await this.runAsync(`UPDATE clips SET view_count = view_count + 1 WHERE clip_id = ?`, [clipId]);
    }
  }

  /**
   * Update clip after processing
   */
  async updateClipProcessingResult(clipId, data) {
    const { status, filePath, thumbnailPath, fileSize, error } = data;

    if (status === 'ready') {
      await this.runAsync(`
        UPDATE clips SET
          status = 'ready', file_path = ?, thumbnail_path = ?, file_size = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE clip_id = ?
      `, [filePath, thumbnailPath, fileSize, clipId]);
      console.log(`✅ CLIPS: Clip ${clipId} ready`);
    } else if (status === 'failed') {
      await this.runAsync(`UPDATE clips SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE clip_id = ?`, [clipId]);
      console.error(`❌ CLIPS: Clip ${clipId} failed: ${error}`);
    }
  }

  /**
   * Get clipping availability info (for UI)
   */
  async getClippingStatus() {
    if (!this.continuousRecordingService) {
      return { available: false, reason: 'Recording service not configured' };
    }

    const status = this.continuousRecordingService.getStatus();
    const range = await this.continuousRecordingService.getClippableRange();

    return {
      available: range.available,
      isRecording: status.isRecording,
      availableDuration: range.duration,
      maxClipDuration: this.MAX_DURATION_MS,
      minClipDuration: this.MIN_DURATION_MS
    };
  }

  /**
   * Check rate limits for both IP and user
   * @param {number|null} userId - User ID (null for anonymous)
   * @param {string} ipAddress - IP address
   */
  async checkRateLimits(userId, ipAddress) {
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;

    // 1. Check IP-based rate limit (applies to everyone)
    if (ipAddress) {
      let ipLimit = this.ipRateLimitCache.get(ipAddress);

      if (!ipLimit || now > ipLimit.resetTime) {
        ipLimit = { count: 0, resetTime: now + hourMs, lastRequest: 0 };
        this.ipRateLimitCache.set(ipAddress, ipLimit);
      }

      // Check cooldown (prevent rapid requests from same IP)
      const timeSinceLastRequest = now - ipLimit.lastRequest;
      if (ipLimit.lastRequest > 0 && timeSinceLastRequest < this.RATE_LIMIT_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((this.RATE_LIMIT_COOLDOWN_MS - timeSinceLastRequest) / 1000);
        throw new Error(`Please wait ${waitSeconds} seconds before creating another clip.`);
      }

      // Check hourly limit per IP
      if (ipLimit.count >= this.MAX_CLIPS_PER_IP_HOUR) {
        const mins = Math.ceil((ipLimit.resetTime - now) / 60000);
        throw new Error(`Too many clips from this location. Try again in ${mins} minutes.`);
      }
    }

    // 2. Check user-based rate limit (different limits for authenticated vs anonymous)
    const rateKey = userId ? `user_${userId}` : `anon_${ipAddress}`;
    const rateLimit = userId ? this.RATE_LIMIT_AUTHENTICATED : this.RATE_LIMIT_ANONYMOUS;

    let userLimit = this.userRateLimitCache.get(rateKey);

    if (!userLimit || now > userLimit.resetTime) {
      userLimit = { count: 0, resetTime: now + hourMs, lastRequest: 0 };
      this.userRateLimitCache.set(rateKey, userLimit);
    }

    // Check user-specific cooldown
    const timeSinceUserRequest = now - userLimit.lastRequest;
    if (userLimit.lastRequest > 0 && timeSinceUserRequest < this.RATE_LIMIT_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((this.RATE_LIMIT_COOLDOWN_MS - timeSinceUserRequest) / 1000);
      throw new Error(`Please wait ${waitSeconds} seconds before creating another clip.`);
    }

    if (userLimit.count >= rateLimit) {
      const mins = Math.ceil((userLimit.resetTime - now) / 60000);
      const message = userId
        ? `You've reached the hourly clip limit (${rateLimit}). Try again in ${mins} minutes.`
        : `Anonymous users can create ${rateLimit} clips per hour. Sign in for more, or try again in ${mins} minutes.`;
      throw new Error(message);
    }
  }

  /**
   * Increment rate limit counters after successful clip creation
   * @param {number|null} userId - User ID (null for anonymous)
   * @param {string} ipAddress - IP address
   */
  incrementRateLimits(userId, ipAddress) {
    const now = Date.now();

    // Increment IP counter
    if (ipAddress) {
      const ipLimit = this.ipRateLimitCache.get(ipAddress);
      if (ipLimit) {
        ipLimit.count++;
        ipLimit.lastRequest = now;
      }
    }

    // Increment user counter
    const rateKey = userId ? `user_${userId}` : `anon_${ipAddress}`;
    const userLimit = this.userRateLimitCache.get(rateKey);
    if (userLimit) {
      userLimit.count++;
      userLimit.lastRequest = now;
    }
  }

  /**
   * Get current rate limit status for a user/IP
   * @param {number|null} userId - User ID
   * @param {string} ipAddress - IP address
   * @returns {Object} Rate limit status
   */
  getRateLimitStatus(userId, ipAddress) {
    const now = Date.now();
    const rateKey = userId ? `user_${userId}` : `anon_${ipAddress}`;
    const rateLimit = userId ? this.RATE_LIMIT_AUTHENTICATED : this.RATE_LIMIT_ANONYMOUS;

    const userLimit = this.userRateLimitCache.get(rateKey);
    const ipLimit = ipAddress ? this.ipRateLimitCache.get(ipAddress) : null;

    const userRemaining = userLimit ? Math.max(0, rateLimit - userLimit.count) : rateLimit;
    const ipRemaining = ipLimit ? Math.max(0, this.MAX_CLIPS_PER_IP_HOUR - ipLimit.count) : this.MAX_CLIPS_PER_IP_HOUR;

    const userCooldown = userLimit?.lastRequest
      ? Math.max(0, this.RATE_LIMIT_COOLDOWN_MS - (now - userLimit.lastRequest))
      : 0;
    const ipCooldown = ipLimit?.lastRequest
      ? Math.max(0, this.RATE_LIMIT_COOLDOWN_MS - (now - ipLimit.lastRequest))
      : 0;

    return {
      remaining: Math.min(userRemaining, ipRemaining),
      limit: rateLimit,
      cooldownMs: Math.max(userCooldown, ipCooldown),
      resetTime: userLimit?.resetTime || null
    };
  }

  /**
   * Get statistics
   */
  async getStats() {
    const stats = await this.getAsync(`
      SELECT
        COUNT(*) as total_clips,
        SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_clips,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_clips,
        SUM(view_count) as total_views,
        SUM(file_size) as total_size
      FROM clips
    `);

    return {
      ...stats,
      storage: this.storageService.getStorageStats()
    };
  }

  /**
   * Capture chat messages for a clip's time range
   * Fetches from chat service API and stores with relative offsets for playback
   * @param {string} clipId - The clip ID
   * @param {number} startTimeMs - Clip start time (unix ms)
   * @param {number} endTimeMs - Clip end time (unix ms)
   */
  async captureChatForClip(clipId, startTimeMs, endTimeMs) {
    const contextMs = 30000; // 30 seconds of context before clip starts

    console.log(`💬 CLIPS: Capturing chat for clip ${clipId} from ${new Date(startTimeMs).toISOString()} to ${new Date(endTimeMs).toISOString()}`);

    try {
      // Fetch chat from chat service API
      const chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
      const axios = require('axios');

      const response = await axios.get(`${chatServiceUrl}/api/chat-history`, {
        params: {
          since: startTimeMs,
          until: endTimeMs,
          contextMs: contextMs
        },
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        timeout: 5000
      });

      if (!response.data.success || !response.data.messages || response.data.messages.length === 0) {
        console.log(`💬 CLIPS: No chat messages found for clip ${clipId}`);
        return { captured: 0 };
      }

      const messages = response.data.messages;
      console.log(`💬 CLIPS: Found ${messages.length} chat messages for clip ${clipId}`);

      // Insert messages with relative timestamps
      let insertedCount = 0;
      for (const msg of messages) {
        try {
          // Calculate relative offset from clip start (context messages will have negative values, which we floor to 0)
          const msgTimeMs = msg.timestampMs || new Date(msg.timestamp).getTime();
          // For context messages (before clip start), use negative relative time
          // Frontend will show these immediately when clip starts
          const relativeTimeMs = msg.isContext ? -(startTimeMs - msgTimeMs) : Math.max(0, msgTimeMs - startTimeMs);

          await this.runAsync(`
            INSERT INTO clip_chat_messages (clip_id, username, message, relative_time_ms, original_timestamp)
            VALUES (?, ?, ?, ?, ?)
          `, [clipId, msg.username, msg.message, relativeTimeMs, msg.timestamp]);

          insertedCount++;
        } catch (err) {
          console.error(`💬 CLIPS: Error inserting chat message:`, err.message);
        }
      }

      console.log(`💬 CLIPS: Captured ${insertedCount} chat messages for clip ${clipId}`);
      return { captured: insertedCount };
    } catch (err) {
      console.error(`💬 CLIPS: Error fetching chat from chat service:`, err.message);
      return { captured: 0, error: err.message };
    }
  }

  /**
   * Get chat messages for a clip (for playback)
   * @param {string} clipId - The clip ID
   * @returns {Array} Chat messages with relative timestamps
   */
  async getClipChat(clipId) {
    const messages = await this.allAsync(`
      SELECT username, message, relative_time_ms, original_timestamp
      FROM clip_chat_messages
      WHERE clip_id = ?
      ORDER BY relative_time_ms ASC
    `, [clipId]);

    return messages || [];
  }

  /**
   * Get chat message count for a clip
   * @param {string} clipId - The clip ID
   * @returns {number} Number of chat messages
   */
  async getClipChatCount(clipId) {
    const result = await this.getAsync(`
      SELECT COUNT(*) as count FROM clip_chat_messages WHERE clip_id = ?
    `, [clipId]);
    return result?.count || 0;
  }
}

module.exports = ClipService;
