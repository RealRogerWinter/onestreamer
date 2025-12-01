class StreamService {
  constructor() {
    this.currentStreamer = null;
    this.streamType = null;
    this.viewers = new Set();
    this.streamStartTime = null;
  }

  setStreamer(socketId, streamType = 'webcam') {
    this.currentStreamer = socketId;
    this.streamType = streamType;
    this.streamStartTime = Date.now();
    this.viewers.delete(socketId);

    // SYNC: Keep MediasoupService in sync to prevent dual-source-of-truth issues
    if (global.mediasoupService) {
      global.mediasoupService.currentStreamer = socketId;
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

    // SYNC: Keep MediasoupService in sync to prevent dual-source-of-truth issues
    if (global.mediasoupService) {
      global.mediasoupService.currentStreamer = null;
    }

    if (previousStreamer) {
      this.viewers.add(previousStreamer);
    }

    return previousStreamer;
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
    // Check both local currentStreamer and MediaSoup service as fallback
    let hasActiveStream = !!this.currentStreamer;
    let streamerId = this.currentStreamer;
    
    // Fallback to MediaSoup service if we don't have a currentStreamer
    // This handles cases where anonymous streamers might not properly sync
    if (!hasActiveStream && global.mediasoupService) {
      const mediasoupStreamer = global.mediasoupService.currentStreamer;
      if (mediasoupStreamer) {
        console.log(`⚠️ STREAM: Using MediaSoup fallback for stream status (found: ${mediasoupStreamer})`);
        hasActiveStream = true;
        streamerId = mediasoupStreamer;
      }
    }
    
    return {
      hasActiveStream,
      streamerId,
      streamType: this.streamType,
      viewerCount: this.viewers.size,
      streamStartTime: this.streamStartTime,
      streamDuration: this.streamStartTime ? Date.now() - this.streamStartTime : 0
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