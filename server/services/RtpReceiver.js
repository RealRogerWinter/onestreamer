const dgram = require('dgram');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class RtpReceiver extends EventEmitter {
    constructor(port, options = {}) {
        super();
        this.port = port;
        this.socket = null;
        this.ffmpegProcess = null;
        this.audioBuffer = Buffer.alloc(0);
        this.packetsReceived = 0;
        this.bytesReceived = 0;
        this.isRunning = false;
        
        this.options = {
            sampleRate: options.sampleRate || 48000,
            channels: options.channels || 2,
            ...options
        };
    }
    
    async start() {
        return new Promise((resolve, reject) => {
            try {
                // Create UDP socket to receive RTP packets
                this.socket = dgram.createSocket('udp4');
                
                this.socket.on('message', (msg, rinfo) => {
                    this.handleRtpPacket(msg, rinfo);
                });
                
                this.socket.on('error', (err) => {
                    console.error(`❌ RTP Receiver socket error:`, err);
                    this.emit('error', err);
                    reject(err);
                });
                
                this.socket.on('listening', () => {
                    const address = this.socket.address();
                    console.log(`📡 RTP Receiver listening on ${address.address}:${address.port}`);
                    this.isRunning = true;
                    
                    // Start FFmpeg process to decode Opus
                    this.startFfmpeg();
                    resolve(address.port);
                });
                
                // Bind to the specified port
                this.socket.bind(this.port, '0.0.0.0');
                
            } catch (error) {
                console.error(`❌ RTP Receiver failed to start:`, error);
                reject(error);
            }
        });
    }
    
    handleRtpPacket(packet, rinfo) {
        this.packetsReceived++;
        this.bytesReceived += packet.length;
        
        // Extract RTP header (first 12 bytes minimum)
        if (packet.length < 12) {
            console.warn(`⚠️ RTP packet too small: ${packet.length} bytes`);
            return;
        }
        
        // Parse RTP header
        const version = (packet[0] >> 6) & 0x03;
        const padding = (packet[0] >> 5) & 0x01;
        const extension = (packet[0] >> 4) & 0x01;
        const csrcCount = packet[0] & 0x0F;
        const marker = (packet[1] >> 7) & 0x01;
        const payloadType = packet[1] & 0x7F;
        const sequenceNumber = packet.readUInt16BE(2);
        const timestamp = packet.readUInt32BE(4);
        const ssrc = packet.readUInt32BE(8);
        
        // Calculate header length
        let headerLength = 12 + (csrcCount * 4);
        
        // Handle extension if present
        if (extension) {
            if (packet.length < headerLength + 4) {
                console.warn(`⚠️ RTP packet with extension too small`);
                return;
            }
            const extensionLength = packet.readUInt16BE(headerLength + 2) * 4;
            headerLength += 4 + extensionLength;
        }
        
        // Extract payload (Opus audio data)
        const payload = packet.slice(headerLength);
        
        // Log periodically
        if (this.packetsReceived % 100 === 0) {
            console.log(`📊 RTP Receiver: ${this.packetsReceived} packets, ${this.bytesReceived} bytes, seq: ${sequenceNumber}`);
        }
        
        // Accumulate Opus payloads
        if (this.opusBuffer) {
            this.opusBuffer.push(payload);
        }
        
        // Emit raw Opus payload for alternative processing
        this.emit('opus-data', payload, {
            sequenceNumber,
            timestamp,
            payloadType,
            marker
        });
    }
    
    startFfmpeg() {
        try {
            console.log(`🎬 RTP Receiver: Starting audio accumulator (no FFmpeg for now)`);
            
            // Initialize buffers - use simpler approach
            this.opusBuffer = [];
            this.audioBuffer = Buffer.alloc(0);
            
            // Accumulate Opus payloads and emit as raw audio chunks
            // This bypasses FFmpeg decoding for now
            this.accumulatorInterval = setInterval(() => {
                if (this.opusBuffer.length > 0) {
                    // Take all accumulated packets
                    const packets = this.opusBuffer.splice(0);
                    
                    if (packets.length > 0) {
                        console.log(`📊 RTP Receiver: Processing ${packets.length} Opus packets`);
                        
                        // Combine all Opus payloads into a single buffer
                        const combinedOpus = Buffer.concat(packets);
                        
                        // Emit the raw Opus data as an audio chunk (bypassing decoding for now)
                        console.log(`📊 RTP Receiver: Emitted audio chunk (${combinedOpus.length} bytes of Opus)`);
                        this.emit('audio-chunk', combinedOpus);
                    }
                }
            }, 5000); // Every 5 seconds to match transcription chunk size
            
            
        } catch (error) {
            console.error(`❌ Failed to start FFmpeg decoder:`, error);
            this.emit('error', error);
        }
    }
    
    
    stop() {
        console.log(`🛑 Stopping RTP Receiver`);
        
        this.isRunning = false;
        
        if (this.accumulatorInterval) {
            clearInterval(this.accumulatorInterval);
            this.accumulatorInterval = null;
        }
        
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGTERM');
            this.ffmpegProcess = null;
        }
        
        if (this.opusDecoder) {
            if (this.opusDecoder.cleanup) {
                this.opusDecoder.cleanup();
            }
            this.opusDecoder = null;
        }
        
        if (this.audioDecoder) {
            if (this.audioDecoder.kill) {
                this.audioDecoder.kill('SIGTERM');
            }
            this.audioDecoder = null;
        }
        
        console.log(`📊 RTP Receiver stats: ${this.packetsReceived} packets, ${this.bytesReceived} bytes received`);
    }
    
    getStats() {
        return {
            packetsReceived: this.packetsReceived,
            bytesReceived: this.bytesReceived,
            isRunning: this.isRunning,
            port: this.port,
            bufferSize: this.audioBuffer.length
        };
    }
}

module.exports = RtpReceiver;