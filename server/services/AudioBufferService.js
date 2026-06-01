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
}

module.exports = AudioBufferService;
