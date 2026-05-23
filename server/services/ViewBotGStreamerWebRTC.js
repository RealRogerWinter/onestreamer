const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const requireEnv = require('../config/requireEnv');

/**
 * ViewBotGStreamerWebRTC - GStreamer with webrtcbin for proper WebRTC/TURN support
 * This replaces Plain RTP with full WebRTC transport for mobile 5G compatibility
 */
class ViewBotGStreamerWebRTC {
  constructor() {
    this.gstreamerPath = process.platform === 'win32'
      ? 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe'
      : 'gst-launch-1.0';
    
    this.activeStreams = new Map();
    
    // TURN server configuration
    const turnDomain = process.env.TURN_DOMAIN || '<SERVER_IP>';
    this.turnServers = [
      'stun://stun.l.google.com:19302',
      `turn://${turnDomain}:3478`,
      `turn://${turnDomain}:3479`
    ];
  }

  /**
   * Generate TURN credentials matching coturn's use-auth-secret format
   */
  generateTurnCredential(username) {
    const secret = requireEnv('TURN_SECRET');
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(username);
    return hmac.digest('base64');
  }

  /**
   * Create WebRTC pipeline using webrtcbin for TURN/mobile support
   */
  createWebRTCPipeline(config) {
    const {
      botId,
      pattern = 'smpte',
      width = 1280,
      height = 720,
      frameRate = 30,
      videoBitrate = 300000,  // 300kbps for mobile
      audioBitrate = 128000,
      videoFile = null,
      customText = 'ViewBot WebRTC Stream'
    } = config;

    // Generate TURN credentials
    const turnUsername = `${Math.floor(Date.now() / 1000) + 86400}:webrtc`;
    const turnCredential = this.generateTurnCredential(turnUsername);

    let pipeline = [];

    if (videoFile && fs.existsSync(videoFile)) {
      // Video file source with WebRTC output
      pipeline = [
        // Video source and decode
        'filesrc', `location="${videoFile}"`,
        '!', 'decodebin', 'name=decoder',
        
        // Video branch
        'decoder.',
        '!', 'queue',
        '!', 'videoconvert',
        '!', 'videoscale',
        '!', `video/x-raw,width=${width},height=${height}`,
        '!', 'videorate',
        '!', `video/x-raw,framerate=${frameRate}/1`,
        
        // VP8 encoding for WebRTC
        '!', 'vp8enc',
          'deadline=1',
          'cpu-used=8',
          'error-resilient=1',
          `target-bitrate=${videoBitrate}`,
          'keyframe-max-dist=30',
        
        // Send to webrtcbin
        '!', 'rtpvp8pay',
        '!', 'application/x-rtp,media=video,encoding-name=VP8,payload=96',
        '!', 'webrtcbin.sink_0',
        
        // Audio branch
        'decoder.',
        '!', 'queue',
        '!', 'audioconvert',
        '!', 'audioresample',
        '!', 'audio/x-raw,rate=48000,channels=2',
        
        // Opus encoding for WebRTC
        '!', 'opusenc',
          `bitrate=${audioBitrate}`,
        
        // Send to webrtcbin
        '!', 'rtpopuspay',
        '!', 'application/x-rtp,media=audio,encoding-name=OPUS,payload=111',
        '!', 'webrtcbin.sink_1',
        
        // WebRTC bin with TURN configuration
        'webrtcbin',
          'name=webrtcbin',
          'bundle-policy=max-bundle',
          `stun-server=${this.turnServers[0]}`,
          `turn-server=turn://${turnUsername}:${turnCredential}@${process.env.TURN_DOMAIN || '<SERVER_IP>'}:3478`
      ];
    } else {
      // Test pattern with WebRTC output
      pipeline = [
        // Video test source
        'videotestsrc',
          `pattern=${pattern}`,
          'is-live=true',
        '!', `video/x-raw,width=${width},height=${height},framerate=${frameRate}/1`,
        
        // Add text overlay
        '!', 'textoverlay',
          `text="${customText}"`,
          'valignment=center',
          'halignment=center',
          'font-desc="Sans 48"',
        
        // VP8 encoding
        '!', 'vp8enc',
          'deadline=1',
          'cpu-used=8',
          'error-resilient=1',
          `target-bitrate=${videoBitrate}`,
          'keyframe-max-dist=30',
        
        // Send to webrtcbin
        '!', 'rtpvp8pay',
        '!', 'application/x-rtp,media=video,encoding-name=VP8,payload=96',
        '!', 'webrtcbin.sink_0',
        
        // Audio test source
        'audiotestsrc',
          'wave=sine',
          'freq=440',
          'is-live=true',
        '!', 'audio/x-raw,rate=48000,channels=2',
        
        // Opus encoding
        '!', 'opusenc',
          `bitrate=${audioBitrate}`,
        
        // Send to webrtcbin
        '!', 'rtpopuspay',
        '!', 'application/x-rtp,media=audio,encoding-name=OPUS,payload=111',
        '!', 'webrtcbin.sink_1',
        
        // WebRTC bin with TURN configuration
        'webrtcbin',
          'name=webrtcbin',
          'bundle-policy=max-bundle',
          `stun-server=${this.turnServers[0]}`,
          `turn-server=turn://${turnUsername}:${turnCredential}@${process.env.TURN_DOMAIN || '<SERVER_IP>'}:3478`
      ];
    }

    return pipeline;
  }

  /**
   * Start GStreamer WebRTC streaming
   */
  async startWebRTCStream(config) {
    const { botId } = config;
    
    // Stop existing stream if any
    this.stopStream(botId);

    console.log(`🚀 ViewBot ${botId}: Starting GStreamer WebRTC pipeline (TURN-enabled)`);
    
    const pipeline = this.createWebRTCPipeline(config);
    
    console.log(`📡 ViewBot ${botId}: Pipeline command: ${this.gstreamerPath} ${pipeline.join(' ')}`);
    
    // Spawn GStreamer process
    const gstProcess = spawn(this.gstreamerPath, pipeline, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    // Handle signaling through stdin/stdout
    gstProcess.stdin.setEncoding('utf8');
    gstProcess.stdout.setEncoding('utf8');
    
    // Store process reference
    this.activeStreams.set(botId, {
      process: gstProcess,
      config: config,
      startTime: Date.now()
    });

    // Handle stdout for SDP and ICE candidates
    gstProcess.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Parse SDP offers/answers
      if (output.includes('SDP')) {
        console.log(`📄 ViewBot ${botId}: SDP received from GStreamer`);
        // This would be sent to MediaSoup for negotiation
      }
      
      // Parse ICE candidates
      if (output.includes('candidate:')) {
        console.log(`🧊 ViewBot ${botId}: ICE candidate from GStreamer`);
        // This would be sent to MediaSoup
      }
    });

    // Handle stderr for debugging
    gstProcess.stderr.on('data', (data) => {
      const error = data.toString();
      if (error.includes('ERROR')) {
        console.error(`❌ ViewBot ${botId}: GStreamer error:`, error);
      } else {
        console.log(`🔍 ViewBot ${botId}: GStreamer:`, error.trim());
      }
    });

    // Handle process exit
    gstProcess.on('exit', (code, signal) => {
      console.log(`🛑 ViewBot ${botId}: GStreamer process exited (code: ${code}, signal: ${signal})`);
      this.activeStreams.delete(botId);
    });

    return {
      success: true,
      pid: gstProcess.pid,
      botId: botId
    };
  }

  /**
   * Stop GStreamer stream
   */
  stopStream(botId) {
    const stream = this.activeStreams.get(botId);
    if (stream && stream.process) {
      console.log(`🛑 ViewBot ${botId}: Stopping GStreamer WebRTC stream`);
      
      try {
        // Send EOS signal to GStreamer
        stream.process.stdin.write('EOS\n');
        
        // Give it time to cleanup
        setTimeout(() => {
          if (!stream.process.killed) {
            stream.process.kill('SIGTERM');
          }
        }, 1000);
        
      } catch (error) {
        console.error(`❌ ViewBot ${botId}: Error stopping GStreamer:`, error);
        stream.process.kill('SIGKILL');
      }
      
      this.activeStreams.delete(botId);
    }
  }

  /**
   * Get stream status
   */
  getStreamStatus(botId) {
    const stream = this.activeStreams.get(botId);
    if (!stream) {
      return { active: false };
    }

    return {
      active: true,
      pid: stream.process.pid,
      uptime: Date.now() - stream.startTime,
      config: stream.config
    };
  }

  /**
   * Stop all streams
   */
  stopAllStreams() {
    console.log(`🛑 Stopping all ${this.activeStreams.size} GStreamer WebRTC streams`);
    
    for (const [botId] of this.activeStreams) {
      this.stopStream(botId);
    }
  }
}

module.exports = ViewBotGStreamerWebRTC;