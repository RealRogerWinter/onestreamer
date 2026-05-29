/**
 * FFmpegPipeline.js - FFmpeg process spawn/handlers/wait/stop for URL streams,
 * extracted from ViewBotURLService.
 *
 * Builds RTP (MediaSoup) and RTMP (LiveKit) FFmpeg processes, wires stderr
 * progress/health/error parsing, waits for first output, and tears down
 * processes. Reads owner.adaptiveConfig, owner.ffmpegPath, owner.rtpPorts,
 * owner.activeStreams and global.urlStreamHealthService via the `owner`
 * back-reference; error/end recovery is delegated to owner so behavior is
 * identical to the in-service form.
 *
 * Deps: { owner, logger }.
 */

const { spawn } = require('child_process');
const { buildRtpFfmpegArgs, buildRtmpFfmpegArgs } = require('../viewbot/ffmpegArgs');

class FFmpegPipeline {
  constructor(owner, logger) {
    this.owner = owner;
    this.logger = logger;
  }

  /**
   * Create FFmpeg process for RTP output (MediaSoup)
   * Uses adaptive encoding settings when available
   */
  createRTPProcess(input, streamEntry) {
    const owner = this.owner;
    const logger = this.logger;
    const settings = streamEntry.encodingSettings;
    const useAdaptive = owner.adaptiveConfig.enabled && settings;

    const args = buildRtpFfmpegArgs({ input, settings, useAdaptive, rtpPorts: owner.rtpPorts });

    const logSettings = useAdaptive
      ? `ADAPTIVE ${settings.width}x${settings.height}@${settings.fps}fps ${settings.videoBitrate}kbps`
      : 'FIXED 720p 1500kbps';

    logger.debug(`🎬 FFmpeg RTP (${logSettings}): ${owner.ffmpegPath} ${args.slice(0, 5).join(' ')}...`);

    const process = spawn(owner.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return process;
  }

  /**
   * Create FFmpeg process for RTMP output (LiveKit)
   * Uses adaptive encoding settings when available, falls back to fixed 720p
   */
  createRTMPProcess(input, rtmpUrl, streamEntry) {
    const owner = this.owner;
    const logger = this.logger;
    const settings = streamEntry.encodingSettings;
    const useAdaptive = owner.adaptiveConfig.enabled && settings;

    // Experimental: VIEWBOT_STREAM_COPY=true bypasses re-encoding entirely (only
    // valid when the source is already H.264 + AAC). Read env via globalThis
    // because the `const process = spawn(...)` below shadows the global `process`
    // for the whole function scope (TDZ).
    const streamCopy = globalThis.process.env.VIEWBOT_STREAM_COPY === 'true' && input !== '-';

    const args = buildRtmpFfmpegArgs({ input, rtmpUrl, settings, useAdaptive, streamCopy });

    if (input !== '-') {
      logger.debug(`📡 Using -re flag with reconnect for direct URL input: ${input.substring(0, 60)}...`);
    }
    if (streamCopy) {
      logger.debug(`🎬 FFmpeg RTMP [STREAM-COPY]: ${owner.ffmpegPath} -i ${input.substring(0, 60)}... -> ${rtmpUrl}`);
    } else {
      const logSettings = useAdaptive
        ? `ADAPTIVE ${settings.width}x${settings.height}@${settings.fps}fps ${settings.videoBitrate}kbps`
        : 'FIXED 720p@30fps 4000kbps';
      logger.debug(`🎬 FFmpeg RTMP (${logSettings}): ${owner.ffmpegPath} ... -> ${rtmpUrl}`);
    }

    const process = spawn(owner.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return process;
  }

  /**
   * Setup FFmpeg process event handlers
   */
  setupHandlers(urlId, ffmpegProcess) {
    const owner = this.owner;
    const logger = this.logger;
    let lastProgressTime = Date.now();
    let lastHealthReportTime = 0;

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();

      // Log errors. Pino drops a bare string as the 2nd arg of `error()`
      // (it expects an object), so the raw stderr we want to see was being
      // eaten silently — every "❌ FFmpeg error for X:" line had no payload.
      // Pass it as an object so the stderr lands in the JSON record.
      if (output.includes('Error') || output.includes('error')) {
        logger.error({ stderr: output.substring(0, 400) }, `❌ FFmpeg error for ${urlId}`);
      }

      // Track progress and report to health service
      if (output.includes('frame=') || output.includes('time=')) {
        const now = Date.now();
        if (now - lastProgressTime > 30000) { // Log every 30s
          logger.debug(`📊 URL stream ${urlId}: FFmpeg active`);
          lastProgressTime = now;
        }

        // Report progress to health service more frequently (every 5s)
        // This prevents false "stale stream" detection
        if (global.urlStreamHealthService && now - lastHealthReportTime > 5000) {
          // Parse FFmpeg stats from output
          const stats = {};
          const frameMatch = output.match(/frame=\s*(\d+)/);
          const fpsMatch = output.match(/fps=\s*(\d+\.?\d*)/);
          const timeMatch = output.match(/time=\s*(\d+:\d+:\d+\.\d+)/);
          const bitrateMatch = output.match(/bitrate=\s*(\d+\.?\d*\w+)/);

          if (frameMatch) stats.frame = parseInt(frameMatch[1]);
          if (fpsMatch) stats.fps = parseFloat(fpsMatch[1]);
          if (timeMatch) stats.time = timeMatch[1];
          if (bitrateMatch) stats.bitrate = bitrateMatch[1];

          global.urlStreamHealthService.updateFFmpegProgress(urlId, stats);
          lastHealthReportTime = now;
        }
      }

      // Detect stream end
      if (output.includes('EOF') || output.includes('End of file')) {
        logger.debug(`🏁 URL stream ${urlId}: Source stream ended`);
        owner._handleStreamEnd(urlId, 'source_ended');
      }

      // CRITICAL: Detect HTTP errors from source stream (403 Forbidden, 404 Not Found, etc.)
      // These cause FFmpeg to exit with code 0 but the stream is dead
      const httpErrorMatch = output.match(/HTTP error (\d{3})/);
      if (httpErrorMatch) {
        const errorCode = httpErrorMatch[1];
        logger.error(`🚫 URL stream ${urlId}: Source returned HTTP ${errorCode}`);
        // Mark that we detected an HTTP error - will trigger reconnect on FFmpeg exit
        const stream = owner.activeStreams.get(urlId);
        if (stream) {
          stream._httpError = parseInt(errorCode);
        }
      }
    });

    ffmpegProcess.on('error', (err) => {
      logger.error({ err }, `❌ FFmpeg process error for ${urlId}`);
      owner._handleStreamError(urlId, 'ffmpeg', err);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      logger.debug(`📤 FFmpeg exited for ${urlId} with code ${code}, signal ${signal}`);

      // CRITICAL FIX: Handle code 0 exits that are actually errors
      // HTTP 403/404 errors cause FFmpeg to exit "successfully" with code 0
      const stream = owner.activeStreams.get(urlId);

      if (code !== 0 && code !== null) {
        owner._handleStreamError(urlId, 'ffmpeg', new Error(`Exit code ${code}`));
      } else if (code === 0 && stream && stream.status === 'streaming') {
        // FFmpeg exited with code 0 but stream was supposed to be running
        // This happens with HTTP 403, source going offline, etc.
        const httpError = stream._httpError;
        if (httpError) {
          logger.debug(`🔄 URL stream ${urlId}: FFmpeg exited normally after HTTP ${httpError}, triggering recovery`);
          owner._handleStreamError(urlId, 'ffmpeg', new Error(`Source HTTP error ${httpError}`));
        } else {
          logger.debug(`🔄 URL stream ${urlId}: FFmpeg exited normally while streaming, triggering recovery`);
          owner._handleStreamError(urlId, 'ffmpeg', new Error('Unexpected stream end'));
        }
      }
    });
  }

  /**
   * Wait for FFmpeg to start producing output
   * Fails fast if FFmpeg exits early (e.g., HTTP 404, connection refused)
   */
  waitForStream(ffmpegProcess, timeout) {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        clearTimeout(timer);
        ffmpegProcess.stderr.removeListener('data', checkOutput);
        ffmpegProcess.removeListener('exit', onExit);
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error('FFmpeg startup timeout'));
        }
      }, timeout);

      const checkOutput = (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('Stream mapping')) {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve();
          }
        }
      };

      // CRITICAL: Fail fast if FFmpeg exits before producing output
      // This happens with HTTP 404/403, connection refused, invalid URLs, etc.
      const onExit = (code) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`FFmpeg exited early with code ${code}`));
        }
      };

      ffmpegProcess.stderr.on('data', checkOutput);
      ffmpegProcess.on('exit', onExit);
    });
  }

  /**
   * Stop all processes for a stream
   * Properly waits for process termination with fallback to SIGKILL
   */
  async stopProcesses(streamEntry) {
    const logger = this.logger;
    const killPromises = streamEntry.processes.map(async ({ type, process }) => {
      if (!process || process.killed) {
        return;
      }

      const pid = process.pid;
      logger.debug(`🛑 Killing ${type} process (PID ${pid}) for ${streamEntry.urlId}`);

      return new Promise((resolve) => {
        let resolved = false;

        // Handle process exit
        const onExit = () => {
          if (!resolved) {
            resolved = true;
            logger.debug(`✅ ${type} process (PID ${pid}) terminated for ${streamEntry.urlId}`);
            resolve();
          }
        };

        process.once('exit', onExit);
        process.once('close', onExit);

        // Try SIGTERM first
        try {
          process.kill('SIGTERM');
        } catch (err) {
          // Process might already be dead
          if (err.code !== 'ESRCH') {
            logger.error(`⚠️ Error sending SIGTERM to ${type} (PID ${pid}):`, err.message);
          }
          if (!resolved) {
            resolved = true;
            resolve();
          }
          return;
        }

        // Force SIGKILL after 3 seconds if not dead
        setTimeout(() => {
          if (!resolved && !process.killed) {
            logger.debug(`⚠️ Force killing ${type} process (PID ${pid}) with SIGKILL`);
            try {
              process.kill('SIGKILL');
            } catch (err) {
              // Ignore errors - process may already be dead
            }
          }
        }, 3000);

        // Final timeout to prevent hanging - resolve after 5 seconds max
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            logger.debug(`⏱️ ${type} process (PID ${pid}) cleanup timeout - continuing`);
            resolve();
          }
        }, 5000);
      });
    });

    // Wait for all processes to be killed (with timeout protection)
    await Promise.all(killPromises);
    streamEntry.processes = [];
  }
}

module.exports = FFmpegPipeline;
