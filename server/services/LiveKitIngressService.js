/**
 * LiveKitIngressService.js - Manages LiveKit RTMP Ingress for ViewBots
 * 
 * Creates and manages RTMP ingress endpoints for streaming video files to LiveKit
 */

const { IngressClient, IngressInput, IngressAudioEncodingPreset, IngressVideoEncodingPreset } = require('livekit-server-sdk');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

class LiveKitIngressService {
  constructor(livekitService) {
    this.livekitService = livekitService;
    this.ingresses = new Map();
    this.ffmpegProcesses = new Map();
    
    // Initialize ingress client
    const apiKey = process.env.LIVEKIT_API_KEY || 'REDACTED-LIVEKIT-API-KEY';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'REDACTED-LIVEKIT-API-SECRET';
    const host = process.env.LIVEKIT_HOST || 'https://onestreamer.live:7880';
    
    this.ingressClient = new IngressClient(host, apiKey, apiSecret);
    
    console.log('🎥 LiveKit Ingress Service initialized');
  }
  
  /**
   * Create an RTMP ingress for a ViewBot
   */
  async createIngress(botId, roomName = 'main') {
    try {
      console.log(`📡 Creating RTMP ingress for ViewBot ${botId}`);
      
      // Create ingress with RTMP input
      const createOptions = {
        name: `ViewBot-${botId}`,
        roomName: roomName,
        participantIdentity: botId,
        participantName: `ViewBot ${botId}`,
        audio: {
          encodingPreset: IngressAudioEncodingPreset.OPUS_STEREO_96KBPS
        },
        video: {
          encodingPreset: IngressVideoEncodingPreset.H264_1080P_30FPS_3_MBPS
        }
      };
      
      // First parameter is inputType, second is options
      const ingress = await this.ingressClient.createIngress(
        IngressInput.RTMP_INPUT,
        createOptions
      );
      
      console.log(`✅ Ingress created for ${botId}`);
      console.log(`📡 RTMP URL: ${ingress.url}`);
      console.log(`🔑 Stream Key: ${ingress.streamKey}`);
      
      // Store ingress info
      this.ingresses.set(botId, {
        id: ingress.ingressId,
        url: ingress.url,
        streamKey: ingress.streamKey,
        roomName: roomName,
        status: 'created'
      });
      
      return {
        success: true,
        ingressId: ingress.ingressId,
        rtmpUrl: ingress.url,
        streamKey: ingress.streamKey
      };
      
    } catch (error) {
      console.error(`❌ Failed to create ingress for ${botId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Start streaming a video file to RTMP ingress using FFmpeg
   */
  async startStreaming(botId, videoFile) {
    const ingressInfo = this.ingresses.get(botId);
    
    if (!ingressInfo) {
      console.error(`❌ No ingress found for ${botId}`);
      return {
        success: false,
        error: 'Ingress not found. Create ingress first.'
      };
    }
    
    // Check if already streaming
    if (this.ffmpegProcesses.has(botId)) {
      console.log(`⚠️ ViewBot ${botId} is already streaming`);
      return {
        success: false,
        error: 'Already streaming'
      };
    }
    
    try {
      // Check if video file exists
      await fs.access(videoFile);
      
      console.log(`🎬 Starting FFmpeg stream for ${botId}`);
      console.log(`📹 Video file: ${videoFile}`);
      
      // Build RTMP URL with stream key
      const rtmpUrl = `${ingressInfo.url}/${ingressInfo.streamKey}`;
      
      // FFmpeg command to stream to RTMP
      const ffmpegArgs = [
        '-re', // Read input at native frame rate
        '-stream_loop', '-1', // Loop the video indefinitely
        '-i', videoFile,
        '-c:v', 'libx264', // H.264 video codec
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-b:v', '2M', // Video bitrate
        '-maxrate', '2M',
        '-bufsize', '4M',
        '-pix_fmt', 'yuv420p',
        '-g', '30', // GOP size (keyframe interval)
        '-c:a', 'aac', // AAC audio codec
        '-b:a', '128k', // Audio bitrate
        '-ar', '44100', // Audio sample rate
        '-ac', '2', // Stereo audio
        '-f', 'flv', // FLV format for RTMP
        rtmpUrl
      ];
      
      console.log(`🚀 Starting FFmpeg with command:`);
      console.log(`ffmpeg ${ffmpegArgs.join(' ')}`);
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Store the process
      this.ffmpegProcesses.set(botId, ffmpegProcess);
      
      // Handle FFmpeg output
      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        
        // Log errors
        if (output.includes('error') || output.includes('Error')) {
          console.error(`❌ FFmpeg error for ${botId}:`, output);
        }
        
        // Log progress
        if (output.includes('frame=')) {
          const frameMatch = output.match(/frame=\s*(\d+)/);
          if (frameMatch && parseInt(frameMatch[1]) % 300 === 0) {
            console.log(`📊 ViewBot ${botId}: Streaming... (frame ${frameMatch[1]})`);
          }
        }
        
        // Check if streaming started
        if (output.includes('Output #0, flv')) {
          console.log(`✅ ViewBot ${botId}: FFmpeg streaming to RTMP`);
          ingressInfo.status = 'streaming';
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        console.error(`❌ FFmpeg process error for ${botId}:`, error);
        this.ffmpegProcesses.delete(botId);
        ingressInfo.status = 'error';
      });
      
      ffmpegProcess.on('exit', (code, signal) => {
        console.log(`🛑 FFmpeg process for ${botId} exited (code: ${code}, signal: ${signal})`);
        this.ffmpegProcesses.delete(botId);
        ingressInfo.status = 'stopped';
      });
      
      // Wait a bit for streaming to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      return {
        success: true,
        message: `Streaming started for ${botId}`,
        rtmpUrl: rtmpUrl
      };
      
    } catch (error) {
      console.error(`❌ Failed to start streaming for ${botId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Stop streaming for a ViewBot
   */
  async stopStreaming(botId) {
    const ffmpegProcess = this.ffmpegProcesses.get(botId);
    
    if (!ffmpegProcess) {
      console.log(`⚠️ No streaming process found for ${botId}`);
      return {
        success: false,
        error: 'Not streaming'
      };
    }
    
    console.log(`⏹️ Stopping stream for ${botId}`);
    
    // Kill FFmpeg process
    ffmpegProcess.kill('SIGTERM');
    this.ffmpegProcesses.delete(botId);
    
    // Update status
    const ingressInfo = this.ingresses.get(botId);
    if (ingressInfo) {
      ingressInfo.status = 'stopped';
    }
    
    return {
      success: true,
      message: `Streaming stopped for ${botId}`
    };
  }
  
  /**
   * Delete an ingress
   */
  async deleteIngress(botId) {
    const ingressInfo = this.ingresses.get(botId);
    
    if (!ingressInfo) {
      console.log(`⚠️ No ingress found for ${botId}`);
      return {
        success: false,
        error: 'Ingress not found'
      };
    }
    
    try {
      // Stop streaming first
      await this.stopStreaming(botId);
      
      // Delete ingress from LiveKit
      console.log(`🗑️ Deleting ingress for ${botId}`);
      await this.ingressClient.deleteIngress(ingressInfo.id);
      
      // Remove from local storage
      this.ingresses.delete(botId);
      
      console.log(`✅ Ingress deleted for ${botId}`);
      
      return {
        success: true,
        message: `Ingress deleted for ${botId}`
      };
      
    } catch (error) {
      console.error(`❌ Failed to delete ingress for ${botId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get status of all ingresses
   */
  getStatus() {
    const status = [];
    
    for (const [botId, info] of this.ingresses) {
      status.push({
        botId: botId,
        ingressId: info.id,
        roomName: info.roomName,
        status: info.status,
        isStreaming: this.ffmpegProcesses.has(botId)
      });
    }
    
    return status;
  }
  
  /**
   * Clean up all resources
   */
  async cleanup() {
    console.log('🧹 Cleaning up LiveKit Ingress Service');
    
    // Stop all streams
    for (const botId of this.ffmpegProcesses.keys()) {
      await this.stopStreaming(botId);
    }
    
    // Delete all ingresses
    for (const botId of this.ingresses.keys()) {
      await this.deleteIngress(botId);
    }
    
    console.log('✅ LiveKit Ingress Service cleaned up');
  }
}

module.exports = LiveKitIngressService;