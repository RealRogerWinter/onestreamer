const EventEmitter = require('events');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const os = require('os');

class VisualFxService extends EventEmitter {
    constructor(mediasoupService = null, buffDebuffService = null, streamInterceptorService = null) {
        super();
        this.mediasoupService = mediasoupService;
        this.buffDebuffService = buffDebuffService;
        this.streamInterceptorService = streamInterceptorService;
        
        // Effect Registry
        this.effectRegistry = new Map();
        this.activeEffects = new Map(); // streamId -> Set of active effects
        this.effectQueue = [];
        this.rtpInterceptors = new Map();
        
        // Processing pipelines
        this.processingPipelines = new Map(); // streamId -> pipeline
        
        // Resource monitoring
        this.resourceMonitor = {
            cpuUsage: 0,
            memoryUsage: 0,
            activeEffectCount: 0,
            maxConcurrentEffects: 50, // Increased for better performance
            lastCleanup: Date.now(),
            cleanupInterval: 30000 // Cleanup every 30 seconds instead of constantly
        };
        
        // Configuration
        this.config = {
            maxEffectsPerStream: 20, // Reasonable limit per stream
            effectTimeout: 60000, // 60 seconds default
            resourceCheckInterval: 15000, // Check less frequently to reduce overhead
            enableAdvancedProcessing: true,
            cpuThreshold: 90, // Higher threshold for high-performance servers
            memoryThreshold: 2048 // 2GB memory threshold
        };
        
        // Initialize effect definitions
        this.initializeEffects();
        
        // Start resource monitoring
        this.startResourceMonitoring();
        
        console.log('🎬 VISUALFX: Service initialized');
    }
    
    setDependencies(mediasoupService, buffDebuffService, streamService = null, io = null, sessionService = null, streamInterceptorService = null) {
        this.mediasoupService = mediasoupService;
        this.buffDebuffService = buffDebuffService;
        this.streamService = streamService;
        this.io = io;
        this.sessionService = sessionService;
        this.streamInterceptorService = streamInterceptorService;
        console.log(`🎬 VISUALFX: Dependencies set - io: ${!!io}, sessionService: ${!!sessionService}`);
        console.log(`🎬 VISUALFX: Socket.io instance:`, this.io ? `Connected (${this.io.engine?.clientsCount || 0} clients)` : 'NOT SET');
        console.log(`🎬 VISUALFX: Socket.io object type:`, typeof this.io);
        console.log(`🎬 VISUALFX: Socket.io has emit method:`, typeof this.io?.emit);
        
        // Hook into buff service events if available
        if (this.buffDebuffService) {
            console.log(`🎬 VISUALFX: Setting up buff-applied event listener`);
            console.log(`🎬 VISUALFX: BuffDebuffService instance:`, this.buffDebuffService ? 'SET' : 'NOT SET');
            console.log(`🎬 VISUALFX: BuffDebuffService is EventEmitter:`, this.buffDebuffService instanceof require('events').EventEmitter);
            
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
            
            console.log(`✅ VISUALFX: Event listeners registered:`);
            console.log(`   - buff-applied: ${buffAppliedListeners.length} listener(s)`);
            console.log(`   - buff-expired: ${buffExpiredListeners.length} listener(s)`);
            
            // Test the connection with a ping
            console.log(`🔧 VISUALFX: Testing buff service connection...`);
            this.buffDebuffService.once('test-visualfx-ping', () => {
                console.log(`✅ VISUALFX: Buff service connection verified!`);
            });
            this.buffDebuffService.emit('test-visualfx-ping');
        } else {
            console.log(`⚠️ VISUALFX: No BuffDebuffService provided!`);
        }
    }
    
    initializeEffects() {
        // Register all available effects
        
        // Resolution effects
        this.registerEffect('resolution_240p', {
            name: 'Ultra Low Resolution',
            type: 'resolution',
            parameters: { width: 426, height: 240, spatialLayer: 0 },
            duration: 30000,
            priority: 5
        });
        
        this.registerEffect('resolution_360p', {
            name: 'Low Resolution',
            type: 'resolution',
            parameters: { width: 640, height: 360, spatialLayer: 1 },
            duration: 30000,
            priority: 5
        });
        
        this.registerEffect('resolution_480p', {
            name: 'Medium Resolution',
            type: 'resolution',
            parameters: { width: 854, height: 480, spatialLayer: 2 },
            duration: 30000,
            priority: 5
        });
        
        // Bitrate effects
        this.registerEffect('bitrate_potato', {
            name: 'Potato Quality',
            type: 'bitrate',
            parameters: { 
                videoBitrate: 30000,  // EXTREME potato - 30kbps video
                audioBitrate: 8000    // 8kbps audio (phone quality)
            },
            duration: 35000,  // Match the Potato item duration
            priority: 6
        });
        
        this.registerEffect('bitrate_low', {
            name: 'Low Bitrate',
            type: 'bitrate',
            parameters: { videoBitrate: 250000, audioBitrate: 64000 },
            duration: 20000,
            priority: 6
        });
        
        this.registerEffect('bitrate_throttle', {
            name: 'Bandwidth Throttle',
            type: 'bitrate',
            parameters: { videoBitrate: 500000, audioBitrate: 96000 },
            duration: 30000,
            priority: 6
        });
        
        // Frame rate effects
        this.registerEffect('framerate_slideshow', {
            name: 'Slideshow Mode',
            type: 'framerate',
            parameters: { fps: 1 },
            duration: 15000,
            priority: 7
        });
        
        this.registerEffect('framerate_choppy', {
            name: 'Choppy Video',
            type: 'framerate',
            parameters: { fps: 10 },
            duration: 20000,
            priority: 7
        });
        
        this.registerEffect('framerate_cinematic', {
            name: 'Cinematic Mode',
            type: 'framerate',
            parameters: { fps: 24 },
            duration: 30000,
            priority: 4
        });
        
        // Network simulation effects
        this.registerEffect('packet_loss_mild', {
            name: 'Mild Packet Loss',
            type: 'packet_loss',
            parameters: { lossRate: 0.02 }, // 2% packet loss
            duration: 15000,
            priority: 8
        });
        
        this.registerEffect('packet_loss_severe', {
            name: 'Severe Packet Loss',
            type: 'packet_loss',
            parameters: { lossRate: 0.1 }, // 10% packet loss
            duration: 10000,
            priority: 9
        });
        
        this.registerEffect('jitter', {
            name: 'Network Jitter',
            type: 'jitter',
            parameters: { jitterMs: 100, variance: 50 },
            duration: 20000,
            priority: 7
        });
        
        // Visual distortion effects
        this.registerEffect('pixelate', {
            name: 'Pixelation',
            type: 'filter',
            parameters: { 
                filter: 'scale=iw/10:ih/10,scale=iw*10:ih*10:flags=neighbor'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        });
        
        this.registerEffect('blur', {
            name: 'Motion Blur',
            type: 'filter',
            parameters: { 
                filter: 'boxblur=10:2'
            },
            duration: 20000,
            priority: 5,
            requiresProcessing: true
        });
        
        this.registerEffect('grayscale', {
            name: 'Black & White',
            type: 'filter',
            parameters: { 
                filter: 'colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        });
        
        this.registerEffect('sepia', {
            name: 'Sepia Tone',
            type: 'filter',
            parameters: { 
                filter: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        });
        
        this.registerEffect('static_noise', {
            name: 'TV Static',
            type: 'filter',
            parameters: { 
                filter: 'noise=alls=20:allf=t'
            },
            duration: 10000,
            priority: 6,
            requiresProcessing: true
        });
        
        this.registerEffect('glitch', {
            name: 'Digital Glitch',
            type: 'filter',
            parameters: { 
                filter: 'rgbashift=rh=5:gh=-5:bv=5:av=0'
            },
            duration: 5000,
            priority: 8,
            requiresProcessing: true
        });
        
        // Audio effects
        this.registerEffect('audio_pitch_high', {
            name: 'Chipmunk Voice',
            type: 'audio',
            parameters: { 
                pitch: 1.5,
                tempo: 1.2
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('audio_pitch_low', {
            name: 'Demon Voice',
            type: 'audio',
            parameters: { 
                pitch: 0.6,
                tempo: 0.9
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('audio_echo', {
            name: 'Echo Chamber',
            type: 'audio',
            parameters: { 
                delay: 500,
                decay: 0.5
            },
            duration: 15000,
            priority: 4,
            requiresProcessing: true
        });
        
        // Freeze effects
        this.registerEffect('freeze_frame', {
            name: 'Freeze Frame',
            type: 'freeze',
            parameters: { 
                freezeDuration: 3000
            },
            duration: 3000,
            priority: 10
        });
        
        this.registerEffect('stutter', {
            name: 'Video Stutter',
            type: 'stutter',
            parameters: { 
                stutterInterval: 500,
                stutterDuration: 100
            },
            duration: 10000,
            priority: 8
        });
        
        // Additional visual filter effects
        this.registerEffect('invert', {
            name: 'Invert Colors',
            type: 'filter',
            parameters: { 
                filter: 'negate'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('brightness_dark', {
            name: 'Darkness',
            type: 'filter',
            parameters: { 
                filter: 'eq=brightness=-0.3'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('brightness_bright', {
            name: 'Overexposed',
            type: 'filter',
            parameters: { 
                filter: 'eq=brightness=0.3'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('contrast_low', {
            name: 'Low Contrast',
            type: 'filter',
            parameters: { 
                filter: 'eq=contrast=0.5'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('contrast_high', {
            name: 'High Contrast',
            type: 'filter',
            parameters: { 
                filter: 'eq=contrast=2'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('saturate', {
            name: 'Oversaturated',
            type: 'filter',
            parameters: { 
                filter: 'eq=saturation=2'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('desaturate', {
            name: 'Desaturated',
            type: 'filter',
            parameters: { 
                filter: 'eq=saturation=0.3'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('hue_rotate', {
            name: 'Hue Shift',
            type: 'filter',
            parameters: { 
                filter: 'hue=h=90'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('edge_detect', {
            name: 'Edge Detection',
            type: 'filter',
            parameters: { 
                filter: 'edgedetect=mode=colormix:high=0.2'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        });
        
        this.registerEffect('emboss', {
            name: 'Emboss',
            type: 'filter',
            parameters: { 
                filter: 'convolution=0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0:0 -1 0 -1 5 -1 0 -1 0'
            },
            duration: 20000,
            priority: 5,
            requiresProcessing: true
        });
        
        this.registerEffect('vignette', {
            name: 'Vignette',
            type: 'filter',
            parameters: { 
                filter: 'vignette=PI/4'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        });
        
        this.registerEffect('mirror', {
            name: 'Mirror',
            type: 'filter',
            parameters: { 
                filter: 'hflip'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('flip_vertical', {
            name: 'Upside Down',
            type: 'filter',
            parameters: { 
                filter: 'vflip'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('rotate_90', {
            name: 'Rotate 90°',
            type: 'filter',
            parameters: { 
                filter: 'transpose=1'
            },
            duration: 20000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('wave', {
            name: 'Wave Distortion',
            type: 'filter',
            parameters: { 
                filter: 'wave=a=10:r=30'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        });
        
        this.registerEffect('wobble', {
            name: 'Wobble',
            type: 'filter',
            parameters: { 
                filter: 'perspective=x0=0:y0=0:x1=W:y1=0:x2=0:y2=H:x3=W:y3=H:interpolation=linear:sense=source'
            },
            duration: 15000,
            priority: 5,
            requiresProcessing: true
        });
        
        this.registerEffect('vintage', {
            name: 'Vintage Film',
            type: 'filter',
            parameters: { 
                filter: 'curves=vintage'
            },
            duration: 30000,
            priority: 3,
            requiresProcessing: true
        });
        
        this.registerEffect('thermal', {
            name: 'Thermal Vision',
            type: 'filter',
            parameters: { 
                filter: 'pseudocolor=p=inferno'
            },
            duration: 25000,
            priority: 4,
            requiresProcessing: true
        });
        
        this.registerEffect('stream_resize_half', {
            name: 'Stream Size Reducer',
            type: 'resize',
            parameters: { 
                scale: 0.5,
                position: 'center'
            },
            duration: 60000,
            priority: 3
        });
        
        console.log(`🎬 VISUALFX: Registered ${this.effectRegistry.size} effects`);
    }
    
    registerEffect(effectId, config) {
        this.effectRegistry.set(effectId, {
            id: effectId,
            ...config,
            createdAt: Date.now()
        });
    }
    
    async applyEffect(streamId, effectId, options = {}) {
        console.log(`🎬 VISUALFX: Applying effect ${effectId} to stream ${streamId}`);
        
        // Check if effect exists
        const effectConfig = this.effectRegistry.get(effectId);
        if (!effectConfig) {
            console.error(`❌ VISUALFX: Effect ${effectId} not found in registry`);
            return null; // Return null instead of throwing to prevent crashes
        }
        
        // Check resource limits
        if (!this.checkResourceAvailability()) {
            console.warn('⚠️ VISUALFX: Resource limit reached, queuing effect');
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
            console.warn(`⚠️ VISUALFX: Max effects reached for stream ${streamId}`);
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
        
        // Apply effect based on type - now using stream interception
        try {
            // Check if we should use stream interception for this effect
            const useInterception = this.streamInterceptorService && 
                                  ['resolution', 'bitrate', 'framerate', 'filter'].includes(effectConfig.type) &&
                                  false; // DISABLED: Stream interception causing instability
            
            if (useInterception) {
                console.log(`🎬 VISUALFX: Attempting stream interception for ${effectId}`);
                
                try {
                    // Map effect to interceptor type
                    let interceptType = 'generic';
                    const interceptOptions = {
                        duration: effect.duration,
                        effectId: effectId,
                        ...effectConfig.parameters
                    };
                    
                    // Configure specific interception based on effect
                    switch (effectConfig.type) {
                        case 'bitrate':
                            if (effectId === 'bitrate_potato') {
                                interceptType = 'potato';
                            } else {
                                interceptType = 'generic';
                                interceptOptions.videoBitrate = effectConfig.parameters.videoBitrate;
                                interceptOptions.audioBitrate = effectConfig.parameters.audioBitrate;
                            }
                            break;
                        case 'resolution':
                            interceptType = 'generic';
                            interceptOptions.width = effectConfig.parameters.width;
                            interceptOptions.height = effectConfig.parameters.height;
                            break;
                        case 'framerate':
                            interceptType = 'generic';
                            interceptOptions.framerate = effectConfig.parameters.fps;
                            break;
                        case 'filter':
                            if (effectConfig.parameters.filterType === 'blur') {
                                interceptType = 'blur';
                            } else if (effectConfig.parameters.filterType === 'pixelate') {
                                interceptType = 'pixelate';
                            }
                            break;
                    }
                    
                    // Apply via stream interception
                    await this.streamInterceptorService.interceptStream(streamId, interceptType, interceptOptions);
                    console.log(`✅ VISUALFX: Stream interception successful for ${effectId}`);
                    
                } catch (interceptError) {
                    console.error(`⚠️ VISUALFX: Stream interception failed for ${effectId}:`, interceptError.message);
                    console.log(`🔄 VISUALFX: Falling back to safe methods for ${effectId}`);
                    
                    // Always use safe fallback methods
                    try {
                        switch (effectConfig.type) {
                            case 'bitrate':
                                await this.applySafeBitrateEffect(streamId, effectConfig.parameters);
                                break;
                            case 'resolution':
                                await this.applySafeResolutionEffect(streamId, effectConfig.parameters);
                                break;
                            default:
                                console.log(`📡 VISUALFX: Effect ${effectId} will be client-side only`);
                                break;
                        }
                    } catch (fallbackError) {
                        console.error(`⚠️ VISUALFX: Safe fallback also failed:`, fallbackError.message);
                    }
                }
                
            } else {
                // Fallback to old methods for effects not yet migrated
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
                console.log(`🎬 VISUALFX: Emitting visual-effect-applied event:`, eventData);
                console.log(`🎬 VISUALFX: Socket.IO engine clients: ${this.io.engine?.clientsCount || 0}`);
                console.log(`🎬 VISUALFX: Socket.IO connected: ${!!this.io.sockets}`);
                this.io.emit('visual-effect-applied', eventData);
                console.log(`📡 VISUALFX: Emitted visual-effect-applied for ${effectId}`);
            } else {
                console.log(`⚠️ VISUALFX: Cannot emit visual-effect-applied - io not available`);
                console.log(`⚠️ VISUALFX: this.io is: ${this.io}`);
                console.log(`⚠️ VISUALFX: typeof this.io: ${typeof this.io}`);
            }
            
            console.log(`✅ VISUALFX: Effect ${effectId} applied successfully`);
            return effect;
            
        } catch (error) {
            console.error(`❌ VISUALFX: Failed to apply effect ${effectId}:`, error.message);
            streamEffects.delete(effect);
            this.resourceMonitor.activeEffectCount--;
            // Don't throw - return null to prevent crashes
            return null;
        }
    }
    
    async applyResolutionEffect(streamId, parameters) {
        console.log(`📹 VISUALFX: Applying resolution effect to stream ${streamId}`);
        console.log(`📹 VISUALFX: Parameters:`, parameters);
        console.log(`📹 VISUALFX: IMPORTANT: Resolution effects are client-side only to prevent stream disruption`);
        
        // DO NOT MODIFY MEDIASOUP CONSUMERS/LAYERS - This can cause stream instability
        // Resolution effects should be purely visual on the client side
        
        if (this.mediasoupService) {
            console.log(`📹 VISUALFX: MediaSoup service available but NOT modifying consumers`);
        }
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        console.log(`✅ VISUALFX: Resolution effect configured for client-side visual feedback only`);
        console.log(`📡 VISUALFX: Clients will apply visual degradation without disrupting the stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applySafeBitrateEffect(streamId, parameters) {
        console.log(`🥔 VISUALFX: Applying SAFE bitrate effect to stream ${streamId}`);
        console.log(`🥔 VISUALFX: Using consumer priority and layer control only`);
        
        try {
            // Get all consumers for this stream
            const allConsumers = this.mediasoupService.consumers;
            let consumerCount = 0;
            
            for (const [socketId, consumers] of allConsumers) {
                // Check if consumers is iterable (Map or Array)
                if (!consumers || typeof consumers[Symbol.iterator] !== 'function') {
                    console.log(`⚠️ Skipping non-iterable consumers for socket ${socketId}`);
                    continue;
                }
                
                for (const [consumerId, consumer] of consumers) {
                    if (!consumer.closed && consumer.producerId) {
                        try {
                            // Set lowest priority
                            if (consumer.setPriority) {
                                await consumer.setPriority(255);
                                console.log(`✅ Set consumer ${consumerId} to priority 255`);
                            }
                            
                            // Try to use preferred layers for simulcast
                            if (consumer.setPreferredLayers) {
                                try {
                                    await consumer.setPreferredLayers({
                                        spatialLayer: 0,
                                        temporalLayer: 0
                                    });
                                    console.log(`✅ Set consumer ${consumerId} to lowest layers`);
                                } catch (e) {
                                    // Not a simulcast stream, that's ok
                                }
                            }
                            
                            consumerCount++;
                        } catch (err) {
                            console.warn(`⚠️ Failed to apply safe effect to consumer ${consumerId}:`, err.message);
                        }
                    }
                }
            }
            
            console.log(`✅ VISUALFX: Safe bitrate effect applied to ${consumerCount} consumers`);
            
        } catch (error) {
            console.error(`❌ VISUALFX: Failed to apply safe bitrate effect:`, error);
        }
    }
    
    async applySafeResolutionEffect(streamId, parameters) {
        console.log(`📹 VISUALFX: Applying SAFE resolution effect to stream ${streamId}`);
        console.log(`📹 VISUALFX: Using consumer layer control only`);
        
        // Similar to bitrate but focus on spatial layers
        await this.applySafeBitrateEffect(streamId, parameters);
    }
    
    async applyBitrateEffect(streamId, parameters) {
        console.log(`🥔 VISUALFX: Applying POTATO QUALITY effect to stream ${streamId}`);
        console.log(`🥔 VISUALFX: Parameters:`, parameters);
        
        if (!this.mediasoupService) {
            console.error('❌ VISUALFX: MediaSoup service not available');
            console.log('🥔 VISUALFX: Effect will be client-side only');
            return;
        }
        
        console.log(`🥔 VISUALFX: Using MediaSoup best practices for quality degradation`);
        
        try {
            const targetBitrate = parameters.videoBitrate || 30000;
            let videoConsumerCount = 0;
            let audioConsumerCount = 0;
            let simulcastConsumerCount = 0;
            
            // Store affected consumers for potential restoration
            const affectedConsumers = [];
            
            // Get all consumers and apply safe degradation
            if (this.mediasoupService.consumers) {
                for (const [consumerId, consumer] of this.mediasoupService.consumers) {
                    try {
                        if (consumer.closed) continue;
                        
                        if (consumer.kind === 'video') {
                            // Store original state for restoration
                            affectedConsumers.push({
                                consumerId,
                                consumer,
                                originalPriority: consumer.priority || 1
                            });
                            
                            // BEST PRACTICE 1: Set consumer priority for bandwidth distribution
                            // Priority 255 = lowest, gets bandwidth last
                            if (consumer.setPriority) {
                                await consumer.setPriority(255);
                                console.log(`🥔 VISUALFX: Set consumer ${consumerId} to priority 255 (lowest)`);
                            }
                            
                            // BEST PRACTICE 2: Use setPreferredLayers for simulcast streams
                            // This is the recommended way to control quality
                            try {
                                // For potato effect, use lowest possible quality
                                await consumer.setPreferredLayers({
                                    spatialLayer: 0,    // Lowest spatial layer (quarter resolution)
                                    temporalLayer: 0    // Lowest temporal layer (reduced framerate)
                                });
                                console.log(`🥔 VISUALFX: Consumer ${consumerId} set to layers S0:T0 (lowest quality)`);
                                simulcastConsumerCount++;
                                
                                // Request keyframe for immediate effect
                                if (consumer.requestKeyFrame) {
                                    await consumer.requestKeyFrame();
                                }
                            } catch (e) {
                                // Consumer doesn't support simulcast - this is fine
                                console.log(`🥔 VISUALFX: Consumer ${consumerId} is not simulcast (single stream)`);
                            }
                            
                            videoConsumerCount++;
                        } else if (consumer.kind === 'audio') {
                            // Audio priority adjustment
                            if (consumer.setPriority) {
                                await consumer.setPriority(255);
                                console.log(`🥔 VISUALFX: Set audio consumer ${consumerId} to lowest priority`);
                            }
                            audioConsumerCount++;
                        }
                    } catch (err) {
                        console.warn(`⚠️ VISUALFX: Failed to degrade consumer ${consumerId}:`, err.message);
                    }
                }
            }
            
            console.log(`✅ VISUALFX: POTATO EFFECT APPLIED!`);
            console.log(`   - Video consumers affected: ${videoConsumerCount}`);
            console.log(`   - Simulcast consumers switched to low quality: ${simulcastConsumerCount}`);
            console.log(`   - Audio consumers affected: ${audioConsumerCount}`);
            console.log(`   - All consumers set to priority 255 (lowest)`);
            console.log(`   - Target bitrate: ${targetBitrate} bps`);
            
            // Store the effect parameters for new viewers
            this.activeBitrateLimit = {
                streamId: streamId,
                bitrate: targetBitrate,
                parameters: parameters,
                throttleActive: true
            };
            
        } catch (error) {
            console.error(`❌ VISUALFX: Failed to apply bitrate effect:`, error);
            throw error;
        }
    }
    
    async applyFramerateEffect(streamId, parameters) {
        console.log(`⏱️ VISUALFX: Applying framerate effect to stream ${streamId}`);
        console.log(`⏱️ VISUALFX: Parameters:`, parameters);
        console.log(`⏱️ VISUALFX: IMPORTANT: Framerate effects are client-side only to prevent stream disruption`);
        
        // DO NOT MODIFY MEDIASOUP PRODUCERS - This can cause stream instability
        // Framerate effects should be purely visual on the client side
        
        if (this.mediasoupService) {
            console.log(`⏱️ VISUALFX: MediaSoup service available but NOT modifying producers`);
        }
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        console.log(`✅ VISUALFX: Framerate effect configured for client-side visual feedback only`);
        console.log(`📡 VISUALFX: Clients will apply visual degradation without disrupting the stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyPacketLossEffect(streamId, parameters) {
        console.log(`📡 VISUALFX: Applying packet loss effect to stream ${streamId}`);
        console.log(`📡 VISUALFX: Parameters:`, parameters);
        console.log(`📡 VISUALFX: IMPORTANT: Packet loss effects are client-side only to prevent stream disruption`);
        
        // DO NOT INTERCEPT RTP PACKETS - This can cause stream instability
        // Packet loss effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        console.log(`✅ VISUALFX: Packet loss effect configured for client-side visual feedback only`);
        console.log(`📡 VISUALFX: Clients will apply visual simulation without disrupting actual packets`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyJitterEffect(streamId, parameters) {
        console.log(`〰️ VISUALFX: Applying jitter effect to stream ${streamId}`);
        console.log(`〰️ VISUALFX: Parameters:`, parameters);
        console.log(`〰️ VISUALFX: IMPORTANT: Jitter effects are client-side only to prevent stream disruption`);
        
        // DO NOT INTERCEPT RTP PACKETS - This can cause stream instability
        // Jitter effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        console.log(`✅ VISUALFX: Jitter effect configured for client-side visual feedback only`);
        console.log(`📡 VISUALFX: Clients will apply visual simulation without disrupting actual timing`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyFilterEffect(streamId, parameters) {
        console.log(`🎬 VISUALFX: Applying filter effect to stream ${streamId}:`, parameters.filter);
        
        // Create or update FFmpeg processing pipeline for visual filters
        await this.createProcessingPipeline(streamId, {
            video: {
                filter: parameters.filter
            }
        });
        
        // Hook into MediaSoup consumers to process their streams
        await this.interceptMediaSoupConsumers(streamId, parameters.filter);
    }

    async interceptMediaSoupConsumers(streamId, videoFilter) {
        if (!this.mediasoupService) {
            console.warn(`⚠️ VISUALFX: No MediaSoup service available for stream interception`);
            return;
        }

        const consumers = this.getStreamConsumers(streamId);
        console.log(`🎬 VISUALFX: Found ${consumers.length} consumers for stream ${streamId}`);

        for (const consumer of consumers) {
            if (consumer.kind === 'video') {
                try {
                    // For now, we'll simulate the effect by modifying consumer properties
                    // In a full implementation, you'd need to:
                    // 1. Extract RTP packets from the consumer
                    // 2. Decode them to raw video frames  
                    // 3. Process through FFmpeg
                    // 4. Re-encode and create new consumer
                    
                    console.log(`🎬 VISUALFX: Intercepting video consumer ${consumer.id} for filter: ${videoFilter}`);
                    
                    // Mark consumer as processed
                    if (!consumer._visualFxProcessed) {
                        consumer._visualFxProcessed = true;
                        consumer._visualFxFilter = videoFilter;
                        console.log(`✅ VISUALFX: Consumer ${consumer.id} marked for processing`);
                    }
                    
                } catch (error) {
                    console.error(`❌ VISUALFX: Failed to intercept consumer ${consumer.id}:`, error);
                }
            }
        }
    }
    
    async applyAudioEffect(streamId, parameters) {
        // Create or update FFmpeg processing pipeline for audio effects
        let audioFilter = '';
        
        if (parameters.pitch) {
            audioFilter += `asetrate=48000*${parameters.pitch},aresample=48000`;
        }
        
        if (parameters.tempo && audioFilter) {
            audioFilter += `,atempo=${parameters.tempo}`;
        } else if (parameters.tempo) {
            audioFilter += `atempo=${parameters.tempo}`;
        }
        
        if (parameters.delay && parameters.decay) {
            if (audioFilter) audioFilter += ',';
            audioFilter += `aecho=0.8:0.9:${parameters.delay}:${parameters.decay}`;
        }
        
        await this.createProcessingPipeline(streamId, {
            audio: {
                filter: audioFilter
            }
        });
    }
    
    async applyFreezeEffect(streamId, parameters) {
        console.log(`🧊 VISUALFX: Applying freeze effect to stream ${streamId}`);
        console.log(`🧊 VISUALFX: Parameters:`, parameters);
        console.log(`🧊 VISUALFX: IMPORTANT: Freeze effects are client-side only to prevent stream disruption`);
        
        // DO NOT PAUSE/RESUME PRODUCERS - This causes stream instability and disconnections
        // Freeze effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        console.log(`✅ VISUALFX: Freeze effect configured for client-side visual feedback only`);
        console.log(`📡 VISUALFX: Clients will simulate freeze without disrupting the actual stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyStutterEffect(streamId, parameters) {
        console.log(`⚡ VISUALFX: Applying stutter effect to stream ${streamId}`);
        console.log(`⚡ VISUALFX: Parameters:`, parameters);
        console.log(`⚡ VISUALFX: IMPORTANT: Stutter effects are client-side only to prevent stream disruption`);
        
        // DO NOT PAUSE/RESUME PRODUCERS - This causes stream instability and disconnections
        // Stutter effects should be purely visual on the client side
        
        // The visual effect will be handled client-side through the 'visual-effect-applied' event
        console.log(`✅ VISUALFX: Stutter effect configured for client-side visual feedback only`);
        console.log(`📡 VISUALFX: Clients will simulate stutter without disrupting the actual stream`);
        
        // Return success - the effect is "applied" (as a client-side visual only)
        return;
    }
    
    async applyResizeEffect(streamId, parameters) {
        console.log(`📉 VISUALFX: Applying resize effect to stream ${streamId}`, parameters);
        
        // This is a client-side effect - the actual resizing will be handled by the frontend
        // We just need to emit the effect to trigger the client-side CSS transform
        
        // The effect will be applied via the socket emission in the main applyEffect method
        // which sends 'visual-effect-applied' with the effect configuration
        // For resize effects, applyToAllViewers=true ensures it affects all viewers, not just the streamer
        
        console.log(`📉 VISUALFX: Resize effect configured - client will handle DOM manipulation FOR ALL VIEWERS`);
    }
    
    async createProcessingPipeline(streamId, options) {
        console.log(`🎬 VISUALFX: Creating processing pipeline for stream ${streamId}`, options);
        
        // Check if pipeline already exists
        if (this.processingPipelines.has(streamId)) {
            await this.updateProcessingPipeline(streamId, options);
            return;
        }
        
        try {
            // Create a comprehensive processing pipeline
            const pipeline = {
                streamId: streamId,
                inputStream: new PassThrough(),
                outputStream: new PassThrough(),
                ffmpegProcess: null,
                filters: {
                    video: options.video || null,
                    audio: options.audio || null
                },
                isActive: false,
                stats: {
                    framesProcessed: 0,
                    errors: 0,
                    startTime: Date.now()
                }
            };
            
            // Build FFmpeg command for real-time processing
            await this.initializeFFmpegPipeline(pipeline);
            
            // Store pipeline
            this.processingPipelines.set(streamId, pipeline);
            
            console.log(`✅ VISUALFX: Processing pipeline created for stream ${streamId}`);
            
        } catch (error) {
            console.error(`❌ VISUALFX: Failed to create processing pipeline:`, error);
            throw error;
        }
    }

    async initializeFFmpegPipeline(pipeline) {
        const { filters, streamId } = pipeline;
        
        // Build filter chain
        let videoFilter = '';
        let audioFilter = '';
        
        if (filters.video && filters.video.filter) {
            videoFilter = filters.video.filter;
        }
        
        if (filters.audio && filters.audio.filter) {
            audioFilter = filters.audio.filter;
        }
        
        // Create FFmpeg command for real-time processing
        const ffmpegArgs = [
            '-f', 'webm',           // Input format (MediaSoup uses WebM)
            '-i', 'pipe:0',         // Input from stdin
            '-c:v', 'libvpx',       // VP8/VP9 codec
            '-c:a', 'libopus',      // Opus audio codec
            '-preset', 'ultrafast', // Fast encoding for real-time
            '-tune', 'zerolatency', // Low latency
        ];
        
        // Add video filter if specified
        if (videoFilter) {
            ffmpegArgs.push('-vf', videoFilter);
        }
        
        // Add audio filter if specified  
        if (audioFilter) {
            ffmpegArgs.push('-af', audioFilter);
        }
        
        // Output settings
        ffmpegArgs.push(
            '-f', 'webm',           // Output format
            '-fflags', '+genpts',   // Generate presentation timestamps
            'pipe:1'                // Output to stdout
        );
        
        console.log(`🎬 VISUALFX: FFmpeg args for ${streamId}:`, ffmpegArgs);
        
        // Spawn FFmpeg process
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
        
        pipeline.ffmpegProcess = ffmpegProcess;
        
        // Handle FFmpeg output
        ffmpegProcess.stdout.on('data', (chunk) => {
            pipeline.outputStream.write(chunk);
            pipeline.stats.framesProcessed++;
        });
        
        // Handle FFmpeg errors
        ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.includes('frame=')) {
                // Normal frame processing info
                console.log(`🎬 VISUALFX: Processing ${streamId}: ${message.trim()}`);
            } else if (message.includes('error') || message.includes('Error')) {
                console.error(`❌ VISUALFX: FFmpeg error for ${streamId}: ${message}`);
                pipeline.stats.errors++;
            }
        });
        
        // Handle process exit
        ffmpegProcess.on('close', (code) => {
            console.log(`🎬 VISUALFX: FFmpeg process for ${streamId} exited with code ${code}`);
            pipeline.isActive = false;
        });
        
        // Handle process errors
        ffmpegProcess.on('error', (error) => {
            console.error(`❌ VISUALFX: FFmpeg process error for ${streamId}:`, error);
            pipeline.isActive = false;
            pipeline.stats.errors++;
        });
        
        pipeline.isActive = true;
        console.log(`🎬 VISUALFX: FFmpeg pipeline initialized for ${streamId}`);
    }
    
    async updateProcessingPipeline(streamId, options) {
        const pipeline = this.processingPipelines.get(streamId);
        if (!pipeline) return;
        
        // Update filters
        if (options.video) {
            pipeline.filters.video = options.video;
        }
        if (options.audio) {
            pipeline.filters.audio = options.audio;
        }
        
        console.log(`🔄 VISUALFX: Updated processing pipeline for stream ${streamId}`);
    }
    
    async removeEffect(streamId, effectInstanceId) {
        const streamEffects = this.activeEffects.get(streamId);
        if (!streamEffects) return;
        
        const effect = Array.from(streamEffects).find(e => e.id === effectInstanceId);
        if (!effect) return;
        
        console.log(`🎬 VISUALFX: Removing effect ${effect.effectId} from stream ${streamId}`);
        
        // Check if this effect is using stream interception
        if (this.streamInterceptorService) {
            const activeInterceptions = this.streamInterceptorService.getActiveInterceptions();
            const hasInterception = activeInterceptions.some(i => 
                i.streamId === streamId && i.effectType === effect.effectId
            );
            
            if (hasInterception) {
                console.log(`🎬 VISUALFX: Stopping stream interception for ${effect.effectId}`);
                await this.streamInterceptorService.stopInterception(streamId);
            }
        }
        
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
                console.log(`📡 VISUALFX: Emitted visual-effect-removed for ${effect.effectId}`, removalData);
            }
            
            console.log(`✅ VISUALFX: Effect ${effect.effectId} removed successfully`);
            
        } catch (error) {
            console.error(`❌ VISUALFX: Failed to remove effect:`, error);
        }
    }
    
    async resetResolution(streamId) {
        const consumers = this.getStreamConsumers(streamId);
        
        for (const consumer of consumers) {
            try {
                // Reset to highest quality
                await consumer.setPreferredLayers({
                    spatialLayer: 2,
                    temporalLayer: 2
                });
            } catch (error) {
                console.error(`❌ VISUALFX: Failed to reset resolution:`, error);
            }
        }
    }
    
    async resetBitrate(streamId) {
        console.log(`🥔 VISUALFX: Resetting quality for all consumers`);
        
        try {
            let resetCount = 0;
            
            // Reset all consumers
            if (this.mediasoupService && this.mediasoupService.consumers) {
                for (const [consumerId, consumer] of this.mediasoupService.consumers) {
                    try {
                        // Reset priority to normal
                        if (consumer.setPriority) {
                            await consumer.setPriority(1); // Normal priority
                            console.log(`🥔 VISUALFX: Reset consumer ${consumerId} to normal priority`);
                        }
                        
                        // Try to reset layers to max quality (if simulcast)
                        if (consumer.kind === 'video' && !consumer.closed) {
                            try {
                                await consumer.setPreferredLayers({
                                    spatialLayer: 2,
                                    temporalLayer: 2
                                });
                                console.log(`🥔 VISUALFX: Reset consumer ${consumerId} to max quality layers`);
                            } catch (e) {
                                // Not simulcast, ignore
                            }
                            resetCount++;
                        }
                    } catch (err) {
                        console.warn(`⚠️ VISUALFX: Failed to reset consumer ${consumerId}:`, err.message);
                    }
                }
            }
            
            // Clear the stored limit
            this.activeBitrateLimit = null;
            
            console.log(`✅ VISUALFX: Reset bitrate for ${resetCount} viewer transports`);
        } catch (error) {
            console.error(`❌ VISUALFX: Failed to reset bitrate:`, error);
        }
    }
    
    removeRtpInterceptor(streamId, type) {
        const interceptorId = `${type}_${streamId}`;
        const interceptor = this.rtpInterceptors.get(interceptorId);
        
        if (interceptor) {
            interceptor.active = false;
            this.rtpInterceptors.delete(interceptorId);
            console.log(`🎬 VISUALFX: Removed RTP interceptor ${type} for stream ${streamId}`);
        }
    }
    
    async removeProcessingPipeline(streamId) {
        const pipeline = this.processingPipelines.get(streamId);
        if (!pipeline) return;
        
        try {
            // Clean up FFmpeg process if running
            if (pipeline.ffmpegProcess) {
                pipeline.ffmpegProcess.kill('SIGTERM');
                // Give it time to clean up
                setTimeout(() => {
                    if (pipeline.ffmpegProcess && !pipeline.ffmpegProcess.killed) {
                        pipeline.ffmpegProcess.kill('SIGKILL');
                    }
                }, 1000);
            }
            
            // Clean up streams
            if (pipeline.inputStream) {
                pipeline.inputStream.destroy();
            }
            if (pipeline.outputStream) {
                pipeline.outputStream.destroy();
            }
        } catch (err) {
            console.error(`⚠️ VISUALFX: Error cleaning up pipeline:`, err.message);
        }
        
        this.processingPipelines.delete(streamId);
        console.log(`🎬 VISUALFX: Removed processing pipeline for stream ${streamId}`);
    }
    
    async removeResizeEffect(streamId) {
        console.log(`📉 VISUALFX: Removing resize effect from stream ${streamId}`);
        
        // Resize effects are client-side, so we just need to emit the removal
        // The actual cleanup happens via the 'visual-effect-removed' socket event
        // which is sent from the main removeEffect method
        // For resize effects, applyToAllViewers=true ensures removal affects all viewers
        
        console.log(`📉 VISUALFX: Resize effect removal configured - client will handle DOM reset FOR ALL VIEWERS`);
    }
    
    // Helper methods to get MediaSoup objects
    getStreamTransport(streamId) {
        if (!this.mediasoupService) return null;
        
        // Simple direct lookup only - no fancy fallbacks that might get wrong transport
        return this.mediasoupService.transports.get(streamId);
    }
    
    getStreamProducers(streamId) {
        if (!this.mediasoupService) return [];
        
        // Simple direct lookup only
        const producerMap = this.mediasoupService.producers.get(streamId);
        if (!producerMap) return [];
        
        return Array.from(producerMap.values());
    }
    
    getStreamConsumers(streamId) {
        if (!this.mediasoupService) return [];
        
        // Get all consumers that are consuming from this stream's producers
        const consumers = [];
        const producerMap = this.mediasoupService.producers.get(streamId);
        
        if (producerMap) {
            // Iterate through all consumer entries
            for (const [consumerId, consumerSet] of this.mediasoupService.consumers.entries()) {
                for (const consumer of consumerSet) {
                    // Check if this consumer is consuming from our stream's producers
                    for (const producer of producerMap.values()) {
                        if (consumer.producerId === producer.id) {
                            consumers.push(consumer);
                        }
                    }
                }
            }
        }
        
        return consumers;
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
                console.error('❌ VISUALFX: Failed to process queued effect:', error);
            }
            
            // Continue processing queue
            if (this.effectQueue.length > 0) {
                setTimeout(() => this.processEffectQueue(), 100);
            }
        }
    }
    
    // Resource monitoring
    startResourceMonitoring() {
        setInterval(() => {
            this.updateResourceMetrics();
        }, this.config.resourceCheckInterval);
    }
    
    updateResourceMetrics() {
        // Update CPU and memory usage
        const usage = process.cpuUsage();
        const memUsage = process.memoryUsage();
        
        // Calculate CPU percentage more accurately
        const cpuPercent = os.loadavg()[0] * 100 / os.cpus().length;
        this.resourceMonitor.cpuUsage = cpuPercent;
        this.resourceMonitor.memoryUsage = memUsage.heapUsed / 1024 / 1024; // Convert to MB
        
        // Only cleanup if truly necessary and not too frequently
        const now = Date.now();
        const timeSinceLastCleanup = now - this.resourceMonitor.lastCleanup;
        
        if (cpuPercent > this.config.cpuThreshold && timeSinceLastCleanup > this.resourceMonitor.cleanupInterval) {
            console.warn(`⚠️ VISUALFX: High CPU usage detected (${cpuPercent.toFixed(1)}%), cleaning up old effects`);
            this.cleanupOldEffects();
            this.resourceMonitor.lastCleanup = now;
        } else if (this.resourceMonitor.memoryUsage > this.config.memoryThreshold) {
            console.warn(`⚠️ VISUALFX: High memory usage detected (${this.resourceMonitor.memoryUsage.toFixed(0)}MB), cleaning up`);
            this.cleanupOldEffects();
            this.resourceMonitor.lastCleanup = now;
        }
    }
    
    checkResourceAvailability() {
        // More lenient resource checking
        const cpuOk = this.resourceMonitor.cpuUsage < this.config.cpuThreshold;
        const memoryOk = this.resourceMonitor.memoryUsage < this.config.memoryThreshold;
        const effectsOk = this.resourceMonitor.activeEffectCount < this.resourceMonitor.maxConcurrentEffects;
        
        if (!cpuOk || !memoryOk || !effectsOk) {
            console.log(`📊 VISUALFX: Resource check - CPU: ${this.resourceMonitor.cpuUsage.toFixed(1)}% (OK: ${cpuOk}), Memory: ${this.resourceMonitor.memoryUsage.toFixed(0)}MB (OK: ${memoryOk}), Effects: ${this.resourceMonitor.activeEffectCount}/${this.resourceMonitor.maxConcurrentEffects} (OK: ${effectsOk})`);
        }
        
        return cpuOk && memoryOk && effectsOk;
    }
    
    cleanupOldEffects() {
        const now = Date.now();
        let cleanedCount = 0;
        
        // Clean up expired effects
        for (const [streamId, effects] of this.activeEffects.entries()) {
            const effectsToRemove = [];
            
            for (const effect of effects) {
                // Remove effects that have exceeded their duration
                if (now - effect.startTime > effect.duration) {
                    effectsToRemove.push(effect.id);
                    cleanedCount++;
                }
            }
            
            // Remove effects in batch to avoid iterator issues
            for (const effectId of effectsToRemove) {
                this.removeEffect(streamId, effectId).catch(err => {
                    console.error(`⚠️ VISUALFX: Error removing expired effect:`, err.message);
                });
            }
        }
        
        // Clean up abandoned pipelines
        for (const [streamId, pipeline] of this.processingPipelines.entries()) {
            if (!pipeline.isActive || (now - pipeline.stats.startTime > 120000)) {
                this.removeProcessingPipeline(streamId);
                cleanedCount++;
            }
        }
        
        // Clear empty effect sets
        for (const [streamId, effects] of this.activeEffects.entries()) {
            if (effects.size === 0) {
                this.activeEffects.delete(streamId);
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`🧹 VISUALFX: Cleaned up ${cleanedCount} expired effects/pipelines`);
        }
    }
    
    // Buff integration handlers
    async handleBuffApplied(buffData) {
        console.log(`🎬 VISUALFX: ===== BUFF APPLIED EVENT RECEIVED =====`);
        
        // Check if this is a resumed buff (streamer coming back online with active buff)
        if (buffData.isResumed) {
            console.log(`🎬 VISUALFX: This is a RESUMED buff for ${buffData.item_name} - re-applying visual effect`);
        }
        
        console.log(`🥔 VISUALFX: handleBuffApplied called with buffData:`, {
            item_name: buffData.item_name,
            stream_id: buffData.stream_id,
            user_id: buffData.user_id,
            duration_seconds: buffData.duration_seconds,
            isResumed: buffData.isResumed || false
        });
        console.log(`🥔 VISUALFX: CRITICAL DEBUG - io availability: ${!!this.io}`);
        if (this.io) {
            console.log(`🥔 VISUALFX: io.engine.clientsCount: ${this.io.engine?.clientsCount || 'unknown'}`);
        }
        
        // Check if this buff should trigger a visual effect
        const effectMapping = {
            // Network effects
            'lag_spike': 'packet_loss_severe',
            'mild_packet_loss': 'packet_loss_mild',
            'network_jitter': 'jitter',
            
            // Resolution/Quality effects
            'potato_mode': 'resolution_240p',
            'potato': 'bitrate_potato',
            'low_bitrate': 'bitrate_low',
            'bandwidth_throttle': 'bitrate_throttle',
            
            // Stream size/orientation
            'stream_reducer': 'stream_resize_half',
            'mirror': 'mirror',
            'upside_down': 'flip_vertical',
            'rotate_90': 'rotate_90',
            
            // Frame rate effects
            'slow_motion': 'framerate_slideshow',
            'slideshow_mode': 'framerate_slideshow',
            'choppy_video': 'framerate_choppy',
            'cinematic_mode': 'framerate_cinematic',
            
            // Visual filters
            'glitch_bomb': 'glitch',
            'static_storm': 'static_noise',
            'tv_static': 'static_noise',
            'pixelate': 'pixelate',
            'motion_blur': 'blur',
            'black_and_white': 'grayscale',
            'sepia_tone': 'sepia',
            'invert_colors': 'invert',
            'darkness': 'brightness_dark',
            'overexposed': 'brightness_bright',
            'low_contrast': 'contrast_low',
            'high_contrast': 'contrast_high',
            'oversaturated': 'saturate',
            'desaturated': 'desaturate',
            'hue_shift': 'hue_rotate',
            'edge_detection': 'edge_detect',
            'emboss': 'emboss',
            'vignette': 'vignette',
            'wave_distortion': 'wave',
            'wobble': 'wobble',
            'vintage_film': 'vintage',
            'thermal_vision': 'thermal',
            
            // Audio effects
            'voice_modulator': 'audio_pitch_high',
            'chipmunk_voice': 'audio_pitch_high',
            'demon_voice': 'audio_pitch_low',
            'echo_chamber': 'audio_echo',
            
            // Freeze/Stutter effects
            'freeze_ray': 'freeze_frame',
            'video_stutter': 'stutter'
        };
        
        const effectId = effectMapping[buffData.item_name];
        console.log(`🥔 VISUALFX: Mapped item_name '${buffData.item_name}' to effectId '${effectId}'`);
        
        if (effectId) {
            try {
                // Get the current streamer's stream ID
                let streamId = buffData.stream_id;
                console.log(`🥔 VISUALFX: Initial streamId from buffData: ${streamId}`);
                
                // Primary approach: Always check if buff is for current streamer first
                if (this.streamService && this.sessionService) {
                    const currentStreamerSocketId = this.streamService.getCurrentStreamer();
                    console.log(`🥔 VISUALFX: Current streamer socketId: ${currentStreamerSocketId}`);
                    
                    if (currentStreamerSocketId) {
                        // Get the userId for the current streamer
                        const session = this.sessionService.getSessionBySocketId(currentStreamerSocketId);
                        if (session && session.userId) {
                            console.log(`🥔 VISUALFX: Current streamer userId: ${session.userId}, buff userId: ${buffData.user_id}`);
                            
                            // Check if the buff is for the current streamer (handle both positive and negative IDs for viewbots)
                            const streamerUserId = session.userId.toString();
                            const buffUserId = buffData.user_id.toString();
                            
                            if (streamerUserId === buffUserId || 
                                Math.abs(parseInt(streamerUserId)) === Math.abs(parseInt(buffUserId))) {
                                streamId = currentStreamerSocketId;
                                console.log(`🥔 VISUALFX: Buff is for current streamer, using socketId: ${streamId}`);
                            }
                        }
                    }
                }
                
                // Fallback approach: If streamId not set and not current streamer, try to find user's sockets
                if (!streamId && this.sessionService) {
                    const userSockets = this.sessionService.getSocketsByUserId(buffData.user_id);
                    console.log(`🥔 VISUALFX: Found ${userSockets ? userSockets.length : 0} sockets for user ${buffData.user_id}`);
                    
                    if (userSockets && userSockets.length > 0) {
                        // Check if any of these sockets have an active transport (meaning they're streaming)
                        for (const socketId of userSockets) {
                            if (this.mediasoupService && this.mediasoupService.transports.has(socketId)) {
                                streamId = socketId;
                                console.log(`🥔 VISUALFX: Found active transport for socket ${socketId}, using as streamId`);
                                break;
                            }
                        }
                        
                        // If no active transport found, use first socket as fallback
                        if (!streamId) {
                            streamId = userSockets[0];
                            console.log(`🥔 VISUALFX: No active transport found, using first socket as streamId: ${streamId}`);
                        }
                    }
                }
                
                if (streamId) {
                    console.log(`🥔 VISUALFX: Final streamId determined: ${streamId}`);
                    console.log(`🥔 VISUALFX: StreamId type: ${typeof streamId}, length: ${streamId.length}`);
                    
                    // DEBUG: Check if this streamId exists in MediaSoup
                    if (this.mediasoupService && this.mediasoupService.transports) {
                        const hasTransport = this.mediasoupService.transports.has(streamId);
                        console.log(`🔍 VISUALFX: DEBUG - StreamId "${streamId}" has transport: ${hasTransport}`);
                        console.log(`🔍 VISUALFX: DEBUG - Available transport keys:`, Array.from(this.mediasoupService.transports.keys()));
                        
                        // Check for similar keys
                        const similarKeys = Array.from(this.mediasoupService.transports.keys()).filter(key => 
                            key.includes(streamId) || streamId.includes(key)
                        );
                        if (similarKeys.length > 0) {
                            console.log(`🔍 VISUALFX: DEBUG - Similar transport keys found:`, similarKeys);
                        }
                    }
                    
                    // Apply the effect with error handling
                    try {
                        await this.applyEffect(streamId, effectId, {
                            duration: (buffData.duration_seconds || buffData.remainingSeconds || 35) * 1000,
                            triggeredByBuff: true,
                            buffId: buffData.id
                        });
                        console.log(`✅ VISUALFX: Successfully applied ${effectId} effect for buff ${buffData.item_name} to stream ${streamId}`);
                    } catch (effectError) {
                        console.error(`❌ VISUALFX: Effect application failed:`, effectError);
                        console.error(`❌ VISUALFX: Error name: ${effectError.name}`);
                        console.error(`❌ VISUALFX: Error message: ${effectError.message}`);
                        
                        // Don't re-throw - let the buff work even if effect fails
                        console.log(`⚠️ VISUALFX: Continuing without visual effect for ${buffData.item_name}`);
                    }
                } else {
                    console.log(`⚠️ VISUALFX: Could not determine stream ID for buff ${buffData.item_name}, effect will be client-side only`);
                }
            } catch (error) {
                console.error('⚠️ VISUALFX: Error in handleBuffApplied, continuing without visual effect:', error);
                // Don't re-throw - let the buff still work even if visual effect fails
            }
        }
    }
    
    async handleBuffExpired(buffData) {
        // Remove any effects associated with this buff
        for (const [streamId, effects] of this.activeEffects.entries()) {
            for (const effect of effects) {
                if (effect.options.buffId === buffData.id) {
                    await this.removeEffect(streamId, effect.id);
                }
            }
        }
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
            console.log(`🔌 VISUALFX: Client ${socket.id} connected, sending ${allActiveEffects.length} active visual effects`);
            
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
                    console.log(`📡 VISUALFX: Syncing active effect ${effect.effectId} to new client ${socket.id} (${eventData.duration}ms remaining)`);
                    socket.emit('visual-effect-applied', eventData);
                }
            });
        } else {
            console.log(`🔌 VISUALFX: Client ${socket.id} connected, no active visual effects to sync`);
        }
        
        // Handle effect sync requests
        socket.on('request-visual-effects-sync', () => {
            console.log(`🔄 VISUALFX: Client ${socket.id} requested visual effects sync`);
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