const { v4: uuidv4 } = require('uuid');
const ProfanityFilterService = require('./ProfanityFilterService');
const ClipRepository = require('../database/repository/ClipRepository');
// CH3: shared helper resolves CHAT_SERVICE_URL and attaches the
// X-Internal-Secret header (+ https agent + timeout) to chat-service calls.
const { chatServiceUrl: resolveChatServiceUrl, chatAxiosConfig } = require('../utils/chatServiceClient');

const logger = require('../bootstrap/logger').child({ svc: 'ClipService' });
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
    // PR 7.1 (ADR-0015): atomic-wrap helper for multi-statement writes.
    // recordView + deleteClip use it; the per-clip JOIN reads that stay
    // inline don't need it.
    this.withTransaction = database.withTransaction;
    // PR 10.2 (Phase 10): pure-SQL wrapper for clips / clip_views /
    // clip_chat_messages. The 3 cross-table JOINs against `users`
    // (getClip / listClips / getUserClips) intentionally stay inline
    // per the single-domain-repo convention (see ClipRepository's
    // class JSDoc).
    this.clipRepository = new ClipRepository({
      getAsync: this.getAsync,
      runAsync: this.runAsync,
      allAsync: this.allAsync,
    });
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

    // Cleanup old entries periodically. Guarded unref: under jest fake
    // timers the stub handle may lack unref, and the timer must never be
    // the only thing keeping a process alive (audit B6).
    this._rateLimitCleanupTimer = setInterval(() => this.cleanupRateLimitCaches(), 15 * 60 * 1000); // Every 15 minutes
    if (typeof this._rateLimitCleanupTimer.unref === 'function') this._rateLimitCleanupTimer.unref();
  }

  /**
   * Stop the rate-limit cache cleanup interval (tests/shutdown).
   */
  stopRateLimitCleanup() {
    if (this._rateLimitCleanupTimer) {
      clearInterval(this._rateLimitCleanupTimer);
      this._rateLimitCleanupTimer = null;
    }
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

    logger.debug(`🧹 CLIPS: Cleaned rate limit caches (users: ${this.userRateLimitCache.size}, ips: ${this.ipRateLimitCache.size})`);
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

    // P2.3/R10: hard precondition BEFORE any DB write. Previously a falsy
    // processorService silently skipped queueing after the insert, leaving
    // a permanently-stuck 'processing' row.
    if (!this.processorService) {
      throw new Error('Clip processing is unavailable right now. Please try again later.');
    }

    // Check processing queue limit
    {
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

    logger.debug(`✂️ CLIP CREATE: clippableRange = ${JSON.stringify(clippableRange)}`);
    logger.debug(`✂️ CLIP CREATE: Calculated clip range: ${startTime} to ${endTime}`);

    // Ensure we have enough recording
    if (startTime < clippableRange.start) {
      const availableSeconds = Math.floor((clippableRange.end - clippableRange.start) / 1000);
      throw new Error(`Only ${availableSeconds} seconds of recording available. Requested ${durationSeconds} seconds.`);
    }

    // Find segments needed for this clip
    logger.debug(`✂️ CLIP CREATE: Calling findSegmentsForClip(${startTime}, ${endTime})`);
    const segmentInfo = await this.continuousRecordingService.findSegmentsForClip(startTime, endTime);
    logger.debug(`✂️ CLIP CREATE: Found ${segmentInfo.segments?.length || 0} segments`);

    if (!segmentInfo.segments || segmentInfo.segments.length === 0) {
      throw new Error('Could not find recording segments for the requested time range');
    }

    // Generate clip ID
    const clipId = uuidv4();

    // Get session ID from first segment for recording reference
    const recordingId = segmentInfo.segments[0].sessionId;

    // Insert clip record with processing status
    await this.clipRepository.insertClip({
      clipId,
      recordingId,
      userId,
      streamerUserId: null,
      title: title.trim(),
      description: description.trim(),
      startMs: startTime,
      endMs: endTime,
      durationMs,
    });

    // Queue for processing with segment info. P2.3/R10: fail CLOSED — a
    // queue failure marks the row 'failed' (invisible to the public list,
    // which filters status='ready') instead of leaving a stuck 'processing'
    // row; the rethrow also skips the rate-limit charge below. The
    // insert-before-queue ordering is deliberate: the processor's completion
    // callback UPDATEs the row, so it must exist first.
    try {
      this.processorService.queueClip({
        clipId,
        segments: segmentInfo.segments,
        clipStartMs: startTime,
        clipEndMs: endTime,
        clipDurationMs: durationMs
      });
    } catch (err) {
      logger.error({ err }, `✂️ CLIPS: Failed to queue clip ${clipId} - marking failed`);
      await this.clipRepository.setClipFailed(clipId);
      throw new Error('Failed to queue clip for processing. Please try again.');
    }

    // Capture chat messages for clip creation time (not recording time).
    // We use current time because chat is ephemeral and recording timestamps
    // may be old. (P2.3: moved after the queue — don't capture chat for a
    // clip that failed to queue.)
    const clipCreationTime = Date.now();
    const chatEndTime = clipCreationTime;
    const chatStartTime = clipCreationTime - durationMs;

    this.captureChatForClip(clipId, chatStartTime, chatEndTime).catch(err => {
      logger.error(`⚠️ CLIPS: Failed to capture chat for clip ${clipId}:`, err.message);
    });

    // Increment rate limit counters
    this.incrementRateLimits(userId, ipAddress);

    logger.debug(`✂️ CLIPS: Created clip ${clipId} (${durationSeconds}s) from ${segmentInfo.segments.length} segments`);

    return {
      clipId,
      status: 'processing',
      durationMs,
      segmentCount: segmentInfo.segments.length
    };
  }

  // (P2.3/R10: createClipFromRecording was deleted — it was dead three ways:
  // it called nonexistent checkRateLimit/incrementRateLimit, its only caller
  // passed sessionId where it expected recordingPath, and the processor only
  // handles segment-jobs. Per-run dirs (ADR-0028) are rm -rf'd after upload,
  // so from-recording clipping would be a new B2-download feature, not a fix.)

  /**
   * Get clip by ID. **Inline by design** (PR 10.2 / Phase 10): the
   * `LEFT JOIN users` is a presentation-layer enrichment (creator
   * username for display); cross-table queries stay in the service
   * per the single-domain repository convention.
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
   * List clips with pagination and optional search. **Inline by design**
   * (PR 10.2 / Phase 10): the SELECT does a `LEFT JOIN users` for the
   * creator-username field, and the matching `COUNT(*)` runs against
   * the same dynamic WHERE — keeping the WHERE-builder colocated with
   * both queries beats duplicating it across the service and a repo.
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
   * Get user's clips. **Inline by design** (PR 10.2 / Phase 10): same
   * reason as `getClip` / `listClips` — the `LEFT JOIN users` is a
   * presentation-layer enrichment.
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
    const fieldValues = {};

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
        fieldValues[key] = key === 'is_public' ? (value ? 1 : 0) : value;
      }
    }

    if (Object.keys(fieldValues).length === 0) return false;

    await this.clipRepository.updateClipFields(clipId, fieldValues);
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

    // PR 10.2 / ADR-0015: the legacy code ran the two DELETEs as
    // back-to-back fire-and-await runAsync calls. If the process
    // crashed between them, clip_views rows could orphan against a
    // deleted clip row, or vice-versa. Wrap both in a withTransaction
    // scope so the deletion is observably all-or-nothing.
    await this.withTransaction(async (tx) => {
      const txRepo = new ClipRepository(tx);
      await txRepo.deleteViewsByClipId(clipId);
      await txRepo.deleteClipById(clipId);
    });

    logger.debug(`🗑️ CLIPS: Deleted clip ${clipId}`);
    return true;
  }

  /**
   * Record a view
   */
  async recordView(clipId, userId = null, ipAddress = null) {
    const recentView = await this.clipRepository.findRecentView({ clipId, userId, ipAddress });

    if (!recentView) {
      // PR 10.2 / ADR-0015: the legacy code ran the audit-log INSERT
      // and the view_count UPDATE as back-to-back un-wrapped calls. A
      // crash between them produces a clip_views row without the
      // matching counter bump (or vice-versa). Wrap both in a
      // withTransaction scope so the audit and the counter commit
      // together. view_count is bumped via the PR 5.1 / ADR-0013a
      // atomic-counter shape (`view_count = view_count + 1`).
      await this.withTransaction(async (tx) => {
        const txRepo = new ClipRepository(tx);
        await txRepo.insertView({ clipId, userId, ipAddress });
        await txRepo.incrementViewCount(clipId);
      });
    }
  }

  /**
   * Update clip after processing
   */
  async updateClipProcessingResult(clipId, data) {
    const { status, filePath, thumbnailPath, fileSize, error } = data;

    if (status === 'ready') {
      await this.clipRepository.setClipReady(clipId, { filePath, thumbnailPath, fileSize });
      logger.debug(`✅ CLIPS: Clip ${clipId} ready`);
    } else if (status === 'failed') {
      await this.clipRepository.setClipFailed(clipId);
      logger.error(`❌ CLIPS: Clip ${clipId} failed: ${error}`);
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
    const stats = await this.clipRepository.getStats();

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

    logger.debug(`💬 CLIPS: Capturing chat for clip ${clipId} from ${new Date(startTimeMs).toISOString()} to ${new Date(endTimeMs).toISOString()}`);

    try {
      // Fetch chat from chat service API (CH3: chatAxiosConfig attaches the
      // X-Internal-Secret header + https agent + 5s timeout)
      const chatServiceUrl = resolveChatServiceUrl('https://127.0.0.1:8444');
      const axios = require('axios');

      const response = await axios.get(`${chatServiceUrl}/api/chat-history`, chatAxiosConfig(chatServiceUrl, {
        params: {
          since: startTimeMs,
          until: endTimeMs,
          contextMs: contextMs
        }
      }));

      if (!response.data.success || !response.data.messages || response.data.messages.length === 0) {
        logger.debug(`💬 CLIPS: No chat messages found for clip ${clipId}`);
        return { captured: 0 };
      }

      const messages = response.data.messages;
      logger.debug(`💬 CLIPS: Found ${messages.length} chat messages for clip ${clipId}`);

      // Insert messages with relative timestamps
      let insertedCount = 0;
      for (const msg of messages) {
        try {
          // Calculate relative offset from clip start (context messages will have negative values, which we floor to 0)
          const msgTimeMs = msg.timestampMs || new Date(msg.timestamp).getTime();
          // For context messages (before clip start), use negative relative time
          // Frontend will show these immediately when clip starts
          const relativeTimeMs = msg.isContext ? -(startTimeMs - msgTimeMs) : Math.max(0, msgTimeMs - startTimeMs);

          await this.clipRepository.insertClipChatMessage({
            clipId,
            username: msg.username,
            message: msg.message,
            relativeTimeMs,
            originalTimestamp: msg.timestamp,
          });

          insertedCount++;
        } catch (err) {
          logger.error(`💬 CLIPS: Error inserting chat message:`, err.message);
        }
      }

      logger.debug(`💬 CLIPS: Captured ${insertedCount} chat messages for clip ${clipId}`);
      return { captured: insertedCount };
    } catch (err) {
      logger.error(`💬 CLIPS: Error fetching chat from chat service:`, err.message);
      return { captured: 0, error: err.message };
    }
  }

  /**
   * Get chat messages for a clip (for playback)
   * @param {string} clipId - The clip ID
   * @returns {Array} Chat messages with relative timestamps
   */
  async getClipChat(clipId) {
    const messages = await this.clipRepository.listChatByClip(clipId);
    return messages || [];
  }

  /**
   * Get chat message count for a clip
   * @param {string} clipId - The clip ID
   * @returns {number} Number of chat messages
   */
  async getClipChatCount(clipId) {
    const result = await this.clipRepository.countChatByClip(clipId);
    return result?.count || 0;
  }
}

module.exports = ClipService;
