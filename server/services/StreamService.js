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
    return {
      hasActiveStream: !!this.currentStreamer,
      streamerId: this.currentStreamer,
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