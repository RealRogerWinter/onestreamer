/**
 * AdaptiveEncodingSettings.js - Calculate optimal encoding settings based on source stream
 *
 * Analyzes source stream properties and determines the best FFmpeg encoding parameters
 * to maximize quality while ensuring smooth playback.
 */

class AdaptiveEncodingSettings {
  constructor(options = {}) {
    // Configuration limits
    this.config = {
      // Maximum output resolution (can be overridden)
      maxWidth: options.maxWidth || 1920,
      maxHeight: options.maxHeight || 1080,

      // Minimum output resolution (don't go below this)
      minWidth: options.minWidth || 640,
      minHeight: options.minHeight || 360,

      // Bitrate limits (in kbps)
      maxVideoBitrate: options.maxVideoBitrate || 6000,  // 6 Mbps max
      minVideoBitrate: options.minVideoBitrate || 500,   // 500 kbps min
      maxAudioBitrate: options.maxAudioBitrate || 192,   // 192 kbps max
      minAudioBitrate: options.minAudioBitrate || 96,    // 96 kbps min

      // FPS limits
      maxFps: options.maxFps || 60,
      minFps: options.minFps || 24,

      // Quality mode: 'quality', 'balanced', 'performance'
      mode: options.mode || 'balanced',

      // Backend type: 'mediasoup' (VP8/RTP) or 'livekit' (H.264/RTMP)
      backend: options.backend || 'livekit'
    };

    // Preset profiles - ALL use fast encoding for real-time streaming
    // Quality differences come from bitrate/resolution, not encoder speed
    this.presets = {
      // Minimum CPU usage, lower bitrate
      performance: {
        x264Preset: 'ultrafast',
        vpxCpuUsed: 8,
        bitrateMultiplier: 0.7,
        allowUpscale: false
      },
      // Balance between quality and CPU (still fast for real-time)
      balanced: {
        x264Preset: 'superfast',
        vpxCpuUsed: 7,
        bitrateMultiplier: 0.85,
        allowUpscale: false
      },
      // Higher bitrate but still fast encoding for real-time
      quality: {
        x264Preset: 'superfast',  // NOT 'fast' - too slow for real-time
        vpxCpuUsed: 6,
        bitrateMultiplier: 1.0,
        allowUpscale: false       // Don't upscale - wastes bandwidth
      }
    };
  }

  /**
   * Calculate optimal encoding settings based on source stream properties
   * @param {object} sourceProps - Properties from StreamProbeService
   * @returns {object} Optimal encoding settings
   */
  calculate(sourceProps) {
    const preset = this.presets[this.config.mode];

    // Calculate target resolution
    const resolution = this._calculateResolution(sourceProps, preset);

    // Calculate target framerate
    const fps = this._calculateFps(sourceProps);

    // Calculate target bitrate based on resolution and content type
    const videoBitrate = this._calculateVideoBitrate(sourceProps, resolution, fps, preset);

    // Calculate audio bitrate
    const audioBitrate = this._calculateAudioBitrate(sourceProps);

    // Determine codec-specific settings
    const codecSettings = this.config.backend === 'mediasoup'
      ? this._getVpxSettings(preset, resolution, fps)
      : this._getX264Settings(preset, resolution, fps);

    // Build the complete settings object
    const settings = {
      // Resolution
      width: resolution.width,
      height: resolution.height,
      scale: resolution.scale,

      // Framerate
      fps,

      // Bitrates
      videoBitrate,
      maxrate: Math.round(videoBitrate * 1.15), // 15% headroom
      bufsize: videoBitrate * 2,
      audioBitrate,

      // Codec settings
      ...codecSettings,

      // Audio settings
      audioSampleRate: 48000,
      audioChannels: Math.min(sourceProps.audioChannels || 2, 2),

      // Keyframe interval (2 seconds worth of frames)
      gopSize: fps * 2,
      keyintMin: fps,

      // Metadata
      sourceWidth: sourceProps.width,
      sourceHeight: sourceProps.height,
      sourceFps: sourceProps.fps,
      sourceBitrate: sourceProps.videoBitrate,
      adaptiveMode: this.config.mode,
      backend: this.config.backend
    };

    console.log(`🎯 Adaptive Settings: ${sourceProps.width}x${sourceProps.height}@${sourceProps.fps}fps → ` +
               `${settings.width}x${settings.height}@${settings.fps}fps, ` +
               `video: ${settings.videoBitrate}kbps, audio: ${settings.audioBitrate}kbps`);

    return settings;
  }

  /**
   * Calculate target resolution based on source and limits
   */
  _calculateResolution(sourceProps, preset) {
    let targetWidth = sourceProps.width;
    let targetHeight = sourceProps.height;
    let scale = null;

    // Don't upscale unless in quality mode
    if (!preset.allowUpscale) {
      targetWidth = Math.min(targetWidth, this.config.maxWidth);
      targetHeight = Math.min(targetHeight, this.config.maxHeight);
    }

    // Cap at maximum resolution
    if (targetWidth > this.config.maxWidth || targetHeight > this.config.maxHeight) {
      const widthRatio = this.config.maxWidth / targetWidth;
      const heightRatio = this.config.maxHeight / targetHeight;
      const ratio = Math.min(widthRatio, heightRatio);

      targetWidth = Math.round(targetWidth * ratio);
      targetHeight = Math.round(targetHeight * ratio);
    }

    // Ensure minimum resolution
    if (targetWidth < this.config.minWidth) {
      const ratio = this.config.minWidth / targetWidth;
      targetWidth = this.config.minWidth;
      targetHeight = Math.round(targetHeight * ratio);
    }
    if (targetHeight < this.config.minHeight) {
      const ratio = this.config.minHeight / targetHeight;
      targetHeight = this.config.minHeight;
      targetWidth = Math.round(targetWidth * ratio);
    }

    // Round to even numbers (required by most codecs)
    targetWidth = Math.round(targetWidth / 2) * 2;
    targetHeight = Math.round(targetHeight / 2) * 2;

    // Determine if scaling is needed
    if (targetWidth !== sourceProps.width || targetHeight !== sourceProps.height) {
      // Use 'decrease' to maintain aspect ratio without upscaling
      if (targetWidth <= sourceProps.width && targetHeight <= sourceProps.height) {
        scale = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease`;
      } else {
        // Allow scaling with padding if needed
        scale = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
                `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`;
      }
    }

    return { width: targetWidth, height: targetHeight, scale };
  }

  /**
   * Calculate target framerate
   */
  _calculateFps(sourceProps) {
    let fps = sourceProps.fps || 30;

    // Clamp to limits
    fps = Math.max(this.config.minFps, Math.min(this.config.maxFps, fps));

    // Round to common framerates
    if (fps <= 25) fps = 24;
    else if (fps <= 32) fps = 30;
    else if (fps <= 50) fps = 30; // Cap high fps at 30 for performance mode
    else fps = 60;

    // In performance mode, cap at 30fps
    if (this.config.mode === 'performance' && fps > 30) {
      fps = 30;
    }

    return fps;
  }

  /**
   * Calculate video bitrate based on resolution, fps, and content
   */
  _calculateVideoBitrate(sourceProps, resolution, fps, preset) {
    // Base bitrate calculation (pixels per second * bits per pixel)
    const pixelsPerSecond = resolution.width * resolution.height * fps;

    // Target bits per pixel varies by content complexity
    // Gaming/fast motion: ~0.1, talking head: ~0.05, static: ~0.03
    const bitsPerPixel = 0.08; // Default balanced value

    let baseBitrate = Math.round((pixelsPerSecond * bitsPerPixel) / 1000); // kbps

    // Common bitrate targets by resolution
    const bitrateTargets = {
      '1920x1080': { min: 3000, ideal: 4500, max: 6000 },
      '1280x720': { min: 1500, ideal: 2500, max: 4000 },
      '854x480': { min: 750, ideal: 1200, max: 2000 },
      '640x360': { min: 400, ideal: 750, max: 1200 }
    };

    // Find closest resolution target
    const resKey = Object.keys(bitrateTargets).find(k => {
      const [w, h] = k.split('x').map(Number);
      return Math.abs(w - resolution.width) < 100 && Math.abs(h - resolution.height) < 100;
    }) || '1280x720';

    const target = bitrateTargets[resKey];

    // Use ideal bitrate, adjusted by preset multiplier
    let bitrate = Math.round(target.ideal * preset.bitrateMultiplier);

    // Adjust for high framerate
    if (fps > 30) {
      bitrate = Math.round(bitrate * 1.3); // 30% more for 60fps
    }

    // Don't exceed source bitrate (if known)
    if (sourceProps.videoBitrate > 0) {
      const sourceBitrateKbps = sourceProps.videoBitrate / 1000;
      // Allow up to 110% of source bitrate (some overhead for re-encoding)
      bitrate = Math.min(bitrate, Math.round(sourceBitrateKbps * 1.1));
    }

    // Clamp to configured limits
    bitrate = Math.max(this.config.minVideoBitrate, Math.min(this.config.maxVideoBitrate, bitrate));

    return bitrate;
  }

  /**
   * Calculate audio bitrate
   */
  _calculateAudioBitrate(sourceProps) {
    if (!sourceProps.hasAudio) {
      return 0;
    }

    // Start with source bitrate
    let bitrate = Math.round((sourceProps.audioBitrate || 128000) / 1000);

    // Clamp to limits
    bitrate = Math.max(this.config.minAudioBitrate, Math.min(this.config.maxAudioBitrate, bitrate));

    // Round to common values
    if (bitrate <= 112) return 96;
    if (bitrate <= 144) return 128;
    if (bitrate <= 176) return 160;
    return 192;
  }

  /**
   * Get VP8/VP9 specific settings for MediaSoup
   */
  _getVpxSettings(preset, resolution, fps) {
    return {
      codec: 'libvpx',
      deadline: 'realtime',
      cpuUsed: preset.vpxCpuUsed,
      audioCodec: 'libopus'
    };
  }

  /**
   * Get H.264 specific settings for LiveKit
   */
  _getX264Settings(preset, resolution, fps) {
    // Determine profile based on resolution
    let profile = 'main';
    let level = '3.1';

    if (resolution.height > 720) {
      profile = 'high';
      level = '4.1';
    } else if (resolution.height <= 480) {
      profile = 'baseline';
      level = '3.0';
    }

    return {
      codec: 'libx264',
      preset: preset.x264Preset,
      profile,
      level,
      pixFmt: 'yuv420p',
      audioCodec: 'aac',
      scThreshold: 0 // Disable scene change detection for consistent keyframes
    };
  }

  /**
   * Build FFmpeg video filter string
   */
  buildVideoFilter(settings) {
    const filters = [];

    // Scaling filter (if needed)
    if (settings.scale) {
      filters.push(settings.scale);
    }

    // FPS filter (if source fps differs significantly)
    if (settings.sourceFps && Math.abs(settings.sourceFps - settings.fps) > 2) {
      filters.push(`fps=${settings.fps}`);
    }

    return filters.length > 0 ? filters.join(',') : null;
  }

  /**
   * Build complete FFmpeg arguments for the calculated settings
   */
  buildFFmpegArgs(settings, input, output, options = {}) {
    const args = [];

    // Input flags
    args.push('-fflags', '+genpts+discardcorrupt');

    if (input !== '-' && !options.noRe) {
      args.push('-re');
    }

    args.push('-i', input);

    // Video filter (scaling/fps)
    const vf = this.buildVideoFilter(settings);
    if (vf) {
      args.push('-vf', vf);
    }

    // Video encoding
    if (settings.codec === 'libvpx') {
      // VP8 for MediaSoup
      args.push(
        '-map', '0:v:0',
        '-c:v', settings.codec,
        '-deadline', settings.deadline,
        '-cpu-used', String(settings.cpuUsed),
        '-b:v', `${settings.videoBitrate}k`,
        '-maxrate', `${settings.maxrate}k`,
        '-bufsize', `${settings.bufsize}k`,
        '-g', String(settings.gopSize),
        '-keyint_min', String(settings.keyintMin)
      );
    } else {
      // H.264 for LiveKit
      args.push(
        '-c:v', settings.codec,
        '-preset', settings.preset,
        '-profile:v', settings.profile,
        '-level', settings.level,
        '-b:v', `${settings.videoBitrate}k`,
        '-maxrate', `${settings.maxrate}k`,
        '-bufsize', `${settings.bufsize}k`,
        '-pix_fmt', settings.pixFmt,
        '-r', String(settings.fps),
        '-g', String(settings.gopSize),
        '-keyint_min', String(settings.keyintMin),
        '-sc_threshold', String(settings.scThreshold)
      );
    }

    // Audio encoding
    if (settings.audioBitrate > 0) {
      args.push(
        settings.codec === 'libvpx' ? '-map' : null,
        settings.codec === 'libvpx' ? '0:a:0?' : null,
        '-c:a', settings.audioCodec,
        '-b:a', `${settings.audioBitrate}k`,
        '-ar', String(settings.audioSampleRate),
        '-ac', String(settings.audioChannels)
      ).filter(Boolean);
    } else {
      args.push('-an'); // No audio
    }

    // Output format and destination
    if (output.format === 'rtp') {
      args.push('-f', 'rtp', output.videoUrl);
      if (settings.audioBitrate > 0) {
        args.push('-f', 'rtp', output.audioUrl);
      }
    } else if (output.format === 'flv') {
      args.push('-f', 'flv', output.url);
    }

    return args;
  }

  /**
   * Update configuration
   */
  setConfig(newConfig) {
    Object.assign(this.config, newConfig);
    console.log('🎯 Adaptive Settings config updated:', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return { ...this.config };
  }
}

module.exports = AdaptiveEncodingSettings;
