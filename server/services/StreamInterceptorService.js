/**
 * Stream Interceptor Service
 * Routes MediaSoup streams through external processors (GStreamer/FFmpeg) for effects
 * without modifying MediaSoup transport/consumer settings
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');

const logger = require('../bootstrap/logger').child({ svc: 'StreamInterceptorService' });
class StreamInterceptorService extends EventEmitter {
    constructor(mediasoupService, plainTransportService) {
        super();
        this.mediasoupService = mediasoupService;
        this.plainTransportService = plainTransportService;
        
        // Active intercepts: streamId -> interception config
        this.activeIntercepts = new Map();
        
        // GStreamer path - detect based on platform
        this.gstreamerPath = process.platform === 'win32'
            ? 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe'
            : '/usr/bin/gst-launch-1.0'; // Full path on Linux
        
        logger.debug('🎬 STREAM INTERCEPTOR: Service initialized');
    }

    /**
     * Generate a random SSRC for RTP streams
     */
    generateSSRC() {
        return Math.floor(Math.random() * 4294967295); // Random 32-bit unsigned integer
    }

    /**
     * Intercept a stream and route through external processor
     */
    async interceptStream(streamId, effectType, options = {}) {
        logger.debug(`🎬 INTERCEPTOR: Starting interception for stream ${streamId} with effect ${effectType}`);
        
        // Check if MediaSoup router is available
        if (!this.mediasoupService || !this.mediasoupService.router) {
            logger.error(`❌ INTERCEPTOR: MediaSoup router not available`);
            throw new Error('MediaSoup router not initialized');
        }
        
        try {
            // Step 1: Create PlainTransport to extract RTP from MediaSoup
            const extractPorts = await this.createExtractionTransport(streamId);
            
            // Step 2: Create PlainTransport to inject processed RTP back
            const injectPorts = await this.createInjectionTransport(streamId);
            
            // Step 3: Start external processor (GStreamer/FFmpeg)
            const processor = await this.startProcessor(effectType, extractPorts, injectPorts, options);
            
            // Step 4: Connect MediaSoup producer to extraction transport
            // Pass the extraction botId so we can find the right transport
            await this.connectProducerToExtraction(streamId, extractPorts);
            
            // Step 5: Switch viewers to processed stream
            await this.switchViewersToProcessed(streamId, injectPorts);
            
            // Store interception config
            this.activeIntercepts.set(streamId, {
                effectType,
                extractPorts,
                injectPorts,
                processor,
                startTime: Date.now(),
                options
            });
            
            logger.debug(`✅ INTERCEPTOR: Stream ${streamId} successfully intercepted with ${effectType}`);
            
            // Auto-remove after duration
            if (options.duration) {
                setTimeout(() => this.stopInterception(streamId), options.duration);
            }
            
            return true;
            
        } catch (error) {
            logger.error(`❌ INTERCEPTOR: Failed to intercept stream ${streamId}:`, error);
            throw error;
        }
    }

    /**
     * Create PlainTransport to extract RTP from MediaSoup
     */
    async createExtractionTransport(streamId) {
        const botId = `extract_${streamId}_${Date.now()}`;
        try {
            const result = await this.plainTransportService.createPlainTransport(botId);
            logger.debug(`✅ INTERCEPTOR: Extraction transport created:`, result);
            // Store the botId with the result so we can use it later
            result.botId = botId;
            return result;
        } catch (error) {
            logger.error(`❌ INTERCEPTOR: Failed to create extraction transport:`, error);
            throw error;
        }
    }

    /**
     * Create PlainTransport to inject processed RTP back
     */
    async createInjectionTransport(streamId) {
        const botId = `inject_${streamId}_${Date.now()}`;
        try {
            const result = await this.plainTransportService.createPlainTransport(botId);
            logger.debug(`✅ INTERCEPTOR: Injection transport created:`, result);
            // Store the botId with the result so we can use it later
            result.botId = botId;
            return result;
        } catch (error) {
            logger.error(`❌ INTERCEPTOR: Failed to create injection transport:`, error);
            throw error;
        }
    }

    /**
     * Start external processor (GStreamer for potato effect)
     */
    async startProcessor(effectType, extractPorts, injectPorts, options) {
        logger.debug(`🎬 INTERCEPTOR: Starting ${effectType} processor`);
        
        // Check if GStreamer exists
        const fs = require('fs');
        if (!fs.existsSync(this.gstreamerPath)) {
            logger.error(`❌ INTERCEPTOR: GStreamer not found at ${this.gstreamerPath}`);
            logger.debug(`⚠️ INTERCEPTOR: Install GStreamer or update path in StreamInterceptorService`);
            // For now, throw error - in production, could fallback to FFmpeg
            throw new Error('GStreamer not installed');
        }
        
        let pipeline;
        
        switch (effectType) {
            case 'potato':
                pipeline = this.buildPotatoPipeline(extractPorts, injectPorts);
                break;
            case 'blur':
                pipeline = this.buildBlurPipeline(extractPorts, injectPorts);
                break;
            case 'pixelate':
                pipeline = this.buildPixelatePipeline(extractPorts, injectPorts);
                break;
            default:
                pipeline = this.buildGenericPipeline(extractPorts, injectPorts, options);
        }
        
        logger.debug(`🎬 INTERCEPTOR: Pipeline command: gst-launch-1.0 ${pipeline.join(' ')}`);
        
        // Windows requires special handling for paths with spaces
        const fullCommand = `"${this.gstreamerPath}" ${pipeline.join(' ')}`;
        const process = spawn(fullCommand, [], {
            shell: true,  // REQUIRED for Windows
            windowsHide: false,  // Show window for debugging
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        process.on('error', (error) => {
            logger.error(`❌ INTERCEPTOR: Processor spawn error:`, error);
            if (error.code === 'ENOENT') {
                logger.error(`❌ INTERCEPTOR: GStreamer executable not found`);
            }
        });
        
        process.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.includes('ERROR') || message.includes('erroneous pipeline') || message.includes('syntax error')) {
                logger.error(`❌ INTERCEPTOR: GStreamer pipeline failed:`, message);
                // Kill the process if pipeline has syntax errors
                if (message.includes('erroneous pipeline') || message.includes('syntax error')) {
                    process.kill();
                    throw new Error(`GStreamer pipeline syntax error: ${message}`);
                }
            } else if (message.includes('WARNING')) {
                logger.warn(`⚠️ INTERCEPTOR: GStreamer warning:`, message);
            }
        });
        
        process.stdout.on('data', (data) => {
            logger.debug(`📺 INTERCEPTOR: GStreamer output:`, data.toString());
        });
        
        return process;
    }

    /**
     * Build GStreamer pipeline for potato effect
     */
    buildPotatoPipeline(extractPorts, injectPorts) {
        return [
            // Video input from MediaSoup
            `udpsrc port=${extractPorts.video} caps="application/x-rtp,media=video,encoding-name=VP8,payload=96"`,
            '! rtpvp8depay',
            '! vp8dec',
            
            // Potato degradation: scale down, reduce quality
            '! videoscale',
            '! video/x-raw,width=320,height=240',  // Ultra low resolution
            '! videoconvert',
            '! videorate',
            '! video/x-raw,framerate=10/1',  // Low framerate
            
            // Re-encode with very low bitrate - ALL PROPERTIES ON ONE LINE
            '! vp8enc deadline=1 cpu-used=16 target-bitrate=30000 min-quantizer=50 max-quantizer=63',
            
            // Send back to MediaSoup
            '! rtpvp8pay ssrc=12345678 pt=96',
            `! udpsink host=127.0.0.1 port=${injectPorts.video}`,
            
            // Audio passthrough with quality reduction
            `udpsrc port=${extractPorts.audio} caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=111"`,
            '! rtpopusdepay',
            '! opusdec',
            '! audioconvert',
            '! audioresample',
            '! audio/x-raw,rate=8000,channels=1',  // Phone quality
            '! opusenc bitrate=8000',  // 8kbps
            '! rtpopuspay ssrc=87654321 pt=111',
            `! udpsink host=127.0.0.1 port=${injectPorts.audio}`
        ];
    }

    /**
     * Build GStreamer pipeline for blur effect
     */
    buildBlurPipeline(extractPorts, injectPorts) {
        return [
            // Video with lower quality (blur not available in basic GStreamer)
            `udpsrc port=${extractPorts.video} caps="application/x-rtp,media=video,encoding-name=VP8,payload=96"`,
            '! rtpvp8depay',
            '! vp8dec',
            '! videoscale',
            '! video/x-raw,width=480,height=360',  // Lower resolution for blur effect
            '! videoconvert',
            '! vp8enc deadline=1 cpu-used=8 target-bitrate=500000',
            '! rtpvp8pay ssrc=12345678 pt=96',
            `! udpsink host=127.0.0.1 port=${injectPorts.video}`,
            
            // Audio passthrough
            `udpsrc port=${extractPorts.audio} caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=111"`,
            `! udpsink host=127.0.0.1 port=${injectPorts.audio}`
        ];
    }

    /**
     * Build GStreamer pipeline for pixelate effect
     */
    buildPixelatePipeline(extractPorts, injectPorts) {
        return [
            // Video with pixelation (scale down then up)
            `udpsrc port=${extractPorts.video} caps="application/x-rtp,media=video,encoding-name=VP8,payload=96"`,
            '! rtpvp8depay',
            '! vp8dec',
            '! videoscale method=nearest-neighbour',  // Use nearest-neighbour for pixelation
            '! video/x-raw,width=160,height=120',  // Scale down
            '! videoscale method=nearest-neighbour',  // Maintain pixelation when scaling up
            '! video/x-raw,width=640,height=480',  // Scale back up (pixelated)
            '! videoconvert',
            '! vp8enc deadline=1 cpu-used=8 target-bitrate=250000',
            '! rtpvp8pay ssrc=12345678 pt=96',
            `! udpsink host=127.0.0.1 port=${injectPorts.video}`,
            
            // Audio passthrough
            `udpsrc port=${extractPorts.audio} caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=111"`,
            `! udpsink host=127.0.0.1 port=${injectPorts.audio}`
        ];
    }

    /**
     * Generic pipeline with configurable parameters
     */
    buildGenericPipeline(extractPorts, injectPorts, options) {
        const width = options.width || 640;
        const height = options.height || 480;
        const framerate = options.framerate || 15;
        const videoBitrate = options.videoBitrate || 250000;
        const audioBitrate = options.audioBitrate || 32000;
        
        return [
            // Configurable video processing
            `udpsrc port=${extractPorts.video} caps="application/x-rtp,media=video,encoding-name=VP8,payload=96"`,
            '! rtpvp8depay',
            '! vp8dec',
            '! videoscale',
            `! video/x-raw,width=${width},height=${height}`,
            '! videoconvert',
            '! videorate',
            `! video/x-raw,framerate=${framerate}/1`,
            `! vp8enc deadline=1 cpu-used=8 target-bitrate=${videoBitrate}`,
            '! rtpvp8pay ssrc=12345678 pt=96',
            `! udpsink host=127.0.0.1 port=${injectPorts.video}`,
            
            // Configurable audio processing
            `udpsrc port=${extractPorts.audio} caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=111"`,
            '! rtpopusdepay',
            '! opusdec',
            '! audioconvert',
            `! opusenc bitrate=${audioBitrate}`,
            '! rtpopuspay ssrc=87654321 pt=111',
            `! udpsink host=127.0.0.1 port=${injectPorts.audio}`
        ];
    }

    /**
     * Connect original producer to extraction transport
     */
    async connectProducerToExtraction(streamId, extractPorts) {
        logger.debug(`🔗 INTERCEPTOR: Connecting producer to extraction transport`);
        
        // Get the current streamer's producers
        const producers = this.mediasoupService.producers.get(streamId);
        if (!producers) {
            throw new Error(`No producers found for stream ${streamId}`);
        }
        
        try {
            // Use the botId that was stored when creating the extraction transport
            const botId = extractPorts.botId;
            if (!botId) {
                throw new Error('Extraction botId not found in extractPorts');
            }
            
            const transports = this.plainTransportService.plainTransports.get(botId);
            
            if (!transports) {
                // Need to create consumers on the plain transports to extract RTP
                // First, let's create the proper consumers
                const videoProducer = producers.get('video');
                const audioProducer = producers.get('audio');
                
                const consumers = {};
                
                // Create video consumer on plain transport to extract RTP
                if (videoProducer && !videoProducer.closed && extractPorts.transportId) {
                    logger.debug(`📹 INTERCEPTOR: Creating plain consumer for video extraction`);
                    
                    // Get the plain transport
                    const transport = await this.getTransportById(extractPorts.transportId);
                    if (transport) {
                        // Create a consumer that will send RTP to our GStreamer pipeline
                        const videoConsumer = await transport.consume({
                            producerId: videoProducer.id,
                            rtpCapabilities: this.mediasoupService.router.rtpCapabilities,
                            paused: false
                        });
                        
                        consumers.video = videoConsumer;
                        logger.debug(`✅ INTERCEPTOR: Video consumer created for extraction: ${videoConsumer.id}`);
                    }
                }
                
                // Create audio consumer on plain transport to extract RTP
                if (audioProducer && !audioProducer.closed && extractPorts.audioTransportId) {
                    logger.debug(`🎤 INTERCEPTOR: Creating plain consumer for audio extraction`);
                    
                    // Get the plain transport
                    const transport = await this.getTransportById(extractPorts.audioTransportId);
                    if (transport) {
                        // Create a consumer that will send RTP to our GStreamer pipeline
                        const audioConsumer = await transport.consume({
                            producerId: audioProducer.id,
                            rtpCapabilities: this.mediasoupService.router.rtpCapabilities,
                            paused: false
                        });
                        
                        consumers.audio = audioConsumer;
                        logger.debug(`✅ INTERCEPTOR: Audio consumer created for extraction: ${audioConsumer.id}`);
                    }
                }
                
                // Store consumers for later cleanup
                this.extractionConsumers = this.extractionConsumers || new Map();
                this.extractionConsumers.set(streamId, consumers);
            } else {
                // Transports exist, create consumers on them
                const videoProducer = producers.get('video');
                const audioProducer = producers.get('audio');
                
                const consumers = {};
                
                // Create video consumer
                if (videoProducer && !videoProducer.closed && transports.video) {
                    logger.debug(`📹 INTERCEPTOR: Creating plain consumer for video extraction on existing transport`);
                    
                    // First, connect the transport to tell it where to send RTP (to GStreamer)
                    if (!transports.video.appData.connected) {
                        await transports.video.connect({
                            ip: '127.0.0.1',
                            port: extractPorts.video,  // GStreamer is listening on this port
                            rtcpPort: extractPorts.videoRtcp
                        });
                        transports.video.appData.connected = true;
                        logger.debug(`🔗 INTERCEPTOR: Video extraction transport connected to GStreamer port ${extractPorts.video}`);
                    }
                    
                    const videoConsumer = await transports.video.consume({
                        producerId: videoProducer.id,
                        rtpCapabilities: this.mediasoupService.router.rtpCapabilities,
                        paused: false
                    });
                    consumers.video = videoConsumer;
                    logger.debug(`✅ INTERCEPTOR: Video consumer created: ${videoConsumer.id}`);
                }
                
                // Create audio consumer
                if (audioProducer && !audioProducer.closed && transports.audio) {
                    logger.debug(`🎤 INTERCEPTOR: Creating plain consumer for audio extraction on existing transport`);
                    
                    // First, connect the transport to tell it where to send RTP (to GStreamer)
                    if (!transports.audio.appData.connected) {
                        await transports.audio.connect({
                            ip: '127.0.0.1',
                            port: extractPorts.audio,  // GStreamer is listening on this port
                            rtcpPort: extractPorts.audioRtcp
                        });
                        transports.audio.appData.connected = true;
                        logger.debug(`🔗 INTERCEPTOR: Audio extraction transport connected to GStreamer port ${extractPorts.audio}`);
                    }
                    
                    const audioConsumer = await transports.audio.consume({
                        producerId: audioProducer.id,
                        rtpCapabilities: this.mediasoupService.router.rtpCapabilities,
                        paused: false
                    });
                    consumers.audio = audioConsumer;
                    logger.debug(`✅ INTERCEPTOR: Audio consumer created: ${audioConsumer.id}`);
                }
                
                // Store consumers
                this.extractionConsumers = this.extractionConsumers || new Map();
                this.extractionConsumers.set(streamId, consumers);
            }
            
            logger.debug(`✅ INTERCEPTOR: Producer connected to extraction ports - Video: ${extractPorts.video}, Audio: ${extractPorts.audio}`);
            return true;
        } catch (error) {
            logger.error(`❌ INTERCEPTOR: Failed to connect producers:`, error);
            throw error;
        }
    }
    
    /**
     * Helper to get transport by ID
     */
    async getTransportById(transportId) {
        // Search through all transports in MediaSoup
        for (const [socketId, transport] of this.mediasoupService.transports) {
            if (transport.id === transportId) {
                return transport;
            }
        }
        
        // Also check plain transports
        for (const [botId, transports] of this.plainTransportService.plainTransports) {
            if (transports.video && transports.video.id === transportId) {
                return transports.video;
            }
            if (transports.audio && transports.audio.id === transportId) {
                return transports.audio;
            }
        }
        
        return null;
    }

    /**
     * Switch viewers to processed stream
     */
    async switchViewersToProcessed(streamId, injectPorts) {
        logger.debug(`🔄 INTERCEPTOR: Switching viewers to processed stream`);
        
        try {
            // Use the botId that was stored when creating the injection transport
            const injectionBotId = injectPorts.botId;
            
            if (!injectionBotId) {
                throw new Error('Injection botId not found in injectPorts');
            }
            
            // We need to create producers that will receive the processed RTP from GStreamer
            await this.plainTransportService.createPlainProducers(injectionBotId, {
                video: {
                    rtpPort: injectPorts.video,
                    rtcpPort: injectPorts.videoRtcp
                },
                audio: {
                    rtpPort: injectPorts.audio,
                    rtcpPort: injectPorts.audioRtcp
                }
            });
            
            // Store the injection producers for later reference
            this.injectionProducers = this.injectionProducers || new Map();
            this.injectionProducers.set(streamId, injectionBotId);
            
            // Now viewers can consume from these new producers
            // We'll emit an event to notify about the switch
            this.emit('stream-intercepted', {
                streamId,
                processedProducerId: injectionBotId,
                timestamp: Date.now()
            });
            
            logger.debug(`✅ INTERCEPTOR: Viewers can now consume from processed stream`);
            return true;
            
        } catch (error) {
            logger.error(`❌ INTERCEPTOR: Failed to switch viewers:`, error);
            throw error;
        }
    }

    /**
     * Stop stream interception and restore normal flow
     */
    async stopInterception(streamId) {
        logger.debug(`🛑 INTERCEPTOR: Stopping interception for stream ${streamId}`);
        
        const intercept = this.activeIntercepts.get(streamId);
        if (!intercept) {
            logger.warn(`⚠️ INTERCEPTOR: No active interception for stream ${streamId}`);
            return false;
        }
        
        try {
            // Kill processor
            if (intercept.processor && !intercept.processor.killed) {
                intercept.processor.kill();
                logger.debug(`🛑 INTERCEPTOR: GStreamer process killed`);
            }
            
            // Clean up extraction consumers
            if (this.extractionConsumers && this.extractionConsumers.has(streamId)) {
                const consumers = this.extractionConsumers.get(streamId);
                if (consumers.video) consumers.video.close();
                if (consumers.audio) consumers.audio.close();
                this.extractionConsumers.delete(streamId);
                logger.debug(`🛑 INTERCEPTOR: Extraction consumers closed`);
            }
            
            // Clean up injection producers
            if (this.injectionProducers && this.injectionProducers.has(streamId)) {
                const botId = this.injectionProducers.get(streamId);
                const producers = this.plainTransportService.plainProducers.get(botId);
                if (producers) {
                    if (producers.video) producers.video.close();
                    if (producers.audio) producers.audio.close();
                    this.plainTransportService.plainProducers.delete(botId);
                }
                this.injectionProducers.delete(streamId);
                logger.debug(`🛑 INTERCEPTOR: Injection producers closed`);
            }
            
            // Clean up transports
            // Note: We should implement proper transport cleanup in PlainTransportService
            
            // Switch viewers back to original stream
            this.emit('stream-restored', {
                streamId,
                timestamp: Date.now()
            });
            
            this.activeIntercepts.delete(streamId);
            
            logger.debug(`✅ INTERCEPTOR: Interception stopped for stream ${streamId}`);
            return true;
            
        } catch (error) {
            logger.error(`❌ INTERCEPTOR: Failed to stop interception:`, error);
            return false;
        }
    }

    /**
     * Get active interceptions
     */
    getActiveInterceptions() {
        const result = [];
        for (const [streamId, config] of this.activeIntercepts) {
            result.push({
                streamId,
                effectType: config.effectType,
                duration: Date.now() - config.startTime,
                options: config.options
            });
        }
        return result;
    }

    /**
     * Clean up all interceptions
     */
    async cleanup() {
        logger.debug('🧹 INTERCEPTOR: Cleaning up all interceptions');
        
        for (const streamId of this.activeIntercepts.keys()) {
            await this.stopInterception(streamId);
        }
    }
}

module.exports = StreamInterceptorService;
