const { runAsync, getAsync, allAsync } = require('../database/database');
const EventEmitter = require('events');

class BuffDebuffService extends EventEmitter {
    constructor(io = null, streamService = null, timeTrackingService = null, sessionService = null) {
        super();
        this.io = io;
        this.streamService = streamService;
        this.timeTrackingService = timeTrackingService;
        this.sessionService = sessionService;
        
        // In-memory cache for active buffs with TTL (performance optimization + memory management)
        this.activeBuffsCache = new Map();
        this.anonymousBuffsCache = new Map(); // For anonymous/viewbot users with negative IDs
        this.cacheMaxSize = 1000; // Maximum cache entries
        this.cacheTTL = 300000; // 5 minutes TTL
        
        // Update interval for streaming-time based duration tracking
        this.updateInterval = null;
        
        // Initialize the service
        this.initialize();
    }

    async initialize() {
        console.log('🎭 BUFF: Initializing BuffDebuffService');
        
        // Load active buffs into cache
        await this.loadActiveBuffsIntoCache();
        
        // Start periodic updates for streaming-time based duration tracking
        this.startDurationUpdates();
        
        // Start cache cleanup interval
        this.startCacheCleanup();
        
        // Clean up expired buffs
        await this.cleanupExpiredBuffs();
        
        console.log('✅ BUFF: BuffDebuffService initialized successfully');
    }
    
    // Periodic cache cleanup to prevent memory leaks
    startCacheCleanup() {
        setInterval(() => {
            const now = Date.now();
            const entriesToDelete = [];
            
            // Remove stale entries
            for (const [key, value] of this.activeBuffsCache.entries()) {
                if (value.timestamp && (now - value.timestamp) > this.cacheTTL) {
                    entriesToDelete.push(key);
                }
            }
            
            // Delete stale entries
            entriesToDelete.forEach(key => this.activeBuffsCache.delete(key));
            
            // Enforce max size by removing oldest entries
            if (this.activeBuffsCache.size > this.cacheMaxSize) {
                const sortedEntries = Array.from(this.activeBuffsCache.entries())
                    .sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
                
                const toRemove = sortedEntries.slice(0, this.activeBuffsCache.size - this.cacheMaxSize);
                toRemove.forEach(([key]) => this.activeBuffsCache.delete(key));
            }
            
            if (entriesToDelete.length > 0) {
                console.log(`🧹 BUFF: Cleaned ${entriesToDelete.length} stale cache entries`);
            }
        }, 60000); // Run every minute
    }

    // Set dependencies after initialization if needed
    setDependencies(io, streamService, timeTrackingService, sessionService) {
        this.io = io;
        this.streamService = streamService;
        this.timeTrackingService = timeTrackingService;
        this.sessionService = sessionService;
    }

    // Load all active buffs into memory cache for performance
    async loadActiveBuffsIntoCache() {
        try {
            const activeBuffs = await allAsync(`
                SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
            `);

            this.activeBuffsCache.clear();
            for (const buff of activeBuffs) {
                // Add timestamp for cache management
                this.activeBuffsCache.set(buff.id, {
                    ...buff,
                    timestamp: Date.now()
                });
            }

            console.log(`🎭 BUFF: Loaded ${activeBuffs.length} active buffs into cache`);
        } catch (error) {
            console.error('❌ BUFF: Error loading active buffs into cache:', error);
        }
    }

    // Apply a buff or debuff to a user
    async applyBuff(userId, itemId, appliedByUserId, duration, effectData = null, skipBroadcasts = false, streamId = null) {
        console.log(`🎭 BUFF: applyBuff called - userId: ${userId}, itemId: ${itemId}, duration: ${duration}`);
        try {
            // Get item details
            const item = await getAsync('SELECT * FROM items WHERE id = ? AND is_active = 1', [itemId]);
            if (!item) {
                throw new Error('Item not found or inactive');
            }

            if (!['buff', 'debuff'].includes(item.item_type)) {
                throw new Error('Item is not a buff or debuff');
            }

            // Use item's duration if not specified
            const buffDuration = duration || item.duration_seconds || 60; // Default 60 seconds

            // Handle stacking behavior
            const existingBuff = await this.getActiveBuffByItemForUser(userId, itemId);
            let buffId;

            if (existingBuff) {
                switch (item.stack_behavior) {
                    case 'replace':
                        // Remove existing buff and create new one
                        await this.removeBuff(existingBuff.id);
                        buffId = await this.createNewBuff(userId, itemId, appliedByUserId, item.item_type, buffDuration, effectData);
                        break;
                    case 'extend':
                        // Extend existing buff duration
                        const newRemaining = existingBuff.remaining_seconds + buffDuration;
                        await this.updateBuffDuration(existingBuff.id, newRemaining);
                        buffId = existingBuff.id;
                        break;
                    case 'stack':
                        // Create new separate buff instance
                        buffId = await this.createNewBuff(userId, itemId, appliedByUserId, item.item_type, buffDuration, effectData);
                        break;
                    default:
                        // Default to replace behavior
                        await this.removeBuff(existingBuff.id);
                        buffId = await this.createNewBuff(userId, itemId, appliedByUserId, item.item_type, buffDuration, effectData);
                }
            } else {
                // No existing buff, create new one
                buffId = await this.createNewBuff(userId, itemId, appliedByUserId, item.item_type, buffDuration, effectData);
            }

            // Get the complete buff data
            const buffData = await this.getBuffById(buffId);
            
            // Update cache
            this.activeBuffsCache.set(buffId, buffData);

            // Emit event for other services to hook into
            // Include stream_id in the event data for VisualFxService
            const eventData = {
                ...buffData,
                stream_id: streamId
            };
            
            // Debug: Check if this is a visual effect item
            const videoEffectItems = ['emboss', 'pixelate', 'motion_blur', 'glitch_bomb', 'thermal_vision', 'rotate_90', 'potato'];
            const canvasEffectItems = ['smoke_bomb', 'spotlight', 'disco_ball', 'confetti_cannon', 'rainbow_effect', 'freeze_frame'];
            
            if (videoEffectItems.includes(item.name)) {
                console.log(`🎭 BUFF: VIDEO EFFECT ITEM DETECTED: ${item.name}`);
                console.log(`🎭 BUFF: Event listeners for 'buff-applied': ${this.listenerCount('buff-applied')}`);
            }
            
            if (canvasEffectItems.includes(item.name)) {
                console.log(`🎭 BUFF: CANVAS EFFECT ITEM DETECTED: ${item.name}`);
                console.log(`🎭 BUFF: Event listeners for 'buff-applied': ${this.listenerCount('buff-applied')}`);
                console.log(`🎭 BUFF: About to emit buff-applied for canvas effect with data:`, JSON.stringify(eventData, null, 2));
            }
            
            this.emit('buff-applied', eventData);
            
            if (canvasEffectItems.includes(item.name)) {
                console.log(`🎭 BUFF: Successfully emitted buff-applied event for canvas effect ${item.name}`);
            }

            // Send real-time update
            if (this.io && !skipBroadcasts) {
                const updateData = await this.formatBuffForClient(buffData);
                this.io.emit('buff-applied', updateData);
                
                // Get all active buffs for the target user for various update types
                const userActiveBuffs = await this.getActiveBuffsForUser(userId);
                
                const isViewbot = userId < 0;
                
                // Send user-buff-update for general consumption (allow for viewbots)
                this.io.emit('user-buff-update', { userId, buffs: userActiveBuffs });
                
                // Send personal buff updates to authenticated sockets for this user (skip for viewbots)
                if (this.sessionService && !isViewbot) {
                    const userSockets = this.sessionService.getSocketsByUserId(userId);
                    for (const socketId of userSockets) {
                        this.io.to(socketId).emit('my-buffs-update', { buffs: userActiveBuffs });
                    }
                } else if (isViewbot) {
                    console.log(`🎭 BUFF: Skipped personal buff updates for viewbot user ${userId}`);
                }
                
                // If this is the current streamer, broadcast streamer buffs to all users (allow for viewbots)
                if (this.streamService && this.streamService.getCurrentStreamer()) {
                    const currentStreamer = this.streamService.getCurrentStreamer();
                    console.log(`🎭 BUFF: Checking if buff target is current streamer - currentStreamer socketId: ${currentStreamer}, targetUserId: ${userId}`);
                    if (this.sessionService) {
                        const session = this.sessionService.getSessionBySocketId(currentStreamer);
                        console.log(`🎭 BUFF: Session for streamer:`, session ? `userId=${session.userId}` : 'not found');
                        if (session && session.userId && session.userId.toString() === userId.toString()) {
                            console.log(`🎭 BUFF: ✅ Target IS the current streamer! Broadcasting streamer-buffs-update to ALL connected sockets`);
                            console.log(`🎭 BUFF: Buff data being sent:`, userActiveBuffs.map(b => ({ id: b.id, displayName: b.displayName, remaining: b.remainingSeconds })));
                            this.io.emit('streamer-buffs-update', { buffs: userActiveBuffs });
                            console.log(`🎭 BUFF: ✅ Successfully broadcasted streamer buffs for user ${userId} (${userActiveBuffs.length} buffs)`);
                            if (isViewbot) {
                                console.log(`🎭 BUFF: (User is a viewbot)`);
                            }
                        } else {
                            console.log(`🎭 BUFF: Target is NOT the current streamer (${session?.userId} !== ${userId})`);
                        }
                    }
                }
            } else if (skipBroadcasts) {
                console.log(`🎭 BUFF: Skipped all broadcasts for user ${userId} (skipBroadcasts=true)`);
            }

            console.log(`✅ BUFF: Applied ${item.item_type} "${item.display_name}" to user ${userId} for ${buffDuration}s`);
            return buffData;

        } catch (error) {
            console.error(`❌ BUFF: Error applying buff to user ${userId}:`, error);
            throw error;
        }
    }

    // Create a new buff record
    async createNewBuff(userId, itemId, appliedByUserId, buffType, duration, effectData) {
        const metadata = effectData ? JSON.stringify(effectData) : null;
        
        console.log(`🎭 BUFF: Creating new buff - userId: ${userId}, itemId: ${itemId}, duration: ${duration}`);
        console.log(`🎭 BUFF: Additional params - appliedByUserId: ${appliedByUserId}, buffType: ${buffType}, metadata: ${metadata}`);
        
        // Check if this is an anonymous/viewbot user (negative ID)
        if (userId < 0) {
            console.log(`🎭 BUFF: Creating in-memory buff for anonymous user ${userId}`);
            
            // Create a synthetic buff ID for anonymous users
            const buffId = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Store in anonymous cache
            const anonymousBuff = {
                id: buffId,
                user_id: userId,
                item_id: itemId,
                applied_by_user_id: appliedByUserId,
                buff_type: buffType,
                duration_seconds: duration,
                remaining_seconds: duration,
                applied_at: new Date().toISOString(),
                is_active: true,
                metadata: metadata
            };
            
            // Add to anonymous cache
            if (!this.anonymousBuffsCache.has(userId)) {
                this.anonymousBuffsCache.set(userId, []);
            }
            this.anonymousBuffsCache.get(userId).push(anonymousBuff);
            
            console.log(`🎭 BUFF: Successfully created anonymous buff with ID: ${buffId}`);
            return buffId;
        }
        
        // For regular users, use database
        try {
            const insertQuery = `
                INSERT INTO active_buffs (
                    user_id, item_id, applied_by_user_id, buff_type,
                    duration_seconds, remaining_seconds, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            console.log(`🎭 BUFF: Executing INSERT query with params:`, [userId, itemId, appliedByUserId, buffType, duration, duration, metadata]);
            
            const result = await runAsync(insertQuery, [userId, itemId, appliedByUserId, buffType, duration, duration, metadata]);
            
            console.log(`🎭 BUFF: Successfully created buff with ID: ${result.id}, changes: ${result.changes}`);
            
            // Verify the buff was actually inserted
            const verifyBuff = await getAsync('SELECT * FROM active_buffs WHERE id = ?', [result.id]);
            console.log(`🎭 BUFF: Verification - buff exists in DB:`, !!verifyBuff, verifyBuff ? `(user_id: ${verifyBuff.user_id})` : '');
            
            return result.id;
        } catch (error) {
            console.error(`❌ BUFF: Failed to create buff:`, error);
            console.error(`❌ BUFF: Error details:`, error.message, error.code);
            throw error;
        }
    }

    // Update buff duration
    async updateBuffDuration(buffId, newRemainingSeconds) {
        // Check if this is an anonymous buff
        if (typeof buffId === 'string' && buffId.startsWith('anon_')) {
            // Update anonymous buff in cache
            for (const [userId, buffs] of this.anonymousBuffsCache.entries()) {
                const buff = buffs.find(b => b.id === buffId);
                if (buff) {
                    buff.remaining_seconds = newRemainingSeconds;
                    buff.last_updated = new Date().toISOString();
                    return;
                }
            }
            return;
        }
        
        // For regular buffs, update database
        await runAsync(`
            UPDATE active_buffs 
            SET remaining_seconds = ?, last_updated = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [newRemainingSeconds, buffId]);

        // Update cache
        const cachedBuff = this.activeBuffsCache.get(buffId);
        if (cachedBuff) {
            cachedBuff.remaining_seconds = newRemainingSeconds;
            cachedBuff.last_updated = new Date().toISOString();
        }
    }

    // Get active buff for specific item and user
    async getActiveBuffByItemForUser(userId, itemId) {
        // Check if this is an anonymous user
        if (userId < 0) {
            const anonymousBuffs = this.anonymousBuffsCache.get(userId) || [];
            return anonymousBuffs.find(buff => 
                buff.item_id === itemId && 
                buff.is_active && 
                buff.remaining_seconds > 0
            ) || null;
        }
        
        // For regular users, check database
        return await getAsync(`
            SELECT * FROM active_buffs 
            WHERE user_id = ? AND item_id = ? AND is_active = 1 AND remaining_seconds > 0
            ORDER BY applied_at DESC LIMIT 1
        `, [userId, itemId]);
    }

    // Get buff by ID with item details
    async getBuffById(buffId) {
        // Check if this is an anonymous buff
        if (typeof buffId === 'string' && buffId.startsWith('anon_')) {
            // Search for anonymous buff in cache
            for (const [userId, buffs] of this.anonymousBuffsCache.entries()) {
                const buff = buffs.find(b => b.id === buffId);
                if (buff) {
                    // Get item details to enrich the buff data
                    const item = await getAsync('SELECT * FROM items WHERE id = ?', [buff.item_id]);
                    if (item) {
                        buff.item_name = item.name;
                        buff.display_name = item.display_name;
                        buff.emoji = item.emoji;
                        buff.effect_data = item.effect_data;
                    }
                    return buff;
                }
            }
            return null;
        }
        
        // For regular buffs, query database
        return await getAsync(`
            SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data
            FROM active_buffs ab
            JOIN items i ON ab.item_id = i.id
            WHERE ab.id = ?
        `, [buffId]);
    }

    // Get all active buffs for a user
    async getActiveBuffsForUser(userId) {
        // Check if this is an anonymous user
        if (userId < 0) {
            const anonymousBuffs = this.anonymousBuffsCache.get(userId) || [];
            // Enrich with item details
            const enrichedBuffs = await Promise.all(anonymousBuffs
                .filter(buff => buff.is_active && buff.remaining_seconds > 0)
                .map(async (buff) => {
                    const item = await getAsync('SELECT * FROM items WHERE id = ?', [buff.item_id]);
                    if (item) {
                        buff.item_name = item.name;
                        buff.display_name = item.display_name;
                        buff.emoji = item.emoji;
                        buff.effect_data = item.effect_data;
                    }
                    return buff;
                }));
            return enrichedBuffs.map(buff => this.formatBuffForClient(buff));
        }
        
        // For regular users, query database
        const buffs = await allAsync(`
            SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data
            FROM active_buffs ab
            JOIN items i ON ab.item_id = i.id
            WHERE ab.user_id = ? AND ab.is_active = 1 AND ab.remaining_seconds > 0
            ORDER BY ab.applied_at DESC
        `, [userId]);

        return buffs.map(buff => this.formatBuffForClient(buff));
    }

    // Get active buffs for the current streamer (public view)
    async getActiveBuffsForCurrentStreamer() {
        if (!this.streamService) {
            console.log(`🎭 BUFF: StreamService not available`);
            return [];
        }

        const currentStreamerSocketId = this.streamService.getCurrentStreamer();
        if (!currentStreamerSocketId) {
            console.log(`🎭 BUFF: No current streamer found`);
            return [];
        }

        // Use the session service to map socketId to userId
        if (!this.sessionService) {
            console.log(`🎭 BUFF: SessionService not available for mapping socketId to userId`);
            return [];
        }

        const session = this.sessionService.getSessionBySocketId(currentStreamerSocketId);
        if (!session || !session.userId) {
            console.log(`🎭 BUFF: No userId found for current streamer socketId: ${currentStreamerSocketId}`);
            
            // Fallback: Try to get any active buffs from the database
            // This handles viewbots and other special cases
            console.log(`🎭 BUFF: Attempting fallback - checking for any active buffs in database`);
            const allActiveBuffs = await allAsync(`
                SELECT ab.*, i.name as item_name, i.display_name, i.emoji, i.effect_data,
                       ab.user_id
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.is_active = 1 AND ab.remaining_seconds > 0
                ORDER BY ab.applied_at DESC
            `);
            
            if (allActiveBuffs && allActiveBuffs.length > 0) {
                console.log(`🎭 BUFF: Found ${allActiveBuffs.length} active buffs in fallback query`);
                // Group by user and return the buffs for the user with most recent activity
                const buffsByUser = {};
                for (const buff of allActiveBuffs) {
                    if (!buffsByUser[buff.user_id]) {
                        buffsByUser[buff.user_id] = [];
                    }
                    buffsByUser[buff.user_id].push(buff);
                }
                
                // Find the user with the most recent buff application (likely the streamer)
                let mostRecentUserId = null;
                let mostRecentTime = null;
                for (const [userId, userBuffs] of Object.entries(buffsByUser)) {
                    const latestBuff = userBuffs[0]; // Already sorted by applied_at DESC
                    if (!mostRecentTime || new Date(latestBuff.applied_at) > mostRecentTime) {
                        mostRecentTime = new Date(latestBuff.applied_at);
                        mostRecentUserId = userId;
                    }
                }
                
                if (mostRecentUserId && buffsByUser[mostRecentUserId]) {
                    console.log(`🎭 BUFF: Returning buffs for user ${mostRecentUserId} (${buffsByUser[mostRecentUserId].length} buffs)`);
                    return buffsByUser[mostRecentUserId].map(buff => this.formatBuffForClient(buff));
                }
            }
            
            return [];
        }

        console.log(`🎭 BUFF: Current streamer: socketId ${currentStreamerSocketId} -> userId ${session.userId}`);
        const buffs = await this.getActiveBuffsForUser(session.userId);
        console.log(`🎭 BUFF: Retrieved ${buffs.length} active buffs for streamer userId ${session.userId}`);
        return buffs;
    }

    // Remove/expire a buff
    async removeBuff(buffId, reason = 'manual') {
        try {
            // Check if this is an anonymous buff
            if (typeof buffId === 'string' && buffId.startsWith('anon_')) {
                // Remove anonymous buff from cache
                for (const [userId, buffs] of this.anonymousBuffsCache.entries()) {
                    const buffIndex = buffs.findIndex(b => b.id === buffId);
                    if (buffIndex !== -1) {
                        const buff = buffs[buffIndex];
                        buff.is_active = false;
                        buff.remaining_seconds = 0;
                        buffs.splice(buffIndex, 1);
                        
                        // Emit expiry event for anonymous buff
                        this.emit('buff-expired', { ...buff, reason });
                        
                        // Send real-time update for anonymous users
                        if (this.io) {
                            this.io.emit('buff-expired', {
                                buffId: buffId,
                                userId: buff.user_id,
                                reason: reason
                            });
                        }
                        
                        return true;
                    }
                }
                return false;
            }
            
            // For regular buffs, use database
            const buff = await this.getBuffById(buffId);
            if (!buff) {
                return false;
            }

            // Mark as inactive in database
            await runAsync(`
                UPDATE active_buffs 
                SET is_active = 0, remaining_seconds = 0, last_updated = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [buffId]);

            // Remove from cache
            this.activeBuffsCache.delete(buffId);

            // Emit expiry event
            this.emit('buff-expired', { ...buff, reason });

            // Send real-time update (skip broadcasts for viewbots with negative user IDs)
            if (this.io && buff.user_id >= 0) {
                this.io.emit('buff-expired', {
                    buffId: buffId,
                    userId: buff.user_id,
                    reason: reason
                });
                
                // Send updated buff lists after removal
                const userActiveBuffs = await this.getActiveBuffsForUser(buff.user_id);
                
                // Send user-buff-update for general consumption
                this.io.emit('user-buff-update', { userId: buff.user_id, buffs: userActiveBuffs });
                
                // Send personal buff updates to authenticated sockets for this user
                if (this.sessionService) {
                    const userSockets = this.sessionService.getSocketsByUserId(buff.user_id);
                    for (const socketId of userSockets) {
                        this.io.to(socketId).emit('my-buffs-update', { buffs: userActiveBuffs });
                    }
                }
                
                // If this was the current streamer's buff, update streamer buffs display
                if (this.streamService && this.streamService.getCurrentStreamer()) {
                    const currentStreamer = this.streamService.getCurrentStreamer();
                    if (this.sessionService) {
                        const session = this.sessionService.getSessionBySocketId(currentStreamer);
                        if (session && session.userId && session.userId.toString() === buff.user_id.toString()) {
                            this.io.emit('streamer-buffs-update', { buffs: userActiveBuffs });
                        }
                    }
                }
            } else if (buff.user_id < 0) {
                console.log(`🎭 BUFF: Skipped broadcasts for viewbot user ${buff.user_id} buff removal`);
            }

            console.log(`🎭 BUFF: Removed buff ${buffId} (${buff.display_name}) from user ${buff.user_id} - ${reason}`);
            return true;

        } catch (error) {
            console.error(`❌ BUFF: Error removing buff ${buffId}:`, error);
            return false;
        }
    }

    // Start periodic updates for real-time buff duration tracking
    startDurationUpdates() {
        // Update every second for real-time countdown
        this.updateInterval = setInterval(async () => {
            await this.updateBuffDurations();
        }, 1000);

        console.log('🎭 BUFF: Started real-time buff duration updates (every 1 second)');
    }

    // Update buff durations for all active buffs (real-time countdown)
    async updateBuffDurations() {
        try {
            // Get all active buffs from cache
            const allActiveBuffs = Array.from(this.activeBuffsCache.values())
                .filter(buff => buff && buff.is_active && buff.remaining_seconds > 0);

            if (allActiveBuffs.length === 0) {
                return; // No active buffs to update
            }

            // Get the current streamer's socketId and map it to userId
            const currentStreamerSocketId = this.streamService?.getCurrentStreamer?.();
            let currentStreamingUserId = null;
            
            if (currentStreamerSocketId && this.sessionService) {
                const session = this.sessionService.getSessionBySocketId(currentStreamerSocketId);
                if (session && session.userId) {
                    currentStreamingUserId = session.userId;
                    // Only log once per minute to avoid spam
                    if (!this.lastDebugLog || Date.now() - this.lastDebugLog > 60000) {
                        console.log(`🎭 BUFF: Current streamer socketId ${currentStreamerSocketId} -> userId ${currentStreamingUserId}`);
                        this.lastDebugLog = Date.now();
                    }
                } else if (!this.lastDebugLog || Date.now() - this.lastDebugLog > 60000) {
                    console.log(`🎭 BUFF: No session found for current streamer socketId ${currentStreamerSocketId}`);
                    this.lastDebugLog = Date.now();
                }
            } else if (!this.lastDebugLog || Date.now() - this.lastDebugLog > 60000) {
                console.log(`🎭 BUFF: No current streamer or session service not available`);
                this.lastDebugLog = Date.now();
            }
            
            // Update all active buff durations
            for (const buff of allActiveBuffs) {
                // Check if this buff belongs to the currently streaming user
                const isUserStreaming = currentStreamingUserId && buff.user_id.toString() === currentStreamingUserId.toString();
                
                // Only decrease buff duration if user is actively streaming
                let newRemaining = buff.remaining_seconds;
                if (isUserStreaming) {
                    newRemaining = Math.max(0, buff.remaining_seconds - 1);
                    // Log every 30 seconds to avoid spam
                    if (newRemaining % 30 === 0 || newRemaining <= 10) {
                        console.log(`🎭 BUFF: "${buff.display_name}" ticking down for streaming user ${buff.user_id} (${newRemaining}s remaining)`);
                    }
                } else {
                    // Log preservation every 60 seconds to avoid spam  
                    if (buff.remaining_seconds % 60 === 0) {
                        console.log(`🎭 BUFF: Preserving "${buff.display_name}" for non-streaming user ${buff.user_id} (${buff.remaining_seconds}s remaining)`);
                    }
                }
                
                if (newRemaining <= 0 && isUserStreaming) {
                    // Buff expired (only possible if user was streaming)
                    console.log(`🎭 BUFF: Buff "${buff.display_name}" expired for streaming user ${buff.user_id}`);
                    await this.removeBuff(buff.id, 'expired');
                } else if (isUserStreaming && newRemaining !== buff.remaining_seconds) {
                    // Update remaining time only if user is streaming and time changed
                    await this.updateBuffDuration(buff.id, newRemaining);
                    
                    // Update streaming time used
                    await runAsync(`
                        UPDATE active_buffs 
                        SET streaming_time_used = streaming_time_used + 1
                        WHERE id = ?
                    `, [buff.id]);
                }
                // If user is not streaming, buff duration is preserved (no database update needed)
            }

            // Emit buff updates for all affected users (skip viewbots with negative IDs)
            const affectedUsers = new Set(allActiveBuffs.map(buff => buff.user_id));
            for (const userId of affectedUsers) {
                // Skip broadcasts for viewbots (negative user IDs)
                if (this.io && userId >= 0) {
                    const activeBuffs = await this.getActiveBuffsForUser(userId);
                    
                    // Emit general user-buff-update
                    this.io.emit('user-buff-update', { userId, buffs: activeBuffs });
                    
                    // Emit personal buff updates to authenticated sockets for this user
                    if (this.sessionService) {
                        const userSockets = this.sessionService.getSocketsByUserId(userId);
                        for (const socketId of userSockets) {
                            this.io.to(socketId).emit('my-buffs-update', { buffs: activeBuffs });
                        }
                    }
                    
                    // If this user is the current streamer, also emit streamer-buffs-update
                    if (this.streamService) {
                        const currentStreamer = this.streamService.getCurrentStreamer();
                        if (currentStreamer) {
                            // Get session to map socketId to userId
                            if (this.sessionService) {
                                const session = this.sessionService.getSessionBySocketId(currentStreamer);
                                if (session && session.userId && session.userId.toString() === userId.toString()) {
                                    this.io.emit('streamer-buffs-update', { buffs: activeBuffs });
                                }
                            }
                        }
                    }
                } else if (userId < 0) {
                    // Viewbot: Skip personal updates but allow streamer updates
                    const activeBuffs = await this.getActiveBuffsForUser(userId);
                    
                    // Skip personal buff updates to the viewbot socket
                    console.log(`🎭 BUFF: Skipped personal duration updates for viewbot user ${userId}`);
                    
                    // But still send streamer buff updates if this viewbot is the current streamer
                    if (this.streamService) {
                        const currentStreamer = this.streamService.getCurrentStreamer();
                        if (currentStreamer && this.sessionService) {
                            const session = this.sessionService.getSessionBySocketId(currentStreamer);
                            if (session && session.userId && session.userId.toString() === userId.toString()) {
                                this.io.emit('streamer-buffs-update', { buffs: activeBuffs });
                                console.log(`🎭 BUFF: Broadcasted duration update for viewbot streamer ${userId} (${activeBuffs.length} buffs)`);
                            }
                        }
                    }
                }
            }

        } catch (error) {
            console.error('❌ BUFF: Error updating streaming-based durations:', error);
        }
    }

    // Clean up expired buffs
    async cleanupExpiredBuffs() {
        try {
            const expiredBuffs = await allAsync(`
                SELECT id FROM active_buffs 
                WHERE is_active = 1 AND remaining_seconds <= 0
            `);

            for (const buff of expiredBuffs) {
                await this.removeBuff(buff.id, 'cleanup');
            }

            if (expiredBuffs.length > 0) {
                console.log(`🎭 BUFF: Cleaned up ${expiredBuffs.length} expired buffs`);
            }

        } catch (error) {
            console.error('❌ BUFF: Error cleaning up expired buffs:', error);
        }
    }

    // Format buff data for client consumption
    formatBuffForClient(buff) {
        return {
            id: buff.id,
            userId: buff.user_id,
            itemId: buff.item_id,
            itemName: buff.item_name,
            displayName: buff.display_name,
            emoji: buff.emoji,
            buffType: buff.buff_type,
            durationSeconds: buff.duration_seconds,
            remainingSeconds: buff.remaining_seconds,
            streamingTimeUsed: buff.streaming_time_used,
            appliedAt: buff.applied_at,
            appliedByUserId: buff.applied_by_user_id,
            metadata: buff.metadata ? JSON.parse(buff.metadata) : null,
            effectData: buff.effect_data ? JSON.parse(buff.effect_data) : null
        };
    }

    // Get buff statistics
    async getBuffStats() {
        try {
            const stats = await allAsync(`
                SELECT 
                    i.name,
                    i.display_name,
                    i.emoji,
                    i.item_type as buff_type,
                    COUNT(*) as total_applications,
                    COUNT(DISTINCT ab.user_id) as unique_users,
                    AVG(ab.duration_seconds) as avg_duration,
                    AVG(ab.streaming_time_used) as avg_streaming_time_used
                FROM active_buffs ab
                JOIN items i ON ab.item_id = i.id
                WHERE ab.applied_at >= datetime('now', '-7 days')
                GROUP BY ab.item_id
                ORDER BY total_applications DESC
            `);

            return stats;
        } catch (error) {
            console.error('❌ BUFF: Error getting buff stats:', error);
            return [];
        }
    }

    // Shutdown cleanup
    shutdown() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        this.activeBuffsCache.clear();
        console.log('🎭 BUFF: BuffDebuffService shutdown complete');
    }
}

module.exports = BuffDebuffService;