const { v4: uuidv4 } = require('uuid');

class TestStreamService {
  constructor() {
    this.isTestStreamActive = false;
    this.testStreamId = null;
    this.streamStartTime = null;
    this.testStreamConfig = {
      type: 'test',
      content: 'color-bars',
      width: 1280,
      height: 720,
      frameRate: 30
    };
  }

  startTestStream(options = {}) {
    if (this.isTestStreamActive) {
      return { success: false, message: 'Test stream is already active' };
    }

    // Update config if provided
    if (options.config) {
      this.testStreamConfig = {
        ...this.testStreamConfig,
        ...options.config
      };
    }

    this.isTestStreamActive = true;
    this.testStreamId = `test-${uuidv4()}`;
    this.streamStartTime = Date.now();
    this.hasRealStream = options.hasRealStream || false;

    return {
      success: true,
      message: `Test stream started${this.hasRealStream ? ' with real media generation' : ''}`,
      streamId: this.testStreamId,
      config: this.testStreamConfig,
      hasRealStream: this.hasRealStream
    };
  }

  stopTestStream() {
    if (!this.isTestStreamActive) {
      return { success: false, message: 'No active test stream to stop' };
    }

    this.isTestStreamActive = false;
    const stoppedStreamId = this.testStreamId;
    this.testStreamId = null;
    this.streamStartTime = null;

    return {
      success: true,
      message: 'Test stream stopped',
      streamId: stoppedStreamId
    };
  }

  getTestStreamStatus() {
    return {
      isActive: this.isTestStreamActive,
      streamId: this.testStreamId,
      startTime: this.streamStartTime,
      duration: this.streamStartTime ? Date.now() - this.streamStartTime : 0,
      config: this.testStreamConfig
    };
  }

  updateTestStreamConfig(config) {
    const allowedTypes = ['color-bars', 'noise', 'gradient', 'text'];
    const allowedContent = ['color-bars', 'noise', 'gradient', 'moving-text', 'clock'];

    if (config.type && !allowedTypes.includes(config.type)) {
      return { success: false, message: 'Invalid stream type' };
    }

    if (config.content && !allowedContent.includes(config.content)) {
      return { success: false, message: 'Invalid stream content type' };
    }

    // Update configuration
    this.testStreamConfig = {
      ...this.testStreamConfig,
      ...config
    };

    return {
      success: true,
      message: 'Test stream configuration updated',
      config: this.testStreamConfig
    };
  }

  generateTestFrame() {
    const timestamp = new Date().toISOString();
    const uptime = this.streamStartTime ? Math.floor((Date.now() - this.streamStartTime) / 1000) : 0;
    
    return {
      type: 'test-frame',
      timestamp,
      uptime,
      frameNumber: Math.floor(uptime * this.testStreamConfig.frameRate),
      config: this.testStreamConfig,
      data: this.generateFrameData()
    };
  }

  generateFrameData() {
    const { content } = this.testStreamConfig;
    
    switch (content) {
      case 'color-bars':
        return {
          pattern: 'SMPTE color bars',
          colors: ['white', 'yellow', 'cyan', 'green', 'magenta', 'red', 'blue', 'black']
        };
      case 'noise':
        return {
          pattern: 'random noise',
          seed: Math.random()
        };
      case 'gradient':
        return {
          pattern: 'linear gradient',
          direction: 'horizontal',
          colors: ['#ff0000', '#00ff00', '#0000ff']
        };
      case 'moving-text':
        return {
          pattern: 'scrolling text',
          text: `OneStreamer Test Stream - Uptime: ${Math.floor((Date.now() - this.streamStartTime) / 1000)}s`,
          position: (Date.now() % 10000) / 100
        };
      case 'clock':
        return {
          pattern: 'digital clock',
          time: new Date().toLocaleTimeString(),
          date: new Date().toLocaleDateString()
        };
      default:
        return { pattern: 'solid color', color: '#808080' };
    }
  }

  isTestStream(streamId) {
    return streamId && streamId.startsWith('test-');
  }

  getTestStreamMetrics() {
    if (!this.isTestStreamActive) {
      return null;
    }

    const now = Date.now();
    const duration = now - this.streamStartTime;
    const frames = Math.floor(duration / 1000 * this.testStreamConfig.frameRate);

    return {
      streamId: this.testStreamId,
      duration,
      totalFrames: frames,
      frameRate: this.testStreamConfig.frameRate,
      resolution: `${this.testStreamConfig.width}x${this.testStreamConfig.height}`,
      bitrate: this.calculateEstimatedBitrate(),
      lastFrameTime: now
    };
  }

  calculateEstimatedBitrate() {
    const { width, height, frameRate } = this.testStreamConfig;
    const pixelsPerFrame = width * height;
    const pixelsPerSecond = pixelsPerFrame * frameRate;
    // Rough estimate: 3 bytes per pixel for RGB, with compression factor
    const estimatedBitrate = Math.floor((pixelsPerSecond * 3 * 0.1) / 1000); // kbps
    return estimatedBitrate;
  }
}

module.exports = TestStreamService;