const logger = require('../bootstrap/logger').child({ svc: 'TakeoverService' });

class TakeoverService {
  constructor(redisClient = null, sessionService = null) {
    this.redisClient = redisClient;
    this.inMemoryStorage = new Map();
    this.sessionService = sessionService;
    this.ipCooldowns = new Map(); // ip -> { timestamp, reason, duration }

    this.globalCooldownSeconds = parseInt(process.env.GLOBAL_COOLDOWN_SECONDS) || 30;
    this.individualCooldownSeconds = parseInt(process.env.INDIVIDUAL_COOLDOWN_SECONDS) || 60;
    this.lastStreamStartTime = null; // Track when the current stream started
    this.extendedCooldownUntil = null; // Track extended cooldowns from guard items

    // Game mode integration (optional)
    this.gameStreamService = null;

    logger.debug(`🔧 TAKEOVER: Cooldown settings (${process.env.NODE_ENV || 'production'}):`);
    logger.debug(`   Global cooldown: ${this.globalCooldownSeconds}s`);
    logger.debug(`   Individual cooldown: ${this.individualCooldownSeconds}s`);

    // Initialize lastStreamStartTime asynchronously
    this.loadLastStreamStartTime().catch((err) => logger.error({ err }, "loadLastStreamStartTime failed"));
    // T5: reload any guard-item extended cooldown that survived a restart
    this.loadExtendedCooldown().catch((err) => logger.error({ err }, "loadExtendedCooldown failed"));
  }

  /**
   * B1 (audit Plan 07): attach the Redis client AFTER it connects.
   * TakeoverService is constructed at module load, before
   * bootInitializeRedis() resolves, so the constructor always captured
   * `undefined` — every Redis path (cooldowns, last_stream_start_time, and
   * the T5 extended_cooldown_until persistence) silently ran on the
   * in-memory fallback, which dies with the process. index.js calls this
   * once Redis is up so cooldowns actually persist across restarts. Then
   * reloads the persisted values that the constructor's fire-and-forget
   * loads missed (they ran against the null client).
   */
  setRedisClient(redisClient) {
    this.redisClient = redisClient || null;
    if (this.redisClient) {
      this.loadLastStreamStartTime().catch((err) => logger.error({ err }, 'loadLastStreamStartTime (post-redis) failed'));
      this.loadExtendedCooldown().catch((err) => logger.error({ err }, 'loadExtendedCooldown (post-redis) failed'));
      logger.debug('🔧 TAKEOVER: Redis client attached - cooldowns now persist across restarts');
    }
  }

  /**
   * Set the game stream service reference (for game mode integration)
   */
  setGameStreamService(gameStreamService) {
    this.gameStreamService = gameStreamService;
    logger.debug('🔧 TAKEOVER: Game stream service integrated');
  }

  async canTakeOver(socketId) {
    try {
      // Check if game mode is active (highest priority block)
      if (this.gameStreamService && !this.gameStreamService.canTakeOver()) {
        const denial = this.gameStreamService.getTakeoverDenialReason();
        logger.debug(`   ❌ Game mode is active - takeover blocked`);
        return denial || {
          allowed: false,
          reason: 'GAME_MODE_ACTIVE',
          message: 'Cannot take over while game mode is active'
        };
      }

      const now = Date.now();

      // Get IP from session service
      let ip = null;
      if (this.sessionService) {
        const session = this.sessionService.getSessionBySocketId(socketId);
        if (session) {
          ip = session.ip;
        }
      }
      
      const identifier = ip || socketId; // Fallback to socketId if no IP available
      
      logger.debug(`🔍 TAKEOVER: Checking if ${socketId} (IP: ${ip || 'unknown'}) can take over`);
      logger.debug(`   Using identifier: ${identifier}`);
      logger.debug(`   Global cooldown: ${this.globalCooldownSeconds}s`);
      logger.debug(`   Individual cooldown: ${this.individualCooldownSeconds}s`);
      logger.debug(`   Last stream start: ${this.lastStreamStartTime ? new Date(this.lastStreamStartTime).toISOString() : 'never'}`);
      
      // Check individual IP cooldown first
      const ipCooldown = await this.getIpCooldown(identifier);
      if (ipCooldown && ipCooldown.remaining > 0) {
        logger.debug(`   ❌ Individual cooldown active: ${ipCooldown.remaining}s remaining`);
        return {
          allowed: false,
          reason: 'individual_cooldown',
          cooldownRemaining: ipCooldown.remaining
        };
      }
      
      // Check for extended cooldown from guard items first
      if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
        const remainingMs = this.extendedCooldownUntil - now;
        logger.debug(`   ❌ Extended cooldown active (guard item): ${Math.ceil(remainingMs / 1000)}s remaining`);
        return {
          allowed: false,
          reason: 'global_cooldown',
          cooldownRemaining: Math.ceil(remainingMs / 1000)
        };
      }
      
      // Check global cooldown (30s after any stream starts)
      if (this.lastStreamStartTime) {
        const globalCooldownMs = this.globalCooldownSeconds * 1000;
        const timeSinceStreamStart = now - this.lastStreamStartTime;
        
        logger.debug(`   Time since last stream start: ${Math.floor(timeSinceStreamStart / 1000)}s`);
        
        if (timeSinceStreamStart < globalCooldownMs) {
          const remainingMs = globalCooldownMs - timeSinceStreamStart;
          logger.debug(`   ❌ Global cooldown active: ${Math.ceil(remainingMs / 1000)}s remaining`);
          return {
            allowed: false,
            reason: 'global_cooldown',
            cooldownRemaining: Math.ceil(remainingMs / 1000)
          };
        }
      }

      logger.debug(`   ✅ Takeover allowed for ${socketId} (IP: ${ip || 'unknown'})`);
      return { allowed: true, ip };
    } catch (err) {
      // T7: fail CLOSED — an error in the eligibility check must not grant a
      // takeover that bypasses every cooldown. Both callers (request-to-stream,
      // join-as-viewer) forward reason/cooldownRemaining to the client.
      logger.error({ err }, 'Error checking takeover eligibility - failing closed');
      return { allowed: false, reason: 'server_error', cooldownRemaining: this.globalCooldownSeconds };
    }
  }

  async recordTakeover(skipGlobalCooldown = false) {
    const timestamp = Date.now();
    
    // CRITICAL: If skipGlobalCooldown is true (for viewbots), do NOT set lastStreamStartTime
    if (!skipGlobalCooldown) {
      this.lastStreamStartTime = timestamp; // Track when new stream starts
      logger.debug(`📝 TAKEOVER: Recording takeover at ${new Date(timestamp).toISOString()}`);
      logger.debug(`   Global cooldown will be active for ${this.globalCooldownSeconds}s`);
    } else {
      logger.debug(`📝 TAKEOVER: Recording takeover WITHOUT global cooldown (viewbot)`);
    }
    
    try {
      if (this.redisClient) {
        await this.redisClient.set('last_takeover_time', timestamp.toString());
        await this.redisClient.set('last_stream_start_time', timestamp.toString());
      } else {
        this.inMemoryStorage.set('last_takeover_time', timestamp);
        this.inMemoryStorage.set('last_stream_start_time', timestamp);
      }
    } catch (error) {
      logger.error({ err: error }, 'Error recording takeover');
      this.inMemoryStorage.set('last_takeover_time', timestamp);
      this.inMemoryStorage.set('last_stream_start_time', timestamp);
    }
  }

  async getLastTakeoverTime() {
    try {
      if (this.redisClient) {
        const result = await this.redisClient.get('last_takeover_time');
        return result ? parseInt(result) : null;
      } else {
        return this.inMemoryStorage.get('last_takeover_time') || null;
      }
    } catch (error) {
      logger.error({ err: error }, 'Error getting last takeover time');
      return this.inMemoryStorage.get('last_takeover_time') || null;
    }
  }

  async getRemainingCooldown() {
    const lastTakeoverTime = await this.getLastTakeoverTime();
    if (!lastTakeoverTime) return 0;

    const now = Date.now();
    const cooldownMs = this.individualCooldownSeconds * 1000;
    const elapsed = now - lastTakeoverTime;

    return elapsed < cooldownMs ? Math.ceil((cooldownMs - elapsed) / 1000) : 0;
  }

  // T5: these historically read/wrote a phantom `this.cooldownSeconds` field
  // that no constructor ever initialized (getCooldownSeconds() returned
  // undefined). They now alias the real individual-cooldown setting.
  setCooldownSeconds(seconds) {
    this.individualCooldownSeconds = seconds;
  }

  getCooldownSeconds() {
    return this.individualCooldownSeconds;
  }

  // IP-specific cooldown management  
  async setIpCooldown(socketId, reason = 'takeover attempt') {
    // Get IP from session service
    let ip = null;
    if (this.sessionService) {
      const session = this.sessionService.getSessionBySocketId(socketId);
      if (session) {
        ip = session.ip;
      }
    }
    
    const identifier = ip || socketId; // Fallback to socketId if no IP available
    const timestamp = Date.now();
    // Use individual cooldown (60s) for stream-related reasons, global (30s) for other reasons
    const streamRelatedReasons = ['stream_taken_over', 'streamer_disconnect', 'voluntary_stream_end'];
    const duration = streamRelatedReasons.includes(reason) ? this.individualCooldownSeconds : this.globalCooldownSeconds;
    
    this.ipCooldowns.set(identifier, { timestamp, reason, duration });
    
    logger.debug(`🔒 TAKEOVER: Set ${duration}s cooldown for ${socketId} (IP: ${ip || 'unknown'}, identifier: ${identifier}, reason: ${reason})`);
    
    try {
      if (this.redisClient) {
        await this.redisClient.set(`cooldown:${identifier}`, JSON.stringify({ timestamp, reason, duration }));
        await this.redisClient.expire(`cooldown:${identifier}`, duration);
      }
    } catch (error) {
      logger.error({ err: error }, 'Error setting IP cooldown in Redis');
    }
  }

  // Legacy method for backward compatibility - now delegates to IP-based method
  async setSocketCooldown(socketId, reason = 'takeover attempt') {
    return this.setIpCooldown(socketId, reason);
  }

  async getIpCooldown(identifier) {
    // Check in-memory first
    if (this.ipCooldowns.has(identifier)) {
      const { timestamp, reason, duration } = this.ipCooldowns.get(identifier);
      const now = Date.now();
      const elapsed = now - timestamp;
      const cooldownMs = (duration || this.globalCooldownSeconds) * 1000;
      
      if (elapsed < cooldownMs) {
        return {
          remaining: Math.ceil((cooldownMs - elapsed) / 1000),
          reason,
          duration
        };
      } else {
        // Cooldown expired
        this.ipCooldowns.delete(identifier);
      }
    }

    // Check Redis if available
    try {
      if (this.redisClient) {
        const result = await this.redisClient.get(`cooldown:${identifier}`);
        if (result) {
          const { timestamp, reason, duration } = JSON.parse(result);
          const now = Date.now();
          const elapsed = now - timestamp;
          const cooldownMs = (duration || this.globalCooldownSeconds) * 1000;
          
          if (elapsed < cooldownMs) {
            // Update in-memory cache
            this.ipCooldowns.set(identifier, { timestamp, reason, duration });
            return {
              remaining: Math.ceil((cooldownMs - elapsed) / 1000),
              reason,
              duration
            };
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error getting IP cooldown from Redis');
    }

    return null;
  }

  // Legacy method for backward compatibility
  async getSocketCooldown(socketId) {
    // Get IP from session service
    let ip = null;
    if (this.sessionService) {
      const session = this.sessionService.getSessionBySocketId(socketId);
      if (session) {
        ip = session.ip;
      }
    }
    
    const identifier = ip || socketId; // Fallback to socketId if no IP available
    return this.getIpCooldown(identifier);
  }

  async removeCooldown(socketId) {
    // Get IP from session service
    let ip = null;
    if (this.sessionService) {
      const session = this.sessionService.getSessionBySocketId(socketId);
      if (session) {
        ip = session.ip;
      }
    }
    
    const identifier = ip || socketId; // Fallback to socketId if no IP available
    const hadCooldown = this.ipCooldowns.has(identifier);
    this.ipCooldowns.delete(identifier);
    
    try {
      if (this.redisClient) {
        await this.redisClient.del(`cooldown:${identifier}`);
      }
    } catch (error) {
      logger.error({ err: error }, 'Error removing cooldown from Redis');
    }

    return hadCooldown;
  }

  async resetAllCooldowns() {
    const count = this.ipCooldowns.size;
    this.ipCooldowns.clear();
    
    try {
      if (this.redisClient) {
        const keys = await this.redisClient.keys('cooldown:*');
        if (keys.length > 0) {
          await this.redisClient.del(...keys);
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error resetting cooldowns in Redis');
    }

    return count;
  }

  async loadLastStreamStartTime() {
    try {
      if (this.redisClient) {
        const result = await this.redisClient.get('last_stream_start_time');
        this.lastStreamStartTime = result ? parseInt(result) : null;
      } else {
        this.lastStreamStartTime = this.inMemoryStorage.get('last_stream_start_time') || null;
      }
    } catch (error) {
      logger.error({ err: error }, 'Error loading last stream start time');
      this.lastStreamStartTime = null;
    }
  }

  /**
   * T5: persist extendedCooldownUntil so guard-item cooldowns survive a
   * restart. The Redis key carries a TTL equal to the cooldown remainder, so
   * it self-expires exactly when the cooldown ends; a null/expired cooldown
   * deletes the key (weapon items can clear it).
   */
  async persistExtendedCooldown() {
    try {
      const until = this.extendedCooldownUntil;
      const ttlSeconds = until ? Math.ceil((until - Date.now()) / 1000) : 0;
      if (this.redisClient) {
        if (until && ttlSeconds > 0) {
          await this.redisClient.set('extended_cooldown_until', until.toString());
          await this.redisClient.expire('extended_cooldown_until', ttlSeconds);
        } else {
          await this.redisClient.del('extended_cooldown_until');
        }
      } else {
        if (until && ttlSeconds > 0) {
          this.inMemoryStorage.set('extended_cooldown_until', until);
        } else {
          this.inMemoryStorage.delete('extended_cooldown_until');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error persisting extended cooldown');
    }
  }

  async loadExtendedCooldown() {
    try {
      let value = null;
      if (this.redisClient) {
        const result = await this.redisClient.get('extended_cooldown_until');
        value = result ? parseInt(result) : null;
      } else {
        value = this.inMemoryStorage.get('extended_cooldown_until') || null;
      }
      // Ignore stale values: the Redis TTL should already have expired them,
      // but the in-memory path and clock skew still need the guard.
      this.extendedCooldownUntil = (value && value > Date.now()) ? value : null;
    } catch (error) {
      logger.error({ err: error }, 'Error loading extended cooldown');
      this.extendedCooldownUntil = null;
    }
  }

  async getAllCooldowns() {
    const cooldowns = [];
    const now = Date.now();

    // Get from in-memory storage
    for (const [identifier, { timestamp, reason, duration }] of this.ipCooldowns.entries()) {
      const cooldownMs = (duration || this.globalCooldownSeconds) * 1000;
      const elapsed = now - timestamp;
      if (elapsed < cooldownMs) {
        cooldowns.push({
          identifier,
          remaining: Math.ceil((cooldownMs - elapsed) / 1000),
          reason,
          duration
        });
      } else {
        // Remove expired cooldown
        this.ipCooldowns.delete(identifier);
      }
    }

    // Also check Redis for any missed cooldowns
    try {
      if (this.redisClient) {
        const keys = await this.redisClient.keys('cooldown:*');
        for (const key of keys) {
          const identifier = key.replace('cooldown:', '');
          if (!this.ipCooldowns.has(identifier)) {
            const result = await this.redisClient.get(key);
            if (result) {
              const { timestamp, reason, duration } = JSON.parse(result);
              const cooldownMs = (duration || this.globalCooldownSeconds) * 1000;
              const elapsed = now - timestamp;
              if (elapsed < cooldownMs) {
                cooldowns.push({
                  identifier,
                  remaining: Math.ceil((cooldownMs - elapsed) / 1000),
                  reason,
                  duration
                });
                // Update in-memory cache
                this.ipCooldowns.set(identifier, { timestamp, reason, duration });
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error getting all cooldowns from Redis');
    }

    return cooldowns;
  }

  // Methods for item-based cooldown modifications
  async modifyGlobalCooldown(changeSeconds, reason = 'item_effect') {
    logger.debug(`🔧 TAKEOVER: ===== MODIFY GLOBAL COOLDOWN CALLED =====`);
    logger.debug(`🔧 TAKEOVER: Change: ${changeSeconds}s, Reason: ${reason}`);
    logger.debug(`🔧 TAKEOVER: Current lastStreamStartTime: ${this.lastStreamStartTime}`);
    try {
      const now = Date.now();
      
      if (!this.lastStreamStartTime) {
        logger.debug(`🔧 TAKEOVER: No active stream - handling cooldown modification`);
        
        if (changeSeconds > 0) {
          // For increases (guard items), ADD to any existing extended cooldown
          // or create a new one if none exists
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            // Add to existing extended cooldown
            const currentRemaining = this.extendedCooldownUntil - now;
            this.extendedCooldownUntil += (changeSeconds * 1000);
            const newRemaining = this.extendedCooldownUntil - now;
            logger.debug(`🔧 TAKEOVER: Added ${changeSeconds}s to existing extended cooldown`);
            logger.debug(`   Previous remaining: ${Math.ceil(currentRemaining / 1000)}s`);
            logger.debug(`   New total remaining: ${Math.ceil(newRemaining / 1000)}s`);
          } else {
            // Create new extended cooldown
            this.extendedCooldownUntil = now + (changeSeconds * 1000);
            logger.debug(`🔧 TAKEOVER: Created new extended cooldown: ${changeSeconds}s (reason: ${reason})`);
            logger.debug(`   Extended until: ${new Date(this.extendedCooldownUntil).toISOString()}`);
          }
        } else {
          // For decreases (weapon items), reduce extended cooldown if it exists
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            const currentRemaining = this.extendedCooldownUntil - now;
            const newRemaining = Math.max(0, currentRemaining + (changeSeconds * 1000)); // changeSeconds is negative
            
            if (newRemaining > 0) {
              this.extendedCooldownUntil = now + newRemaining;
              logger.debug(`🔧 TAKEOVER: Reduced extended cooldown from ${Math.ceil(currentRemaining / 1000)}s to ${Math.ceil(newRemaining / 1000)}s`);
            } else {
              this.extendedCooldownUntil = null;
              logger.debug(`🔧 TAKEOVER: Extended cooldown completely removed by weapon`);
            }
          } else {
            logger.debug(`🔧 TAKEOVER: Cannot reduce non-existent cooldown (reason: ${reason})`);
            return false;
          }
        }
      } else {
        // There's an active stream, modify cooldown based on current state
        const originalGlobalCooldownMs = this.globalCooldownSeconds * 1000;
        const timeSinceStreamStart = now - this.lastStreamStartTime;
        
        // Calculate remaining cooldown before modification
        const remainingMs = Math.max(0, originalGlobalCooldownMs - timeSinceStreamStart);
        
        logger.debug(`🔧 TAKEOVER: Current state before modification:`);
        logger.debug(`   Time since stream start: ${Math.ceil(timeSinceStreamStart / 1000)}s`);
        logger.debug(`   Base global cooldown: ${Math.ceil(originalGlobalCooldownMs / 1000)}s`);
        logger.debug(`   Current remaining: ${Math.ceil(remainingMs / 1000)}s`);
        
        if (changeSeconds > 0) {
          // For increases (guard items), ADD to the current cooldown duration
          // Check if there's already an extended cooldown active
          let currentEffectiveCooldownEnd = 0;
          
          // First, check for extended cooldown
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            currentEffectiveCooldownEnd = this.extendedCooldownUntil;
            logger.debug(`🔧 TAKEOVER: Found existing extended cooldown ending at ${new Date(currentEffectiveCooldownEnd).toISOString()}`);
          }
          // Otherwise, check for base cooldown
          else if (remainingMs > 0) {
            currentEffectiveCooldownEnd = now + remainingMs;
            logger.debug(`🔧 TAKEOVER: Found base cooldown with ${Math.ceil(remainingMs / 1000)}s remaining`);
          }
          // No cooldown active, start from now
          else {
            currentEffectiveCooldownEnd = now;
            logger.debug(`🔧 TAKEOVER: No active cooldown, starting from now`);
          }
          
          // Add the new cooldown time to the current effective end time
          const additionalMs = changeSeconds * 1000;
          this.extendedCooldownUntil = currentEffectiveCooldownEnd + additionalMs;
          
          const totalRemaining = Math.ceil((this.extendedCooldownUntil - now) / 1000);
          logger.debug(`🔧 TAKEOVER: Guard item used - ADDING ${changeSeconds}s to cooldown`);
          logger.debug(`   Previous effective end: ${new Date(currentEffectiveCooldownEnd).toISOString()}`);
          logger.debug(`   New extended cooldown until: ${new Date(this.extendedCooldownUntil).toISOString()}`);
          logger.debug(`   Total cooldown remaining: ${totalRemaining}s`);
        } else {
          // For decreases (weapon items), reduce from current remaining
          logger.debug(`🔧 TAKEOVER: Weapon item used - attempting to reduce cooldown by ${Math.abs(changeSeconds)}s`);
          logger.debug(`   Current remaining: ${Math.ceil(remainingMs / 1000)}s`);
          
          // Check if we have an extended cooldown active
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            // Reduce the extended cooldown directly
            const currentExtendedRemaining = this.extendedCooldownUntil - now;
            const newExtendedRemaining = Math.max(0, currentExtendedRemaining + (changeSeconds * 1000)); // changeSeconds is negative
            
            if (newExtendedRemaining > 0) {
              this.extendedCooldownUntil = now + newExtendedRemaining;
              logger.debug(`🔧 TAKEOVER: Reduced extended cooldown to ${Math.ceil(newExtendedRemaining / 1000)}s`);
            } else {
              this.extendedCooldownUntil = null;
              logger.debug(`🔧 TAKEOVER: Extended cooldown completely removed by weapon`);
            }
          } else {
            // No extended cooldown, use standard logic
            const newRemainingMs = Math.max(0, remainingMs + (changeSeconds * 1000));
            
            if (newRemainingMs > 0) {
              // Create a new extended cooldown for the reduced time
              this.extendedCooldownUntil = now + newRemainingMs;
              logger.debug(`🔧 TAKEOVER: Created new reduced cooldown: ${Math.ceil(newRemainingMs / 1000)}s`);
            } else {
              logger.debug(`🔧 TAKEOVER: Weapon completely removed remaining cooldown`);
            }
          }
        }
      }
      
      // T5: persist the extended cooldown itself. The previous code here
      // re-persisted last_stream_start_time (which this method never mutates —
      // recordTakeover owns it) and threw a swallowed null.toString() TypeError
      // whenever a guard item was used with no active stream, so the
      // extendedCooldownUntil change never survived a restart.
      await this.persistExtendedCooldown();

      return true;
    } catch (error) {
      logger.error({ err: error }, 'Error modifying global cooldown');
      return false;
    }
  }

  async resetAllIndividualCooldowns(reason = 'chaos_orb') {
    try {
      const count = await this.resetAllCooldowns();
      logger.debug(`🔧 TAKEOVER: Reset all ${count} individual cooldowns (reason: ${reason})`);
      return count;
    } catch (error) {
      logger.error({ err: error }, 'Error resetting all individual cooldowns');
      return 0;
    }
  }

  async freezeIndividualCooldowns(durationSeconds, reason = 'time_freeze') {
    try {
      const now = Date.now();
      const freezeDuration = durationSeconds * 1000;
      
      // Extend all existing cooldowns by the freeze duration
      for (const [identifier, cooldownData] of this.ipCooldowns.entries()) {
        cooldownData.timestamp = cooldownData.timestamp - freezeDuration;
        this.ipCooldowns.set(identifier, cooldownData);
        
        // Update in Redis if available
        try {
          if (this.redisClient) {
            await this.redisClient.set(`cooldown:${identifier}`, JSON.stringify(cooldownData));
            // Don't change the TTL - let it expire naturally with the extended time
          }
        } catch (error) {
          logger.error({ err: error }, `Error updating frozen cooldown for ${identifier}`);
        }
      }
      
      logger.debug(`🔧 TAKEOVER: Froze ${this.ipCooldowns.size} individual cooldowns for ${durationSeconds}s (reason: ${reason})`);
      return this.ipCooldowns.size;
    } catch (error) {
      logger.error({ err: error }, 'Error freezing individual cooldowns');
      return 0;
    }
  }

  // Get current global cooldown remaining time
  async getGlobalCooldownRemaining() {
    logger.debug(`🔧 TAKEOVER: ===== GET GLOBAL COOLDOWN REMAINING =====`);
    logger.debug(`🔧 TAKEOVER: lastStreamStartTime: ${this.lastStreamStartTime}`);
    logger.debug(`🔧 TAKEOVER: globalCooldownSeconds: ${this.globalCooldownSeconds}`);
    
    const now = Date.now();
    
    // First check for extended cooldown (can exist even without active stream)
    if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
      const remaining = Math.ceil((this.extendedCooldownUntil - now) / 1000);
      logger.debug(`🔧 TAKEOVER: Using extended cooldown - remaining: ${remaining}s`);
      return Math.max(0, remaining);
    }
    
    if (!this.lastStreamStartTime) {
      logger.debug(`🔧 TAKEOVER: No stream start time and no extended cooldown - returning 0`);
      return 0;
    }
    
    const timeSinceStreamStart = now - this.lastStreamStartTime;
    
    // Default calculation using base cooldown
    const globalCooldownMs = this.globalCooldownSeconds * 1000;
    const remaining = Math.max(0, Math.ceil((globalCooldownMs - timeSinceStreamStart) / 1000));
    
    logger.debug(`🔧 TAKEOVER: now: ${now} (${new Date(now).toISOString()})`);
    logger.debug(`🔧 TAKEOVER: timeSinceStreamStart: ${timeSinceStreamStart}ms`);
    logger.debug(`🔧 TAKEOVER: globalCooldownMs: ${globalCooldownMs}ms`);
    logger.debug(`🔧 TAKEOVER: remaining: ${remaining}s`);
    
    return remaining;
  }
}

module.exports = TakeoverService;
