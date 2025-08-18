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
    
    console.log(`🔧 TAKEOVER: Cooldown settings (${process.env.NODE_ENV || 'production'}):`);
    console.log(`   Global cooldown: ${this.globalCooldownSeconds}s`);
    console.log(`   Individual cooldown: ${this.individualCooldownSeconds}s`);
    
    // Initialize lastStreamStartTime asynchronously
    this.loadLastStreamStartTime().catch(console.error);
  }

  async canTakeOver(socketId) {
    try {
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
      
      console.log(`🔍 TAKEOVER: Checking if ${socketId} (IP: ${ip || 'unknown'}) can take over`);
      console.log(`   Using identifier: ${identifier}`);
      console.log(`   Global cooldown: ${this.globalCooldownSeconds}s`);
      console.log(`   Individual cooldown: ${this.individualCooldownSeconds}s`);
      console.log(`   Last stream start: ${this.lastStreamStartTime ? new Date(this.lastStreamStartTime).toISOString() : 'never'}`);
      
      // Check individual IP cooldown first
      const ipCooldown = await this.getIpCooldown(identifier);
      if (ipCooldown && ipCooldown.remaining > 0) {
        console.log(`   ❌ Individual cooldown active: ${ipCooldown.remaining}s remaining`);
        return {
          allowed: false,
          reason: 'individual_cooldown',
          cooldownRemaining: ipCooldown.remaining
        };
      }
      
      // Check for extended cooldown from guard items first
      if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
        const remainingMs = this.extendedCooldownUntil - now;
        console.log(`   ❌ Extended cooldown active (guard item): ${Math.ceil(remainingMs / 1000)}s remaining`);
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
        
        console.log(`   Time since last stream start: ${Math.floor(timeSinceStreamStart / 1000)}s`);
        
        if (timeSinceStreamStart < globalCooldownMs) {
          const remainingMs = globalCooldownMs - timeSinceStreamStart;
          console.log(`   ❌ Global cooldown active: ${Math.ceil(remainingMs / 1000)}s remaining`);
          return {
            allowed: false,
            reason: 'global_cooldown',
            cooldownRemaining: Math.ceil(remainingMs / 1000)
          };
        }
      }

      console.log(`   ✅ Takeover allowed for ${socketId} (IP: ${ip || 'unknown'})`);
      return { allowed: true, ip };
    } catch (error) {
      console.error('Error checking takeover eligibility:', error);
      return { allowed: true };
    }
  }

  async recordTakeover() {
    const timestamp = Date.now();
    this.lastStreamStartTime = timestamp; // Track when new stream starts
    
    console.log(`📝 TAKEOVER: Recording takeover at ${new Date(timestamp).toISOString()}`);
    console.log(`   Global cooldown will be active for ${this.globalCooldownSeconds}s`);
    
    try {
      if (this.redisClient) {
        await this.redisClient.set('last_takeover_time', timestamp.toString());
        await this.redisClient.set('last_stream_start_time', timestamp.toString());
      } else {
        this.inMemoryStorage.set('last_takeover_time', timestamp);
        this.inMemoryStorage.set('last_stream_start_time', timestamp);
      }
    } catch (error) {
      console.error('Error recording takeover:', error);
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
      console.error('Error getting last takeover time:', error);
      return this.inMemoryStorage.get('last_takeover_time') || null;
    }
  }

  async getRemainingCooldown() {
    const lastTakeoverTime = await this.getLastTakeoverTime();
    if (!lastTakeoverTime) return 0;

    const now = Date.now();
    const cooldownMs = this.cooldownSeconds * 1000;
    const elapsed = now - lastTakeoverTime;
    
    return elapsed < cooldownMs ? Math.ceil((cooldownMs - elapsed) / 1000) : 0;
  }

  setCooldownSeconds(seconds) {
    this.cooldownSeconds = seconds;
  }

  getCooldownSeconds() {
    return this.cooldownSeconds;
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
    
    console.log(`🔒 TAKEOVER: Set ${duration}s cooldown for ${socketId} (IP: ${ip || 'unknown'}, identifier: ${identifier}, reason: ${reason})`);
    
    try {
      if (this.redisClient) {
        await this.redisClient.set(`cooldown:${identifier}`, JSON.stringify({ timestamp, reason, duration }));
        await this.redisClient.expire(`cooldown:${identifier}`, duration);
      }
    } catch (error) {
      console.error('Error setting IP cooldown in Redis:', error);
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
      console.error('Error getting IP cooldown from Redis:', error);
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
      console.error('Error removing cooldown from Redis:', error);
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
      console.error('Error resetting cooldowns in Redis:', error);
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
      console.error('Error loading last stream start time:', error);
      this.lastStreamStartTime = null;
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
      console.error('Error getting all cooldowns from Redis:', error);
    }

    return cooldowns;
  }

  // Methods for item-based cooldown modifications
  async modifyGlobalCooldown(changeSeconds, reason = 'item_effect') {
    console.log(`🔧 TAKEOVER: ===== MODIFY GLOBAL COOLDOWN CALLED =====`);
    console.log(`🔧 TAKEOVER: Change: ${changeSeconds}s, Reason: ${reason}`);
    console.log(`🔧 TAKEOVER: Current lastStreamStartTime: ${this.lastStreamStartTime}`);
    try {
      const now = Date.now();
      
      if (!this.lastStreamStartTime) {
        console.log(`🔧 TAKEOVER: No active stream - handling cooldown modification`);
        
        if (changeSeconds > 0) {
          // For increases (guard items), ADD to any existing extended cooldown
          // or create a new one if none exists
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            // Add to existing extended cooldown
            const currentRemaining = this.extendedCooldownUntil - now;
            this.extendedCooldownUntil += (changeSeconds * 1000);
            const newRemaining = this.extendedCooldownUntil - now;
            console.log(`🔧 TAKEOVER: Added ${changeSeconds}s to existing extended cooldown`);
            console.log(`   Previous remaining: ${Math.ceil(currentRemaining / 1000)}s`);
            console.log(`   New total remaining: ${Math.ceil(newRemaining / 1000)}s`);
          } else {
            // Create new extended cooldown
            this.extendedCooldownUntil = now + (changeSeconds * 1000);
            console.log(`🔧 TAKEOVER: Created new extended cooldown: ${changeSeconds}s (reason: ${reason})`);
            console.log(`   Extended until: ${new Date(this.extendedCooldownUntil).toISOString()}`);
          }
        } else {
          // For decreases (weapon items), reduce extended cooldown if it exists
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            const currentRemaining = this.extendedCooldownUntil - now;
            const newRemaining = Math.max(0, currentRemaining + (changeSeconds * 1000)); // changeSeconds is negative
            
            if (newRemaining > 0) {
              this.extendedCooldownUntil = now + newRemaining;
              console.log(`🔧 TAKEOVER: Reduced extended cooldown from ${Math.ceil(currentRemaining / 1000)}s to ${Math.ceil(newRemaining / 1000)}s`);
            } else {
              this.extendedCooldownUntil = null;
              console.log(`🔧 TAKEOVER: Extended cooldown completely removed by weapon`);
            }
          } else {
            console.log(`🔧 TAKEOVER: Cannot reduce non-existent cooldown (reason: ${reason})`);
            return false;
          }
        }
      } else {
        // There's an active stream, modify cooldown based on current state
        const originalGlobalCooldownMs = this.globalCooldownSeconds * 1000;
        const timeSinceStreamStart = now - this.lastStreamStartTime;
        
        // Calculate remaining cooldown before modification
        const remainingMs = Math.max(0, originalGlobalCooldownMs - timeSinceStreamStart);
        
        console.log(`🔧 TAKEOVER: Current state before modification:`);
        console.log(`   Time since stream start: ${Math.ceil(timeSinceStreamStart / 1000)}s`);
        console.log(`   Base global cooldown: ${Math.ceil(originalGlobalCooldownMs / 1000)}s`);
        console.log(`   Current remaining: ${Math.ceil(remainingMs / 1000)}s`);
        
        if (changeSeconds > 0) {
          // For increases (guard items), ADD to the current cooldown duration
          // Check if there's already an extended cooldown active
          let currentEffectiveCooldownEnd = 0;
          
          // First, check for extended cooldown
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            currentEffectiveCooldownEnd = this.extendedCooldownUntil;
            console.log(`🔧 TAKEOVER: Found existing extended cooldown ending at ${new Date(currentEffectiveCooldownEnd).toISOString()}`);
          }
          // Otherwise, check for base cooldown
          else if (remainingMs > 0) {
            currentEffectiveCooldownEnd = now + remainingMs;
            console.log(`🔧 TAKEOVER: Found base cooldown with ${Math.ceil(remainingMs / 1000)}s remaining`);
          }
          // No cooldown active, start from now
          else {
            currentEffectiveCooldownEnd = now;
            console.log(`🔧 TAKEOVER: No active cooldown, starting from now`);
          }
          
          // Add the new cooldown time to the current effective end time
          const additionalMs = changeSeconds * 1000;
          this.extendedCooldownUntil = currentEffectiveCooldownEnd + additionalMs;
          
          const totalRemaining = Math.ceil((this.extendedCooldownUntil - now) / 1000);
          console.log(`🔧 TAKEOVER: Guard item used - ADDING ${changeSeconds}s to cooldown`);
          console.log(`   Previous effective end: ${new Date(currentEffectiveCooldownEnd).toISOString()}`);
          console.log(`   New extended cooldown until: ${new Date(this.extendedCooldownUntil).toISOString()}`);
          console.log(`   Total cooldown remaining: ${totalRemaining}s`);
        } else {
          // For decreases (weapon items), reduce from current remaining
          console.log(`🔧 TAKEOVER: Weapon item used - attempting to reduce cooldown by ${Math.abs(changeSeconds)}s`);
          console.log(`   Current remaining: ${Math.ceil(remainingMs / 1000)}s`);
          
          // Check if we have an extended cooldown active
          if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
            // Reduce the extended cooldown directly
            const currentExtendedRemaining = this.extendedCooldownUntil - now;
            const newExtendedRemaining = Math.max(0, currentExtendedRemaining + (changeSeconds * 1000)); // changeSeconds is negative
            
            if (newExtendedRemaining > 0) {
              this.extendedCooldownUntil = now + newExtendedRemaining;
              console.log(`🔧 TAKEOVER: Reduced extended cooldown to ${Math.ceil(newExtendedRemaining / 1000)}s`);
            } else {
              this.extendedCooldownUntil = null;
              console.log(`🔧 TAKEOVER: Extended cooldown completely removed by weapon`);
            }
          } else {
            // No extended cooldown, use standard logic
            const newRemainingMs = Math.max(0, remainingMs + (changeSeconds * 1000));
            
            if (newRemainingMs > 0) {
              // Create a new extended cooldown for the reduced time
              this.extendedCooldownUntil = now + newRemainingMs;
              console.log(`🔧 TAKEOVER: Created new reduced cooldown: ${Math.ceil(newRemainingMs / 1000)}s`);
            } else {
              console.log(`🔧 TAKEOVER: Weapon completely removed remaining cooldown`);
            }
          }
        }
      }
      
      // Persist the change
      try {
        if (this.redisClient) {
          await this.redisClient.set('last_stream_start_time', this.lastStreamStartTime.toString());
        } else {
          this.inMemoryStorage.set('last_stream_start_time', this.lastStreamStartTime);
        }
      } catch (error) {
        console.error('Error persisting global cooldown modification:', error);
      }
      
      return true;
    } catch (error) {
      console.error('Error modifying global cooldown:', error);
      return false;
    }
  }

  async resetAllIndividualCooldowns(reason = 'chaos_orb') {
    try {
      const count = await this.resetAllCooldowns();
      console.log(`🔧 TAKEOVER: Reset all ${count} individual cooldowns (reason: ${reason})`);
      return count;
    } catch (error) {
      console.error('Error resetting all individual cooldowns:', error);
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
          console.error(`Error updating frozen cooldown for ${identifier}:`, error);
        }
      }
      
      console.log(`🔧 TAKEOVER: Froze ${this.ipCooldowns.size} individual cooldowns for ${durationSeconds}s (reason: ${reason})`);
      return this.ipCooldowns.size;
    } catch (error) {
      console.error('Error freezing individual cooldowns:', error);
      return 0;
    }
  }

  // Get current global cooldown remaining time
  async getGlobalCooldownRemaining() {
    console.log(`🔧 TAKEOVER: ===== GET GLOBAL COOLDOWN REMAINING =====`);
    console.log(`🔧 TAKEOVER: lastStreamStartTime: ${this.lastStreamStartTime}`);
    console.log(`🔧 TAKEOVER: globalCooldownSeconds: ${this.globalCooldownSeconds}`);
    
    const now = Date.now();
    
    // First check for extended cooldown (can exist even without active stream)
    if (this.extendedCooldownUntil && now < this.extendedCooldownUntil) {
      const remaining = Math.ceil((this.extendedCooldownUntil - now) / 1000);
      console.log(`🔧 TAKEOVER: Using extended cooldown - remaining: ${remaining}s`);
      return Math.max(0, remaining);
    }
    
    if (!this.lastStreamStartTime) {
      console.log(`🔧 TAKEOVER: No stream start time and no extended cooldown - returning 0`);
      return 0;
    }
    
    const timeSinceStreamStart = now - this.lastStreamStartTime;
    
    // Default calculation using base cooldown
    const globalCooldownMs = this.globalCooldownSeconds * 1000;
    const remaining = Math.max(0, Math.ceil((globalCooldownMs - timeSinceStreamStart) / 1000));
    
    console.log(`🔧 TAKEOVER: now: ${now} (${new Date(now).toISOString()})`);
    console.log(`🔧 TAKEOVER: timeSinceStreamStart: ${timeSinceStreamStart}ms`);
    console.log(`🔧 TAKEOVER: globalCooldownMs: ${globalCooldownMs}ms`);
    console.log(`🔧 TAKEOVER: remaining: ${remaining}s`);
    
    return remaining;
  }
}

module.exports = TakeoverService;