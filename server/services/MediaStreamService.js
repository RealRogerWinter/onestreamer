const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = require('wrtc');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

const logger = require('../bootstrap/logger').child({ svc: 'MediaStreamService' });
class MediaStreamService {
  constructor() {
    this.activeStreamer = null;
    this.peerConnection = null;
    this.ffmpegProcess = null;
    this.streamId = null;
    this.hlsPath = path.join(__dirname, '../../public/hls');
    this.mediaSource = null;
    
    // Ensure HLS directory exists
    this.ensureHLSDirectory();
  }

  ensureHLSDirectory() {
    if (!fs.existsSync(this.hlsPath)) {
      fs.mkdirSync(this.hlsPath, { recursive: true });
      logger.debug('📁 Created HLS directory:', this.hlsPath);
    }
  }

  async startIngestion(streamerId, offer) {
    logger.debug('🎥 MEDIA: Starting WebRTC ingestion for streamer:', streamerId);
    
    // Clean up existing stream
    this.stopIngestion();
    
    this.activeStreamer = streamerId;
    this.streamId = `stream_${streamerId}_${Date.now()}`;
    
    // Create WebRTC peer connection
    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Handle incoming media stream
    this.peerConnection.ontrack = (event) => {
      logger.debug('📺 MEDIA: Received media track:', event.track.kind);
      if (event.streams && event.streams[0]) {
        this.handleIncomingStream(event.streams[0]);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      logger.debug('🔗 MEDIA: WebRTC connection state:', this.peerConnection.connectionState);
      if (this.peerConnection.connectionState === 'failed' || 
          this.peerConnection.connectionState === 'disconnected') {
        this.stopIngestion();
      }
    };

    try {
      // Set remote description (offer from client)
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Create and set local description (answer)
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      
      logger.debug('✅ MEDIA: WebRTC handshake completed');
      return { success: true, answer: answer, streamId: this.streamId };
      
    } catch (error) {
      logger.error('❌ MEDIA: WebRTC setup failed:', error);
      this.stopIngestion();
      return { success: false, error: error.message };
    }
  }

  async addIceCandidate(candidate) {
    if (this.peerConnection && candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        logger.debug('🧊 MEDIA: Added ICE candidate');
      } catch (error) {
        logger.error('❌ MEDIA: Failed to add ICE candidate:', error);
      }
    }
  }

  handleIncomingStream(stream) {
    logger.debug('🎬 MEDIA: Processing incoming stream for HLS conversion');
    
    // Create media source that can be fed to FFmpeg
    this.mediaSource = new nonstandard.RTCAudioSink(stream.getAudioTracks()[0]);
    
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const videoSink = new nonstandard.RTCVideoSink(videoTrack);
      
      // Start FFmpeg process to convert to HLS
      this.startFFmpegHLS(videoSink);
    }
  }

  startFFmpegHLS(videoSink) {
    logger.debug('🔄 MEDIA: Starting FFmpeg HLS conversion');
    
    const hlsOutputPath = path.join(this.hlsPath, `${this.streamId}.m3u8`);
    const segmentPath = path.join(this.hlsPath, `${this.streamId}_segment_%03d.ts`);
    
    // For now, we'll create a simpler approach using a named pipe or direct streaming
    // This is a simplified version - in production you'd want more robust handling
    
    try {
      this.ffmpegProcess = ffmpeg()
        .input('pipe:0')
        .inputFormat('rawvideo')
        .inputOptions([
          '-pix_fmt yuv420p',
          '-s 1280x720',
          '-r 30'
        ])
        .output(hlsOutputPath)
        .outputOptions([
          '-f hls',
          '-hls_time 2',
          '-hls_list_size 5',
          '-hls_flags delete_segments',
          '-hls_segment_filename', segmentPath
        ])
        .on('start', (commandLine) => {
          logger.debug('🚀 MEDIA: FFmpeg started:', commandLine);
        })
        .on('error', (err) => {
          logger.error('❌ MEDIA: FFmpeg error:', err);
          this.stopIngestion();
        })
        .on('end', () => {
          logger.debug('🏁 MEDIA: FFmpeg process ended');
        })
        .run();

      // Note: This is a simplified approach. In a real implementation,
      // you'd need to properly handle the WebRTC video frames and feed them to FFmpeg
      // For now, let's create a basic HLS stream manually
      this.createTestHLSStream();
      
    } catch (error) {
      logger.error('❌ MEDIA: Failed to start FFmpeg:', error);
    }
  }

  // Temporary method to create a test HLS stream
  createTestHLSStream() {
    logger.debug('📺 MEDIA: Creating test HLS stream');
    
    const m3u8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
${this.streamId}_segment_000.ts
#EXTINF:2.0,
${this.streamId}_segment_001.ts
#EXTINF:2.0,
${this.streamId}_segment_002.ts`;

    const hlsFilePath = path.join(this.hlsPath, `${this.streamId}.m3u8`);
    fs.writeFileSync(hlsFilePath, m3u8Content);
    
    logger.debug('✅ MEDIA: Test HLS manifest created:', hlsFilePath);
  }

  stopIngestion() {
    logger.debug('🛑 MEDIA: Stopping stream ingestion');
    
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    
    if (this.mediaSource) {
      this.mediaSource = null;
    }
    
    // Clean up HLS files
    if (this.streamId) {
      this.cleanupHLSFiles();
    }
    
    this.activeStreamer = null;
    this.streamId = null;
  }

  cleanupHLSFiles() {
    try {
      const files = fs.readdirSync(this.hlsPath);
      files.forEach(file => {
        if (file.includes(this.streamId)) {
          fs.unlinkSync(path.join(this.hlsPath, file));
        }
      });
      logger.debug('🧹 MEDIA: Cleaned up HLS files for stream:', this.streamId);
    } catch (error) {
      logger.warn('⚠️ MEDIA: Failed to cleanup HLS files:', error);
    }
  }

  getStreamInfo() {
    return {
      activeStreamer: this.activeStreamer,
      streamId: this.streamId,
      isActive: !!this.activeStreamer,
      hlsUrl: this.streamId ? `/hls/${this.streamId}.m3u8` : null
    };
  }

  isStreaming(streamerId) {
    return this.activeStreamer === streamerId;
  }
}

module.exports = MediaStreamService;
