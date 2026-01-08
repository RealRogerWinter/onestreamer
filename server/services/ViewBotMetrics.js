/**
 * ViewBotMetrics - Tracks and reports metrics for ViewBot instances
 */
class ViewBotMetrics {
  constructor(botId) {
    this.botId = botId;
    this.startTime = null;
    this.endTime = null;
    
    // Performance metrics
    this.fps = 0;
    this.bitrate = 0;
    this.packetLoss = 0;
    this.latency = 0;
    this.bandwidth = 0;
    
    // Resource metrics
    this.cpuUsage = 0;
    this.memoryUsage = 0;
    
    // Stream metrics
    this.framesSent = 0;
    this.packetsLost = 0;
    this.packetsSent = 0;
    this.bytesSent = 0;
    
    // History tracking
    this.history = {
      fps: [],
      bitrate: [],
      latency: [],
      bandwidth: []
    };
    
    // Update interval
    this.updateInterval = null;
    this.historyMaxLength = 60; // Keep last 60 data points
  }
  
  /**
   * Start metrics tracking
   */
  start() {
    this.startTime = Date.now();
    this.endTime = null;
    
    // Start metrics update loop
    this.updateInterval = setInterval(() => {
      this.updateMetrics();
    }, 1000);
  }
  
  /**
   * Stop metrics tracking
   */
  stop() {
    this.endTime = Date.now();
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
  
  /**
   * Update metrics (simulated for now, can be connected to real data sources)
   */
  updateMetrics() {
    // Simulate metrics with some variance
    this.fps = Math.floor(25 + Math.random() * 5);
    this.bitrate = Math.floor(2000 + Math.random() * 3000);
    this.latency = Math.floor(10 + Math.random() * 40);
    this.bandwidth = Math.floor(5 + Math.random() * 10);
    this.packetLoss = Math.random() * 2;
    
    // Simulate resource usage
    this.cpuUsage = Math.floor(20 + Math.random() * 30);
    this.memoryUsage = Math.floor(30 + Math.random() * 40);
    
    // Update counters
    this.framesSent += this.fps;
    this.packetsSent += Math.floor(this.fps * 10);
    this.packetsLost += Math.floor(this.packetsSent * (this.packetLoss / 100));
    this.bytesSent += Math.floor(this.bitrate * 125); // Convert kbps to bytes
    
    // Update history
    this.addToHistory('fps', this.fps);
    this.addToHistory('bitrate', this.bitrate);
    this.addToHistory('latency', this.latency);
    this.addToHistory('bandwidth', this.bandwidth);
  }
  
  /**
   * Add value to history, maintaining max length
   */
  addToHistory(metric, value) {
    if (!this.history[metric]) {
      this.history[metric] = [];
    }
    
    this.history[metric].push({
      timestamp: Date.now(),
      value: value
    });
    
    // Keep only last N data points
    if (this.history[metric].length > this.historyMaxLength) {
      this.history[metric].shift();
    }
  }
  
  /**
   * Get current metrics snapshot
   */
  getSnapshot() {
    const duration = this.getDuration();
    
    return {
      botId: this.botId,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: duration,
      fps: this.fps,
      bitrate: this.bitrate,
      packetLoss: this.packetLoss,
      latency: this.latency,
      bandwidth: this.bandwidth,
      cpuUsage: this.cpuUsage,
      memoryUsage: this.memoryUsage,
      framesSent: this.framesSent,
      packetsLost: this.packetsLost,
      packetsSent: this.packetsSent,
      bytesSent: this.bytesSent,
      avgFps: this.getAverage('fps'),
      avgBitrate: this.getAverage('bitrate'),
      avgLatency: this.getAverage('latency'),
      avgBandwidth: this.getAverage('bandwidth')
    };
  }
  
  /**
   * Get duration in seconds
   */
  getDuration() {
    if (!this.startTime) return 0;
    const endTime = this.endTime || Date.now();
    return Math.floor((endTime - this.startTime) / 1000);
  }
  
  /**
   * Get average value for a metric
   */
  getAverage(metric) {
    const history = this.history[metric];
    if (!history || history.length === 0) return 0;
    
    const sum = history.reduce((acc, item) => acc + item.value, 0);
    return Math.round(sum / history.length);
  }
  
  /**
   * Get metrics history for charting
   */
  getHistory(metric) {
    return this.history[metric] || [];
  }
  
  /**
   * Get all metrics history
   */
  getAllHistory() {
    return this.history;
  }
  
  /**
   * Reset metrics
   */
  reset() {
    this.stop();
    
    this.fps = 0;
    this.bitrate = 0;
    this.packetLoss = 0;
    this.latency = 0;
    this.bandwidth = 0;
    this.cpuUsage = 0;
    this.memoryUsage = 0;
    this.framesSent = 0;
    this.packetsLost = 0;
    this.packetsSent = 0;
    this.bytesSent = 0;
    
    Object.keys(this.history).forEach(key => {
      this.history[key] = [];
    });
  }
  
  /**
   * Set metrics from external source (e.g., WebRTC stats)
   */
  setFromWebRTCStats(stats) {
    if (stats.video) {
      this.fps = stats.video.framesPerSecond || this.fps;
      this.framesSent = stats.video.framesSent || this.framesSent;
    }
    
    if (stats.audio) {
      // Process audio stats if needed
    }
    
    if (stats.transport) {
      this.bytesSent = stats.transport.bytesSent || this.bytesSent;
      this.packetsSent = stats.transport.packetsSent || this.packetsSent;
      this.packetsLost = stats.transport.packetsLost || this.packetsLost;
      
      // Calculate packet loss percentage
      if (this.packetsSent > 0) {
        this.packetLoss = (this.packetsLost / this.packetsSent) * 100;
      }
    }
    
    if (stats.candidate) {
      // Extract latency from candidate pair stats
      if (stats.candidate.currentRoundTripTime) {
        this.latency = Math.round(stats.candidate.currentRoundTripTime * 1000); // Convert to ms
      }
    }
    
    // Calculate bitrate from bytes sent
    if (this.bytesSent > 0 && this.getDuration() > 0) {
      this.bitrate = Math.floor((this.bytesSent * 8) / (this.getDuration() * 1000)); // kbps
    }
  }
}

module.exports = ViewBotMetrics;