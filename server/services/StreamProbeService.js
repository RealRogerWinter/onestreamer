/**
 * StreamProbeService.js - Probe and analyze stream properties for adaptive encoding
 *
 * Uses ffprobe to analyze source streams and determine optimal encoding settings.
 * This enables the URL relay system to adapt to various stream qualities.
 */

const { spawn } = require('child_process');

const logger = require('../bootstrap/logger').child({ svc: 'StreamProbeService' });
class StreamProbeService {
  constructor() {
    this.ffprobePath = 'ffprobe';
    this.probeCache = new Map(); // Cache probe results (URL -> result)
    this.cacheTimeout = 60000; // 1 minute cache

    // Default values if probe fails
    this.defaults = {
      width: 1280,
      height: 720,
      fps: 30,
      videoBitrate: 3000000, // 3 Mbps
      audioBitrate: 128000,  // 128 kbps
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      hasVideo: true
    };
  }

  /**
   * Probe a stream URL or pipe to get its properties
   * @param {string} input - Stream URL or '-' for stdin
   * @param {object} options - Additional options
   * @returns {Promise<object>} Stream properties
   */
  async probeStream(input, options = {}) {
    // Check cache for URL inputs
    if (input !== '-' && this.probeCache.has(input)) {
      const cached = this.probeCache.get(input);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        logger.debug(`📊 StreamProbe: Using cached result for ${input.substring(0, 50)}...`);
        return cached.result;
      }
      this.probeCache.delete(input);
    }

    try {
      const result = await this._runProbe(input, options);

      // Cache URL results
      if (input !== '-') {
        this.probeCache.set(input, {
          result,
          timestamp: Date.now()
        });
      }

      return result;
    } catch (error) {
      logger.warn(`⚠️ StreamProbe: Failed to probe stream, using defaults: ${error.message}`);
      return { ...this.defaults, probeError: error.message };
    }
  }

  /**
   * Run ffprobe and parse results
   */
  async _runProbe(input, options = {}) {
    const timeout = options.timeout || 10000; // 10 second timeout

    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-show_streams',
        '-show_format',
        '-print_format', 'json'
      ];

      // For HLS/network streams, add protocol options
      if (input.startsWith('http')) {
        args.unshift(
          '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          '-timeout', '5000000' // 5 second network timeout
        );
      }

      args.push('-i', input);

      logger.debug(`📊 StreamProbe: Probing ${input.substring(0, 60)}...`);

      const ffprobe = spawn(this.ffprobePath, args);

      let stdout = '';
      let stderr = '';
      let completed = false;

      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          ffprobe.kill('SIGKILL');
          reject(new Error(`Probe timeout after ${timeout}ms`));
        }
      }, timeout);

      ffprobe.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);

        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code}: ${stderr.substring(0, 200)}`));
          return;
        }

        try {
          const parsed = this._parseProbeOutput(stdout);
          logger.debug(`✅ StreamProbe: ${parsed.width}x${parsed.height}@${parsed.fps}fps, ` +
                     `video: ${Math.round(parsed.videoBitrate/1000)}kbps, ` +
                     `audio: ${parsed.hasAudio ? Math.round(parsed.audioBitrate/1000) + 'kbps' : 'none'}`);
          resolve(parsed);
        } catch (parseError) {
          reject(new Error(`Failed to parse probe output: ${parseError.message}`));
        }
      });

      ffprobe.on('error', (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Parse ffprobe JSON output into a structured result
   */
  _parseProbeOutput(jsonStr) {
    const data = JSON.parse(jsonStr);
    const result = { ...this.defaults };

    // Find video stream
    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    if (videoStream) {
      result.hasVideo = true;
      result.width = videoStream.width || result.width;
      result.height = videoStream.height || result.height;
      result.videoCodec = videoStream.codec_name || result.videoCodec;

      // Parse framerate (can be "30/1" or "29.97" format)
      if (videoStream.r_frame_rate) {
        const fpsMatch = videoStream.r_frame_rate.match(/(\d+)\/(\d+)/);
        if (fpsMatch) {
          result.fps = Math.round(parseInt(fpsMatch[1]) / parseInt(fpsMatch[2]));
        } else {
          result.fps = parseFloat(videoStream.r_frame_rate) || result.fps;
        }
      } else if (videoStream.avg_frame_rate) {
        const fpsMatch = videoStream.avg_frame_rate.match(/(\d+)\/(\d+)/);
        if (fpsMatch && parseInt(fpsMatch[2]) !== 0) {
          result.fps = Math.round(parseInt(fpsMatch[1]) / parseInt(fpsMatch[2]));
        }
      }

      // Estimate video bitrate
      if (videoStream.bit_rate) {
        result.videoBitrate = parseInt(videoStream.bit_rate);
      } else if (data.format?.bit_rate) {
        // Use format bitrate minus audio estimate
        result.videoBitrate = parseInt(data.format.bit_rate) - 128000;
      }
    } else {
      result.hasVideo = false;
    }

    // Find audio stream
    const audioStream = data.streams?.find(s => s.codec_type === 'audio');
    if (audioStream) {
      result.hasAudio = true;
      result.audioCodec = audioStream.codec_name || result.audioCodec;
      result.audioBitrate = parseInt(audioStream.bit_rate) || result.audioBitrate;
      result.audioSampleRate = parseInt(audioStream.sample_rate) || 48000;
      result.audioChannels = audioStream.channels || 2;
    } else {
      result.hasAudio = false;
    }

    // Clamp FPS to reasonable values
    result.fps = Math.max(15, Math.min(60, result.fps));

    return result;
  }

  /**
   * Probe via pipe - starts a short probe session through streamlink/yt-dlp
   * Useful when direct URL probe fails
   */
  async probePipe(pipeProcess, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn(this.ffprobePath, [
        '-v', 'error',
        '-show_streams',
        '-show_format',
        '-print_format', 'json',
        '-i', 'pipe:0'
      ]);

      let stdout = '';
      let completed = false;

      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          ffprobe.kill();
          pipeProcess.kill();
          // Return defaults on timeout (common for live streams)
          resolve({ ...this.defaults, probeNote: 'pipe_timeout' });
        }
      }, timeout);

      // Pipe data from source to ffprobe
      pipeProcess.stdout.pipe(ffprobe.stdin);

      ffprobe.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        pipeProcess.kill();

        if (code === 0 && stdout) {
          try {
            const parsed = this._parseProbeOutput(stdout);
            resolve(parsed);
          } catch (e) {
            resolve({ ...this.defaults, probeNote: 'parse_failed' });
          }
        } else {
          resolve({ ...this.defaults, probeNote: 'probe_failed' });
        }
      });

      ffprobe.on('error', () => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          resolve({ ...this.defaults, probeNote: 'probe_error' });
        }
      });
    });
  }

  /**
   * Quick probe that tries multiple methods
   */
  async quickProbe(url, platform) {
    // First try direct URL probe (works for most HLS streams)
    try {
      return await this.probeStream(url, { timeout: 8000 });
    } catch (e) {
      logger.debug(`📊 StreamProbe: Direct probe failed, returning defaults`);
      return { ...this.defaults, probeNote: 'direct_failed' };
    }
  }

  /**
   * Clear probe cache
   */
  clearCache() {
    this.probeCache.clear();
    logger.debug('📊 StreamProbe: Cache cleared');
  }
}

module.exports = StreamProbeService;
