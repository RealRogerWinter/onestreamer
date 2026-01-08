/**
 * WebRTC Backend Configuration
 * Controls which WebRTC implementation to use (MediaSoup or LiveKit)
 */

const config = {
  // Backend selection: 'mediasoup' or 'livekit'
  backend: process.env.WEBRTC_BACKEND || 'mediasoup',
  
  // MediaSoup configuration (existing)
  mediasoup: {
    listenIp: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || process.env.ANNOUNCED_IP || '<SERVER_IP>',
    minPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '50000'),
    maxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '50199'),
    logLevel: process.env.NODE_ENV === 'production' ? 'error' : 'warn',
    transportOptions: {
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: false,
      initialAvailableOutgoingBitrate: 300000,
      minimumAvailableOutgoingBitrate: 100000,
      maxIncomingBitrate: 1500000
    }
  },
  
  // LiveKit configuration (new)
  livekit: {
    host: process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882',
    apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
    apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
    wsUrl: process.env.LIVEKIT_WS_URL || 'ws://localhost:7882',
    roomName: process.env.LIVEKIT_ROOM_NAME || 'onestreamer-main',
    enableTurn: process.env.LIVEKIT_TURN_ENABLED === 'true',
    turnHost: process.env.TURN_DOMAIN || '<SERVER_IP>',
    turnUsername: process.env.TURN_USERNAME,
    turnCredential: process.env.TURN_CREDENTIAL,
    maxParticipants: parseInt(process.env.LIVEKIT_MAX_PARTICIPANTS || '1000'),
    emptyTimeout: parseInt(process.env.LIVEKIT_EMPTY_TIMEOUT || '300')
  },
  
  // Shared configuration
  shared: {
    enableMetrics: process.env.ENABLE_METRICS === 'true',
    enableLogging: process.env.ENABLE_WEBRTC_LOGGING === 'true',
    statsInterval: parseInt(process.env.STATS_INTERVAL || '5000')
  }
};

// Validate configuration
function validateConfig() {
  const validBackends = ['mediasoup', 'livekit'];
  if (!validBackends.includes(config.backend)) {
    console.error(`Invalid WEBRTC_BACKEND: ${config.backend}. Must be 'mediasoup' or 'livekit'`);
    config.backend = 'mediasoup'; // Default fallback
  }
  
  console.log(`📡 WebRTC Backend Configuration: ${config.backend.toUpperCase()}`);
  return config;
}

module.exports = validateConfig();