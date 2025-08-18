const TestStreamService = require('../services/TestStreamService');

describe('TestStreamService', () => {
  let testStreamService;

  beforeEach(() => {
    testStreamService = new TestStreamService();
  });

  describe('startTestStream', () => {
    test('should start test stream successfully', () => {
      const result = testStreamService.startTestStream();
      
      expect(result.success).toBe(true);
      expect(result.message).toBe('Test stream started');
      expect(result.streamId).toMatch(/^test-/);
      expect(result.config).toMatchObject({
        type: 'test',
        content: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30
      });
    });

    test('should not start if already active', () => {
      testStreamService.startTestStream();
      const result = testStreamService.startTestStream();
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Test stream is already active');
    });
  });

  describe('stopTestStream', () => {
    test('should stop active test stream', () => {
      const startResult = testStreamService.startTestStream();
      const stopResult = testStreamService.stopTestStream();
      
      expect(stopResult.success).toBe(true);
      expect(stopResult.message).toBe('Test stream stopped');
      expect(stopResult.streamId).toBe(startResult.streamId);
    });

    test('should not stop if no active stream', () => {
      const result = testStreamService.stopTestStream();
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('No active test stream to stop');
    });
  });

  describe('getTestStreamStatus', () => {
    test('should return inactive status by default', () => {
      const status = testStreamService.getTestStreamStatus();
      
      expect(status).toMatchObject({
        isActive: false,
        streamId: null,
        startTime: null,
        duration: 0
      });
      expect(status.config).toMatchObject({
        type: 'test',
        content: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30
      });
    });

    test('should return active status when streaming', () => {
      const startTime = Date.now();
      testStreamService.startTestStream();
      
      const status = testStreamService.getTestStreamStatus();
      
      expect(status.isActive).toBe(true);
      expect(status.streamId).toMatch(/^test-/);
      expect(status.startTime).toBeGreaterThanOrEqual(startTime);
      expect(status.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('updateTestStreamConfig', () => {
    test('should update valid configuration', () => {
      const newConfig = {
        content: 'noise',
        width: 1920,
        height: 1080,
        frameRate: 60
      };
      
      const result = testStreamService.updateTestStreamConfig(newConfig);
      
      expect(result.success).toBe(true);
      expect(result.message).toBe('Test stream configuration updated');
      expect(result.config).toMatchObject({
        type: 'test',
        content: 'noise',
        width: 1920,
        height: 1080,
        frameRate: 60
      });
    });

    test('should reject invalid content type', () => {
      const result = testStreamService.updateTestStreamConfig({ content: 'invalid' });
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid stream content type');
    });

    test('should reject invalid stream type', () => {
      const result = testStreamService.updateTestStreamConfig({ type: 'invalid' });
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid stream type');
    });
  });

  describe('generateTestFrame', () => {
    test('should generate frame data when active', () => {
      testStreamService.startTestStream();
      
      const frame = testStreamService.generateTestFrame();
      
      expect(frame).toHaveProperty('type', 'test-frame');
      expect(frame).toHaveProperty('timestamp');
      expect(frame).toHaveProperty('uptime');
      expect(frame).toHaveProperty('frameNumber');
      expect(frame).toHaveProperty('config');
      expect(frame).toHaveProperty('data');
    });

    test('should generate different content based on config', () => {
      testStreamService.startTestStream();
      testStreamService.updateTestStreamConfig({ content: 'noise' });
      
      const frame = testStreamService.generateTestFrame();
      
      expect(frame.data.pattern).toBe('random noise');
      expect(frame.data).toHaveProperty('seed');
    });

    test('should generate clock content', () => {
      testStreamService.startTestStream();
      testStreamService.updateTestStreamConfig({ content: 'clock' });
      
      const frame = testStreamService.generateTestFrame();
      
      expect(frame.data.pattern).toBe('digital clock');
      expect(frame.data).toHaveProperty('time');
      expect(frame.data).toHaveProperty('date');
    });
  });

  describe('isTestStream', () => {
    test('should identify test stream IDs', () => {
      expect(testStreamService.isTestStream('test-12345')).toBe(true);
      expect(testStreamService.isTestStream('regular-stream')).toBe(false);
      expect(testStreamService.isTestStream(null)).toBeFalsy();
    });
  });

  describe('getTestStreamMetrics', () => {
    test('should return null when not active', () => {
      const metrics = testStreamService.getTestStreamMetrics();
      expect(metrics).toBe(null);
    });

    test('should return metrics when active', () => {
      testStreamService.startTestStream();
      
      const metrics = testStreamService.getTestStreamMetrics();
      
      expect(metrics).toHaveProperty('streamId');
      expect(metrics).toHaveProperty('duration');
      expect(metrics).toHaveProperty('totalFrames');
      expect(metrics).toHaveProperty('frameRate', 30);
      expect(metrics).toHaveProperty('resolution', '1280x720');
      expect(metrics).toHaveProperty('bitrate');
      expect(metrics).toHaveProperty('lastFrameTime');
    });
  });

  describe('calculateEstimatedBitrate', () => {
    test('should calculate bitrate based on resolution and framerate', () => {
      const bitrate = testStreamService.calculateEstimatedBitrate();
      
      expect(typeof bitrate).toBe('number');
      expect(bitrate).toBeGreaterThan(0);
    });

    test('should calculate higher bitrate for higher resolution', () => {
      const lowResBitrate = testStreamService.calculateEstimatedBitrate();
      
      testStreamService.updateTestStreamConfig({ width: 1920, height: 1080 });
      const highResBitrate = testStreamService.calculateEstimatedBitrate();
      
      expect(highResBitrate).toBeGreaterThan(lowResBitrate);
    });
  });
});