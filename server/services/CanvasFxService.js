const EventEmitter = require('events');

const logger = require('../bootstrap/logger').child({ svc: 'CanvasFxService' });

const { CANVAS_EFFECT_MAPPINGS, CANVAS_INTERACTION_CONFIGS } = require('./canvasfx/effectDefinitions');

class CanvasFxService extends EventEmitter {
    constructor(io = null, itemService = null, buffDebuffService = null) {
        super();
        this.io = io;
        this.itemService = itemService;
        this.buffDebuffService = buffDebuffService;
        
        // Track active visual effects
        this.activeEffects = new Map();
        
        // Track effects that sync with buff duration
        this.buffSyncedEffects = new Map(); // effectId -> buffId
        
        // Effect queue for sequential rendering
        this.effectQueue = [];
        
        // Performance monitoring
        this.effectStats = {
            totalTriggered: 0,
            activeCount: 0,
            droppedEffects: 0
        };
        
        // Configuration
        this.config = {
            maxConcurrentEffects: 10,
            effectQueueSize: 20,
            defaultDuration: 2000
        };
        
        logger.debug('🎨 CANVASFX: Service initialized');
    }
    
    // Set dependencies after initialization if needed
    setDependencies(io, itemService, buffDebuffService, streamService = null, sessionService = null) {
        this.io = io;
        this.itemService = itemService;
        this.buffDebuffService = buffDebuffService;
        this.streamService = streamService;
        this.sessionService = sessionService;
        
        // Hook into buff service events
        if (this.buffDebuffService) {
            this.buffDebuffService.on('buff-applied', this.handleBuffApplied.bind(this));
            this.buffDebuffService.on('buff-expired', this.handleBuffExpired.bind(this));
        }
        
        // Track current streamer for change detection
        this.currentStreamer = null;
        this.streamerCheckInterval = null;
        
        // Start monitoring streamer changes if we have stream service
        if (this.streamService) {
            this.startStreamerMonitoring();
        }
    }
    
    // Handle buff applied event from BuffDebuffService
    async handleBuffApplied(buffData) {
        logger.debug(`🎨 CANVASFX: handleBuffApplied called with buffData:`, JSON.stringify(buffData, null, 2));
        
        // Check if this is a resumed buff (streamer coming back online with active buff)
        if (buffData.isResumed) {
            logger.debug(`🎨 CANVASFX: This is a RESUMED buff for ${buffData.item_name} - re-applying visual effect`);
        }
        
        try {
            // Check if this buff has visual effects
            const item = await this.itemService.getItemById(buffData.item_id);
            logger.debug(`🎨 CANVASFX: Retrieved item:`, item ? item.name : 'null');
            if (item && this.hasVisualEffect(item)) {
                logger.debug(`🎨 CANVASFX: Triggering visual effect for ${item.name}`);
                logger.debug(`🎨 CANVASFX: Buff data for ${item.name}:`, JSON.stringify(buffData, null, 2));
                const buffDuration = buffData.remaining_seconds || buffData.duration_seconds || 60;
                logger.debug(`🎨 CANVASFX: Using buff duration ${buffDuration}s for ${item.name}`);
                
                const effect = await this.triggerItemEffect(
                    buffData.user_id,
                    buffData.item_id,
                    buffData.stream_id,
                    { 
                        triggeredByBuff: true,
                        buffId: buffData.id,
                        buffDuration: buffDuration
                    }
                );
                
                // Track buff-synced effects (like smoke bomb)
                if (effect && this.isBuffSyncedEffect(item)) {
                    if (effect.isMultiPhase) {
                        // For multi-phase effects, we need to track all phases
                        const phaseEffects = Array.from(this.activeEffects.values()).filter(e => 
                            e.mainEffectId === effect.id || e.id.startsWith(effect.id + '_phase')
                        );
                        for (const phaseEffect of phaseEffects) {
                            this.buffSyncedEffects.set(phaseEffect.id, buffData.id);
                        }
                        logger.debug(`🎨 CANVASFX: Tracking multi-phase buff-synced effect ${effect.id} (${phaseEffects.length} phases) with buff ${buffData.id}`);
                    } else {
                        this.buffSyncedEffects.set(effect.id, buffData.id);
                        logger.debug(`🎨 CANVASFX: Tracking buff-synced effect ${effect.id} with buff ${buffData.id}`);
                    }
                }
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling buff visual effect:', error);
        }
    }
    
    // Check if an item has visual effects
    hasVisualEffect(item) {
        const visualEffectItems = [
            'tomato',
            'confetti_cannon',
            'smoke_bomb',
            'rainbow_effect',
            'disco_ball',
            'spotlight',
            'freeze_frame',
            'red_marker',
            'blue_marker',
            'green_marker',
            'yellow_marker',
            'purple_marker',
            'orange_marker',
            'pink_marker',
            'black_marker',
            'white_marker',
            'rainbow_marker',
            'heart_swarm',
            'arrow',
            'molotov',
            'lsd',
            'bugs'
        ];
        
        return visualEffectItems.includes(item.name);
    }
    
    // Check if an item's effect should be synced with buff duration
    isBuffSyncedEffect(item) {
        const buffSyncedItems = [
            'smoke_bomb'
        ];
        
        return buffSyncedItems.includes(item.name);
    }
    
    // Handle buff expired event from BuffDebuffService
    async handleBuffExpired(buffData) {
        try {
            // Find any effects that are synced to this buff
            const effectsToCancel = [];
            this.buffSyncedEffects.forEach((buffId, effectId) => {
                if (buffId === buffData.id) {
                    effectsToCancel.push(effectId);
                }
            });
            
            // Cancel the synced effects
            for (const effectId of effectsToCancel) {
                await this.cancelEffect(effectId, 'buff-expired');
                this.buffSyncedEffects.delete(effectId);
            }
            
            if (effectsToCancel.length > 0) {
                logger.debug(`🎨 CANVASFX: Cancelled ${effectsToCancel.length} buff-synced effects for expired buff ${buffData.id}`);
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling buff expiry:', error);
        }
    }
    
    // Start monitoring for streamer changes
    startStreamerMonitoring() {
        // Initialize current streamer
        this.currentStreamer = this.streamService.getCurrentStreamer();
        logger.debug(`🎨 CANVASFX: Started streamer monitoring - Initial streamer: ${this.currentStreamer}`);
        
        // Check for streamer changes every 2 seconds
        this.streamerCheckInterval = setInterval(async () => {
            await this.checkStreamerChange();
        }, 2000);
    }
    
    // Check for streamer changes and handle them
    async checkStreamerChange() {
        try {
            const newStreamer = this.streamService.getCurrentStreamer();
            
            // Log every change for debugging
            if (this.currentStreamer !== newStreamer) {
                logger.debug(`🎨 CANVASFX: Streamer change detected - Previous: ${this.currentStreamer}, New: ${newStreamer}`);
            }
            
            // Streamer changed or went offline
            if (this.currentStreamer !== newStreamer) {
                const previousStreamer = this.currentStreamer;
                this.currentStreamer = newStreamer;
                
                logger.debug(`🎨 CANVASFX: DEBUG - Conditions: prev=${previousStreamer}, new=${newStreamer}, prev&&!new=${previousStreamer && !newStreamer}, prev&&new&&different=${previousStreamer && newStreamer && previousStreamer !== newStreamer}, !prev&&new=${!previousStreamer && newStreamer}`);
                
                if (previousStreamer && !newStreamer) {
                    // Stream ended
                    logger.debug(`🎨 CANVASFX: BRANCH: Stream ended`);
                    await this.handleStreamEnded();
                    logger.debug(`🎨 CANVASFX: Stream ended, previous streamer was ${previousStreamer}`);
                } else if (previousStreamer && newStreamer && previousStreamer !== newStreamer) {
                    // Streamer switched
                    logger.debug(`🎨 CANVASFX: BRANCH: Streamer switched`);
                    logger.debug(`🎨 CANVASFX: ABOUT TO CALL handleStreamerChanged(${previousStreamer}, ${newStreamer})`);
                    try {
                        await this.handleStreamerChanged(previousStreamer, newStreamer);
                        logger.debug(`🎨 CANVASFX: COMPLETED handleStreamerChanged call`);
                    } catch (error) {
                        logger.error(`❌ CANVASFX: ERROR in handleStreamerChanged:`, error);
                    }
                    logger.debug(`🎨 CANVASFX: Streamer changed from ${previousStreamer} to ${newStreamer}`);
                } else if (!previousStreamer && newStreamer) {
                    // New streamer went live
                    logger.debug(`🎨 CANVASFX: BRANCH: New streamer went live`);
                    // New streamer went live - but check if this might be a takeover
                    logger.debug(`🎨 CANVASFX: NEW STREAMER DETECTED - calling handleStreamerWentLive(${newStreamer})`);
                    
                    // Clear any existing buff-synced effects first (in case this is actually a takeover)
                    const existingEffects = Array.from(this.buffSyncedEffects.keys());
                    if (existingEffects.length > 0) {
                        logger.debug(`🎨 CANVASFX: Clearing ${existingEffects.length} existing buff-synced effects before new streamer`);
                        for (const effectId of existingEffects) {
                            await this.cancelEffect(effectId, 'new-streamer-cleanup');
                            this.buffSyncedEffects.delete(effectId);
                        }
                        
                        // Send cleanup to all clients
                        if (this.io) {
                            this.io.emit('canvas-effects-clear-buff-synced');
                            logger.debug(`📡 CANVASFX: Sent buff-synced effects clear before new streamer`);
                        }
                    }
                    
                    await this.handleStreamerWentLive(newStreamer);
                    logger.debug(`🎨 CANVASFX: New streamer went live: ${newStreamer}`);
                }
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error checking streamer change:', error);
        }
    }
    
    // Handle streamer change
    async handleStreamerChanged(previousStreamer, newStreamer) {
        logger.debug(`🎨 CANVASFX: ENTERED handleStreamerChanged method - ${previousStreamer} -> ${newStreamer}`);
        try {
            logger.debug(`🎨 CANVASFX: Handling streamer switch from ${previousStreamer} to ${newStreamer}`);
            logger.debug(`🎨 CANVASFX: DEBUG - Starting STEP 1: Clear existing effects`);
            
            // STEP 1: Clear all existing buff-synced effects from previous streamer
            const effectsToCancel = [];
            
            this.buffSyncedEffects.forEach((buffId, effectId) => {
                // Cancel all buff-synced effects on streamer switch
                effectsToCancel.push(effectId);
                logger.debug(`🎨 CANVASFX: Marking buff-synced effect ${effectId} for cancellation`);
            });
            
            logger.debug(`🎨 CANVASFX: DEBUG - Found ${effectsToCancel.length} effects to cancel`);
            
            // Cancel all found effects
            for (const effectId of effectsToCancel) {
                await this.cancelEffect(effectId, 'streamer-switched');
                this.buffSyncedEffects.delete(effectId);
            }
            
            // Also clear any remaining active effects that might be lingering
            const remainingEffects = [];
            this.activeEffects.forEach((effect, effectId) => {
                if (this.isBuffSyncedEffect({ name: effect.itemName })) {
                    remainingEffects.push(effectId);
                }
            });
            
            logger.debug(`🎨 CANVASFX: DEBUG - Found ${remainingEffects.length} remaining effects to cleanup`);
            
            for (const effectId of remainingEffects) {
                if (!effectsToCancel.includes(effectId)) {
                    await this.cancelEffect(effectId, 'streamer-switched-cleanup');
                }
            }
            
            if (effectsToCancel.length > 0) {
                logger.debug(`🎨 CANVASFX: Cancelled ${effectsToCancel.length} buff-synced effects from previous streamer`);
            }
            
            // Send cleanup broadcast to all clients
            if (this.io) {
                this.io.emit('canvas-effects-clear-buff-synced');
                logger.debug(`📡 CANVASFX: Sent buff-synced effects clear to all clients`);
            }
            
            // Force cleanup for the previous streamer specifically
            if (previousStreamer) {
                this.forceCleanupForSocket(previousStreamer, 'streamer-switched');
            }
            
            logger.debug(`🎨 CANVASFX: DEBUG - Starting STEP 2: Check new streamer buffs`);
            
            // STEP 2: Check if NEW streamer has active smoke bomb buffs and trigger them
            logger.debug(`🎨 CANVASFX: Calling handleStreamerWentLive for new streamer ${newStreamer}`);
            await this.handleStreamerWentLive(newStreamer);
            logger.debug(`🎨 CANVASFX: Completed handleStreamerWentLive for new streamer ${newStreamer}`);
            
            logger.debug(`🎨 CANVASFX: DEBUG - Completed streamer switch handling`);
            
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling streamer change:', error);
            logger.error('❌ CANVASFX: Error stack:', error.stack);
        }
    }
    
    // Handle streamer going live
    async handleStreamerWentLive(newStreamerSocketId) {
        try {
            // Map socket ID to user ID
            if (!this.sessionService) {
                logger.warn('⚠️ CANVASFX: SessionService not available for mapping streamer socket to user');
                return;
            }
            
            const session = this.sessionService.getSessionBySocketId(newStreamerSocketId);
            if (!session || !session.userId) {
                logger.debug(`🎨 CANVASFX: No session found for new streamer socketId ${newStreamerSocketId}`);
                return;
            }
            
            const streamerId = session.userId;
            logger.debug(`🎨 CANVASFX: Checking for existing buffs for new streamer userId ${streamerId}`);
            
            // Check for active smoke bomb debuffs on this streamer
            if (this.buffDebuffService) {
                const activeBuffs = await this.buffDebuffService.getActiveBuffsForUser(streamerId);
                
                // Find smoke bomb buffs
                const smokeBombBuffs = activeBuffs.filter(buff => 
                    buff.itemName === 'smoke_bomb' && buff.remainingSeconds > 0
                );
                
                if (smokeBombBuffs.length > 0) {
                    logger.debug(`🎨 CANVASFX: Found ${smokeBombBuffs.length} active smoke bomb buff(s) on new streamer`);
                    
                    // For each smoke bomb buff, trigger the persistent smoke phase
                    for (const buff of smokeBombBuffs) {
                        const item = await this.itemService.getItemById(buff.itemId);
                        if (item) {
                            logger.debug(`🎨 CANVASFX: Triggering existing smoke bomb animation for streamer (${buff.remainingSeconds}s remaining)`);
                            
                            // Calculate remaining duration in milliseconds
                            const remainingDurationMs = buff.remainingSeconds * 1000;
                            
                            // Create persistent smoke effect (skip initial puff since buff is already active)
                            const persistentSmokeEffect = {
                                id: `fx_live_smoke_${buff.itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                userId: streamerId,
                                itemId: buff.itemId,
                                streamId: null, // Current stream
                                itemName: item.name,
                                displayName: item.display_name,
                                emoji: item.emoji,
                                type: 'overlay',
                                duration: remainingDurationMs,
                                config: {
                                    phaseName: 'persistent_smoke',
                                    phaseIndex: 1,
                                    totalPhases: 2,
                                    color: 'rgba(100, 100, 100, 0.6)',
                                    animation: 'smoke-fill',
                                    spread: true,
                                    opacity: 0.6,
                                    width: 'full',
                                    height: 'full',
                                    fadeIn: true,
                                    fadeInDuration: 2000, // Quick fade-in since buff is already active
                                    persistent: true,
                                    waveEffect: true,
                                    density: 0.7,
                                    triggeredByBuff: true,
                                    buffId: buff.id,
                                    buffDuration: buff.remainingSeconds,
                                    streamerWentLive: true // Flag to indicate this was triggered by streamer going live
                                },
                                startTime: Date.now(),
                                position: { x: 0.5, y: 0.5 }, // Center screen
                                buffId: buff.id,
                                isMultiPhase: false // This is just the persistent phase
                            };
                            
                            // Store active effect
                            this.activeEffects.set(persistentSmokeEffect.id, persistentSmokeEffect);
                            this.effectStats.totalTriggered++;
                            this.effectStats.activeCount = this.activeEffects.size;
                            
                            // Track as buff-synced effect
                            this.buffSyncedEffects.set(persistentSmokeEffect.id, buff.id);
                            
                            // Broadcast to all viewers immediately
                            if (this.io) {
                                this.io.emit('canvas-effect-trigger', persistentSmokeEffect);
                                logger.debug(`📡 CANVASFX: Broadcasted existing smoke bomb effect for new streamer (${remainingDurationMs}ms remaining)`);
                            }
                            
                            // Emit local event
                            this.emit('effect-triggered', persistentSmokeEffect);
                            
                            logger.debug(`✅ CANVASFX: Activated persistent smoke for streamer with existing buff (${buff.remainingSeconds}s remaining)`);
                        }
                    }
                } else {
                    logger.debug(`🎨 CANVASFX: No active smoke bomb buffs found for new streamer userId ${streamerId}`);
                }
            } else {
                logger.warn('⚠️ CANVASFX: BuffDebuffService not available for checking existing buffs');
            }
            
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling streamer went live:', error);
        }
    }
    
    // Handle stream ending
    async handleStreamEnded() {
        try {
            logger.debug(`🎨 CANVASFX: Handling stream end - cleaning up all buff-synced effects`);
            
            // Cancel all buff-synced effects when stream ends
            const effectsToCancel = Array.from(this.buffSyncedEffects.keys());
            
            for (const effectId of effectsToCancel) {
                await this.cancelEffect(effectId, 'stream-ended');
                this.buffSyncedEffects.delete(effectId);
            }
            
            // Also clean up any remaining smoke bomb effects in active effects
            const remainingEffects = [];
            this.activeEffects.forEach((effect, effectId) => {
                if (this.isBuffSyncedEffect({ name: effect.itemName })) {
                    remainingEffects.push(effectId);
                }
            });
            
            for (const effectId of remainingEffects) {
                if (!effectsToCancel.includes(effectId)) {
                    await this.cancelEffect(effectId, 'stream-ended-cleanup');
                }
            }
            
            // Force a complete cleanup broadcast
            if (this.io) {
                this.io.emit('canvas-effects-clear-buff-synced');
                logger.debug(`📡 CANVASFX: Sent complete buff-synced effects clear to all clients (stream ended)`);
            }
            
            if (effectsToCancel.length > 0 || remainingEffects.length > 0) {
                logger.debug(`🎨 CANVASFX: Cancelled ${effectsToCancel.length} buff-synced effects + ${remainingEffects.length} remaining effects due to stream ending`);
            }
        } catch (error) {
            logger.error('❌ CANVASFX: Error handling stream end:', error);
        }
    }
    
    // Check if an item requires interactive behavior (click-to-throw)
    isInteractiveItem(item) {
        const interactiveItems = [
            'tomato',
            'snowball',
            'paint_balloon',
            'water_balloon',
            'confetti_cannon',
            'smoke_bomb',
            'disco_ball',
            'spotlight',
            'rainbow_effect',
            'red_marker',
            'blue_marker',
            'green_marker',
            'yellow_marker',
            'purple_marker',
            'orange_marker',
            'pink_marker',
            'black_marker',
            'white_marker',
            'rainbow_marker',
            'heart_swarm',
            'arrow',
            'molotov',
            'lsd',
            'bugs'
        ];
        
        return interactiveItems.includes(item.name);
    }
    
    // Get interaction configuration for an item
    getInteractionConfig(item) {
        const interactionConfigs = CANVAS_INTERACTION_CONFIGS;
        
        const config = interactionConfigs[item.name];
        if (!config) return null;
        
        // Replace placeholders with actual values
        const itemDisplayName = item.display_name || item.displayName || item.name || 'item';
        return {
            ...config,
            indicator: config.indicator.replace('{itemName}', itemDisplayName),
            chatMessage: config.chatMessage // Will be replaced at runtime with username
        };
    }
    
    // Trigger visual effect from item usage
    async triggerItemEffect(userId, itemId, streamId, effectParams = {}) {
        try {
            logger.debug(`🎨 CANVASFX: === TRIGGERING ITEM EFFECT ===`);
            logger.debug(`🎨 CANVASFX DEBUG: triggerItemEffect called - userId: ${userId}, itemId: ${itemId}, streamId: ${streamId}`);
            logger.debug(`🎨 CANVASFX DEBUG: effectParams:`, JSON.stringify(effectParams, null, 2));
            
            // Check concurrent effect limit
            if (this.activeEffects.size >= this.config.maxConcurrentEffects) {
                logger.warn('⚠️ CANVASFX: Max concurrent effects reached, dropping effect');
                this.effectStats.droppedEffects++;
                return null;
            }
            
            const item = await this.itemService.getItemById(itemId);
            if (!item) {
                logger.error('❌ CANVASFX: Item not found:', itemId);
                return null;
            }
            
            logger.debug(`🎨 CANVASFX DEBUG: Item found - name: ${item.name}, display_name: ${item.display_name}`);
            
            const effectConfig = this.getEffectConfig(item);
            logger.debug(`🎨 CANVASFX DEBUG: Effect config retrieved:`, effectConfig);
            
            // Handle buff-duration effects specially
            let effectDuration = effectConfig.duration;
            if (effectConfig.duration === 'buff-duration' && effectParams.buffDuration) {
                effectDuration = effectParams.buffDuration * 1000; // Convert seconds to milliseconds
                logger.debug(`🎨 CANVASFX: Using buff duration of ${effectParams.buffDuration}s for ${item.name}`);
            }
            
            // Handle multi-phase effects
            if (effectConfig.type === 'multi-phase') {
                return await this.triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, effectDuration, effectParams);
            }
            
            // Create single-phase effect instance
            const effect = {
                id: `fx_${userId}_${itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                userId,
                itemId,
                streamId,
                itemName: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: effectConfig.type,
                duration: effectDuration,
                config: { ...effectConfig.config, ...effectParams },
                startTime: Date.now(),
                position: this.getRandomPosition(),
                buffId: effectParams.buffId || null
            };
            
            // Store active effect
            this.activeEffects.set(effect.id, effect);
            this.effectStats.totalTriggered++;
            this.effectStats.activeCount = this.activeEffects.size;
            
            // Broadcast to all viewers
            if (this.io) {
                logger.debug(`📡 CANVASFX: About to broadcast canvas-effect-trigger for ${item.display_name}`);
                logger.debug(`📡 CANVASFX: Effect data being sent:`, JSON.stringify(effect, null, 2));
                this.io.emit('canvas-effect-trigger', effect);
                logger.debug(`📡 CANVASFX: Broadcasted effect ${effect.type} for item ${item.display_name}`);
            } else {
                logger.error(`❌ CANVASFX: No io instance available to broadcast effect!`);
            }
            
            // Emit local event
            this.emit('effect-triggered', effect);
            
            // Auto-cleanup after duration (but only for non-buff-synced effects)
            if (!this.isBuffSyncedEffect(item)) {
                setTimeout(() => {
                    this.cleanupEffect(effect.id);
                }, effectDuration);
            } else {
                logger.debug(`🎨 CANVASFX: Buff-synced effect ${effect.id} will be managed by buff lifecycle`);
            }
            
            return effect;
            
        } catch (error) {
            logger.error('❌ CANVASFX: Error triggering item effect:', error);
            return null;
        }
    }
    
    // Trigger visual effect at specific position (for click-to-throw functionality)
    async triggerItemEffectAtPosition(userId, itemId, streamId, position, effectParams = {}) {
        try {
            // Check concurrent effect limit
            if (this.activeEffects.size >= this.config.maxConcurrentEffects) {
                logger.warn('⚠️ CANVASFX: Max concurrent effects reached, dropping effect');
                this.effectStats.droppedEffects++;
                return null;
            }
            
            const item = await this.itemService.getItemById(itemId);
            if (!item) {
                logger.error('❌ CANVASFX: Item not found:', itemId);
                return null;
            }
            
            const effectConfig = this.getEffectConfig(item);
            
            // Handle buff-duration effects specially
            let effectDuration = effectConfig.duration;
            if (effectConfig.duration === 'buff-duration' && effectParams.buffDuration) {
                effectDuration = effectParams.buffDuration * 1000; // Convert seconds to milliseconds
                logger.debug(`🎨 CANVASFX: Using buff duration of ${effectParams.buffDuration}s for positioned ${item.name}`);
            }
            
            // Handle multi-phase effects
            if (effectConfig.type === 'multi-phase') {
                // For positioned multi-phase effects, pass the position to all phases
                return await this.triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, effectDuration, { 
                    ...effectParams, 
                    position: { 
                        x: Math.max(0, Math.min(1, position.x)), // Clamp between 0 and 1
                        y: Math.max(0, Math.min(1, position.y))  // Clamp between 0 and 1
                    }
                });
            }
            
            // Create single-phase effect instance with specified position
            const effect = {
                id: `fx_throw_${userId}_${itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                userId,
                itemId,
                streamId,
                itemName: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: effectConfig.type,
                duration: effectDuration,
                config: { ...effectConfig.config, ...effectParams },
                startTime: Date.now(),
                position: { 
                    x: Math.max(0, Math.min(1, position.x)), // Clamp between 0 and 1
                    y: Math.max(0, Math.min(1, position.y))  // Clamp between 0 and 1
                }
            };
            
            // Store active effect
            this.activeEffects.set(effect.id, effect);
            this.effectStats.totalTriggered++;
            this.effectStats.activeCount = this.activeEffects.size;
            
            // Broadcast to all viewers
            if (this.io) {
                this.io.emit('canvas-effect-trigger', effect);
                logger.debug(`📡 CANVASFX: Broadcasted positioned effect ${effect.type} for item ${item.display_name} at (${position.x}, ${position.y})`);
            }
            
            // Emit local event
            this.emit('effect-triggered', effect);
            
            // Auto-cleanup after duration (but only for non-buff-synced effects)
            if (!this.isBuffSyncedEffect(item)) {
                setTimeout(() => {
                    this.cleanupEffect(effect.id);
                }, effectDuration);
            } else {
                logger.debug(`🎨 CANVASFX: Buff-synced positioned effect ${effect.id} will be managed by buff lifecycle`);
            }
            
            return effect;
            
        } catch (error) {
            logger.error('❌ CANVASFX: Error triggering positioned item effect:', error);
            return null;
        }
    }
    
    // Trigger multi-phase effect (like smoke bomb with initial puff + persistent smoke)
    async triggerMultiPhaseEffect(userId, itemId, streamId, item, effectConfig, totalDuration, effectParams) {
        try {
            logger.debug(`🎨 CANVASFX: Triggering multi-phase effect for ${item.name} with total duration ${totalDuration}ms`);
            
            const mainEffectId = `fx_multi_${userId}_${itemId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const phaseEffects = [];
            let currentTime = 0;
            
            for (const [phaseIndex, phase] of effectConfig.config.phases.entries()) {
                const phaseId = `${mainEffectId}_phase${phaseIndex}`;
                const phaseStartTime = Date.now() + (phase.delay || 0);
                
                // Calculate phase duration
                let phaseDuration = phase.duration;
                if (phase.duration === 'remaining-duration') {
                    // Calculate remaining duration after initial phases
                    const usedTime = (phase.delay || 0) + 2000; // Account for initial puff + delay
                    phaseDuration = Math.max(1000, totalDuration - usedTime); // At least 1 second
                }
                
                const phaseEffect = {
                    id: phaseId,
                    mainEffectId: mainEffectId,
                    userId,
                    itemId,
                    streamId,
                    itemName: item.name,
                    displayName: item.display_name,
                    emoji: item.emoji,
                    type: phase.type,
                    duration: phaseDuration,
                    config: { 
                        ...phase.config, 
                        ...effectParams,
                        phaseName: phase.name,
                        phaseIndex: phaseIndex,
                        totalPhases: effectConfig.config.phases.length
                    },
                    startTime: phaseStartTime,
                    position: effectParams.position || this.getRandomPosition(),
                    buffId: effectParams.buffId || null,
                    isMultiPhase: true,
                    delay: phase.delay || 0
                };
                
                phaseEffects.push(phaseEffect);
                
                // Store phase effect in active effects
                this.activeEffects.set(phaseEffect.id, phaseEffect);
                
                // Schedule the phase to start
                setTimeout(async () => {
                    if (this.activeEffects.has(phaseEffect.id)) {
                        // Broadcast phase to all viewers
                        if (this.io) {
                            this.io.emit('canvas-effect-trigger', phaseEffect);
                            logger.debug(`📡 CANVASFX: Broadcasted phase "${phase.name}" of ${item.display_name} (${phaseDuration}ms)`);
                        }
                        
                        // Auto-cleanup after phase duration (only for non-buff-synced phases or last phase)
                        if (!this.isBuffSyncedEffect(item) || phaseIndex === effectConfig.config.phases.length - 1) {
                            setTimeout(() => {
                                this.cleanupEffect(phaseEffect.id);
                            }, phaseDuration);
                        } else {
                            logger.debug(`🎨 CANVASFX: Phase "${phase.name}" will be managed by buff lifecycle`);
                        }
                    }
                }, phase.delay || 0);
            }
            
            // Update stats
            this.effectStats.totalTriggered++;
            this.effectStats.activeCount = this.activeEffects.size;
            
            // Emit local event for main effect
            const mainEffect = {
                id: mainEffectId,
                userId,
                itemId,
                streamId,
                itemName: item.name,
                displayName: item.display_name,
                type: 'multi-phase',
                phases: phaseEffects.length,
                totalDuration,
                isMultiPhase: true
            };
            this.emit('effect-triggered', mainEffect);
            
            logger.debug(`✅ CANVASFX: Multi-phase effect "${item.name}" scheduled with ${phaseEffects.length} phases`);
            
            // Return the main effect for tracking
            return mainEffect;
            
        } catch (error) {
            logger.error('❌ CANVASFX: Error triggering multi-phase effect:', error);
            return null;
        }
    }

    // Get effect configuration for an item
    getEffectConfig(item) {
        // Map items to visual effects
        const effectMappings = CANVAS_EFFECT_MAPPINGS;
        
        return effectMappings[item.name] || {
            type: 'default',
            duration: this.config.defaultDuration,
            config: {
                color: '#ffffff',
                animation: 'fade'
            }
        };
    }
    
    // Get random position for effect placement
    getRandomPosition() {
        return {
            x: 0.1 + Math.random() * 0.8, // 10% to 90% of width
            y: 0.1 + Math.random() * 0.8  // 10% to 90% of height
        };
    }
    
    // Cleanup an effect
    cleanupEffect(effectId) {
        const effect = this.activeEffects.get(effectId);
        if (effect) {
            this.activeEffects.delete(effectId);
            this.effectStats.activeCount = this.activeEffects.size;
            
            // Remove from buff-synced tracking if needed
            this.buffSyncedEffects.delete(effectId);
            
            // Notify clients
            if (this.io) {
                this.io.emit('canvas-effect-complete', { effectId });
            }
            
            // Emit local event
            this.emit('effect-completed', effect);
            
            logger.debug(`🧹 CANVASFX: Cleaned up effect ${effectId}`);
        }
    }
    
    // Cancel an effect immediately (used for buff expiry or streamer switching)
    async cancelEffect(effectId, reason = 'cancelled') {
        const effect = this.activeEffects.get(effectId);
        if (effect) {
            this.activeEffects.delete(effectId);
            this.effectStats.activeCount = this.activeEffects.size;
            
            // Remove from buff-synced tracking if needed
            this.buffSyncedEffects.delete(effectId);
            
            // Notify clients to immediately cancel the effect
            if (this.io) {
                this.io.emit('canvas-effect-cancelled', { 
                    effectId, 
                    reason,
                    itemName: effect.itemName 
                });
                
                // For smoke bomb effects, send additional force clear to ensure cleanup
                if (effect.itemName === 'smoke_bomb') {
                    this.io.emit('canvas-effect-force-clear-item', { 
                        itemName: 'smoke_bomb',
                        reason: reason,
                        effectId: effectId
                    });
                    logger.debug(`📡 CANVASFX: Sent additional smoke bomb force clear for ${effectId}`);
                }
            }
            
            // Emit local event
            this.emit('effect-cancelled', { ...effect, reason });
            
            logger.debug(`🚫 CANVASFX: Cancelled effect ${effectId} (${effect.itemName}) - ${reason}`);
            return true;
        }
        return false;
    }
    
    // Clear all active effects
    clearAllEffects() {
        const effectIds = Array.from(this.activeEffects.keys());
        effectIds.forEach(id => this.cleanupEffect(id));
        
        if (this.io) {
            this.io.emit('canvas-effects-clear');
        }
        
        logger.debug('🧹 CANVASFX: Cleared all active effects');
    }
    
    // Force clear smoke bomb effects for a specific socket (e.g., former streamer)
    forceCleanupForSocket(socketId, reason = 'manual') {
        logger.debug(`🎨 CANVASFX: Force cleaning up effects for socket ${socketId} - ${reason}`);
        
        if (this.io && socketId) {
            // Send multiple cleanup events to ensure the client clears the effects
            this.io.to(socketId).emit('canvas-effects-clear');
            this.io.to(socketId).emit('canvas-effects-clear-buff-synced');
            this.io.to(socketId).emit('canvas-effect-force-clear', { 
                reason: reason,
                effects: ['smoke_bomb'],
                forceComplete: true
            });
            
            logger.debug(`📡 CANVASFX: Sent comprehensive cleanup to socket ${socketId}`);
        }
    }
    
    // Get active effects for a user
    getActiveEffectsForUser(userId) {
        const userEffects = [];
        this.activeEffects.forEach(effect => {
            if (effect.userId === userId) {
                userEffects.push(effect);
            }
        });
        return userEffects;
    }
    
    // Get all active effects
    getAllActiveEffects() {
        return Array.from(this.activeEffects.values());
    }
    
    // Get effect statistics
    getStats() {
        return {
            ...this.effectStats,
            activeEffects: Array.from(this.activeEffects.keys())
        };
    }
    
    // Handle socket connection for a client
    handleClientConnection(socket) {
        // Send current active effects to new viewer
        const activeEffects = this.getAllActiveEffects();
        if (activeEffects.length > 0) {
            socket.emit('canvas-effects-sync', { effects: activeEffects });
        }
        
        // Handle effect requests
        socket.on('request-effect-sync', () => {
            socket.emit('canvas-effects-sync', { effects: this.getAllActiveEffects() });
        });
        
        logger.debug(`🔌 CANVASFX: Client connected, sent ${activeEffects.length} active effects`);
    }
    
    // Lifecycle entry point — uniform name across services for the
    // bootstrap shutdown loop (PR 1.2). Delegates to the existing teardown.
    async stop() {
        this.shutdown();
    }

    // Shutdown cleanup
    shutdown() {
        if (this.streamerCheckInterval) {
            clearInterval(this.streamerCheckInterval);
            this.streamerCheckInterval = null;
        }
        
        this.activeEffects.clear();
        this.buffSyncedEffects.clear();
        logger.debug('🎨 CANVASFX: Service shutdown complete');
    }
}

module.exports = CanvasFxService;
