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
        streamDuration: 0,
        streamGeneration: 0
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

  describe('streamGeneration (PR 2.5)', () => {
    // Monotonic sequence number threaded through every stream-status emit
    // via getStreamStatus(). The client adoption (drop-by-counter +
    // delete the takeoverTargetRef 10-second lock at App.tsx:272-323)
    // lands in PR 2.5b; this PR adds the server-side seam.

    test('starts at 0 on construction', () => {
      expect(streamService.getStreamGeneration()).toBe(0);
      expect(streamService.getStreamStatus().streamGeneration).toBe(0);
    });

    test('setStreamer increments the counter', () => {
      streamService.setStreamer('socket-A');
      expect(streamService.getStreamGeneration()).toBe(1);

      // Re-setStreamer (takeover replacement) bumps again.
      streamService.setStreamer('socket-B');
      expect(streamService.getStreamGeneration()).toBe(2);
    });

    test('clearStreamer increments the counter (every call, not "every state change")', () => {
      streamService.setStreamer('socket-A');
      expect(streamService.getStreamGeneration()).toBe(1);

      streamService.clearStreamer();
      expect(streamService.getStreamGeneration()).toBe(2);

      // Per the spec at StreamService.js:7-17, the counter is strictly
      // monotonic and bumps on *every* setStreamer/clearStreamer call —
      // it is intentionally not 1:1 with semantic identity changes.
      // A second clearStreamer (no-op for streamer state) still bumps.
      // The client's drop-by-counter check only needs monotonicity, and
      // tying the bump to "did state semantically change?" would create
      // gaps that race against the call site (e.g. the viewbot-override
      // path in MediaSoupHandler.js issues clearStreamer→setStreamer
      // back-to-back with no emit in between — N→N+2 is fine; bumping
      // only on real changes would force introspection that's worse).
      streamService.clearStreamer();
      expect(streamService.getStreamGeneration()).toBe(3);
    });

    test('getStreamStatus reflects the current generation', () => {
      streamService.setStreamer('socket-A');
      streamService.setStreamer('socket-B');
      streamService.clearStreamer();

      const status = streamService.getStreamStatus();
      expect(status.streamGeneration).toBe(3);
    });

    test('viewer add/remove does NOT bump the generation', () => {
      // Viewer count is part of the stream-status payload but a viewer
      // join/leave shouldn't invalidate prior stream-state messages —
      // only stream-identity changes do.
      streamService.setStreamer('socket-A');
      const before = streamService.getStreamGeneration();

      streamService.addViewer('viewer-1');
      streamService.addViewer('viewer-2');
      streamService.removeViewer('viewer-1');

      expect(streamService.getStreamGeneration()).toBe(before);
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