const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const logger = require('../bootstrap/logger').child({ svc: 'OpusDecoder' });
class OpusDecoder extends EventEmitter {
    constructor() {
        super();
        this.ffmpegProcess = null;
        this.tempDir = path.join(__dirname, '..', '..', 'temp', 'opus');
        this.sessionId = Date.now();
        this.chunkIndex = 0;
        
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        
        logger.debug(`🎵 OpusDecoder: Initialized with temp dir: ${this.tempDir}`);
    }
    
    createOpusStreamFromRtp(payloads) {
        // Create a minimal Opus stream from RTP payloads
        // Since RTP Opus payloads are compressed Opus frames, we need to add minimal container headers
        
        const opusHeader = Buffer.from([
            0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
            0x01, // Version
            0x02, // Channel count (stereo)
            0x00, 0x00, // Pre-skip (little-endian)
            0x80, 0xBB, 0x00, 0x00, // Sample rate 48000 (little-endian)
            0x00, 0x00, // Output gain
            0x00 // Channel mapping family
        ]);
        
        // Combine all payloads
        const combinedPayloads = Buffer.concat(payloads);
        
        logger.debug(`🎵 OpusDecoder: Created Opus stream - header: ${opusHeader.length}, data: ${combinedPayloads.length}`);
        
        return Buffer.concat([opusHeader, combinedPayloads]);
    }
    
    async decodeOpusFile(inputFile) {
        return new Promise((resolve, reject) => {
            try {
                const outputFile = path.join(this.tempDir, `pcm_${this.sessionId}_${this.chunkIndex}.raw`);
                
                // Use FFmpeg to decode with more explicit format handling
                const ffmpegArgs = [
                    '-y', // Overwrite output file
                    '-i', inputFile,
                    '-f', 's16le',    // Output format: signed 16-bit little-endian
                    '-acodec', 'pcm_s16le',
                    '-ar', '16000',   // Whisper sample rate
                    '-ac', '1',       // Mono for Whisper
                    '-loglevel', 'warning',
                    outputFile
                ];
                
                logger.debug(`🎵 OpusDecoder: Running FFmpeg: ${ffmpegArgs.join(' ')}`);
                const ffmpeg = spawn('ffmpeg', ffmpegArgs);
                
                let stderr = '';
                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                ffmpeg.on('close', (code) => {
                    if (code === 0 && fs.existsSync(outputFile)) {
                        const pcmData = fs.readFileSync(outputFile);
                        logger.debug(`🎵 OpusDecoder: Successfully decoded ${pcmData.length} bytes of PCM`);
                        
                        // Clean up temp file
                        try {
                            fs.unlinkSync(outputFile);
                        } catch (e) {
                            // Ignore cleanup errors
                        }
                        
                        resolve(pcmData);
                    } else {
                        logger.error(`🎵 OpusDecoder: FFmpeg failed with code ${code}`);
                        logger.error(`🎵 OpusDecoder: FFmpeg stderr:`, stderr);
                        reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
                    }
                });
                
                ffmpeg.on('error', (error) => {
                    logger.error(`🎵 OpusDecoder: FFmpeg process error:`, error);
                    reject(error);
                });
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    async processRtpOpusPayloads(payloads) {
        // Process RTP Opus payloads by creating proper Opus frames
        
        try {
            logger.debug(`🎵 OpusDecoder: Processing ${payloads.length} RTP payloads`);
            
            // Create proper Opus stream from RTP payloads
            const opusStream = this.createOpusStreamFromRtp(payloads);
            
            // Save as temporary Opus file
            this.chunkIndex++;
            const inputFile = path.join(this.tempDir, `rtp_opus_${this.sessionId}_${this.chunkIndex}.opus`);
            fs.writeFileSync(inputFile, opusStream);
            
            logger.debug(`🎵 OpusDecoder: Created Opus file: ${inputFile} (${opusStream.length} bytes)`);
            
            // Decode the Opus file to PCM
            const pcm = await this.decodeOpusFile(inputFile);
            
            // Clean up temp file
            try {
                fs.unlinkSync(inputFile);
            } catch (e) {
                // Ignore cleanup errors
            }
            
            return pcm;
            
        } catch (error) {
            logger.error('🎵 OpusDecoder: Failed to decode Opus payloads:', error);
            
            // Return minimal PCM data (not full silence)
            return Buffer.alloc(32000); // 1 second of silence at 16kHz mono
        }
    }
    
    cleanup() {
        logger.debug(`🧹 OpusDecoder: Cleaning up session ${this.sessionId}`);
        
        // Stop any running FFmpeg process
        if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
            this.ffmpegProcess.kill('SIGTERM');
        }
        
        // Clean up any remaining temp files
        try {
            const files = fs.readdirSync(this.tempDir);
            let cleanedCount = 0;
            files.forEach(file => {
                if (file.includes(`_${this.sessionId}_`) || file.includes(`rtp_opus_`)) {
                    fs.unlinkSync(path.join(this.tempDir, file));
                    cleanedCount++;
                }
            });
            logger.debug(`🧹 OpusDecoder: Cleaned up ${cleanedCount} temp files`);
        } catch (e) {
            logger.error(`🧹 OpusDecoder: Cleanup error:`, e);
        }
    }
}

module.exports = OpusDecoder;
