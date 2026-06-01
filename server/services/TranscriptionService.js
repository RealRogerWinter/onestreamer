const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const AudioBufferService = require('./AudioBufferService');
const TranscriptionAudioAdapter = require('./TranscriptionAudioAdapter');
const TranscriptionRepository = require('./transcription/TranscriptionRepository');
const WhisperRunner = require('./transcription/WhisperRunner');
const AudioFileJanitor = require('./transcription/AudioFileJanitor');

const logger = require('../bootstrap/logger').child({ svc: 'TranscriptionService' });

class TranscriptionService extends EventEmitter {
    constructor(database, webrtcService, recordingService = null) {
        super();
        this.database = database;
        this.db = database.db;
        this.runAsync = database.runAsync;
        this.getAsync = database.getAsync;
        this.allAsync = database.allAsync;
        this.webrtcService = webrtcService;
        this.recordingService = recordingService;

        // Create audio adapter for backend-agnostic audio capture
        this.audioAdapter = new TranscriptionAudioAdapter(webrtcService);
        
        // Initialize AudioBufferService
        this.audioBufferService = new AudioBufferService();
        
        // Active transcription sessions
        this.activeSessions = new Map();
        
        // Configuration
        this.config = {
            enableTranscription: false,
            model: 'small', // tiny, base, small, medium, large
            language: 'en', // auto-detect if null
            chunkDuration: 5000, // 5 seconds chunks
            whisperPath: path.join(__dirname, '..', '..', 'whisper'),
            tempDir: path.join(__dirname, '..', '..', 'temp', 'transcription')
        };
        
        // Platform detection
        this.isWindows = process.platform === 'win32';
        
        // Audio format settings
        this.audioFormat = {
            sampleRate: 16000,
            channels: 1,
            bitDepth: 16
        };

        // Collaborators (extracted seams)
        this.repository = new TranscriptionRepository({
            runAsync: this.runAsync,
            getAsync: this.getAsync,
            allAsync: this.allAsync
        });
        this.whisperRunner = new WhisperRunner({
            whisperPath: this.config.whisperPath,
            isWindows: this.isWindows
        });
        this.audioFileJanitor = new AudioFileJanitor({
            tempDir: this.config.tempDir,
            baseDir: path.join(__dirname, '..', '..')
        });

        // Ensure temp directory exists
        this.initializeDirectories();
        
        logger.debug('🎙️ TRANSCRIPTION: Service initialized');
        logger.debug(`   Platform: ${this.isWindows ? 'Windows' : 'Unix-like'}`);
        logger.debug(`   Model: ${this.config.model}`);
        logger.debug(`   Chunk duration: ${this.config.chunkDuration}ms`);
        logger.debug(`   Backend: ${this.audioAdapter.backendType.toUpperCase()}`);
        
        // Start periodic cleanup of old audio files
        this.startPeriodicCleanup(15); // Clean up every 15 minutes
    }
    
    initializeDirectories() {
        return this.audioFileJanitor.initializeDirectories();
    }
    
    async startTranscription(streamerId, options = {}) {
        logger.debug(`🎙️ TRANSCRIPTION: Starting transcription for ${streamerId}`);
        
        const sessionId = uuidv4();
        
        try {
            // Verify stream is active - be flexible with streamer ID validation
            const currentStreamer = await this.audioAdapter.getCurrentStreamer();
            let effectiveStreamerId = streamerId;

            if (!currentStreamer) {
                logger.error(`❌ TRANSCRIPTION: No active streamer found`);
                return { success: false, error: 'No active streamer found' };
            }

            // If provided streamerId doesn't match current streamer, use current streamer instead
            // This accommodates ViewBot streams and streamer transitions
            if (currentStreamer !== streamerId) {
                logger.debug(`⚠️ TRANSCRIPTION: Streamer ID mismatch - requested: ${streamerId}, current: ${currentStreamer}`);
                logger.debug(`🔄 TRANSCRIPTION: Using current active streamer: ${currentStreamer}`);
                effectiveStreamerId = currentStreamer;
            }

            // Check for audio producer using the effective streamer ID
            const audioProducer = await this.audioAdapter.getAudioProducer(effectiveStreamerId);

            if (!audioProducer) {
                logger.error(`❌ TRANSCRIPTION: No audio producer found for ${effectiveStreamerId}`);
                if (this.audioAdapter.isMediaSoup()) {
                    const producerMap = this.webrtcService.producers.get(effectiveStreamerId);
                    logger.debug(`   Available producers:`, producerMap ? Array.from(producerMap.keys()) : 'none');
                } else {
                    logger.debug(`   LiveKit: No participants with audio found in room`);
                }
                return { success: false, error: 'No audio producer available' };
            }

            logger.debug(`✅ TRANSCRIPTION: Found audio producer for ${effectiveStreamerId}`);
            if (audioProducer.id) {
                logger.debug(`   Producer ID: ${audioProducer.id}`);
            }
            if (audioProducer.kind) {
                logger.debug(`   Producer kind: ${audioProducer.kind}`);
            }
            if (audioProducer.paused !== undefined) {
                logger.debug(`   Producer paused: ${audioProducer.paused}`);
            }
            
            // Create transcription session
            const session = {
                id: sessionId,
                streamerId: effectiveStreamerId,
                startTime: new Date(),
                status: 'initializing',
                config: { ...this.config, ...options },
                audioBuffer: Buffer.alloc(0),
                lastTranscription: '',
                totalTranscription: '',
                wordCount: 0,
                transport: null,
                consumer: null,
                ffmpegProcess: null,
                whisperProcess: null,
                processingChunk: false,
                chunkCount: 0,
                lastProcessedDuration: 0,  // Track what we've already processed
                processingInterval: 5  // Process every 5 seconds of new audio
            };
            
            // Create audio capture using the adapter (supports both MediaSoup and LiveKit)
            const captureResult = await this.audioAdapter.createAudioCapture(sessionId, effectiveStreamerId);
            if (!captureResult.success) {
                return { success: false, error: captureResult.error };
            }

            // Store capture info in session
            session.transport = captureResult.transport;
            session.consumer = captureResult.consumer;
            session.captureInfo = captureResult;

            // For MediaSoup, store RTP ports
            if (captureResult.ffmpegRtpPort) {
                session.ffmpegRtpPort = captureResult.ffmpegRtpPort;
                session.ffmpegRtcpPort = captureResult.ffmpegRtcpPort;
            }
            
            // Start audio buffering using the adapter
            const bufferResult = await this.audioAdapter.startAudioBuffering(
                session,
                session.captureInfo,
                this.audioBufferService
            );
            
            if (!bufferResult.success) {
                await this.cleanupSession(session);
                return { success: false, error: bufferResult.error };
            }
            
            session.bufferFile = bufferResult.bufferFile;
            
            // Give FFmpeg a moment to be ready
            await new Promise(resolve => setTimeout(resolve, 300));

            // Resume the consumer to start audio flow (MediaSoup only)
            if (this.audioAdapter.isMediaSoup() && session.consumer && typeof session.consumer.resume === 'function') {
                logger.debug(`▶️ TRANSCRIPTION: Starting audio flow (MediaSoup)...`);
                await session.consumer.resume();
            } else if (this.audioAdapter.isLiveKit()) {
                logger.debug(`▶️ TRANSCRIPTION: Audio capture active (LiveKit)...`);
            }
            
            session.status = 'active';
            
            // For timed recordings, immediately start timer but add buffer time
            if (options.timed) {
                session.timedDuration = options.duration;
                session.recordingStartTime = Date.now();
                session.recordingStartPosition = 0;
                
                logger.debug(`🔴 TRANSCRIPTION: Recording started!`);
                logger.debug(`   Target duration: ${options.duration}s`);
                
                // Add extra time to compensate for any startup delays
                // User starts counting when they click, so we need to capture from that moment
                const extraTime = 1.5; // Add 1.5 seconds to ensure we get the beginning
                const totalRecordTime = options.duration + extraTime;
                
                // Set auto-stop timer for duration + buffer time
                session.autoStopTimer = setTimeout(async () => {
                    logger.debug(`⏰ TRANSCRIPTION: Stopping after ${totalRecordTime}s (includes ${extraTime}s buffer)`);

                    // Wait a moment to ensure all audio is written
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // For LiveKit RTC, finalize the WAV file before processing
                    if (this.audioAdapter.isLiveKit() && session.pcmFile) {
                        logger.debug(`📝 TRANSCRIPTION: Finalizing LiveKit audio capture...`);
                        await this.audioAdapter.finalizeLiveKitCapture(session);
                    }

                    // Process the recording
                    await this.processTimedRecording(session);

                    // Stop the transcription
                    const stopResult = await this.stopTranscription(session.id);

                    if (stopResult.success) {
                        logger.debug(`✅ TRANSCRIPTION: Timed session ${session.id} completed`);
                        
                        // Emit completion event
                        this.emit('transcription-stopped', {
                            sessionId: session.id,
                            streamerId: session.streamerId,
                            duration: stopResult.duration,
                            wordCount: stopResult.wordCount,
                            transcription: session.totalTranscription || '',
                            timed: true,
                            autoStopped: true
                        });
                    }
                }, totalRecordTime * 1000);
                
                logger.debug(`⏲️ TRANSCRIPTION: Will record for ${totalRecordTime}s total`);
            } else {
                // Start periodic transcription processing for continuous mode
                this.startTranscriptionProcessing(session);
            }
            
            logger.debug(`🎧 TRANSCRIPTION: Session ${sessionId} ready with audio buffer`);
            
            // Store session
            this.activeSessions.set(sessionId, session);
            
            // Save to database
            await this.saveTranscriptionToDatabase(session);
            
            // Emit start event
            this.emit('transcription-started', {
                sessionId: sessionId,
                streamerId: effectiveStreamerId,
                startTime: session.startTime
            });
            
            logger.debug(`✅ TRANSCRIPTION: Started session ${sessionId} for ${effectiveStreamerId}`);
            
            return {
                success: true,
                sessionId: sessionId,
                startTime: session.startTime
            };
            
        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to start:', error);
            return { success: false, error: error.message };
        }
    }
    
    startTranscriptionProcessing(session) {
        // Process audio from buffer every 5 seconds
        session.transcriptionInterval = setInterval(async () => {
            if (session.status !== 'active' || session.processingChunk) {
                return;
            }
            
            try {
                session.processingChunk = true;
                
                // Get current buffer duration
                const bufferInfo = await this.audioBufferService.getBufferInfo(session.id);
                if (!bufferInfo || !bufferInfo.duration) {
                    logger.debug(`⚠️ TRANSCRIPTION: No buffer info available yet`);
                    return;
                }
                
                const currentDuration = bufferInfo.duration;
                const newAudioDuration = currentDuration - session.lastProcessedDuration;
                
                // Only process if we have at least 5 seconds of new audio
                if (newAudioDuration < session.processingInterval) {
                    logger.debug(`⏳ TRANSCRIPTION: Waiting for more audio (${newAudioDuration.toFixed(1)}s available)`);
                    return;
                }
                
                // Extract only the new audio since last processing
                // We'll extract a window from lastProcessedDuration to current
                const extractDuration = Math.min(newAudioDuration, 30); // Max 30 seconds at a time
                const extractResult = await this.audioBufferService.extractAudioRange(
                    session.id,
                    session.lastProcessedDuration,
                    session.lastProcessedDuration + extractDuration
                );
                
                if (extractResult.success) {
                    session.chunkCount++;
                    session.lastProcessedDuration += extractDuration; // Update last processed position
                    logger.debug(`🎵 TRANSCRIPTION: Processing chunk ${session.chunkCount} (${extractResult.duration.toFixed(1)}s of new audio)`);
                    logger.debug(`   Processed up to: ${session.lastProcessedDuration.toFixed(1)}s`);
                    
                    // Transcribe the extracted audio
                    const transcription = await this.transcribeWithWhisperCpp(
                        extractResult.audioPath,
                        session.config
                    );
                    
                    if (transcription && transcription.trim() && transcription.trim() !== 'you') {
                        // Update session
                        session.lastTranscription = transcription;
                        session.totalTranscription += ' ' + transcription;
                        session.wordCount += transcription.split(/\s+/).length;
                        
                        logger.debug(`📝 TRANSCRIPTION [${session.chunkCount}]: ${transcription.substring(0, 100)}...`);
                        
                        // Emit transcription event
                        this.emit('transcription-chunk', {
                            sessionId: session.id,
                            streamerId: session.streamerId,
                            chunkNumber: session.chunkCount,
                            text: transcription,
                            timestamp: new Date(),
                            wordCount: session.wordCount
                        });
                        
                        // Save to database
                        await this.saveTranscriptionChunk(session, transcription, session.chunkCount);
                    } else if (transcription && transcription.trim() === 'you') {
                        logger.debug(`⚠️ TRANSCRIPTION: Ignoring 'you' hallucination from chunk ${session.chunkCount}`);
                    }
                    
                    // Clean up extracted audio file after successful transcription
                    try {
                        if (fs.existsSync(extractResult.audioPath)) {
                            fs.unlinkSync(extractResult.audioPath);
                            logger.debug(`🧹 TRANSCRIPTION: Deleted processed audio file: ${path.basename(extractResult.audioPath)}`);
                        }
                    } catch (e) {
                        logger.error(`⚠️ TRANSCRIPTION: Failed to delete audio file:`, e.message);
                    }
                } else {
                    logger.debug(`⚠️ TRANSCRIPTION: Could not extract audio: ${extractResult.error}`);
                }
                
            } catch (error) {
                logger.error(`❌ TRANSCRIPTION: Error processing chunk:`, error);
            } finally {
                session.processingChunk = false;
            }
            
        }, 5000); // Process every 5 seconds
    }
    
    // Removed - no longer needed with AudioBufferService
    
    // Removed - no longer needed with AudioBufferService
    
    // Removed - no longer needed with AudioBufferService
    
    // Removed handleAudioChunk - no longer needed with AudioBufferService
    
    // Removed processAudioChunk - replaced with startTranscriptionProcessing
    
    async transcribeWithWhisperCpp(audioPath, config) {
        return this.whisperRunner.transcribeWithWhisperCpp(audioPath, config);
    }
    
    // Removed demo transcription - using real audio only
    
    async stopTranscription(sessionId) {
        logger.debug(`🛑 TRANSCRIPTION: Stopping session ${sessionId}`);
        
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }
        
        session.status = 'stopping';
        session.endTime = new Date();

        // Cleanup session. (Audio is consumed continuously by the
        // startTranscriptionProcessing interval via AudioBufferService; there
        // is no separate end-of-session buffer to flush here.)
        await this.cleanupSession(session);
        
        // Update database
        await this.updateTranscriptionInDatabase(session);
        
        // Remove from active sessions
        this.activeSessions.delete(sessionId);
        
        // Emit stop event
        this.emit('transcription-stopped', {
            sessionId: sessionId,
            streamerId: session.streamerId,
            endTime: session.endTime,
            wordCount: session.wordCount,  // Changed from totalWords to wordCount for consistency
            totalWords: session.wordCount,  // Keep for backwards compatibility
            duration: session.endTime - session.startTime,
            transcription: session.totalTranscription || session.lastTranscription || ''
        });
        
        logger.debug(`✅ TRANSCRIPTION: Stopped session ${sessionId}`);
        
        return {
            success: true,
            sessionId: sessionId,
            duration: session.endTime - session.startTime,
            wordCount: session.wordCount
        };
    }
    
    async cleanupSession(session) {
        try {
            logger.debug(`🧹 TRANSCRIPTION: Cleaning up session ${session.id}`);

            // Clear auto-stop timer if it exists
            if (session.autoStopTimer) {
                clearTimeout(session.autoStopTimer);
                logger.debug(`✅ TRANSCRIPTION: Cleared auto-stop timer`);
            }

            // Stop transcription processing interval
            if (session.transcriptionInterval) {
                clearInterval(session.transcriptionInterval);
                logger.debug(`✅ TRANSCRIPTION: Stopped transcription interval`);
            }

            // Stop audio buffering
            if (this.audioBufferService) {
                await this.audioBufferService.stopBuffering(session.id);
                logger.debug(`✅ TRANSCRIPTION: Stopped audio buffering`);
            }

            // Stop FFmpeg process if it exists (legacy)
            if (session.ffmpegProcess) {
                session.ffmpegProcess.kill('SIGTERM');
            }

            // Use adapter to cleanup audio capture resources
            if (this.audioAdapter) {
                await this.audioAdapter.cleanup(session);
                logger.debug(`✅ TRANSCRIPTION: Adapter cleanup completed`);
            } else {
                // Fallback to direct cleanup (for backward compatibility)
                // Close consumer
                if (session.consumer && !session.consumer.closed) {
                    if (typeof session.consumer.close === 'function') {
                        session.consumer.close();
                    }
                }

                // Close transport
                if (session.transport && !session.transport.closed) {
                    if (typeof session.transport.close === 'function') {
                        session.transport.close();
                    }
                }
            }

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Error during cleanup:', error);
        }
    }
    
    // Database methods
    async saveTranscriptionToDatabase(session) {
        return this.repository.saveTranscriptionToDatabase(session);
    }

    async saveTranscriptionChunk(session, text, chunkNumber) {
        return this.repository.saveTranscriptionChunk(session, text, chunkNumber);
    }

    async updateTranscriptionInDatabase(session) {
        return this.repository.updateTranscriptionInDatabase(session);
    }

    async getTranscription(sessionId) {
        return this.repository.getTranscription(sessionId);
    }

    async getActiveTranscriptions() {
        const active = [];
        for (const [id, session] of this.activeSessions) {
            active.push({
                id: id,
                streamerId: session.streamerId,
                startTime: session.startTime,
                status: session.status,
                wordCount: session.wordCount,
                chunkCount: session.chunkCount
            });
        }
        return active;
    }
    
    async getTranscriptionHistory(limit = 50, offset = 0, filters = {}) {
        return this.repository.getTranscriptionHistory(limit, offset, filters);
    }

    async deleteOldTranscriptions(daysOld = 30) {
        return this.repository.deleteOldTranscriptions(daysOld);
    }

    // Configuration methods
    enableTranscription() {
        this.config.enableTranscription = true;
        logger.debug('✅ TRANSCRIPTION: Enabled');
    }
    
    disableTranscription() {
        this.config.enableTranscription = false;
        logger.debug('⏸️ TRANSCRIPTION: Disabled');
    }
    
    setModel(model) {
        const validModels = ['tiny', 'base', 'small', 'medium', 'large'];
        if (validModels.includes(model)) {
            this.config.model = model;
            logger.debug(`✅ TRANSCRIPTION: Model set to ${model}`);
        } else {
            logger.error(`❌ TRANSCRIPTION: Invalid model ${model}`);
        }
    }
    
    setLanguage(language) {
        this.config.language = language;
        logger.debug(`✅ TRANSCRIPTION: Language set to ${language || 'auto'}`);
    }
    
    async startTimedTranscription(streamerId, duration = 30, options = {}) {
        logger.debug(`⏱️ TRANSCRIPTION: Starting timed transcription for ${streamerId} (${duration}s)`);
        
        try {
            // Start a regular transcription session with timed flag
            const result = await this.startTranscription(streamerId, {
                ...options,
                timed: true,
                duration: duration
            });
            
            if (!result.success) {
                return result;
            }
            
            const sessionId = result.sessionId;
            const session = this.activeSessions.get(sessionId);
            
            if (session) {
                // Timer is already set in startTranscription for timed recordings
                logger.debug(`✅ TRANSCRIPTION: Timed session ${sessionId} is recording for ${duration}s`);
            }
            
            return result;
            
        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to start timed transcription:', error);
            return { success: false, error: error.message };
        }
    }
    
    async processTimedRecording(session) {
        try {
            logger.debug(`🎵 TRANSCRIPTION: Processing complete ${session.timedDuration}s recording`);
            logger.debug(`🔍 TRANSCRIPTION: Backend check - isLiveKit: ${this.audioAdapter.isLiveKit()}, backendType: ${this.audioAdapter.backendType}`);

            // For LiveKit RTC capture, WAV file is already finalized by cleanup
            // For MediaSoup, we need to extract from the buffer
            if (this.audioAdapter.isLiveKit()) {
                logger.debug(`📝 TRANSCRIPTION: LiveKit RTC - using finalized WAV file`);

                // The WAV file should already exist (created during capture)
                if (!session.bufferFile || !fs.existsSync(session.bufferFile)) {
                    logger.error(`❌ TRANSCRIPTION: WAV file not found: ${session.bufferFile}`);
                    return;
                }

                const stats = fs.statSync(session.bufferFile);
                logger.debug(`📊 TRANSCRIPTION: WAV file ready: ${stats.size} bytes`);

                // Transcribe directly from the WAV file
                logger.debug(`🎙️ TRANSCRIPTION: Transcribing with Whisper...`);
                const transcription = await this.transcribeWithWhisperCpp(
                    session.bufferFile,
                    session.config
                );

                if (transcription && transcription.trim() && transcription.trim() !== 'you') {
                    session.lastTranscription = transcription;
                    session.totalTranscription = transcription;
                    session.wordCount = transcription.split(/\s+/).length;
                    session.chunkCount = 1;

                    logger.debug(`✅ TRANSCRIPTION: Complete transcription (${session.wordCount} words)`);
                    logger.debug(`📝 TRANSCRIPTION: "${transcription.substring(0, 100)}${transcription.length > 100 ? '...' : ''}"`);

                    // Emit transcription event
                    this.emit('transcription-chunk', {
                        sessionId: session.id,
                        streamerId: session.streamerId,
                        transcription: transcription,
                        wordCount: session.wordCount,
                        isComplete: true
                    });
                } else {
                    logger.debug(`⚠️ TRANSCRIPTION: No valid transcription produced`);
                }

                return;
            }

            // MediaSoup path - use buffer service
            logger.debug(`📝 TRANSCRIPTION: MediaSoup - extracting from buffer`);

            // Get current buffer info
            const bufferInfo = await this.audioBufferService.getBufferInfo(session.id);
            if (!bufferInfo) {
                logger.error(`❌ TRANSCRIPTION: No buffer info available`);
                return;
            }

            const recordingEndPosition = bufferInfo.duration;

            // Extract the requested duration from the BEGINNING of the buffer
            // We recorded extra time to ensure we capture everything
            const targetDuration = Math.min(recordingEndPosition, session.timedDuration);

            logger.debug(`📊 TRANSCRIPTION: Extracting recording:`);
            logger.debug(`   Buffer contains: ${recordingEndPosition.toFixed(1)}s total`);
            logger.debug(`   Requested duration: ${session.timedDuration}s`);
            logger.debug(`   Extracting first: ${targetDuration.toFixed(1)}s`);

            // Extract from the beginning of the recording
            const extractResult = await this.audioBufferService.extractAudioRange(
                session.id,
                0,  // Start from the beginning
                targetDuration  // Extract up to the requested duration
            );

            if (!extractResult.success) {
                logger.error(`❌ TRANSCRIPTION: Failed to extract audio: ${extractResult.error}`);
                return;
            }

            logger.debug(`📝 TRANSCRIPTION: Transcribing ${extractResult.duration.toFixed(1)}s of audio...`);

            // Transcribe the entire recording
            const transcription = await this.transcribeWithWhisperCpp(
                extractResult.audioPath,
                session.config
            );

            if (transcription && transcription.trim() && transcription.trim() !== 'you') {
                session.lastTranscription = transcription;
                session.totalTranscription = transcription;
                session.wordCount = transcription.split(/\s+/).length;
                session.chunkCount = 1; // Single chunk for timed recording

                logger.debug(`✅ TRANSCRIPTION: Complete transcription (${session.wordCount} words)`);
                
                // Emit single transcription event with all text
                this.emit('transcription-chunk', {
                    sessionId: session.id,
                    streamerId: session.streamerId,
                    chunkNumber: 1,
                    text: transcription,
                    timestamp: new Date(),
                    wordCount: session.wordCount,
                    complete: true
                });
                
                // Save to database
                await this.saveTranscriptionChunk(session, transcription, 1);
            } else if (transcription && transcription.trim() === 'you') {
                logger.debug(`⚠️ TRANSCRIPTION: Ignoring 'you' hallucination`);
            } else {
                logger.debug(`⚠️ TRANSCRIPTION: No speech detected in recording`);
            }
            
            // Clean up extracted audio file after successful transcription
            try {
                if (fs.existsSync(extractResult.audioPath)) {
                    fs.unlinkSync(extractResult.audioPath);
                    logger.debug(`🧹 TRANSCRIPTION: Deleted processed audio file: ${path.basename(extractResult.audioPath)}`);
                }
            } catch (e) {
                logger.error(`⚠️ TRANSCRIPTION: Failed to delete audio file:`, e.message);
            }
            
        } catch (error) {
            logger.error(`❌ TRANSCRIPTION: Error processing timed recording:`, error);
        }
    }
    
    // Clean up old audio files periodically
    async cleanupOldAudioFiles(maxAgeMinutes = 30) {
        return this.audioFileJanitor.cleanupOldAudioFiles(maxAgeMinutes);
    }

    // Start periodic cleanup (called from constructor or init)
    startPeriodicCleanup(intervalMinutes = 15) {
        return this.audioFileJanitor.startPeriodicCleanup(intervalMinutes);
    }
}

module.exports = TranscriptionService;
