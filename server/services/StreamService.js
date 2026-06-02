const logger = require('../bootstrap/logger').child({ svc: 'StreamService' });

class StreamService {
  constructor() {
    this.currentStreamer = null;
    this.streamType = null;
    this.viewers = new Set();
    this.streamStartTime = null;
    // Strictly-monotonic sequence number bumped on every setStreamer /
    // clearStreamer call. Threaded through every stream-status emit via
    // getStreamStatus() so the client can drop out-of-order arrivals by
    // counter — the same problem the takeoverTargetRef 10-second lock
    // currently papers over (PR 2.5b deletes the lock and adopts the
    // counter on the client). The invariant the drop-by-counter check
    // needs is *strictly monotonic*, not "increments by exactly 1 per
    // semantic identity change" — compound transitions can bump by more
    // than 1 (e.g. the takeover viewbot-override path calls
    // clearStreamer() then setStreamer() with no emit between, going
    // N → N+2). Gaps are fine; backwards is not.
    this.streamGeneration = 0;
  }

  setStreamer(socketId, streamType = 'webcam') {
    this.currentStreamer = socketId;
    this.streamType = streamType;
    this.streamStartTime = Date.now();
    this.streamGeneration += 1;
    this.viewers.delete(socketId);

    // SYNC: Keep the LiveKit WebRTC service in sync to prevent
    // dual-source-of-truth issues.
    if (global.webrtcService) {
      global.webrtcService.currentStreamer = socketId;
    }
  }

  getCurrentStreamer() {
    return this.currentStreamer;
  }

  getStreamType() {
    return this.streamType;
  }

  clearStreamer() {
    const previousStreamer = this.currentStreamer;
    this.currentStreamer = null;
    this.streamType = null;
    this.streamStartTime = null;
    this.streamGeneration += 1;

    // SYNC: Keep the LiveKit WebRTC service in sync to prevent
    // dual-source-of-truth issues.
    if (global.webrtcService) {
      global.webrtcService.currentStreamer = null;
    }

    if (previousStreamer) {
      this.viewers.add(previousStreamer);
    }

    return previousStreamer;
  }

  getStreamGeneration() {
    return this.streamGeneration;
  }

  /**
   * Explicit bump for callers that emit a stream-status payload without
   * going through setStreamer/clearStreamer. Used by GameStreamService:
   * its start/stop emits build their own payload (the streamer is the
   * SYSTEM_GAME_STREAM sentinel, not a real socket), so it needs to bump
   * the generation itself so the client's drop-by-counter check fires.
   * Plain setStreamer/clearStreamer callers should NOT call this — they
   * already bump.
   */
  bumpStreamGeneration() {
    this.streamGeneration += 1;
    return this.streamGeneration;
  }

  addViewer(socketId) {
    this.viewers.add(socketId);
  }

  removeViewer(socketId) {
    this.viewers.delete(socketId);
  }

  getViewerCount() {
    return this.viewers.size;
  }

  getStreamStatus() {
    // Check both local currentStreamer and the LiveKit WebRTC service as fallback
    let hasActiveStream = !!this.currentStreamer;
    let streamerId = this.currentStreamer;

    // Fallback to the LiveKit WebRTC service if we don't have a currentStreamer.
    // This handles cases where anonymous streamers might not properly sync.
    if (!hasActiveStream && global.webrtcService) {
      const webrtcStreamer = global.webrtcService.currentStreamer;
      if (webrtcStreamer) {
        logger.debug(`⚠️ STREAM: Using LiveKit WebRTC fallback for stream status (found: ${webrtcStreamer})`);
        hasActiveStream = true;
        streamerId = webrtcStreamer;
      }
    }
    
    return {
      hasActiveStream,
      streamerId,
      streamType: this.streamType,
      viewerCount: this.viewers.size,
      streamStartTime: this.streamStartTime,
      streamDuration: this.streamStartTime ? Date.now() - this.streamStartTime : 0,
      streamGeneration: this.streamGeneration
    };
  }

  isStreaming(socketId) {
    return this.currentStreamer === socketId;
  }

  getAllViewers() {
    return Array.from(this.viewers);
  }
}

module.exports = StreamService;
