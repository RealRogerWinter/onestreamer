const EventEmitter = require('events');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const os = require('os');

const logger = require('../bootstrap/logger').child({ svc: 'VisualFxService' });

const { VISUAL_FX_EFFECTS } = require('./visualfx/effectRegistry');
const ResourceMonitor = require('./visualfx/ResourceMonitor');
const FfmpegPipeline = require('./visualfx/FfmpegPipeline');
const BuffBridge = require('./visualfx/BuffBridge');
const ConsumerControl = require('./visualfx/ConsumerControl');

class VisualFxService extends EventEmitter {
    constructor(mediasoupService = null, buffDebuffService = null) {
        super();
        this.mediasoupService = mediasoupService;
        this.buffDebuffService = buffDebuffService;
        
        // Effect Registry
        this.effectRegistry = new Map();
        this.activeEffects = new Map(); // streamId -> Set of active effects
        this.effectQueue = [];
        this.rtpInterceptors = new Map();
        
        // Processing pipelines
        this.processingPipelines = new Map(); // streamId -> pipeline

        // Configuration
        this.config = {
            maxEffectsPerStream: 20, // Reasonable limit per stream
            effectTimeout: 60000, // 60 seconds default
            resourceCheckInterval: 15000, // Check less frequently to reduce overhead
            enableAdvancedProcessing: true,
            cpuThreshold: 90, // Higher threshold for high-performance servers
            memoryThreshold: 2048 // 2GB memory threshold
        };

        // Collaborators (back-referenced via owner)
        this.resourceMonitorService = new ResourceMonitor(this);
        this.ffmpegPipeline = new FfmpegPipeline(this);
        this.buffBridge = new BuffBridge(this);
        this.consumerControl = new ConsumerControl(this);

        // Resource monitoring state (shared by reference with ResourceMonitor)
        this.resourceMonitor = this.resourceMonitorService.state;

        // Initialize effect definitions
        this.initializeEffects();

        // Start resource monitoring
        this.startResourceMonitoring();
        
        logger.debug('🎬 VISUALFX: Service initialized');
    }
    
    setDependencies(mediasoupService, buffDebuffService, streamService = null, io = null, sessionService = null) {
        this.mediasoupService = mediasoupService;
        this.buffDebuffService = buffDebuffService;
        this.streamService = streamService;
        this.io = io;
        this.sessionService = sessionService;
        logger.debug(`🎬 VISUALFX: Dependencies set - io: ${!!io}, sessionService: ${!!sessionService}`);
        logger.debug(`🎬 VISUALFX: Socket.io instance:`, this.io ? `Connected (${this.io.engine?.clientsCount || 0} clients)` : 'NOT SET');
        logger.debug(`🎬 VISUALFX: Socket.io object type:`, typeof this.io);
        logger.debug(`🎬 VISUALFX: Socket.io has emit method:`, typeof this.io?.emit);
        
        // Hook into buff service events if available
        if (this.buffDebuffService) {
            logger.debug(`🎬 VISUALFX: Setting up buff-applied event listener`);
            logger.debug(`🎬 VISUALFX: BuffDebuffService instance:`, this.buffDebuffService ? 'SET' : 'NOT SET');
            logger.debug(`🎬 VISUALFX: BuffDebuffService is EventEmitter:`, this.buffDebuffService instanceof require('events').EventEmitter);
            
            // Remove any existing listeners first to prevent duplicates
            this.buffDebuffService.removeAllListeners('buff-applied');
            this.buffDebuffService.removeAllListeners('buff-expired');
            
            // Add event listener for buff-applied
            const handleBuffAppliedBound = this.handleBuffApplied.bind(this);
            const handleBuffExpiredBound = this.handleBuffExpired.bind(this);
            
            this.buffDebuffService.on('buff-applied', handleBuffAppliedBound);
            this.buffDebuffService.on('buff-expired', handleBuffExpiredBound);
            
            // Verify listeners are registered
            const buffAppliedListeners = this.buffDebuffService.listeners('buff-applied');
            const buffExpiredListeners = this.buffDebuffService.listeners('buff-expired');
            
            logger.debug(`✅ VISUALFX: Event listeners registered:`);
            logger.debug(`   - buff-applied: ${buffAppliedListeners.length} listener(s)`);
            logger.debug(`   - buff-expired: ${buffExpiredListeners.length} listener(s)`);
            
            // Test the connection with a ping
            logger.debug(`🔧 VISUALFX: Testing buff service connection...`);
            this.buffDebuffService.once('test-visualfx-ping', () => {
                logger.debug(`✅ VISUALFX: Buff service connection verified!`);
            });
            this.buffDebuffService.emit('test-visualfx-ping');
        } else {
            logger.debug(`⚠️ VISUALFX: No BuffDebuffService provided!`);
        }
    }
    
    initializeEffects() {
        for (const [effectId, config] of VISUAL_FX_EFFECTS) {
            this.registerEffect(effectId, config);
        }
        logger.debug(`🎬 VISUALFX: Registered ${this.effectRegistry.size} effects`);
    }
    
    registerEffect(effectId, config) {
        this.effectRegistry.set(effectId, {
            id: effectId,
            ...config,
            createdAt: Date.now()
        });
    }
    
    async applyEffect(streamId, effectId, options = {}) {
        logger.debug(`🎬 VISUALFX: Applying effect ${effectId} to stream ${streamId}`);
        
        // Check if effect exists
        const effectConfig = this.effectRegistry.get(effectId);
        if (!effectConfig) {
            logger.error(`❌ VISUALFX: Effect ${effectId} not found in registry`);
            return null; // Return null instead of throwing to prevent crashes
        }
        
        // Check resource limits
        if (!this.checkResourceAvailability()) {
            logger.warn('⚠️ VISUALFX: Resource limit reached, queuing effect');
            this.queueEffect(streamId, effectId, options);
            return null;
        }
        
        // Initialize active effects set for stream
        if (!this.activeEffects.has(streamId)) {
            this.activeEffects.set(streamId, new Set());
        }
        
        // Check max effects per stream
        const streamEffects = this.activeEffects.get(streamId);
        if (streamEffects.size >= this.config.maxEffectsPerStream) {
            logger.warn(`⚠️ VISUALFX: Max effects reached for stream ${streamId}`);
            return null;
        }
        
        // Create effect instance
        const effect = {
            id: `${effectId}_${Date.now()}`,
            effectId: effectId,
            streamId: streamId,
            config: effectConfig,
            startTime: Date.now(),
            duration: options.duration || effectConfig.duration,
            status: 'active',
            options: options
        };
        
        // Add to active effects
        streamEffects.add(effect);
        this.resourceMonitor.activeEffectCount++;
        
        // Apply effect based on type
        try {
            switch (effectConfig.type) {
                    case 'resolution':
                        await this.applyResolutionEffect(streamId, effectConfig.parameters);
                        break;
                    case 'bitrate':
                        await this.applyBitrateEffect(streamId, effectConfig.parameters);
                        break;
                    case 'framerate':
                        await this.applyFramerateEffect(streamId, effectConfig.parameters);
                        break;
                    case 'packet_loss':
                        await this.applyPacketLossEffect(streamId, effectConfig.parameters);
                        break;
                    case 'jitter':
                        await this.applyJitterEffect(streamId, effectConfig.parameters);
                        break;
                    case 'filter':
                        if (effectConfig.requiresProcessing) {
                            await this.applyFilterEffect(streamId, effectConfig.parameters);
                        }
                        break;
                    case 'audio':
                        if (effectConfig.requiresProcessing) {
                            await this.applyAudioEffect(streamId, effectConfig.parameters);
                        }
                        break;
                    case 'freeze':
                        await this.applyFreezeEffect(streamId, effectConfig.parameters);
                        break;
                    case 'stutter':
                        await this.applyStutterEffect(streamId, effectConfig.parameters);
                        break;
                    case 'resize':
                        await this.applyResizeEffect(streamId, effectConfig.parameters);
                        break;
                }
            
            // Set timeout to remove effect
            setTimeout(() => {
                this.removeEffect(streamId, effect.id);
            }, effect.duration);
            
            // Emit event internally
            this.emit('effect-applied', {
                streamId,
                effectId,
                effect
            });
            
            // Emit socket event for client-side processing
            if (this.io) {
                // For bitrate effects (like potato), apply to EVERYONE for visual feedback
                const isBitrateEffect = effectConfig.type === 'bitrate';
                const eventData = {
                    effectId: effectId,
                    duration: effect.duration,
                    applyToStreamer: true,  // Always apply to streamer for visual feedback
                    isStreamerPreview: true,
                    applyToAllViewers: true, // Apply to all viewers for consistent experience
                    streamId: streamId,
                    effectConfig: effectConfig
                };
                logger.debug(`🎬 VISUALFX: Emitting visual-effect-applied event:`, eventData);
                logger.debug(`🎬 VISUALFX: Socket.IO engine clients: ${this.io.engine?.clientsCount || 0}`);
                logger.debug(`🎬 VISUALFX: Socket.IO connected: ${!!this.io.sockets}`);
                this.io.emit('visual-effect-applied', eventData);
                logger.debug(`📡 VISUALFX: Emitted visual-effect-applied for ${effectId}`);
            } else {
                logger.debug(`⚠️ VISUALFX: Cannot emit visual-effect-applied - io not available`);
                logger.debug(`⚠️ VISUALFX: this.io is: ${this.io}`);
                logger.debug(`⚠️ VISUALFX: typeof this.io: ${typeof this.io}`);
            }
            
            logger.debug(`✅ VISUALFX: Effect ${effectId} applied successfully`);
            return effect;
            
        } catch (error) {
            logger.error(`❌ VISUALFX: Failed to apply effect ${effectId}:`, error.message);
            streamEffects.delete(effect);
            this.resourceMonitor.activeEffectCount--;
            // Don't throw - return null to prevent crashes
            return null;
        }
    }
    
    async applyResolutionEffect(streamId, parameters) {
        logger.debug(`📹 VISUALFX: Applying resolution effect to stream ${streamId}`);
        logger.debug(`📹 VISUALFX: Parameters:`, parameters);
        logger.debug(`📹 VISUALFX: IMPORTANT: Resolution effects are client-side only to prevent stream disruption`);
        
        // DO NOT MODIFY MEDIASOUP CONSUMERS/LAYERS - This can cause stream instability
        // Resolution effects should be purely visual on the client side
        
        if (this.mediasoupService) {
            logger.debug(`📹 VISUALFX: MediaSoup service available but NOT modifying consumers`);
        }
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        logger.debug(`✅ VISUALFX: Resolution effect configured for client-side visual feedback only`);
        logger.debug(`📡 VISUALFX: Clients will apply visual degradation without disrupting the stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyBitrateEffect(streamId, parameters) {
        return this.consumerControl.applyBitrateEffect(streamId, parameters);
    }
    
    async applyFramerateEffect(streamId, parameters) {
        logger.debug(`⏱️ VISUALFX: Applying framerate effect to stream ${streamId}`);
        logger.debug(`⏱️ VISUALFX: Parameters:`, parameters);
        logger.debug(`⏱️ VISUALFX: IMPORTANT: Framerate effects are client-side only to prevent stream disruption`);
        
        // DO NOT MODIFY MEDIASOUP PRODUCERS - This can cause stream instability
        // Framerate effects should be purely visual on the client side
        
        if (this.mediasoupService) {
            logger.debug(`⏱️ VISUALFX: MediaSoup service available but NOT modifying producers`);
        }
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        logger.debug(`✅ VISUALFX: Framerate effect configured for client-side visual feedback only`);
        logger.debug(`📡 VISUALFX: Clients will apply visual degradation without disrupting the stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyPacketLossEffect(streamId, parameters) {
        logger.debug(`📡 VISUALFX: Applying packet loss effect to stream ${streamId}`);
        logger.debug(`📡 VISUALFX: Parameters:`, parameters);
        logger.debug(`📡 VISUALFX: IMPORTANT: Packet loss effects are client-side only to prevent stream disruption`);
        
        // DO NOT INTERCEPT RTP PACKETS - This can cause stream instability
        // Packet loss effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        logger.debug(`✅ VISUALFX: Packet loss effect configured for client-side visual feedback only`);
        logger.debug(`📡 VISUALFX: Clients will apply visual simulation without disrupting actual packets`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyJitterEffect(streamId, parameters) {
        logger.debug(`〰️ VISUALFX: Applying jitter effect to stream ${streamId}`);
        logger.debug(`〰️ VISUALFX: Parameters:`, parameters);
        logger.debug(`〰️ VISUALFX: IMPORTANT: Jitter effects are client-side only to prevent stream disruption`);
        
        // DO NOT INTERCEPT RTP PACKETS - This can cause stream instability
        // Jitter effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        logger.debug(`✅ VISUALFX: Jitter effect configured for client-side visual feedback only`);
        logger.debug(`📡 VISUALFX: Clients will apply visual simulation without disrupting actual timing`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyFilterEffect(streamId, parameters) {
        return this.ffmpegPipeline.applyFilterEffect(streamId, parameters);
    }

    async interceptMediaSoupConsumers(streamId, videoFilter) {
        return this.ffmpegPipeline.interceptMediaSoupConsumers(streamId, videoFilter);
    }

    async applyAudioEffect(streamId, parameters) {
        return this.ffmpegPipeline.applyAudioEffect(streamId, parameters);
    }
    
    async applyFreezeEffect(streamId, parameters) {
        logger.debug(`🧊 VISUALFX: Applying freeze effect to stream ${streamId}`);
        logger.debug(`🧊 VISUALFX: Parameters:`, parameters);
        logger.debug(`🧊 VISUALFX: IMPORTANT: Freeze effects are client-side only to prevent stream disruption`);
        
        // DO NOT PAUSE/RESUME PRODUCERS - This causes stream instability and disconnections
        // Freeze effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        logger.debug(`✅ VISUALFX: Freeze effect configured for client-side visual feedback only`);
        logger.debug(`📡 VISUALFX: Clients will simulate freeze without disrupting the actual stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyStutterEffect(streamId, parameters) {
        logger.debug(`⚡ VISUALFX: Applying stutter effect to stream ${streamId}`);
        logger.debug(`⚡ VISUALFX: Parameters:`, parameters);
        logger.debug(`⚡ VISUALFX: IMPORTANT: Stutter effects are client-side only to prevent stream disruption`);
        
        // DO NOT PAUSE/RESUME PRODUCERS - This causes stream instability and disconnections
        // Stutter effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        logger.debug(`✅ VISUALFX: Stutter effect configured for client-side visual feedback only`);
        logger.debug(`📡 VISUALFX: Clients will simulate stutter without disrupting the actual stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyResizeEffect(streamId, parameters) {
        logger.debug(`📉 VISUALFX: Applying resize effect to stream ${streamId}`, parameters);
        
        // This is a client-side effect - the actual resizing will be handled by the frontend
        // We just need to emit the effect to trigger the client-side CSS transform
        
        // The effect will be applied via the socket emission in the main applyEffect method
        // which sends 'visual-effect-applied' with the effect configuration
        // For resize effects, applyToAllViewers=true ensures it affects all viewers, not just the streamer
        
        logger.debug(`📉 VISUALFX: Resize effect configured - client will handle DOM manipulation FOR ALL VIEWERS`);
    }
    
    async createProcessingPipeline(streamId, options) {
        return this.ffmpegPipeline.createProcessingPipeline(streamId, options);
    }

    async initializeFFmpegPipeline(pipeline) {
        return this.ffmpegPipeline.initializeFFmpegPipeline(pipeline);
    }

    async updateProcessingPipeline(streamId, options) {
        return this.ffmpegPipeline.updateProcessingPipeline(streamId, options);
    }
    
    async removeEffect(streamId, effectInstanceId) {
        const streamEffects = this.activeEffects.get(streamId);
        if (!streamEffects) return;
        
        const effect = Array.from(streamEffects).find(e => e.id === effectInstanceId);
        if (!effect) return;
        
        logger.debug(`🎬 VISUALFX: Removing effect ${effect.effectId} from stream ${streamId}`);

        // Clean up based on effect type
        const effectConfig = effect.config;
        
        try {
            switch (effectConfig.type) {
                case 'resolution':
                    await this.resetResolution(streamId);
                    break;
                case 'bitrate':
                    await this.resetBitrate(streamId);
                    break;
                case 'packet_loss':
                case 'jitter':
                    this.removeRtpInterceptor(streamId, effectConfig.type);
                    break;
                case 'filter':
                case 'audio':
                    if (effectConfig.requiresProcessing) {
                        await this.removeProcessingPipeline(streamId);
                    }
                    break;
                case 'resize':
                    await this.removeResizeEffect(streamId);
                    break;
            }
            
            // Remove from active effects
            streamEffects.delete(effect);
            this.resourceMonitor.activeEffectCount--;
            
            // Clean up empty sets
            if (streamEffects.size === 0) {
                this.activeEffects.delete(streamId);
            }
            
            // Emit event internally
            this.emit('effect-removed', {
                streamId,
                effectId: effect.effectId,
                effectInstanceId
            });
            
            // Emit socket event for client-side processing
            if (this.io) {
                const removalData = {
                    effectInstanceId: effectInstanceId,
                    streamId: streamId,
                    effectId: effect.effectId,
                    applyToAllViewers: true // Remove effects from all viewers
                };
                this.io.emit('visual-effect-removed', removalData);
                logger.debug(`📡 VISUALFX: Emitted visual-effect-removed for ${effect.effectId}`, removalData);
            }
            
            logger.debug(`✅ VISUALFX: Effect ${effect.effectId} removed successfully`);
            
        } catch (error) {
            logger.error(`❌ VISUALFX: Failed to remove effect:`, error);
        }
    }
    
    async resetResolution(streamId) {
        return this.consumerControl.resetResolution(streamId);
    }

    async resetBitrate(streamId) {
        return this.consumerControl.resetBitrate(streamId);
    }

    removeRtpInterceptor(streamId, type) {
        const interceptorId = `${type}_${streamId}`;
        const interceptor = this.rtpInterceptors.get(interceptorId);
        
        if (interceptor) {
            interceptor.active = false;
            this.rtpInterceptors.delete(interceptorId);
            logger.debug(`🎬 VISUALFX: Removed RTP interceptor ${type} for stream ${streamId}`);
        }
    }
    
    async removeProcessingPipeline(streamId) {
        return this.ffmpegPipeline.removeProcessingPipeline(streamId);
    }
    
    async removeResizeEffect(streamId) {
        logger.debug(`📉 VISUALFX: Removing resize effect from stream ${streamId}`);
        
        // Resize effects are client-side, so we just need to emit the removal
        // The actual cleanup happens via the 'visual-effect-removed' socket event
        // which is sent from the main removeEffect method
        // For resize effects, applyToAllViewers=true ensures removal affects all viewers
        
        logger.debug(`📉 VISUALFX: Resize effect removal configured - client will handle DOM reset FOR ALL VIEWERS`);
    }
    
    // Helper methods to get MediaSoup objects
    getStreamConsumers(streamId) {
        return this.consumerControl.getStreamConsumers(streamId);
    }
    
    // Queue management
    queueEffect(streamId, effectId, options) {
        this.effectQueue.push({
            streamId,
            effectId,
            options,
            queuedAt: Date.now()
        });
        
        // Process queue after a delay
        setTimeout(() => this.processEffectQueue(), 1000);
    }
    
    async processEffectQueue() {
        if (this.effectQueue.length === 0) return;
        
        // Check if resources are available
        if (!this.checkResourceAvailability()) {
            // Try again later
            setTimeout(() => this.processEffectQueue(), 5000);
            return;
        }
        
        // Process next effect in queue
        const queuedEffect = this.effectQueue.shift();
        if (queuedEffect) {
            try {
                await this.applyEffect(
                    queuedEffect.streamId,
                    queuedEffect.effectId,
                    queuedEffect.options
                );
            } catch (error) {
                logger.error('❌ VISUALFX: Failed to process queued effect:', error);
            }
            
            // Continue processing queue
            if (this.effectQueue.length > 0) {
                setTimeout(() => this.processEffectQueue(), 100);
            }
        }
    }
    
    // Resource monitoring
    startResourceMonitoring() {
        return this.resourceMonitorService.startResourceMonitoring();
    }

    updateResourceMetrics() {
        return this.resourceMonitorService.updateResourceMetrics();
    }

    checkResourceAvailability() {
        return this.resourceMonitorService.checkResourceAvailability();
    }

    cleanupOldEffects() {
        return this.resourceMonitorService.cleanupOldEffects();
    }

    // Buff integration handlers
    async handleBuffApplied(buffData) {
        return this.buffBridge.handleBuffApplied(buffData);
    }

    async handleBuffExpired(buffData) {
        return this.buffBridge.handleBuffExpired(buffData);
    }

    // Get effect information
    getActiveEffects(streamId = null) {
        if (streamId) {
            const effects = this.activeEffects.get(streamId);
            return effects ? Array.from(effects) : [];
        }
        
        // Return all active effects
        const allEffects = [];
        for (const [streamId, effects] of this.activeEffects.entries()) {
            for (const effect of effects) {
                allEffects.push({
                    ...effect,
                    streamId
                });
            }
        }
        return allEffects;
    }
    
    // Handle socket connection for a client - send active visual effects to new viewers
    handleClientConnection(socket) {
        // Send current active visual effects to new client
        const allActiveEffects = this.getActiveEffects();
        
        if (allActiveEffects.length > 0) {
            logger.debug(`🔌 VISUALFX: Client ${socket.id} connected, sending ${allActiveEffects.length} active visual effects`);
            
            // Send each active effect to the new client
            allActiveEffects.forEach(effect => {
                const eventData = {
                    effectId: effect.effectId,
                    duration: Math.max(0, effect.duration - (Date.now() - effect.startTime)), // Remaining duration
                    applyToStreamer: effect.config.type !== 'resize',
                    isStreamerPreview: effect.config.type !== 'resize',
                    applyToAllViewers: effect.config.type === 'resize',
                    streamId: effect.streamId,
                    effectConfig: effect.config,
                    isSyncEvent: true // Flag to indicate this is a sync event for late-joining client
                };
                
                // Only send if there's still time remaining on the effect
                if (eventData.duration > 0) {
                    logger.debug(`📡 VISUALFX: Syncing active effect ${effect.effectId} to new client ${socket.id} (${eventData.duration}ms remaining)`);
                    socket.emit('visual-effect-applied', eventData);
                }
            });
        } else {
            logger.debug(`🔌 VISUALFX: Client ${socket.id} connected, no active visual effects to sync`);
        }
        
        // Handle effect sync requests
        socket.on('request-visual-effects-sync', () => {
            logger.debug(`🔄 VISUALFX: Client ${socket.id} requested visual effects sync`);
            this.handleClientConnection(socket);
        });
    }
    
    getEffectRegistry() {
        return Array.from(this.effectRegistry.values());
    }
    
    getStats() {
        return {
            activeEffects: this.resourceMonitor.activeEffectCount,
            queuedEffects: this.effectQueue.length,
            processingPipelines: this.processingPipelines.size,
            rtpInterceptors: this.rtpInterceptors.size,
            cpuUsage: `${this.resourceMonitor.cpuUsage.toFixed(2)}%`,
            memoryUsage: `${this.resourceMonitor.memoryUsage.toFixed(2)} MB`,
            totalEffectsRegistered: this.effectRegistry.size
        };
    }
}

module.exports = VisualFxService;
