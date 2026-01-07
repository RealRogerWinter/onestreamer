/**
 * ViewBotURLService.js - Stream external URLs (Twitch, YouTube, etc.) as viewbots
 *
 * This service creates viewbots that relay content from external streaming platforms
 * onto onestreamer. URL viewbots are treated like "real streamers" - other viewbots
 * cannot interrupt them.
 *
 * Pipeline: URL -> streamlink/yt-dlp -> FFmpeg -> RTP/RTMP -> MediaSoup/LiveKit -> Viewers
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const URLStreamExtractorService = require('./URLStreamExtractorService');
const webrtcConfig = require('../config/webrtc.config');

class ViewBotURLService extends EventEmitter {
  constructor() {
    super();

    // Dependencies
    this.extractorService = new URLStreamExtractorService();
    this.streamService = null;
    this.livekitService = null;

    // Active URL streams
    this.activeStreams = new Map(); // urlId -> stream info

    // RTP ports for MediaSoup
    this.rtpPorts = {
      video: 5004,
      audio: 5006
    };

    // Backend detection
    this.backend = webrtcConfig.backend || 'mediasoup';

    // Stream counter for unique IDs
    this.streamCounter = 0;

    console.log(`🔗 ViewBotURLService initialized (backend: ${this.backend})`);
  }

  /**
   * Set StreamService reference for stream management
   */
  setStreamService(streamService) {
    this.streamService = streamService;
    console.log('✅ StreamService registered with ViewBotURLService');
  }

  /**
   * Set LiveKit service for LiveKit backend
   */
  setLiveKitService(livekitService) {
    this.livekitService = livekitService;
    console.log('✅ LiveKitService registered with ViewBotURLService');
  }

  /**
   * Check if a URL stream is currently active
   */
  isURLStreamActive() {
    return this.activeStreams.size > 0;
  }

  /**
   * Get active URL stream info (for protection checks)
   */
  getActiveURLStream() {
    if (this.activeStreams.size === 0) return null;
    // Return first active stream
    const [urlId, info] = this.activeStreams.entries().next().value;
    return { urlId, ...info };
  }

  /**
   * Validate a URL before starting stream
   */
  async validateURL(url) {
    return await this.extractorService.validateStream(url);
  }

  /**
   * Start streaming from a URL
   */
  async startURLStream(url, options = {}) {
    const {
      quality = 'best',
      displayName = null,
      autoReconnect = true
    } = options;

    // Generate unique ID
    const urlId = `url-stream-${Date.now()}-${++this.streamCounter}`;

    console.log(`🚀 Starting URL stream: ${urlId}`);
    console.log(`   URL: ${url}`);
    console.log(`   Quality: ${quality}`);

    // Validate URL first
    const validation = await this.validateURL(url);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error || 'Invalid stream URL',
        urlId
      };
    }

    console.log(`✅ URL validated: ${validation.title} (${validation.platform})`);

    // Check if already streaming from this URL
    for (const [existingId, info] of this.activeStreams) {
      if (info.sourceUrl === url) {
        return {
          success: false,
          error: 'Already streaming from this URL',
          existingUrlId: existingId
        };
      }
    }

    // Get stream URL/pipe mode
    const streamInfo = await this.extractorService.getStreamURL(url, quality);

    // Create stream entry
    const streamEntry = {
      urlId,
      sourceUrl: url,
      platform: validation.platform,
      quality,
      displayName: displayName || validation.title || 'URL Stream',
      status: 'starting',
      startedAt: Date.now(),
      validation,
      streamInfo,
      processes: [],
      autoReconnect,
      reconnectAttempts: 0,
      maxReconnectAttempts: 3
    };

    this.activeStreams.set(urlId, streamEntry);

    try {
      // Start the streaming pipeline
      if (this.backend === 'livekit' && this.livekitService) {
        await this._startLiveKitStream(urlId, streamEntry);
      } else {
        await this._startMediaSoupStream(urlId, streamEntry);
      }

      streamEntry.status = 'streaming';

      // Emit event for integration
      this.emit('url-stream-started', {
        urlId,
        sourceUrl: url,
        platform: validation.platform,
        title: validation.title
      });

      console.log(`✅ URL stream started: ${urlId}`);

      return {
        success: true,
        urlId,
        platform: validation.platform,
        title: validation.title,
        qualities: validation.qualities
      };

    } catch (error) {
      console.error(`❌ Failed to start URL stream ${urlId}:`, error);
      this.activeStreams.delete(urlId);
      return {
        success: false,
        error: error.message,
        urlId
      };
    }
  }

  /**
   * Start MediaSoup RTP stream pipeline
   * Uses: streamlink -> FFmpeg -> RTP -> MediaSoup
   */
  async _startMediaSoupStream(urlId, streamEntry) {
    const { sourceUrl, quality, streamInfo } = streamEntry;

    console.log(`🎥 Starting MediaSoup pipeline for ${urlId}`);

    let ffmpegProcess;

    if (streamInfo.pipeMode) {
      // Pipe mode: streamlink stdout -> FFmpeg stdin
      const streamlinkProcess = this.extractorService.createStreamPipe(sourceUrl, quality);
      streamEntry.processes.push({ type: 'streamlink', process: streamlinkProcess });

      // FFmpeg reads from stdin
      ffmpegProcess = this._createFFmpegRTPProcess('-', streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });

      // Pipe streamlink to FFmpeg
      streamlinkProcess.stdout.pipe(ffmpegProcess.stdin);

      // Handle streamlink errors
      streamlinkProcess.on('error', (err) => {
        console.error(`❌ Streamlink error for ${urlId}:`, err);
        this._handleStreamError(urlId, 'streamlink', err);
      });

      streamlinkProcess.on('exit', (code) => {
        console.log(`📤 Streamlink exited for ${urlId} with code ${code}`);
        if (code !== 0) {
          this._handleStreamError(urlId, 'streamlink', new Error(`Exit code ${code}`));
        }
      });

    } else {
      // Direct URL mode: FFmpeg reads from URL directly
      ffmpegProcess = this._createFFmpegRTPProcess(streamInfo.streamUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });
    }

    // Handle FFmpeg events
    this._setupFFmpegHandlers(urlId, ffmpegProcess);

    // Wait for FFmpeg to start producing
    await this._waitForStream(ffmpegProcess, 10000);

    console.log(`✅ MediaSoup pipeline started for ${urlId}`);
  }

  /**
   * Start LiveKit RTMP stream pipeline
   * Uses: streamlink -> FFmpeg -> RTMP -> LiveKit
   */
  async _startLiveKitStream(urlId, streamEntry) {
    const { sourceUrl, quality, streamInfo } = streamEntry;

    console.log(`🎥 Starting LiveKit pipeline for ${urlId}`);

    // Get RTMP ingress URL from LiveKit service
    const ingressInfo = await this.livekitService.createIngress({
      name: streamEntry.displayName,
      type: 'rtmp'
    });

    if (!ingressInfo.success) {
      throw new Error(ingressInfo.error || 'Failed to create LiveKit ingress');
    }

    streamEntry.ingressInfo = ingressInfo;

    let ffmpegProcess;

    if (streamInfo.pipeMode) {
      // Pipe mode
      const streamlinkProcess = this.extractorService.createStreamPipe(sourceUrl, quality);
      streamEntry.processes.push({ type: 'streamlink', process: streamlinkProcess });

      ffmpegProcess = this._createFFmpegRTMPProcess('-', ingressInfo.rtmpUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });

      streamlinkProcess.stdout.pipe(ffmpegProcess.stdin);

      streamlinkProcess.on('error', (err) => this._handleStreamError(urlId, 'streamlink', err));
      streamlinkProcess.on('exit', (code) => {
        if (code !== 0) this._handleStreamError(urlId, 'streamlink', new Error(`Exit code ${code}`));
      });

    } else {
      // Direct URL mode
      ffmpegProcess = this._createFFmpegRTMPProcess(streamInfo.streamUrl, ingressInfo.rtmpUrl, streamEntry);
      streamEntry.processes.push({ type: 'ffmpeg', process: ffmpegProcess });
    }

    this._setupFFmpegHandlers(urlId, ffmpegProcess);
    await this._waitForStream(ffmpegProcess, 10000);

    console.log(`✅ LiveKit pipeline started for ${urlId}`);
  }

  /**
   * Create FFmpeg process for RTP output (MediaSoup)
   */
  _createFFmpegRTPProcess(input, streamEntry) {
    const args = [
      '-re', // Read input at native frame rate
      '-i', input,
      // Video encoding
      '-map', '0:v:0',
      '-c:v', 'libvpx', // VP8 for MediaSoup
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '30', // Keyframe every 30 frames
      '-keyint_min', '30',
      '-f', 'rtp',
      `rtp://127.0.0.1:${this.rtpPorts.video}?pkt_size=1200`,
      // Audio encoding
      '-map', '0:a:0?', // Optional audio stream
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'rtp',
      `rtp://127.0.0.1:${this.rtpPorts.audio}?pkt_size=1200`
    ];

    console.log(`🎬 FFmpeg RTP command: ffmpeg ${args.join(' ')}`);

    const process = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return process;
  }

  /**
   * Create FFmpeg process for RTMP output (LiveKit)
   */
  _createFFmpegRTMPProcess(input, rtmpUrl, streamEntry) {
    const args = [
      '-re',
      '-i', input,
      // Video encoding for RTMP (H.264)
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline', // iOS Safari compatibility
      '-level', '3.1',
      '-b:v', '2000k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
      '-g', '60',
      '-keyint_min', '60',
      // Audio encoding
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      // Output
      '-f', 'flv',
      rtmpUrl
    ];

    console.log(`🎬 FFmpeg RTMP command: ffmpeg ${args.slice(0, 5).join(' ')}... -> ${rtmpUrl}`);

    const process = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return process;
  }

  /**
   * Setup FFmpeg process event handlers
   */
  _setupFFmpegHandlers(urlId, ffmpegProcess) {
    let lastProgressTime = Date.now();

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();

      // Log errors
      if (output.includes('Error') || output.includes('error')) {
        console.error(`❌ FFmpeg error for ${urlId}:`, output.substring(0, 200));
      }

      // Track progress
      if (output.includes('frame=') || output.includes('time=')) {
        const now = Date.now();
        if (now - lastProgressTime > 30000) { // Log every 30s
          console.log(`📊 URL stream ${urlId}: FFmpeg active`);
          lastProgressTime = now;
        }
      }

      // Detect stream end
      if (output.includes('EOF') || output.includes('End of file')) {
        console.log(`🏁 URL stream ${urlId}: Source stream ended`);
        this._handleStreamEnd(urlId, 'source_ended');
      }
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`❌ FFmpeg process error for ${urlId}:`, err);
      this._handleStreamError(urlId, 'ffmpeg', err);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      console.log(`📤 FFmpeg exited for ${urlId} with code ${code}, signal ${signal}`);
      if (code !== 0 && code !== null) {
        this._handleStreamError(urlId, 'ffmpeg', new Error(`Exit code ${code}`));
      }
    });
  }

  /**
   * Wait for FFmpeg to start producing output
   */
  _waitForStream(ffmpegProcess, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('FFmpeg startup timeout'));
      }, timeout);

      const checkOutput = (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('Stream mapping')) {
          clearTimeout(timer);
          ffmpegProcess.stderr.removeListener('data', checkOutput);
          resolve();
        }
      };

      ffmpegProcess.stderr.on('data', checkOutput);
    });
  }

  /**
   * Handle stream errors with optional reconnection
   */
  async _handleStreamError(urlId, source, error) {
    const streamEntry = this.activeStreams.get(urlId);
    if (!streamEntry) return;

    console.error(`❌ Stream error for ${urlId} (${source}):`, error.message);

    if (streamEntry.autoReconnect && streamEntry.reconnectAttempts < streamEntry.maxReconnectAttempts) {
      streamEntry.reconnectAttempts++;
      streamEntry.status = 'reconnecting';

      console.log(`🔄 Attempting reconnect ${streamEntry.reconnectAttempts}/${streamEntry.maxReconnectAttempts} for ${urlId}`);

      // Stop current processes
      await this._stopProcesses(streamEntry);

      // Wait before reconnecting (exponential backoff)
      const delay = Math.min(5000 * Math.pow(2, streamEntry.reconnectAttempts - 1), 30000);
      await new Promise(resolve => setTimeout(resolve, delay));

      // Attempt restart
      try {
        if (this.backend === 'livekit' && this.livekitService) {
          await this._startLiveKitStream(urlId, streamEntry);
        } else {
          await this._startMediaSoupStream(urlId, streamEntry);
        }
        streamEntry.status = 'streaming';
        console.log(`✅ Reconnected successfully: ${urlId}`);
      } catch (reconnectError) {
        console.error(`❌ Reconnect failed for ${urlId}:`, reconnectError);
        this._handleStreamEnd(urlId, 'reconnect_failed');
      }
    } else {
      this._handleStreamEnd(urlId, 'error');
    }
  }

  /**
   * Handle stream ending
   */
  _handleStreamEnd(urlId, reason) {
    const streamEntry = this.activeStreams.get(urlId);
    if (!streamEntry) return;

    console.log(`🛑 URL stream ended: ${urlId} (reason: ${reason})`);

    // Stop all processes
    this._stopProcesses(streamEntry);

    // Update status
    streamEntry.status = 'ended';
    streamEntry.endedAt = Date.now();
    streamEntry.endReason = reason;

    // Remove from active streams
    this.activeStreams.delete(urlId);

    // Emit event
    this.emit('url-stream-ended', {
      urlId,
      reason,
      sourceUrl: streamEntry.sourceUrl,
      duration: streamEntry.endedAt - streamEntry.startedAt
    });
  }

  /**
   * Stop all processes for a stream
   */
  async _stopProcesses(streamEntry) {
    for (const { type, process } of streamEntry.processes) {
      try {
        if (process && !process.killed) {
          console.log(`🛑 Killing ${type} process for ${streamEntry.urlId}`);
          process.kill('SIGTERM');

          // Force kill after timeout
          setTimeout(() => {
            if (!process.killed) {
              process.kill('SIGKILL');
            }
          }, 3000);
        }
      } catch (err) {
        console.error(`⚠️ Error killing ${type} process:`, err);
      }
    }
    streamEntry.processes = [];
  }

  /**
   * Stop a URL stream
   */
  async stopURLStream(urlId) {
    const streamEntry = this.activeStreams.get(urlId);

    if (!streamEntry) {
      return { success: false, error: 'Stream not found' };
    }

    console.log(`⏹️ Stopping URL stream: ${urlId}`);

    // Stop processes
    await this._stopProcesses(streamEntry);

    // If using LiveKit, stop ingress
    if (streamEntry.ingressInfo && this.livekitService) {
      try {
        await this.livekitService.deleteIngress(streamEntry.ingressInfo.ingressId);
      } catch (err) {
        console.error('⚠️ Error stopping LiveKit ingress:', err);
      }
    }

    // Remove from active streams
    this.activeStreams.delete(urlId);

    // Emit event
    this.emit('url-stream-stopped', { urlId });

    console.log(`✅ URL stream stopped: ${urlId}`);

    return { success: true };
  }

  /**
   * Stop all URL streams
   */
  async stopAllURLStreams() {
    console.log(`🛑 Stopping all URL streams (${this.activeStreams.size} active)`);

    const stopPromises = [];
    for (const urlId of this.activeStreams.keys()) {
      stopPromises.push(this.stopURLStream(urlId));
    }

    await Promise.allSettled(stopPromises);

    console.log('✅ All URL streams stopped');
  }

  /**
   * Get status of a URL stream
   */
  getStreamStatus(urlId) {
    const streamEntry = this.activeStreams.get(urlId);

    if (!streamEntry) {
      return null;
    }

    return {
      urlId,
      sourceUrl: streamEntry.sourceUrl,
      platform: streamEntry.platform,
      displayName: streamEntry.displayName,
      quality: streamEntry.quality,
      status: streamEntry.status,
      startedAt: streamEntry.startedAt,
      uptime: Date.now() - streamEntry.startedAt,
      reconnectAttempts: streamEntry.reconnectAttempts,
      processCount: streamEntry.processes.length
    };
  }

  /**
   * Get all active streams
   */
  getAllStreams() {
    const streams = [];
    for (const [urlId, entry] of this.activeStreams) {
      streams.push(this.getStreamStatus(urlId));
    }
    return streams;
  }

  /**
   * Test tools availability
   */
  async testTools() {
    return await this.extractorService.testTools();
  }

  /**
   * Clean shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down ViewBotURLService');
    await this.stopAllURLStreams();
  }
}

module.exports = ViewBotURLService;
