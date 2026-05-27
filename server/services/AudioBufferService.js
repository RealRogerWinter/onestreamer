const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const logger = require('../bootstrap/logger').child({ svc: 'AudioBufferService' });

class AudioBufferService extends EventEmitter {
    constructor() {
        super();
        
        // Configuration
        this.config = {
            bufferDuration: 60, // Keep 60 seconds of audio in buffer
            sampleRate: 16000,   // Whisper-compatible sample rate
            channels: 1,         // Mono for Whisper
            bitDepth: 16,        // 16-bit PCM
            format: 'wav'        // Output format
        };
        
        // Calculate buffer size in bytes
        // Formula: sampleRate * channels * (bitDepth/8) * duration
        this.bytesPerSecond = this.config.sampleRate * this.config.channels * 2; // 2 bytes for 16-bit
        this.maxBufferSize = this.bytesPerSecond * this.config.bufferDuration;
        
        // Active sessions
        this.sessions = new Map();
        
        // Paths
        this.bufferDir = path.join(__dirname, '..', '..', 'audio-buffers');
        this.tempDir = path.join(__dirname, '..', '..', 'temp', 'audio');
        
        // Initialize directories
        this.initializeDirectories();
        
        logger.debug('🎵 AudioBufferService: Initialized');
        logger.debug(`   Buffer duration: ${this.config.bufferDuration}s`);
        logger.debug(`   Sample rate: ${this.config.sampleRate}Hz`);
        logger.debug(`   Max buffer size: ${(this.maxBufferSize / 1024 / 1024).toFixed(2)}MB`);
    }
    
    initializeDirectories() {
        [this.bufferDir, this.tempDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }
    
    async startBuffering(sessionId, transport, audioConsumer, ffmpegRtpPort, ffmpegRtcpPort) {
        logger.debug(`🎵 AudioBufferService: Starting buffering for session ${sessionId}`);
        logger.debug(`   FFmpeg will listen on ports: RTP=${ffmpegRtpPort}, RTCP=${ffmpegRtcpPort}`);
        
        if (this.sessions.has(sessionId)) {
            logger.warn(`⚠️ AudioBufferService: Session ${sessionId} already exists`);
            return { success: false, error: 'Session already exists' };
        }
        
        try {
            const session = {
                id: sessionId,
                startTime: new Date(),
                bufferFile: path.join(this.bufferDir, `${sessionId}.wav`),
                ffmpegProcess: null,
                ffmpegRtpPort: ffmpegRtpPort,
                ffmpegRtcpPort: ffmpegRtcpPort,
                transport: transport,
                consumer: audioConsumer,
                bytesWritten: 0,
                isActive: true,
                lastExtraction: Date.now(),
                extractionCount: 0
            };
            
            // Start FFmpeg process to capture audio
            const ffmpegResult = await this.startFFmpegCapture(session, transport, audioConsumer);
            if (!ffmpegResult.success) {
                return { success: false, error: ffmpegResult.error };
            }
            
            session.ffmpegProcess = ffmpegResult.process;
            this.sessions.set(sessionId, session);
            
            // Monitor buffer growth
            this.startBufferMonitoring(session);
            
            logger.debug(`✅ AudioBufferService: Started buffering for ${sessionId}`);
            return { 
                success: true, 
                sessionId, 
                bufferFile: session.bufferFile 
            };
            
        } catch (error) {
            logger.error(`❌ AudioBufferService: Failed to start buffering:`, error);
            return { success: false, error: error.message };
        }
    }
    
    async startFFmpegCapture(session, transport, audioConsumer) {
        return new Promise((resolve) => {
            try {
                // Get RTP parameters from consumer
                const rtpParams = audioConsumer.rtpParameters;
                const audioCodec = rtpParams.codecs[0];
                const payloadType = audioCodec.payloadType;
                
                // Use the FFmpeg listening port that MediaSoup is configured to send to
                const ffmpegRtpPort = session.ffmpegRtpPort;
                
                logger.debug(`🎬 AudioBufferService: Starting FFmpeg capture`);
                logger.debug(`   FFmpeg RTP Port: ${ffmpegRtpPort}`);
                logger.debug(`   MediaSoup sending from: ${transport.tuple.localIp}:${transport.tuple.localPort}`);
                logger.debug(`   Codec: ${audioCodec.mimeType}`);
                logger.debug(`   Payload Type: ${payloadType}`);
                
                // Create SDP file for FFmpeg to listen on the correct port
                const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=AudioBuffer
c=IN IP4 127.0.0.1
t=0 0
m=audio ${ffmpegRtpPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} opus/48000/2
a=fmtp:${payloadType} minptime=10;useinbandfec=1
`;
                
                const sdpPath = path.join(this.tempDir, `${session.id}.sdp`);
                fs.writeFileSync(sdpPath, sdpContent);
                
                // FFmpeg command to capture audio and convert to WAV
                const ffmpegArgs = [
                    '-protocol_whitelist', 'file,udp,rtp',
                    '-f', 'sdp',
                    '-i', sdpPath,
                    '-ar', String(this.config.sampleRate),  // 16kHz for Whisper
                    '-ac', String(this.config.channels),    // Mono
                    '-f', 'wav',
                    '-y',
                    session.bufferFile
                ];
                
                logger.debug(`🚀 AudioBufferService: FFmpeg command:`, 'ffmpeg', ffmpegArgs.join(' '));
                
                const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
                
                let startupError = null;
                let outputBuffer = '';
                
                ffmpegProcess.stderr.on('data', (data) => {
                    const message = data.toString();
                    outputBuffer += message;
                    
                    // Log FFmpeg output for debugging
                    if (message.includes('Error') || message.includes('Failed')) {
                        logger.error(`❌ FFmpeg:`, message);
                        if (!startupError) {
                            startupError = message;
                        }
                    } else if (message.includes('Stream #') || message.includes('Output #')) {
                        logger.debug(`📹 FFmpeg:`, message.trim());
                    }
                });
                
                ffmpegProcess.on('error', (error) => {
                    logger.error(`❌ AudioBufferService: FFmpeg process error:`, error);
                    resolve({ success: false, error: error.message });
                });
                
                // Give FFmpeg a moment to start and check if it's running
                setTimeout(() => {
                    if (!ffmpegProcess.killed) {
                        // Check if file is being created
                        if (fs.existsSync(session.bufferFile)) {
                            logger.debug(`✅ AudioBufferService: FFmpeg is running and writing to ${session.bufferFile}`);
                            resolve({ success: true, process: ffmpegProcess });
                        } else if (startupError) {
                            ffmpegProcess.kill();
                            resolve({ success: false, error: startupError });
                        } else {
                            // File might take a moment to appear - check again quickly
                            setTimeout(() => {
                                if (fs.existsSync(session.bufferFile)) {
                                    resolve({ success: true, process: ffmpegProcess });
                                } else {
                                    // Don't kill FFmpeg yet, just resolve success for faster startup
                                    logger.debug(`⏳ AudioBufferService: FFmpeg started, buffer file pending`);
                                    resolve({ success: true, process: ffmpegProcess });
                                }
                            }, 500); // Reduced from 2000ms for faster response
                        }
                    } else {
                        resolve({ success: false, error: 'FFmpeg process died immediately' });
                    }
                }, 500); // Reduced from 1000ms for faster startup
                
            } catch (error) {
                logger.error(`❌ AudioBufferService: Failed to start FFmpeg:`, error);
                resolve({ success: false, error: error.message });
            }
        });
    }
    
    startBufferMonitoring(session) {
        // Monitor buffer file growth and manage circular buffer
        session.monitorInterval = setInterval(() => {
            if (!session.isActive) {
                clearInterval(session.monitorInterval);
                return;
            }
            
            try {
                if (fs.existsSync(session.bufferFile)) {
                    const stats = fs.statSync(session.bufferFile);
                    const oldSize = session.bytesWritten;
                    session.bytesWritten = stats.size;
                    
                    // Calculate growth rate
                    const growthRate = session.bytesWritten - oldSize;
                    const duration = Math.floor(session.bytesWritten / this.bytesPerSecond);
                    
                    if (growthRate > 0) {
                        logger.debug(`📊 AudioBufferService: Buffer ${session.id}`);
                        logger.debug(`   Size: ${(session.bytesWritten / 1024).toFixed(2)}KB`);
                        logger.debug(`   Duration: ${duration}s`);
                        logger.debug(`   Growth: ${(growthRate / 1024).toFixed(2)}KB/s`);
                        
                        this.emit('buffer-update', {
                            sessionId: session.id,
                            size: session.bytesWritten,
                            duration: duration,
                            growthRate: growthRate
                        });
                    }
                    
                    // Implement circular buffer if size exceeds max
                    if (session.bytesWritten > this.maxBufferSize) {
                        logger.debug(`⚠️ AudioBufferService: Buffer size exceeded, implementing circular buffer`);
                        this.trimBuffer(session);
                    }
                }
            } catch (error) {
                logger.error(`❌ AudioBufferService: Monitor error:`, error);
            }
        }, 2000); // Check every 2 seconds
    }
    
    async trimBuffer(session) {
        // For now, we'll restart the FFmpeg process to keep it simple
        // In production, you might want to implement a proper circular buffer
        logger.debug(`🔄 AudioBufferService: Trimming buffer for ${session.id}`);
        
        try {
            // Extract the last N seconds before trimming
            const extractResult = await this.extractLastNSeconds(session.id, this.config.bufferDuration - 10);
            
            if (extractResult.success) {
                // Stop current FFmpeg
                if (session.ffmpegProcess) {
                    session.ffmpegProcess.kill('SIGTERM');
                }
                
                // Move trimmed file to buffer location
                fs.renameSync(extractResult.audioPath, session.bufferFile);
                
                // Restart FFmpeg to append to the trimmed file
                // Note: This is simplified - in production you'd handle this more gracefully
                logger.debug(`✅ AudioBufferService: Buffer trimmed successfully`);
            }
        } catch (error) {
            logger.error(`❌ AudioBufferService: Failed to trim buffer:`, error);
        }
    }
    
    async extractLastNSeconds(sessionId, seconds = 30) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }
        
        if (!fs.existsSync(session.bufferFile)) {
            return { success: false, error: 'Buffer file not found' };
        }
        
        try {
            const stats = fs.statSync(session.bufferFile);
            const fileSizeBytes = stats.size;
            
            // WAV header is 44 bytes
            const wavHeaderSize = 44;
            const audioDataSize = fileSizeBytes - wavHeaderSize;
            
            if (audioDataSize <= 0) {
                return { success: false, error: 'Buffer file too small' };
            }
            
            // Calculate how many bytes we need for N seconds
            const bytesNeeded = seconds * this.bytesPerSecond;
            const bytesToExtract = Math.min(bytesNeeded, audioDataSize);
            const secondsToExtract = bytesToExtract / this.bytesPerSecond;
            
            session.extractionCount++;
            const outputPath = path.join(this.tempDir, `${sessionId}_extract_${session.extractionCount}.wav`);
            
            logger.debug(`🎯 AudioBufferService: Extracting last ${secondsToExtract.toFixed(1)}s from buffer`);
            logger.debug(`   Buffer size: ${(fileSizeBytes / 1024).toFixed(2)}KB`);
            logger.debug(`   Extracting: ${(bytesToExtract / 1024).toFixed(2)}KB`);
            
            // Use FFmpeg to extract the last N seconds
            return new Promise((resolve) => {
                // Calculate start time based on file duration
                const totalDuration = audioDataSize / this.bytesPerSecond;
                const startTime = Math.max(0, totalDuration - seconds);
                
                const ffmpegArgs = [
                    '-i', session.bufferFile,
                    '-ss', String(startTime),  // Start time in seconds
                    '-t', String(secondsToExtract), // Duration to extract
                    '-ar', String(this.config.sampleRate),
                    '-ac', String(this.config.channels),
                    '-f', 'wav',
                    '-y',
                    outputPath
                ];
                
                const ffmpeg = spawn('ffmpeg', ffmpegArgs);
                
                ffmpeg.on('close', (code) => {
                    if (code === 0 && fs.existsSync(outputPath)) {
                        const extractStats = fs.statSync(outputPath);
                        logger.debug(`✅ AudioBufferService: Extracted ${(extractStats.size / 1024).toFixed(2)}KB audio`);
                        
                        resolve({
                            success: true,
                            audioPath: outputPath,
                            duration: secondsToExtract,
                            size: extractStats.size
                        });
                    } else {
                        logger.error(`❌ AudioBufferService: FFmpeg extraction failed with code ${code}`);
                        resolve({ success: false, error: `FFmpeg failed with code ${code}` });
                    }
                });
                
                ffmpeg.on('error', (error) => {
                    logger.error(`❌ AudioBufferService: FFmpeg error:`, error);
                    resolve({ success: false, error: error.message });
                });
            });
            
        } catch (error) {
            logger.error(`❌ AudioBufferService: Extraction error:`, error);
            return { success: false, error: error.message };
        }
    }
    
    async getBufferInfo(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        
        if (!fs.existsSync(session.bufferFile)) {
            return { duration: 0, size: 0 };
        }
        
        try {
            const stats = fs.statSync(session.bufferFile);
            const audioDataSize = Math.max(0, stats.size - 44); // Subtract WAV header
            const duration = audioDataSize / this.bytesPerSecond;
            
            return {
                duration: duration,
                size: stats.size,
                audioSize: audioDataSize
            };
        } catch (error) {
            logger.error(`❌ AudioBufferService: Error getting buffer info:`, error);
            return { duration: 0, size: 0 };
        }
    }
    
    async extractAudioRange(sessionId, startSeconds, endSeconds) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }
        
        if (!fs.existsSync(session.bufferFile)) {
            return { success: false, error: 'Buffer file not found' };
        }
        
        try {
            const stats = fs.statSync(session.bufferFile);
            const audioDataSize = Math.max(0, stats.size - 44);
            const totalDuration = audioDataSize / this.bytesPerSecond;
            
            // Validate range
            if (startSeconds < 0 || startSeconds >= totalDuration) {
                return { success: false, error: 'Invalid start time' };
            }
            
            if (endSeconds <= startSeconds) {
                return { success: false, error: 'End time must be after start time' };
            }
            
            // Clamp end time to available duration
            const actualEnd = Math.min(endSeconds, totalDuration);
            const extractDuration = actualEnd - startSeconds;
            
            session.extractionCount++;
            const outputPath = path.join(this.tempDir, `${sessionId}_extract_${session.extractionCount}.wav`);
            
            logger.debug(`🎯 AudioBufferService: Extracting audio range ${startSeconds.toFixed(1)}s - ${actualEnd.toFixed(1)}s`);
            logger.debug(`   Duration: ${extractDuration.toFixed(1)}s`);
            
            // Use FFmpeg to extract the specified range
            return new Promise((resolve) => {
                const ffmpegArgs = [
                    '-i', session.bufferFile,
                    '-ss', String(startSeconds),  // Start time in seconds
                    '-t', String(extractDuration), // Duration to extract
                    '-ar', String(this.config.sampleRate),
                    '-ac', String(this.config.channels),
                    '-f', 'wav',
                    '-y',
                    outputPath
                ];
                
                const ffmpeg = spawn('ffmpeg', ffmpegArgs);
                
                let stderr = '';
                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                ffmpeg.on('close', (code) => {
                    if (code === 0 && fs.existsSync(outputPath)) {
                        const extractedStats = fs.statSync(outputPath);
                        logger.debug(`✅ AudioBufferService: Extracted ${(extractedStats.size / 1024).toFixed(2)}KB`);
                        
                        resolve({
                            success: true,
                            audioPath: outputPath,
                            duration: extractDuration,
                            startTime: startSeconds,
                            endTime: actualEnd
                        });
                    } else {
                        logger.error(`❌ AudioBufferService: FFmpeg extraction failed:`, stderr);
                        resolve({
                            success: false,
                            error: `FFmpeg failed with code ${code}`
                        });
                    }
                });
                
                ffmpeg.on('error', (error) => {
                    logger.error(`❌ AudioBufferService: FFmpeg error:`, error);
                    resolve({
                        success: false,
                        error: error.message
                    });
                });
            });
        } catch (error) {
            logger.error(`❌ AudioBufferService: Extract range error:`, error);
            return { success: false, error: error.message };
        }
    }
    
    async stopBuffering(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }
        
        logger.debug(`🛑 AudioBufferService: Stopping buffering for ${sessionId}`);
        
        session.isActive = false;
        
        // Stop monitoring
        if (session.monitorInterval) {
            clearInterval(session.monitorInterval);
        }
        
        // Stop FFmpeg process
        if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
            session.ffmpegProcess.kill('SIGTERM');
            
            // Give it a moment to terminate gracefully
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            if (!session.ffmpegProcess.killed) {
                session.ffmpegProcess.kill('SIGKILL');
            }
        }
        
        // Clean up buffer file
        try {
            if (fs.existsSync(session.bufferFile)) {
                fs.unlinkSync(session.bufferFile);
            }
            
            // Clean up SDP file
            const sdpPath = path.join(this.tempDir, `${sessionId}.sdp`);
            if (fs.existsSync(sdpPath)) {
                fs.unlinkSync(sdpPath);
            }
        } catch (error) {
            logger.error(`⚠️ AudioBufferService: Error cleaning up files:`, error);
        }
        
        this.sessions.delete(sessionId);
        
        logger.debug(`✅ AudioBufferService: Stopped buffering for ${sessionId}`);
        return { success: true };
    }
    
    getSessionInfo(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        
        return {
            id: session.id,
            startTime: session.startTime,
            bytesWritten: session.bytesWritten,
            duration: Math.floor(session.bytesWritten / this.bytesPerSecond),
            isActive: session.isActive,
            extractionCount: session.extractionCount
        };
    }
    
    getAllSessions() {
        const sessions = [];
        for (const [id, session] of this.sessions) {
            sessions.push(this.getSessionInfo(id));
        }
        return sessions;
    }
}

module.exports = AudioBufferService;
