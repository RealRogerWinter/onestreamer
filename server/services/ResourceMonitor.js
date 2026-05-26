/**
 * Server-side resource monitoring for OneStreamer
 * Tracks system resources, connection metrics, and performance
 */

const os = require('os');
const process = require('process');
const { performance } = require('perf_hooks');

class ResourceMonitor {
  constructor() {
    this.metrics = {
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        freeMemory: 0,
        totalMemory: 0,
        loadAverage: [0, 0, 0],
        uptime: 0
      },
      process: {
        pid: process.pid,
        cpuUsage: { user: 0, system: 0 },
        memoryUsage: { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 },
        uptime: 0,
        version: process.version
      },
      connections: {
        total: 0,
        active: 0,
        streamers: 0,
        viewers: 0,
        reconnecting: 0
      },
      mediasoup: {
        workers: 0,
        routers: 0,
        transports: 0,
        producers: 0,
        consumers: 0
      },
      performance: {
        responseTime: 0,
        throughput: 0,
        errors: 0,
        warnings: 0
      }
    };

    this.alerts = [];
    this.isMonitoring = false;
    this.monitoringInterval = null;
    
    // Performance thresholds
    this.thresholds = {
      cpu: { warning: 70, critical: 90 },
      memory: { warning: 80, critical: 95 },
      connections: { warning: 100, critical: 200 },
      responseTime: { warning: 500, critical: 1000 }
    };

    this.callbacks = {};
    this.lastCpuUsage = process.cpuUsage();
  }

  // Start monitoring
  startMonitoring(intervalMs = 5000) {
    if (this.isMonitoring) {
      console.warn('⚠️ RESOURCE MONITOR: Already monitoring');
      return;
    }

    this.isMonitoring = true;
    console.log('📊 RESOURCE MONITOR: Starting resource monitoring');

    this.monitoringInterval = setInterval(() => {
      this.updateMetrics();
    }, intervalMs);

    // Initial metrics collection
    this.updateMetrics();
  }

  // Lifecycle entry point — uniform name across services for the
  // bootstrap shutdown loop (PR 1.2). Delegates to the existing teardown.
  async stop() {
    this.stopMonitoring();
  }

  // Stop monitoring
  stopMonitoring() {
    if (!this.isMonitoring) return;

    console.log('📊 RESOURCE MONITOR: Stopping resource monitoring');
    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  // Set callbacks for alerts and metrics updates
  setCallbacks(callbacks) {
    Object.assign(this.callbacks, callbacks);
  }

  // Update all metrics
  updateMetrics() {
    this.updateSystemMetrics();
    this.updateProcessMetrics();
    this.checkAlerts();
    this.triggerCallbacks();
  }

  // Update system metrics
  updateSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    this.metrics.system = {
      cpuUsage: this.calculateCpuUsage(),
      memoryUsage: Math.round((usedMem / totalMem) * 100),
      freeMemory: freeMem,
      totalMemory: totalMem,
      loadAverage: os.loadavg(),
      uptime: os.uptime()
    };
  }

  // Update process metrics
  updateProcessMetrics() {
    const memUsage = process.memoryUsage();
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();

    this.metrics.process = {
      pid: process.pid,
      cpuUsage: currentCpuUsage,
      memoryUsage: memUsage,
      uptime: process.uptime(),
      version: process.version
    };
  }

  // Calculate CPU usage percentage
  calculateCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);

    return Math.max(0, Math.min(100, usage));
  }

  // Update connection metrics
  updateConnectionMetrics(socketStats) {
    if (!socketStats) return;

    this.metrics.connections = {
      total: socketStats.total || 0,
      active: socketStats.active || 0,
      streamers: socketStats.streamers || 0,
      viewers: socketStats.viewers || 0,
      reconnecting: socketStats.reconnecting || 0
    };
  }

  // Update mediasoup metrics
  updateMediasoupMetrics(mediasoupStats) {
    if (!mediasoupStats) return;

    this.metrics.mediasoup = {
      workers: mediasoupStats.workers || 0,
      routers: mediasoupStats.routers || 0,
      transports: mediasoupStats.transports || 0,
      producers: mediasoupStats.producers || 0,
      consumers: mediasoupStats.consumers || 0
    };
  }

  // Update performance metrics
  updatePerformanceMetrics(perfStats) {
    if (!perfStats) return;

    this.metrics.performance = {
      responseTime: perfStats.responseTime || 0,
      throughput: perfStats.throughput || 0,
      errors: perfStats.errors || 0,
      warnings: perfStats.warnings || 0
    };
  }

  // Check for alerts based on thresholds
  checkAlerts() {
    const { system, connections, performance } = this.metrics;

    // CPU usage alerts
    if (system.cpuUsage >= this.thresholds.cpu.critical) {
      this.addAlert('critical', 'system', 'Critical CPU usage detected', system.cpuUsage);
    } else if (system.cpuUsage >= this.thresholds.cpu.warning) {
      this.addAlert('warning', 'system', 'High CPU usage detected', system.cpuUsage);
    }

    // Memory usage alerts
    if (system.memoryUsage >= this.thresholds.memory.critical) {
      this.addAlert('critical', 'system', 'Critical memory usage detected', system.memoryUsage);
    } else if (system.memoryUsage >= this.thresholds.memory.warning) {
      this.addAlert('warning', 'system', 'High memory usage detected', system.memoryUsage);
    }

    // Connection alerts
    if (connections.total >= this.thresholds.connections.critical) {
      this.addAlert('critical', 'connections', 'Critical number of connections', connections.total);
    } else if (connections.total >= this.thresholds.connections.warning) {
      this.addAlert('warning', 'connections', 'High number of connections', connections.total);
    }

    // Performance alerts
    if (performance.responseTime >= this.thresholds.responseTime.critical) {
      this.addAlert('critical', 'performance', 'Critical response time detected', performance.responseTime);
    } else if (performance.responseTime >= this.thresholds.responseTime.warning) {
      this.addAlert('warning', 'performance', 'High response time detected', performance.responseTime);
    }
  }

  // Add alert
  addAlert(type, category, message, value) {
    const alert = {
      id: Date.now() + Math.random(),
      type,
      category,
      message,
      value,
      threshold: this.thresholds[category]?.[type] || 0,
      timestamp: new Date().toISOString()
    };

    // Avoid duplicate alerts within 30 seconds
    const recentSimilar = this.alerts.find(a => 
      a.type === type && 
      a.category === category && 
      Date.now() - new Date(a.timestamp).getTime() < 30000
    );

    if (!recentSimilar) {
      this.alerts.push(alert);
      
      // Limit alerts history
      if (this.alerts.length > 50) {
        this.alerts = this.alerts.slice(-25);
      }

      console.warn(`⚠️ RESOURCE ALERT [${type.toUpperCase()}]: ${message} (${value})`);

      if (this.callbacks.onAlert) {
        this.callbacks.onAlert(alert);
      }
    }
  }

  // Trigger callbacks
  triggerCallbacks() {
    if (this.callbacks.onMetricsUpdate) {
      this.callbacks.onMetricsUpdate(this.getMetrics());
    }
  }

  // Get current metrics
  getMetrics() {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  // Get alerts
  getAlerts(limit = 10) {
    return this.alerts.slice(-limit);
  }

  // Clear alerts
  clearAlerts() {
    this.alerts = [];
  }

  // Get system health summary
  getHealthSummary() {
    const { system, connections, performance } = this.metrics;
    
    let status = 'healthy';
    const issues = [];

    if (system.cpuUsage >= this.thresholds.cpu.critical || 
        system.memoryUsage >= this.thresholds.memory.critical) {
      status = 'critical';
      issues.push('System resources critically high');
    } else if (system.cpuUsage >= this.thresholds.cpu.warning || 
               system.memoryUsage >= this.thresholds.memory.warning) {
      status = 'warning';
      issues.push('System resources elevated');
    }

    if (connections.total >= this.thresholds.connections.critical) {
      status = 'critical';
      issues.push('Connection limit approaching');
    } else if (connections.total >= this.thresholds.connections.warning) {
      if (status !== 'critical') status = 'warning';
      issues.push('High connection count');
    }

    if (performance.responseTime >= this.thresholds.responseTime.critical) {
      status = 'critical';
      issues.push('Response time critically high');
    } else if (performance.responseTime >= this.thresholds.responseTime.warning) {
      if (status !== 'critical') status = 'warning';
      issues.push('Response time elevated');
    }

    return {
      status,
      issues,
      metrics: this.getMetrics(),
      alerts: this.getAlerts(5),
      recommendations: this.generateRecommendations()
    };
  }

  // Generate recommendations
  generateRecommendations() {
    const recommendations = [];
    const { system, connections, process: proc } = this.metrics;

    if (system.cpuUsage > this.thresholds.cpu.warning) {
      recommendations.push('Consider scaling horizontally or optimizing CPU-intensive operations');
    }

    if (system.memoryUsage > this.thresholds.memory.warning) {
      recommendations.push('Monitor memory leaks and consider increasing available memory');
    }

    if (connections.total > this.thresholds.connections.warning) {
      recommendations.push('Consider implementing connection pooling or load balancing');
    }

    if (proc.memoryUsage.heapUsed > proc.memoryUsage.heapTotal * 0.8) {
      recommendations.push('Node.js heap usage is high - consider garbage collection optimization');
    }

    if (system.loadAverage[0] > os.cpus().length) {
      recommendations.push('System load is high - consider distributing workload');
    }

    return recommendations;
  }

  // Format bytes for display
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Get formatted metrics for display
  getFormattedMetrics() {
    const metrics = this.getMetrics();
    
    return {
      system: {
        ...metrics.system,
        freeMemoryFormatted: this.formatBytes(metrics.system.freeMemory),
        totalMemoryFormatted: this.formatBytes(metrics.system.totalMemory),
        uptimeFormatted: this.formatUptime(metrics.system.uptime)
      },
      process: {
        ...metrics.process,
        memoryUsage: {
          ...metrics.process.memoryUsage,
          rssFormatted: this.formatBytes(metrics.process.memoryUsage.rss),
          heapUsedFormatted: this.formatBytes(metrics.process.memoryUsage.heapUsed),
          heapTotalFormatted: this.formatBytes(metrics.process.memoryUsage.heapTotal),
          externalFormatted: this.formatBytes(metrics.process.memoryUsage.external)
        },
        uptimeFormatted: this.formatUptime(metrics.process.uptime)
      },
      connections: metrics.connections,
      mediasoup: metrics.mediasoup,
      performance: metrics.performance
    };
  }

  // Format uptime for display
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
}

module.exports = ResourceMonitor;