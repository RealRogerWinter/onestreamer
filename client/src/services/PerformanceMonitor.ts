/**
 * Performance monitoring service for WebRTC streaming
 * Tracks connection quality, resource usage, and system metrics
 */

export interface PerformanceMetrics {
  connection: {
    latency: number;
    jitter: number;
    packetLoss: number;
    bandwidth: {
      up: number;
      down: number;
    };
  };
  video: {
    resolution: { width: number; height: number };
    frameRate: number;
    bitrate: number;
    framesDropped: number;
    framesDecoded: number;
  };
  audio: {
    sampleRate: number;
    bitrate: number;
    audioLevel: number;
    jitterBuffer: number;
  };
  system: {
    cpuUsage: number;
    memoryUsage: number;
    networkType: string;
    batteryLevel?: number;
  };
}

export interface PerformanceAlert {
  type: 'warning' | 'critical';
  category: 'connection' | 'video' | 'audio' | 'system';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
}

export class PerformanceMonitor {
  private metrics: PerformanceMetrics;
  private alerts: PerformanceAlert[] = [];
  private monitoringInterval?: NodeJS.Timeout;
  private rtcStatsInterval?: NodeJS.Timeout;
  private peerConnection?: RTCPeerConnection;
  private lastStats?: RTCStatsReport;
  private isMonitoring = false;

  // Performance thresholds
  private readonly thresholds = {
    latency: { warning: 100, critical: 200 }, // ms
    packetLoss: { warning: 1, critical: 5 }, // %
    frameRate: { warning: 20, critical: 15 }, // fps
    cpuUsage: { warning: 70, critical: 90 }, // %
    memoryUsage: { warning: 80, critical: 95 } // %
  };

  private readonly callbacks: {
    onMetricsUpdate?: (metrics: PerformanceMetrics) => void;
    onAlert?: (alert: PerformanceAlert) => void;
    onQualityChange?: (quality: 'excellent' | 'good' | 'poor' | 'critical') => void;
  } = {};

  constructor() {
    this.metrics = this.initializeMetrics();
  }

  private initializeMetrics(): PerformanceMetrics {
    return {
      connection: {
        latency: 0,
        jitter: 0,
        packetLoss: 0,
        bandwidth: { up: 0, down: 0 }
      },
      video: {
        resolution: { width: 0, height: 0 },
        frameRate: 0,
        bitrate: 0,
        framesDropped: 0,
        framesDecoded: 0
      },
      audio: {
        sampleRate: 0,
        bitrate: 0,
        audioLevel: 0,
        jitterBuffer: 0
      },
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        networkType: 'unknown'
      }
    };
  }

  // Start monitoring
  startMonitoring(peerConnection?: RTCPeerConnection): void {
    if (this.isMonitoring) {
      console.warn('⚠️ PERFORMANCE: Monitoring already started');
      return;
    }

    this.isMonitoring = true;
    this.peerConnection = peerConnection;

    console.log('📊 PERFORMANCE: Starting performance monitoring');

    // Monitor system metrics every 5 seconds
    this.monitoringInterval = setInterval(() => {
      this.updateSystemMetrics();
    }, 5000);

    // Monitor WebRTC stats every 2 seconds if peer connection available
    if (this.peerConnection) {
      this.rtcStatsInterval = setInterval(() => {
        this.updateWebRTCStats();
      }, 2000);
    }

    // Initial metrics collection
    this.updateSystemMetrics();
    if (this.peerConnection) {
      this.updateWebRTCStats();
    }
  }

  // Stop monitoring
  stopMonitoring(): void {
    if (!this.isMonitoring) return;

    console.log('📊 PERFORMANCE: Stopping performance monitoring');

    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    if (this.rtcStatsInterval) {
      clearInterval(this.rtcStatsInterval);
      this.rtcStatsInterval = undefined;
    }

    this.peerConnection = undefined;
    this.lastStats = undefined;
  }

  // Set callback handlers
  setCallbacks(callbacks: typeof this.callbacks): void {
    Object.assign(this.callbacks, callbacks);
  }

  // Get current metrics
  getMetrics(): PerformanceMetrics {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  // Get recent alerts
  getAlerts(limit: number = 10): PerformanceAlert[] {
    return this.alerts.slice(-limit);
  }

  // Clear alerts
  clearAlerts(): void {
    this.alerts = [];
  }

  // Update system metrics
  private async updateSystemMetrics(): Promise<void> {
    try {
      // Memory usage
      if ('memory' in performance) {
        const memory = (performance as any).memory;
        const memoryUsage = (memory.usedJSHeapSize / memory.totalJSHeapSize) * 100;
        this.metrics.system.memoryUsage = Math.round(memoryUsage);
      }

      // Network information
      if ('connection' in navigator) {
        const connection = (navigator as any).connection;
        this.metrics.system.networkType = connection?.effectiveType || 'unknown';
      }

      // Battery information
      if ('getBattery' in navigator) {
        try {
          const battery = await (navigator as any).getBattery();
          this.metrics.system.batteryLevel = Math.round(battery.level * 100);
        } catch (error) {
          // Battery API not available
        }
      }

      // CPU usage estimation (rough approximation)
      const startTime = performance.now();
      const iterations = 10000;
      
      for (let i = 0; i < iterations; i++) {
        Math.random();
      }
      
      const endTime = performance.now();
      const executionTime = endTime - startTime;
      
      // Rough CPU usage estimation based on execution time
      const cpuUsage = Math.min((executionTime / 10) * 100, 100);
      this.metrics.system.cpuUsage = Math.round(cpuUsage);

      this.checkSystemAlerts();
      this.triggerCallbacks();
    } catch (error) {
      console.error('❌ PERFORMANCE: Failed to update system metrics:', error);
    }
  }

  // Update WebRTC statistics
  private async updateWebRTCStats(): Promise<void> {
    if (!this.peerConnection) return;

    try {
      const stats = await this.peerConnection.getStats();
      this.processWebRTCStats(stats);
      this.lastStats = stats;
    } catch (error) {
      console.error('❌ PERFORMANCE: Failed to get WebRTC stats:', error);
    }
  }

  // Process WebRTC statistics
  private processWebRTCStats(stats: RTCStatsReport): void {
    stats.forEach((stat) => {
      switch (stat.type) {
        case 'inbound-rtp':
          this.processInboundRTPStats(stat);
          break;
        case 'outbound-rtp':
          this.processOutboundRTPStats(stat);
          break;
        case 'remote-inbound-rtp':
          this.processRemoteInboundRTPStats(stat);
          break;
        case 'candidate-pair':
          this.processCandidatePairStats(stat);
          break;
        case 'media-source':
          this.processMediaSourceStats(stat);
          break;
      }
    });

    this.checkConnectionAlerts();
    this.triggerCallbacks();
  }

  // Process inbound RTP statistics
  private processInboundRTPStats(stat: any): void {
    if (stat.mediaType === 'video') {
      this.metrics.video.frameRate = stat.framesPerSecond || 0;
      this.metrics.video.framesDecoded = stat.framesDecoded || 0;
      this.metrics.video.framesDropped = stat.framesDropped || 0;
      this.metrics.video.bitrate = this.calculateBitrate(stat.bytesReceived, stat.timestamp);
      
      if (stat.frameWidth && stat.frameHeight) {
        this.metrics.video.resolution = {
          width: stat.frameWidth,
          height: stat.frameHeight
        };
      }
    } else if (stat.mediaType === 'audio') {
      this.metrics.audio.bitrate = this.calculateBitrate(stat.bytesReceived, stat.timestamp);
      this.metrics.audio.audioLevel = stat.audioLevel || 0;
      this.metrics.audio.jitterBuffer = stat.jitterBufferDelay || 0;
    }

    // Packet loss calculation
    if (stat.packetsLost && stat.packetsReceived) {
      const totalPackets = stat.packetsLost + stat.packetsReceived;
      this.metrics.connection.packetLoss = (stat.packetsLost / totalPackets) * 100;
    }
  }

  // Process outbound RTP statistics
  private processOutboundRTPStats(stat: any): void {
    if (stat.mediaType === 'video') {
      this.metrics.video.frameRate = stat.framesPerSecond || 0;
      this.metrics.video.bitrate = this.calculateBitrate(stat.bytesSent, stat.timestamp);
    } else if (stat.mediaType === 'audio') {
      this.metrics.audio.bitrate = this.calculateBitrate(stat.bytesSent, stat.timestamp);
    }
  }

  // Process remote inbound RTP statistics
  private processRemoteInboundRTPStats(stat: any): void {
    if (stat.roundTripTime) {
      this.metrics.connection.latency = stat.roundTripTime * 1000; // Convert to ms
    }
    if (stat.jitter) {
      this.metrics.connection.jitter = stat.jitter * 1000; // Convert to ms
    }
  }

  // Process candidate pair statistics
  private processCandidatePairStats(stat: any): void {
    if (stat.state === 'succeeded' && stat.nominated) {
      this.metrics.connection.bandwidth.up = stat.availableOutgoingBitrate || 0;
      this.metrics.connection.bandwidth.down = stat.availableIncomingBitrate || 0;
    }
  }

  // Process media source statistics
  private processMediaSourceStats(stat: any): void {
    if (stat.kind === 'audio' && stat.audioLevel !== undefined) {
      this.metrics.audio.audioLevel = stat.audioLevel;
    }
  }

  // Calculate bitrate from bytes and timestamp
  private calculateBitrate(bytes: number, timestamp: number): number {
    if (!this.lastStats) return 0;

    const lastStat = Array.from(this.lastStats.values()).find(
      s => s.type === 'inbound-rtp' || s.type === 'outbound-rtp'
    );

    if (!lastStat || !lastStat.bytesReceived && !lastStat.bytesSent) return 0;

    const lastBytes = lastStat.bytesReceived || lastStat.bytesSent || 0;
    const timeDiff = (timestamp - lastStat.timestamp) / 1000; // Convert to seconds
    
    if (timeDiff <= 0) return 0;

    const bytesDiff = bytes - lastBytes;
    return Math.round((bytesDiff * 8) / timeDiff); // Convert to bits per second
  }

  // Check for system-related alerts
  private checkSystemAlerts(): void {
    const { system } = this.metrics;

    // CPU usage alert
    if (system.cpuUsage >= this.thresholds.cpuUsage.critical) {
      this.addAlert('critical', 'system', 'High CPU usage detected', system.cpuUsage, this.thresholds.cpuUsage.critical);
    } else if (system.cpuUsage >= this.thresholds.cpuUsage.warning) {
      this.addAlert('warning', 'system', 'Elevated CPU usage', system.cpuUsage, this.thresholds.cpuUsage.warning);
    }

    // Memory usage alert
    if (system.memoryUsage >= this.thresholds.memoryUsage.critical) {
      this.addAlert('critical', 'system', 'High memory usage detected', system.memoryUsage, this.thresholds.memoryUsage.critical);
    } else if (system.memoryUsage >= this.thresholds.memoryUsage.warning) {
      this.addAlert('warning', 'system', 'Elevated memory usage', system.memoryUsage, this.thresholds.memoryUsage.warning);
    }
  }

  // Check for connection-related alerts
  private checkConnectionAlerts(): void {
    const { connection, video } = this.metrics;

    // Latency alerts
    if (connection.latency >= this.thresholds.latency.critical) {
      this.addAlert('critical', 'connection', 'High latency detected', connection.latency, this.thresholds.latency.critical);
    } else if (connection.latency >= this.thresholds.latency.warning) {
      this.addAlert('warning', 'connection', 'Elevated latency', connection.latency, this.thresholds.latency.warning);
    }

    // Packet loss alerts
    if (connection.packetLoss >= this.thresholds.packetLoss.critical) {
      this.addAlert('critical', 'connection', 'High packet loss detected', connection.packetLoss, this.thresholds.packetLoss.critical);
    } else if (connection.packetLoss >= this.thresholds.packetLoss.warning) {
      this.addAlert('warning', 'connection', 'Packet loss detected', connection.packetLoss, this.thresholds.packetLoss.warning);
    }

    // Frame rate alerts
    if (video.frameRate <= this.thresholds.frameRate.critical && video.frameRate > 0) {
      this.addAlert('critical', 'video', 'Very low frame rate', video.frameRate, this.thresholds.frameRate.critical);
    } else if (video.frameRate <= this.thresholds.frameRate.warning && video.frameRate > 0) {
      this.addAlert('warning', 'video', 'Low frame rate', video.frameRate, this.thresholds.frameRate.warning);
    }
  }

  // Add performance alert
  private addAlert(type: 'warning' | 'critical', category: PerformanceAlert['category'], message: string, value: number, threshold: number): void {
    const alert: PerformanceAlert = {
      type,
      category,
      message,
      value,
      threshold,
      timestamp: Date.now()
    };

    // Avoid duplicate alerts (same type and category within 10 seconds)
    const recentSimilar = this.alerts.find(a => 
      a.type === type && 
      a.category === category && 
      Date.now() - a.timestamp < 10000
    );

    if (!recentSimilar) {
      this.alerts.push(alert);
      
      // Limit alerts history
      if (this.alerts.length > 100) {
        this.alerts = this.alerts.slice(-50);
      }

      if (this.callbacks.onAlert) {
        this.callbacks.onAlert(alert);
      }

      console.warn(`⚠️ PERFORMANCE ${type.toUpperCase()}: ${message} (${value} >= ${threshold})`);
    }
  }

  // Determine overall connection quality
  private getConnectionQuality(): 'excellent' | 'good' | 'poor' | 'critical' {
    const { connection, video } = this.metrics;

    // Critical conditions
    if (connection.latency > this.thresholds.latency.critical ||
        connection.packetLoss > this.thresholds.packetLoss.critical ||
        video.frameRate < this.thresholds.frameRate.critical) {
      return 'critical';
    }

    // Poor conditions
    if (connection.latency > this.thresholds.latency.warning ||
        connection.packetLoss > this.thresholds.packetLoss.warning ||
        video.frameRate < this.thresholds.frameRate.warning) {
      return 'poor';
    }

    // Good conditions
    if (connection.latency > 50 || connection.packetLoss > 0.1) {
      return 'good';
    }

    // Excellent conditions
    return 'excellent';
  }

  // Trigger callbacks
  private triggerCallbacks(): void {
    if (this.callbacks.onMetricsUpdate) {
      this.callbacks.onMetricsUpdate(this.getMetrics());
    }

    if (this.callbacks.onQualityChange) {
      const currentQuality = this.getConnectionQuality();
      this.callbacks.onQualityChange(currentQuality);
    }
  }

  // Get performance summary
  getPerformanceSummary(): {
    quality: 'excellent' | 'good' | 'poor' | 'critical';
    metrics: PerformanceMetrics;
    alerts: PerformanceAlert[];
    recommendations: string[];
  } {
    const quality = this.getConnectionQuality();
    const recommendations = this.generateRecommendations();

    return {
      quality,
      metrics: this.getMetrics(),
      alerts: this.getAlerts(5),
      recommendations
    };
  }

  // Generate performance recommendations
  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const { connection, video, system } = this.metrics;

    if (connection.latency > this.thresholds.latency.warning) {
      recommendations.push('High latency detected. Check network connection or move closer to server.');
    }

    if (connection.packetLoss > this.thresholds.packetLoss.warning) {
      recommendations.push('Packet loss detected. Check network stability and consider wired connection.');
    }

    if (video.frameRate < this.thresholds.frameRate.warning) {
      recommendations.push('Low frame rate. Consider reducing video quality or closing other applications.');
    }

    if (system.cpuUsage > this.thresholds.cpuUsage.warning) {
      recommendations.push('High CPU usage. Close unnecessary applications to improve performance.');
    }

    if (system.memoryUsage > this.thresholds.memoryUsage.warning) {
      recommendations.push('High memory usage. Close browser tabs or applications to free up memory.');
    }

    if (video.resolution.width > 1920 && (connection.bandwidth.down < 5000000 || system.cpuUsage > 60)) {
      recommendations.push('Consider reducing video resolution for better performance on this connection.');
    }

    return recommendations;
  }
}

export default PerformanceMonitor;