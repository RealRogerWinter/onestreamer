/**
 * PortMonitorService - Periodic sweep of orphaned LiveKit transports/producers.
 *
 * History: under MediaSoup this service ALSO polled `ss -tuln` for UDP RTP
 * port exhaustion (this process owned the RTP ports) and force-closed all
 * transports at a critical threshold. Under LiveKit (ADR-0024) the media plane
 * runs in its own container on :7882 — this process no longer owns the RTP UDP
 * ports — so the port-exhaustion polling and the force-cleanup-all path were
 * removed.
 *
 * What remains is the orphaned-transport/producer sweep: on a 30s interval it
 * walks `webrtcService.transports` / `.producers` (LiveKitService's Maps) and
 * closes any keyed to a socket id that is no longer connected, so dangling
 * per-socket entries don't accumulate after abrupt disconnects.
 */

const logger = require('../bootstrap/logger').child({ svc: 'PortMonitorService' });

class PortMonitorService {
  constructor(webrtcService) {
    this.webrtcService = webrtcService;
    this.monitorInterval = null;
    this.checkIntervalMs = 30000; // Sweep every 30 seconds
  }

  /**
   * Start the periodic orphaned-transport sweep.
   */
  startMonitoring() {
    logger.debug('🔍 PORT MONITOR: Starting orphaned-transport sweep...');

    // Initial sweep
    this.cleanupOrphanedTransports();

    // Set up periodic sweep
    this.monitorInterval = setInterval(() => {
      this.cleanupOrphanedTransports();
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
   * Clean up orphaned transports (transports without active connections)
   */
  async cleanupOrphanedTransports() {
    if (!this.webrtcService.transports) return;

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
    for (const [socketId, transport] of this.webrtcService.transports) {
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

        this.webrtcService.transports.delete(socketId);
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
    if (!this.webrtcService.producers) return;

    let cleanedCount = 0;
    for (const [socketId, producers] of this.webrtcService.producers) {
      if (!connectedSocketIds.has(socketId)) {
        logger.debug(`🧹 PORT MONITOR: Cleaning orphaned producers for ${socketId}`);

        if (producers instanceof Map) {
          for (const [kind, producer] of producers) {
            if (!producer.closed) {
              producer.close();
            }
          }
        }

        this.webrtcService.producers.delete(socketId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`✅ PORT MONITOR: Cleaned up producers for ${cleanedCount} sockets`);
    }
  }
}

module.exports = PortMonitorService;
