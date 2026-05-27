/**
 * PortMonitorService - Monitors MediaSoup port usage and provides recovery mechanisms
 */

const { exec } = require('child_process');
const util = require('util');

const logger = require('../bootstrap/logger').child({ svc: 'PortMonitorService' });

const execPromise = util.promisify(exec);

class PortMonitorService {
  constructor(mediasoupService) {
    this.mediasoupService = mediasoupService;
    this.monitorInterval = null;
    this.lastPortCount = 0;
    this.portExhaustionThreshold = 180; // Alert when 180+ ports are used (90% of 200)
    this.criticalThreshold = 195; // Force cleanup at 195+ ports
    this.checkIntervalMs = 30000; // Check every 30 seconds
  }

  /**
   * Start monitoring port usage
   */
  startMonitoring() {
    logger.debug('🔍 PORT MONITOR: Starting port usage monitoring...');
    
    // Initial check
    this.checkPortUsage();
    
    // Set up periodic monitoring
    this.monitorInterval = setInterval(() => {
      this.checkPortUsage();
    }, this.checkIntervalMs);
  }

  // Lifecycle entry point — uniform name across services for the
  // bootstrap shutdown loop (PR 1.2). Delegates to the existing teardown.
  async stop() {
    this.stopMonitoring();
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      logger.debug('⏹️ PORT MONITOR: Stopped monitoring');
    }
  }

  /**
   * Check current port usage
   */
  async checkPortUsage() {
    try {
      // Count UDP ports on localhost (MediaSoup uses UDP for RTP)
      const { stdout } = await execPromise('ss -tuln | grep "127.0.0.1:" | grep "udp" | wc -l');
      const portCount = parseInt(stdout.trim(), 10);
      
      // Log if port usage changed significantly
      if (Math.abs(portCount - this.lastPortCount) > 10) {
        logger.debug(`📊 PORT MONITOR: UDP ports in use: ${portCount}/200`);
        this.lastPortCount = portCount;
      }
      
      // Check thresholds
      if (portCount >= this.criticalThreshold) {
        logger.error(`🚨 PORT MONITOR: CRITICAL - ${portCount} ports in use! Forcing cleanup...`);
        await this.forceCleanup();
      } else if (portCount >= this.portExhaustionThreshold) {
        logger.warn(`⚠️ PORT MONITOR: WARNING - ${portCount} ports in use (${Math.round(portCount/2)}% of capacity)`);
        await this.cleanupOrphanedTransports();
      }
      
      return portCount;
    } catch (error) {
      logger.error('❌ PORT MONITOR: Error checking port usage:', error);
      return -1;
    }
  }

  /**
   * Clean up orphaned transports (transports without active connections)
   */
  async cleanupOrphanedTransports() {
    if (!this.mediasoupService.transports) return;
    
    logger.debug('🧹 PORT MONITOR: Checking for orphaned transports...');
    let cleanedCount = 0;
    
    // Get all connected socket IDs
    const connectedSocketIds = new Set();
    if (global.io) {
      for (const [id, socket] of global.io.sockets.sockets) {
        if (socket.connected) {
          connectedSocketIds.add(id);
        }
      }
    }
    
    // Check each transport
    for (const [socketId, transport] of this.mediasoupService.transports) {
      // If socket is not connected, clean up the transport
      if (!connectedSocketIds.has(socketId)) {
        logger.debug(`🧹 PORT MONITOR: Cleaning orphaned transport for disconnected socket ${socketId}`);
        
        try {
          if (transport.video && transport.audio) {
            // ViewBot dual transport
            if (!transport.video.closed) transport.video.close();
            if (!transport.audio.closed) transport.audio.close();
          } else if (typeof transport.close === 'function' && !transport.closed) {
            transport.close();
          }
        } catch (e) {
          logger.error(`❌ PORT MONITOR: Error closing transport for ${socketId}:`, e);
        }
        
        this.mediasoupService.transports.delete(socketId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.debug(`✅ PORT MONITOR: Cleaned up ${cleanedCount} orphaned transports`);
      
      // Also clean up associated producers
      this.cleanupOrphanedProducers(connectedSocketIds);
    }
  }

  /**
   * Clean up orphaned producers
   */
  cleanupOrphanedProducers(connectedSocketIds) {
    if (!this.mediasoupService.producers) return;
    
    let cleanedCount = 0;
    for (const [socketId, producers] of this.mediasoupService.producers) {
      if (!connectedSocketIds.has(socketId)) {
        logger.debug(`🧹 PORT MONITOR: Cleaning orphaned producers for ${socketId}`);
        
        if (producers instanceof Map) {
          for (const [kind, producer] of producers) {
            if (!producer.closed) {
              producer.close();
            }
          }
        }
        
        this.mediasoupService.producers.delete(socketId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.debug(`✅ PORT MONITOR: Cleaned up producers for ${cleanedCount} sockets`);
    }
  }

  /**
   * Force cleanup of all transports (emergency recovery)
   */
  async forceCleanup() {
    logger.debug('🚨 PORT MONITOR: Forcing cleanup of all transports...');
    
    if (!this.mediasoupService.transports) return;
    
    let cleanedCount = 0;
    for (const [socketId, transport] of this.mediasoupService.transports) {
      try {
        if (transport.video && transport.audio) {
          if (!transport.video.closed) transport.video.close();
          if (!transport.audio.closed) transport.audio.close();
        } else if (typeof transport.close === 'function' && !transport.closed) {
          transport.close();
        }
        cleanedCount++;
      } catch (e) {
        logger.error(`❌ Error force-closing transport for ${socketId}:`, e);
      }
    }
    
    // Clear all transport references
    this.mediasoupService.transports.clear();
    
    // Also clear all producers
    if (this.mediasoupService.producers) {
      for (const [socketId, producers] of this.mediasoupService.producers) {
        if (producers instanceof Map) {
          for (const [kind, producer] of producers) {
            if (!producer.closed) {
              producer.close();
            }
          }
        }
      }
      this.mediasoupService.producers.clear();
    }
    
    logger.debug(`✅ PORT MONITOR: Force cleaned ${cleanedCount} transports and all producers`);
    
    // Trigger ViewBot rotation restart after cleanup
    if (global.viewBotRotationService && global.viewBotRotationService.enabled) {
      logger.debug('🔄 PORT MONITOR: Restarting ViewBot rotation after cleanup...');
      setTimeout(() => {
        global.viewBotRotationService.forceRotation();
      }, 2000);
    }
  }

  /**
   * Get current status
   */
  async getStatus() {
    const portCount = await this.checkPortUsage();
    const transportCount = this.mediasoupService.transports ? this.mediasoupService.transports.size : 0;
    const producerCount = this.mediasoupService.producers ? this.mediasoupService.producers.size : 0;
    
    return {
      portsInUse: portCount,
      portCapacity: 200,
      portUsagePercent: Math.round((portCount / 200) * 100),
      activeTransports: transportCount,
      activeProducers: producerCount,
      isHealthy: portCount < this.portExhaustionThreshold,
      isCritical: portCount >= this.criticalThreshold
    };
  }
}

module.exports = PortMonitorService;
