const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const AudioBufferService = require('./AudioBufferService');

class TranscriptionService extends EventEmitter {
    constructor(database, mediasoupService, recordingService = null) {
        super();
        this.database = database;
        this.db = database.db;
        this.runAsync = database.runAsync;
        this.getAsync = database.getAsync;
        this.allAsync = database.allAsync;
        this.mediasoupService = mediasoupService;
        this.recordingService = recordingService;
        
        // Initialize AudioBufferService
        this.audioBufferService = new AudioBufferService();
        
        // Active transcription sessions
        this.activeSessions = new Map();
        
        // Configuration
        this.config = {
            enableTranscription: false,
            model: 'base', // tiny, base, small, medium, large
            language: 'en', // auto-detect if null
            chunkDuration: 5000, // 5 seconds chunks
            overlapDuration: 500, // 0.5 second overlap
            maxBufferSize: 30000, // 30 seconds max buffer
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
        
        // Ensure temp directory exists
        this.initializeDirectories();
        
        console.log('🎙️ TRANSCRIPTION: Service initialized');
        console.log(`   Platform: ${this.isWindows ? 'Windows' : 'Unix-like'}`);
        console.log(`   Model: ${this.config.model}`);
        console.log(`   Chunk duration: ${this.config.chunkDuration}ms`);
    }
    
    initializeDirectories() {
        if (!fs.existsSync(this.config.tempDir)) {
            fs.mkdirSync(this.config.tempDir, { recursive: true });
        }
        
        const transcriptsDir = path.join(__dirname, '..', '..', 'transcripts');
        if (!fs.existsSync(transcriptsDir)) {
            fs.mkdirSync(transcriptsDir, { recursive: true });
        }
    }
    
    async startTranscription(streamerId, options = {}) {
        console.log(`🎙️ TRANSCRIPTION: Starting transcription for ${streamerId}`);
        
        const sessionId = uuidv4();
        
        try {
            // Verify stream is active - be flexible with streamer ID validation
            const currentStreamer = this.mediasoupService.getCurrentStreamer();
            let effectiveStreamerId = streamerId;
            
            if (!currentStreamer) {
                console.error(`❌ TRANSCRIPTION: No active streamer found`);
                return { success: false, error: 'No active streamer found' };
            }
            
            // If provided streamerId doesn't match current streamer, use current streamer instead
            // This accommodates ViewBot streams and streamer transitions
            if (currentStreamer !== streamerId) {
                console.log(`⚠️ TRANSCRIPTION: Streamer ID mismatch - requested: ${streamerId}, current: ${currentStreamer}`);
                console.log(`🔄 TRANSCRIPTION: Using current active streamer: ${currentStreamer}`);
                effectiveStreamerId = currentStreamer;
            }
            
            // Check for audio producer using the effective streamer ID
            const producerMap = this.mediasoupService.producers.get(effectiveStreamerId);
            const audioProducer = producerMap?.get('audio');
            
            if (!audioProducer) {
                console.error(`❌ TRANSCRIPTION: No audio producer found for ${effectiveStreamerId}`);
                console.log(`   Available producers:`, producerMap ? Array.from(producerMap.keys()) : 'none');
                return { success: false, error: 'No audio producer available' };
            }
            
            console.log(`✅ TRANSCRIPTION: Found audio producer ${audioProducer.id} for ${effectiveStreamerId}`);
            console.log(`   Producer kind: ${audioProducer.kind}`);
            console.log(`   Producer paused: ${audioProducer.paused}`);
            
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
            
            // Create MediaSoup plain transport for audio
            const transportResult = await this.createAudioTransport();
            if (!transportResult.success) {
                return { success: false, error: transportResult.error };
            }
            
            session.transport = transportResult.transport;
            session.ffmpegRtpPort = transportResult.ffmpegRtpPort;
            session.ffmpegRtcpPort = transportResult.ffmpegRtcpPort;
            
            // Create audio consumer
            const consumerResult = await this.createAudioConsumer(session, audioProducer);
            if (!consumerResult.success) {
                await this.cleanupSession(session);
                return { success: false, error: consumerResult.error };
            }
            
            session.consumer = consumerResult.consumer;
            
            // Start audio buffering using AudioBufferService with FFmpeg ports
            const bufferResult = await this.audioBufferService.startBuffering(
                sessionId,
                session.transport,
                session.consumer,
                session.ffmpegRtpPort,
                session.ffmpegRtcpPort
            );
            
            if (!bufferResult.success) {
                await this.cleanupSession(session);
                return { success: false, error: bufferResult.error };
            }
            
            session.bufferFile = bufferResult.bufferFile;
            
            // Give FFmpeg a moment to be ready
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // Now resume the consumer to start audio flow
            console.log(`▶️ TRANSCRIPTION: Starting audio flow...`);
            await session.consumer.resume();
            
            session.status = 'active';
            
            // For timed recordings, immediately start timer but add buffer time
            if (options.timed) {
                session.timedDuration = options.duration;
                session.recordingStartTime = Date.now();
                session.recordingStartPosition = 0;
                
                console.log(`🔴 TRANSCRIPTION: Recording started!`);
                console.log(`   Target duration: ${options.duration}s`);
                
                // Add extra time to compensate for any startup delays
                // User starts counting when they click, so we need to capture from that moment
                const extraTime = 1.5; // Add 1.5 seconds to ensure we get the beginning
                const totalRecordTime = options.duration + extraTime;
                
                // Set auto-stop timer for duration + buffer time
                session.autoStopTimer = setTimeout(async () => {
                    console.log(`⏰ TRANSCRIPTION: Stopping after ${totalRecordTime}s (includes ${extraTime}s buffer)`);
                    
                    // Wait a moment to ensure all audio is written
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    // Process the recording
                    await this.processTimedRecording(session);
                    
                    // Stop the transcription
                    const stopResult = await this.stopTranscription(session.id);
                    
                    if (stopResult.success) {
                        console.log(`✅ TRANSCRIPTION: Timed session ${session.id} completed`);
                        
                        // Emit completion event  
                        this.emit('transcription-stopped', {
                            sessionId: session.id,
                            streamerId: session.streamerId,
                            duration: stopResult.duration,
                            wordCount: stopResult.wordCount,
                            timed: true,
                            autoStopped: true
                        });
                    }
                }, totalRecordTime * 1000);
                
                console.log(`⏲️ TRANSCRIPTION: Will record for ${totalRecordTime}s total`);
            } else {
                // Start periodic transcription processing for continuous mode
                this.startTranscriptionProcessing(session);
            }
            
            console.log(`🎧 TRANSCRIPTION: Session ${sessionId} ready with audio buffer`);
            
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
            
            console.log(`✅ TRANSCRIPTION: Started session ${sessionId} for ${effectiveStreamerId}`);
            
            return {
                success: true,
                sessionId: sessionId,
                startTime: session.startTime
            };
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to start:', error);
            return { success: false, error: error.message };
        }
    }
    
    async createAudioTransport() {
        try {
            const router = this.mediasoupService.router;
            if (!router) {
                throw new Error('MediaSoup router not available');
            }
            
            // Choose a dynamic port for FFmpeg to listen on (avoid conflicts)
            const ffmpegRtpPort = 5004 + Math.floor(Math.random() * 100) * 2;  // Even port for RTP
            const ffmpegRtcpPort = ffmpegRtpPort + 1;  // Odd port for RTCP
            
            const transport = await router.createPlainTransport({
                listenIp: {
                    ip: '0.0.0.0',
                    announcedIp: '127.0.0.1'
                },
                rtcpMux: false,
                comedia: false  // We specify the destination
            });
            
            console.log(`📡 TRANSCRIPTION: Plain transport created on port ${transport.tuple.localPort}`);
            
            // For comedia mode, we don't connect() - MediaSoup will auto-detect
            // But we still need to tell it where to send RTP for a consumer
            // Actually for Plain Transport consumers, we DO need to connect()
            await transport.connect({
                ip: '127.0.0.1',
                port: ffmpegRtpPort,
                rtcpPort: ffmpegRtcpPort
            });
            
            console.log(`🔗 TRANSCRIPTION: Connected transport to FFmpeg at 127.0.0.1:${ffmpegRtpPort}`);
            
            // Get the port that MediaSoup is listening on
            const { tuple } = transport;
            const audioPort = tuple.localPort;
            
            console.log(`📡 TRANSCRIPTION: Plain transport created`);
            console.log(`   Transport ID: ${transport.id}`);
            console.log(`   Listening on: ${tuple.localIp}:${audioPort}`);
            console.log(`   Forwarding RTP to: 127.0.0.1:${ffmpegRtpPort}`);
            console.log(`   Protocol: ${tuple.protocol}`);
            
            return { success: true, transport, ffmpegRtpPort, ffmpegRtcpPort };
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to create transport:', error);
            return { success: false, error: error.message };
        }
    }
    
    async createAudioConsumer(session, audioProducer) {
        try {
            const rtpCapabilities = {
                codecs: [
                    {
                        kind: 'audio',
                        mimeType: 'audio/opus',
                        clockRate: 48000,
                        channels: 2,
                        parameters: {},
                        rtcpFeedback: [
                            { type: 'transport-cc' }
                        ]
                    }
                ],
                headerExtensions: []
            };
            
            const consumer = await session.transport.consume({
                producerId: audioProducer.id,
                rtpCapabilities: rtpCapabilities,
                paused: true  // Keep paused until FFmpeg is ready
            });
            
            console.log(`🎬 TRANSCRIPTION: Consumer created (paused)`);
            // Don't resume yet - wait until after FFmpeg is set up
            
            console.log(`✅ TRANSCRIPTION: Audio consumer created for session ${session.id}`);
            console.log(`   Consumer ID: ${consumer.id}`);
            console.log(`   Consumer kind: ${consumer.kind}`);
            console.log(`   Consumer paused: ${consumer.paused}`);
            console.log(`   Consumer RTP parameters:`, JSON.stringify(consumer.rtpParameters, null, 2));
            
            // Monitor transport stats
            setTimeout(async () => {
                if (session.transport && !session.transport.closed) {
                    const stats = await session.transport.getStats();
                    console.log(`📊 TRANSCRIPTION: Transport stats after 2s:`, JSON.stringify(stats, null, 2));
                    
                    // Also check consumer stats
                    const consumerStats = await consumer.getStats();
                    console.log(`📊 TRANSCRIPTION: Consumer stats:`, JSON.stringify(consumerStats, null, 2));
                    
                    // Check transport tuple (connection info)
                    console.log(`🔗 TRANSCRIPTION: Transport tuple:`, session.transport.tuple);
                }
            }, 2000);
            
            return { success: true, consumer };
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to create consumer:', error);
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
                    console.log(`⚠️ TRANSCRIPTION: No buffer info available yet`);
                    return;
                }
                
                const currentDuration = bufferInfo.duration;
                const newAudioDuration = currentDuration - session.lastProcessedDuration;
                
                // Only process if we have at least 5 seconds of new audio
                if (newAudioDuration < session.processingInterval) {
                    console.log(`⏳ TRANSCRIPTION: Waiting for more audio (${newAudioDuration.toFixed(1)}s available)`);
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
                    console.log(`🎵 TRANSCRIPTION: Processing chunk ${session.chunkCount} (${extractResult.duration.toFixed(1)}s of new audio)`);
                    console.log(`   Processed up to: ${session.lastProcessedDuration.toFixed(1)}s`);
                    
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
                        
                        console.log(`📝 TRANSCRIPTION [${session.chunkCount}]: ${transcription.substring(0, 100)}...`);
                        
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
                        console.log(`⚠️ TRANSCRIPTION: Ignoring 'you' hallucination from chunk ${session.chunkCount}`);
                    }
                    
                    // Clean up extracted audio file
                    try {
                        if (fs.existsSync(extractResult.audioPath)) {
                            fs.unlinkSync(extractResult.audioPath);
                        }
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                } else {
                    console.log(`⚠️ TRANSCRIPTION: Could not extract audio: ${extractResult.error}`);
                }
                
            } catch (error) {
                console.error(`❌ TRANSCRIPTION: Error processing chunk:`, error);
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
    
    async saveAsWav(audioBuffer, outputPath) {
        // If the buffer is raw Opus data, decode it first using FFmpeg
        if (this.isOpusData(audioBuffer)) {
            console.log(`🎵 TRANSCRIPTION: Converting Opus to WAV using FFmpeg`);
            await this.convertOpusToWav(audioBuffer, outputPath);
        } else {
            // Assume PCM data - create WAV header
            const wavHeader = Buffer.alloc(44);
            
            // RIFF header
            wavHeader.write('RIFF', 0);
            wavHeader.writeUInt32LE(36 + audioBuffer.length, 4);
            wavHeader.write('WAVE', 8);
            
            // fmt chunk
            wavHeader.write('fmt ', 12);
            wavHeader.writeUInt32LE(16, 16); // fmt chunk size
            wavHeader.writeUInt16LE(1, 20); // PCM format
            wavHeader.writeUInt16LE(this.audioFormat.channels, 22);
            wavHeader.writeUInt32LE(this.audioFormat.sampleRate, 24);
            wavHeader.writeUInt32LE(this.audioFormat.sampleRate * this.audioFormat.channels * 2, 28); // byte rate
            wavHeader.writeUInt16LE(this.audioFormat.channels * 2, 32); // block align
            wavHeader.writeUInt16LE(16, 34); // bits per sample
            
            // data chunk
            wavHeader.write('data', 36);
            wavHeader.writeUInt32LE(audioBuffer.length, 40);
            
            // Write WAV file
            const wavData = Buffer.concat([wavHeader, audioBuffer]);
            fs.writeFileSync(outputPath, wavData);
        }
    }
    
    isOpusData(buffer) {
        // Heuristic: if buffer is larger than expected PCM (which would be much bigger)
        // and doesn't look like PCM patterns, assume it's Opus
        return buffer.length > 1000 && buffer.length < 200000;
    }
    
    async convertOpusToWav(opusBuffer, outputPath) {
        return new Promise((resolve, reject) => {
            const tempOpusPath = outputPath.replace('.wav', '.opus');
            
            try {
                // Write raw Opus data to temp file
                fs.writeFileSync(tempOpusPath, opusBuffer);
                
                // Use FFmpeg to convert Opus to WAV
                const ffmpegArgs = [
                    '-y', // Overwrite output
                    '-i', tempOpusPath,
                    '-ar', '16000',  // Whisper sample rate
                    '-ac', '1',      // Mono
                    '-f', 'wav',
                    outputPath
                ];
                
                const { spawn } = require('child_process');
                const ffmpeg = spawn('ffmpeg', ffmpegArgs);
                
                let stderr = '';
                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                ffmpeg.on('close', (code) => {
                    // Clean up temp file
                    try {
                        fs.unlinkSync(tempOpusPath);
                    } catch (e) {}
                    
                    if (code === 0 && fs.existsSync(outputPath)) {
                        console.log(`✅ TRANSCRIPTION: Converted Opus to WAV: ${outputPath}`);
                        resolve();
                    } else {
                        console.error(`❌ TRANSCRIPTION: FFmpeg failed: ${stderr}`);
                        reject(new Error(`FFmpeg conversion failed: ${stderr}`));
                    }
                });
                
                ffmpeg.on('error', reject);
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    async transcribeWithWhisperCpp(audioPath, config) {
        return new Promise((resolve, reject) => {
            const modelPath = path.join(this.config.whisperPath, 'models', `ggml-${config.model}.bin`);
            const whisperExe = this.isWindows 
                ? path.join(this.config.whisperPath, 'Release', 'whisper-cli.exe')
                : path.join(this.config.whisperPath, 'whisper.cpp', 'main');
            
            const args = [
                '-m', modelPath,
                '-f', audioPath,
                '-t', '4', // threads
                '--no-timestamps',
                '-otxt'
            ];
            
            if (config.language && config.language !== 'auto') {
                args.push('-l', config.language);
            }
            
            const whisperProcess = spawn(whisperExe, args);
            
            let output = '';
            whisperProcess.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            whisperProcess.on('close', (code) => {
                if (code === 0) {
                    // Read the output text file
                    const txtPath = audioPath + '.txt';
                    if (fs.existsSync(txtPath)) {
                        const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                        fs.unlinkSync(txtPath);
                        resolve(transcription);
                    } else {
                        resolve(output.trim());
                    }
                } else {
                    reject(new Error(`Whisper process exited with code ${code}`));
                }
            });
            
            whisperProcess.on('error', reject);
        });
    }
    
    // Removed demo transcription - using real audio only
    
    async transcribeWithNodeWhisper(audioPath, config) {
        // Use whisper.cpp on Windows
        console.log('🎙️ TRANSCRIPTION: Using whisper.cpp for transcription');
        console.log(`   Audio file: ${audioPath}`);
        console.log(`   Model: ${config.model}`);
        console.log(`   Language: ${config.language}`);
        
        try {
            // Use the same whisper.cpp method
            const result = await this.transcribeWithWhisperCpp(audioPath, config);
            console.log(`📝 TRANSCRIPTION: Result: "${result}"`);
            return result;
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Whisper.cpp failed:', error);
            // Return empty string instead of demo text
            return '';
        }
    }
    
    async stopTranscription(sessionId) {
        console.log(`🛑 TRANSCRIPTION: Stopping session ${sessionId}`);
        
        const session = this.activeSessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }
        
        session.status = 'stopping';
        session.endTime = new Date();
        
        // Process any remaining audio in buffer
        if (session.audioBuffer.length > 0) {
            await this.processAudioChunk(session, session.audioBuffer);
        }
        
        // Cleanup session
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
            totalWords: session.wordCount,
            duration: session.endTime - session.startTime
        });
        
        console.log(`✅ TRANSCRIPTION: Stopped session ${sessionId}`);
        
        return {
            success: true,
            sessionId: sessionId,
            duration: session.endTime - session.startTime,
            wordCount: session.wordCount
        };
    }
    
    async cleanupSession(session) {
        try {
            console.log(`🧹 TRANSCRIPTION: Cleaning up session ${session.id}`);
            
            // Clear auto-stop timer if it exists
            if (session.autoStopTimer) {
                clearTimeout(session.autoStopTimer);
                console.log(`✅ TRANSCRIPTION: Cleared auto-stop timer`);
            }
            
            // Stop transcription processing interval
            if (session.transcriptionInterval) {
                clearInterval(session.transcriptionInterval);
                console.log(`✅ TRANSCRIPTION: Stopped transcription interval`);
            }
            
            // Stop audio buffering
            if (this.audioBufferService) {
                await this.audioBufferService.stopBuffering(session.id);
                console.log(`✅ TRANSCRIPTION: Stopped audio buffering`);
            }
            
            // Stop FFmpeg process if it exists (legacy)
            if (session.ffmpegProcess) {
                session.ffmpegProcess.kill('SIGTERM');
            }
            
            // Close consumer
            if (session.consumer && !session.consumer.closed) {
                session.consumer.close();
            }
            
            // Close transport
            if (session.transport && !session.transport.closed) {
                session.transport.close();
            }
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Error during cleanup:', error);
        }
    }
    
    // Database methods
    async saveTranscriptionToDatabase(session) {
        try {
            const sql = `
                INSERT INTO transcriptions (
                    id, stream_id, streamer_id, start_time, 
                    language, model, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            await this.runAsync(sql, [
                session.id,
                session.id, // Using session ID as stream ID for now
                session.streamerId,
                session.startTime.toISOString(),
                session.config.language || 'auto',
                session.config.model,
                session.status,
                new Date().toISOString()
            ]);
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to save to database:', error);
        }
    }
    
    async saveTranscriptionChunk(session, text, chunkNumber) {
        try {
            const sql = `
                INSERT INTO transcription_chunks (
                    transcription_id, chunk_number, text, 
                    timestamp, word_count
                ) VALUES (?, ?, ?, ?, ?)
            `;
            
            await this.runAsync(sql, [
                session.id,
                chunkNumber,
                text,
                new Date().toISOString(),
                text.split(/\s+/).length
            ]);
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to save chunk to database:', error);
        }
    }
    
    async updateTranscriptionInDatabase(session) {
        try {
            const duration = session.endTime 
                ? Math.floor((session.endTime - session.startTime) / 1000)
                : 0;
            
            const sql = `
                UPDATE transcriptions 
                SET end_time = ?, duration = ?, word_count = ?, status = ?
                WHERE id = ?
            `;
            
            await this.runAsync(sql, [
                session.endTime?.toISOString(),
                duration,
                session.wordCount,
                session.status,
                session.id
            ]);
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to update database:', error);
        }
    }
    
    async getTranscription(sessionId) {
        try {
            const sql = `
                SELECT t.*, GROUP_CONCAT(tc.text, ' ') as full_text
                FROM transcriptions t
                LEFT JOIN transcription_chunks tc ON t.id = tc.transcription_id
                WHERE t.id = ?
                GROUP BY t.id
            `;
            
            const result = await this.getAsync(sql, [sessionId]);
            return result;
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to get transcription:', error);
            return null;
        }
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
        try {
            let sql = `
                SELECT t.*, 
                       COUNT(tc.id) as chunk_count,
                       GROUP_CONCAT(tc.text, ' ') as full_text
                FROM transcriptions t
                LEFT JOIN transcription_chunks tc ON t.id = tc.transcription_id
                WHERE 1=1
            `;
            
            const params = [];
            
            // Add filters
            if (filters.status) {
                sql += ' AND t.status = ?';
                params.push(filters.status);
            }
            
            if (filters.streamerId) {
                sql += ' AND t.streamer_id = ?';
                params.push(filters.streamerId);
            }
            
            if (filters.startDate) {
                sql += ' AND DATE(t.start_time) >= DATE(?)';
                params.push(filters.startDate);
            }
            
            if (filters.endDate) {
                sql += ' AND DATE(t.start_time) <= DATE(?)';
                params.push(filters.endDate);
            }
            
            sql += `
                GROUP BY t.id
                ORDER BY t.created_at DESC
                LIMIT ? OFFSET ?
            `;
            
            params.push(limit, offset);
            
            const transcriptions = await this.allAsync(sql, params);
            
            // Get total count for pagination
            const countSql = `
                SELECT COUNT(DISTINCT id) as total 
                FROM transcriptions 
                WHERE 1=1
                ${filters.status ? ' AND status = ?' : ''}
                ${filters.streamerId ? ' AND streamer_id = ?' : ''}
                ${filters.startDate ? ' AND DATE(start_time) >= DATE(?)' : ''}
                ${filters.endDate ? ' AND DATE(start_time) <= DATE(?)' : ''}
            `;
            
            const countParams = params.slice(0, -2); // Remove limit and offset
            const countResult = await this.getAsync(countSql, countParams);
            
            return {
                transcriptions: transcriptions || [],
                total: countResult?.total || 0,
                limit,
                offset
            };
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to get history:', error);
            return {
                transcriptions: [],
                total: 0,
                limit,
                offset
            };
        }
    }
    
    async deleteOldTranscriptions(daysOld = 30) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);
            
            const sql = `
                DELETE FROM transcriptions 
                WHERE created_at < ? AND status = 'completed'
            `;
            
            const result = await this.runAsync(sql, [cutoffDate.toISOString()]);
            
            return {
                success: true,
                deletedCount: result.changes
            };
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to delete old transcriptions:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Configuration methods
    enableTranscription() {
        this.config.enableTranscription = true;
        console.log('✅ TRANSCRIPTION: Enabled');
    }
    
    disableTranscription() {
        this.config.enableTranscription = false;
        console.log('⏸️ TRANSCRIPTION: Disabled');
    }
    
    setModel(model) {
        const validModels = ['tiny', 'base', 'small', 'medium', 'large'];
        if (validModels.includes(model)) {
            this.config.model = model;
            console.log(`✅ TRANSCRIPTION: Model set to ${model}`);
        } else {
            console.error(`❌ TRANSCRIPTION: Invalid model ${model}`);
        }
    }
    
    setLanguage(language) {
        this.config.language = language;
        console.log(`✅ TRANSCRIPTION: Language set to ${language || 'auto'}`);
    }
    
    async startTimedTranscription(streamerId, duration = 30, options = {}) {
        console.log(`⏱️ TRANSCRIPTION: Starting timed transcription for ${streamerId} (${duration}s)`);
        
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
                console.log(`✅ TRANSCRIPTION: Timed session ${sessionId} is recording for ${duration}s`);
            }
            
            return result;
            
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Failed to start timed transcription:', error);
            return { success: false, error: error.message };
        }
    }
    
    async processTimedRecording(session) {
        try {
            console.log(`🎵 TRANSCRIPTION: Processing complete ${session.timedDuration}s recording`);
            
            // Get current buffer info
            const bufferInfo = await this.audioBufferService.getBufferInfo(session.id);
            if (!bufferInfo) {
                console.error(`❌ TRANSCRIPTION: No buffer info available`);
                return;
            }
            
            const recordingEndPosition = bufferInfo.duration;
            
            // Extract the requested duration from the BEGINNING of the buffer
            // We recorded extra time to ensure we capture everything
            const targetDuration = Math.min(recordingEndPosition, session.timedDuration);
            
            console.log(`📊 TRANSCRIPTION: Extracting recording:`);
            console.log(`   Buffer contains: ${recordingEndPosition.toFixed(1)}s total`);
            console.log(`   Requested duration: ${session.timedDuration}s`);
            console.log(`   Extracting first: ${targetDuration.toFixed(1)}s`);
            
            // Extract from the beginning of the recording
            const extractResult = await this.audioBufferService.extractAudioRange(
                session.id,
                0,  // Start from the beginning
                targetDuration  // Extract up to the requested duration
            );
            
            if (!extractResult.success) {
                console.error(`❌ TRANSCRIPTION: Failed to extract audio: ${extractResult.error}`);
                return;
            }
            
            console.log(`📝 TRANSCRIPTION: Transcribing ${extractResult.duration.toFixed(1)}s of audio...`);
            
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
                
                console.log(`✅ TRANSCRIPTION: Complete transcription (${session.wordCount} words)`);
                
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
                console.log(`⚠️ TRANSCRIPTION: Ignoring 'you' hallucination`);
            } else {
                console.log(`⚠️ TRANSCRIPTION: No speech detected in recording`);
            }
            
            // Clean up extracted audio file
            try {
                if (fs.existsSync(extractResult.audioPath)) {
                    fs.unlinkSync(extractResult.audioPath);
                }
            } catch (e) {
                // Ignore cleanup errors
            }
            
        } catch (error) {
            console.error(`❌ TRANSCRIPTION: Error processing timed recording:`, error);
        }
    }
    
    async cleanupInstantSession(session) {
        try {
            if (session.consumer && !session.consumer.closed) {
                session.consumer.close();
            }
            if (session.transport && !session.transport.closed) {
                session.transport.close();
            }
        } catch (error) {
            console.error('❌ TRANSCRIPTION: Error cleaning up instant session:', error);
        }
    }
}

module.exports = TranscriptionService;