const { spawn } = require('child_process');
const { PassThrough } = require('stream');

const logger = require('../../bootstrap/logger').child({ svc: 'VisualFxService' });

/**
 * Owns the FFmpeg processing-pipeline lifecycle and the filter/audio effect
 * methods that drive it, plus MediaSoup consumer interception for filters.
 * Extracted verbatim from VisualFxService; reads service state
 * (processingPipelines, mediasoupService, getStreamConsumers) via `owner`.
 */
class FfmpegPipeline {
    constructor(owner) {
        this.owner = owner;
    }

    async applyFilterEffect(streamId, parameters) {
        logger.debug(`🎬 VISUALFX: Applying filter effect to stream ${streamId}:`, parameters.filter);

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
        const owner = this.owner;
        if (!owner.mediasoupService) {
            logger.warn(`⚠️ VISUALFX: No MediaSoup service available for stream interception`);
            return;
        }

        const consumers = owner.getStreamConsumers(streamId);
        logger.debug(`🎬 VISUALFX: Found ${consumers.length} consumers for stream ${streamId}`);

        for (const consumer of consumers) {
            if (consumer.kind === 'video') {
                try {
                    // For now, we'll simulate the effect by modifying consumer properties
                    // In a full implementation, you'd need to:
                    // 1. Extract RTP packets from the consumer
                    // 2. Decode them to raw video frames
                    // 3. Process through FFmpeg
                    // 4. Re-encode and create new consumer

                    logger.debug(`🎬 VISUALFX: Intercepting video consumer ${consumer.id} for filter: ${videoFilter}`);

                    // Mark consumer as processed
                    if (!consumer._visualFxProcessed) {
                        consumer._visualFxProcessed = true;
                        consumer._visualFxFilter = videoFilter;
                        logger.debug(`✅ VISUALFX: Consumer ${consumer.id} marked for processing`);
                    }

                } catch (error) {
                    logger.error(`❌ VISUALFX: Failed to intercept consumer ${consumer.id}:`, error);
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

    async createProcessingPipeline(streamId, options) {
        const owner = this.owner;
        logger.debug(`🎬 VISUALFX: Creating processing pipeline for stream ${streamId}`, options);

        // Check if pipeline already exists
        if (owner.processingPipelines.has(streamId)) {
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
            owner.processingPipelines.set(streamId, pipeline);

            logger.debug(`✅ VISUALFX: Processing pipeline created for stream ${streamId}`);

        } catch (error) {
            logger.error(`❌ VISUALFX: Failed to create processing pipeline:`, error);
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

        logger.debug(`🎬 VISUALFX: FFmpeg args for ${streamId}:`, ffmpegArgs);

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
                logger.debug(`🎬 VISUALFX: Processing ${streamId}: ${message.trim()}`);
            } else if (message.includes('error') || message.includes('Error')) {
                logger.error(`❌ VISUALFX: FFmpeg error for ${streamId}: ${message}`);
                pipeline.stats.errors++;
            }
        });

        // Handle process exit
        ffmpegProcess.on('close', (code) => {
            logger.debug(`🎬 VISUALFX: FFmpeg process for ${streamId} exited with code ${code}`);
            pipeline.isActive = false;
        });

        // Handle process errors
        ffmpegProcess.on('error', (error) => {
            logger.error(`❌ VISUALFX: FFmpeg process error for ${streamId}:`, error);
            pipeline.isActive = false;
            pipeline.stats.errors++;
        });

        pipeline.isActive = true;
        logger.debug(`🎬 VISUALFX: FFmpeg pipeline initialized for ${streamId}`);
    }

    async updateProcessingPipeline(streamId, options) {
        const owner = this.owner;
        const pipeline = owner.processingPipelines.get(streamId);
        if (!pipeline) return;

        // Update filters
        if (options.video) {
            pipeline.filters.video = options.video;
        }
        if (options.audio) {
            pipeline.filters.audio = options.audio;
        }

        logger.debug(`🔄 VISUALFX: Updated processing pipeline for stream ${streamId}`);
    }

    async removeProcessingPipeline(streamId) {
        const owner = this.owner;
        const pipeline = owner.processingPipelines.get(streamId);
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
            logger.error(`⚠️ VISUALFX: Error cleaning up pipeline:`, err.message);
        }

        owner.processingPipelines.delete(streamId);
        logger.debug(`🎬 VISUALFX: Removed processing pipeline for stream ${streamId}`);
    }
}

module.exports = FfmpegPipeline;
