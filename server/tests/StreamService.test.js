const StreamService = require('../services/StreamService');

describe('StreamService', () => {
  let streamService;

  beforeEach(() => {
    streamService = new StreamService();
  });

  describe('setStreamer', () => {
    test('should set a streamer with default webcam type', () => {
      const socketId = 'socket123';
      streamService.setStreamer(socketId);

      expect(streamService.getCurrentStreamer()).toBe(socketId);
      expect(streamService.getStreamType()).toBe('webcam');
      expect(streamService.streamStartTime).toBeTruthy();
    });

    test('should set a streamer with custom stream type', () => {
      const socketId = 'socket123';
      streamService.setStreamer(socketId, 'screen');

      expect(streamService.getCurrentStreamer()).toBe(socketId);
      expect(streamService.getStreamType()).toBe('screen');
    });

    test('should remove streamer from viewers when they become streamer', () => {
      const socketId = 'socket123';
      streamService.addViewer(socketId);
      expect(streamService.getViewerCount()).toBe(1);

      streamService.setStreamer(socketId);
      expect(streamService.getViewerCount()).toBe(0);
    });
  });

  describe('clearStreamer', () => {
    test('should clear current streamer and add back to viewers', () => {
      const socketId = 'socket123';
      streamService.setStreamer(socketId);
      
      const clearedStreamer = streamService.clearStreamer();
      
      expect(clearedStreamer).toBe(socketId);
      expect(streamService.getCurrentStreamer()).toBe(null);
      expect(streamService.getStreamType()).toBe(null);
      expect(streamService.streamStartTime).toBe(null);
      expect(streamService.getViewerCount()).toBe(1);
    });

    test('should return null when no streamer to clear', () => {
      const clearedStreamer = streamService.clearStreamer();
      expect(clearedStreamer).toBe(null);
    });
  });

  describe('viewer management', () => {
    test('should add and remove viewers', () => {
      const viewer1 = 'viewer1';
      const viewer2 = 'viewer2';

      streamService.addViewer(viewer1);
      streamService.addViewer(viewer2);
      expect(streamService.getViewerCount()).toBe(2);

      streamService.removeViewer(viewer1);
      expect(streamService.getViewerCount()).toBe(1);

      const allViewers = streamService.getAllViewers();
      expect(allViewers).toContain(viewer2);
      expect(allViewers).not.toContain(viewer1);
    });

    test('should not add duplicate viewers', () => {
      const viewer = 'viewer1';
      streamService.addViewer(viewer);
      streamService.addViewer(viewer);
      
      expect(streamService.getViewerCount()).toBe(1);
    });
  });

  describe('getStreamStatus', () => {
    test('should return correct status when no stream is active', () => {
      const status = streamService.getStreamStatus();
      
      expect(status).toEqual({
        hasActiveStream: false,
        streamerId: null,
        streamType: null,
        viewerCount: 0,
        streamStartTime: null,
        streamDuration: 0
      });
    });

    test('should return correct status when stream is active', () => {
      const socketId = 'socket123';
      const startTime = Date.now();
      
      streamService.setStreamer(socketId, 'webcam');
      streamService.addViewer('viewer1');
      streamService.addViewer('viewer2');
      
      const status = streamService.getStreamStatus();
      
      expect(status.hasActiveStream).toBe(true);
      expect(status.streamerId).toBe(socketId);
      expect(status.streamType).toBe('webcam');
      expect(status.viewerCount).toBe(2);
      expect(status.streamStartTime).toBeGreaterThanOrEqual(startTime);
      expect(status.streamDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isStreaming', () => {
    test('should return true for current streamer', () => {
      const socketId = 'socket123';
      streamService.setStreamer(socketId);
      
      expect(streamService.isStreaming(socketId)).toBe(true);
    });

    test('should return false for non-streamer', () => {
      const socketId = 'socket123';
      streamService.setStreamer(socketId);
      
      expect(streamService.isStreaming('other')).toBe(false);
    });

    test('should return false when no streamer is set', () => {
      expect(streamService.isStreaming('anyone')).toBe(false);
    });
  });
});