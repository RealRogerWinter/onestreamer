/**
 * Pure WebRTC transport-options builder for MediasoupService.
 *
 * Extracted VERBATIM from MediasoupService.createWebRtcTransport(). Given the
 * service's base transportOptions, the mobile flag, and the socketId, it
 * returns the fully-resolved config object passed to
 * router.createWebRtcTransport(). No live mediasoup objects are touched here —
 * the parent still owns transport creation, the event wiring, and the map.
 *
 * Mobile-optimized transport configuration based on MediaSoup best practices.
 */

/**
 * @param {object} baseOptions the service's this.transportOptions
 * @param {boolean} isMobileClient mobile flag (already coerced to boolean)
 * @param {string} socketId socket identifier (recorded in appData)
 * @returns {object} transport config for router.createWebRtcTransport()
 */
function buildWebRtcTransportConfig(baseOptions, isMobileClient, socketId) {
  return {
    ...baseOptions,
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: process.env.ANNOUNCED_IP || '<SERVER_IP>', // IPv4 address
      },
      {
        ip: '::',
        announcedIp: process.env.ANNOUNCED_IPV6 || '2001:db8::1', // IPv6 address for IPv6 clients
      },
    ],
    // Enable both TCP and UDP for compatibility
    enableUdp: true,
    enableTcp: true,
    preferUdp: true, // Prefer UDP for performance
    preferTcp: false,
    // Mobile-optimized bitrate settings as per MediaSoup recommendations
    initialAvailableOutgoingBitrate: isMobileClient ? 800000 : 1000000, // 800kbps mobile, 1Mbps desktop
    minimumAvailableOutgoingBitrate: isMobileClient ? 400000 : 100000, // 400kbps min for mobile stability
    maxIncomingBitrate: isMobileClient ? 2000000 : 3000000, // 2Mbps max mobile, 3Mbps desktop
    // Extended ICE consent timeout for mobile network instability and cell tower handovers
    iceConsentTimeout: isMobileClient ? 45 : 12, // 45 seconds mobile (for TURN relay), 12 desktop (default)
    // Extended DTLS handshake timeout for relay connections
    dtlsHandshakeTimeoutMs: isMobileClient ? 30000 : 5000, // 30s mobile, 5s desktop
    // Enable SCTP for data channels
    enableSctp: true,
    numSctpStreams: { OS: 1024, MIS: 1024 },
    // MediaSoup uses ICE-lite - TURN must be configured client-side only
    appData: {
      socketId,
      clientType: isMobileClient ? 'mobile' : 'desktop',
      createdAt: Date.now()
    }
  };
}

module.exports = { buildWebRtcTransportConfig };
