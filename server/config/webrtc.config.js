/**
 * WebRTC Backend Configuration
 *
 * LiveKit is the sole WebRTC backend (ADR-0024 retired MediaSoup). The
 * backend selector, the MediaSoup config block, and the validate/fallback
 * dance were removed with it — `backend` is pinned to 'livekit'.
 */

const logger = require('../bootstrap/logger').child({ svc: 'webrtc.config' });

const config = {
  // LiveKit is the only backend. Kept as a field because callers read
  // `webrtcConfig.backend` and branch on === 'livekit'.
  backend: 'livekit',

  // LiveKit configuration
  livekit: {
    host: process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882',
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    wsUrl: process.env.LIVEKIT_WS_URL || 'ws://localhost:7882',
    roomName: process.env.LIVEKIT_ROOM_NAME || 'onestreamer-main',
    enableTurn: process.env.LIVEKIT_TURN_ENABLED === 'true',
    turnHost: process.env.TURN_DOMAIN || 'turn.example.com',
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

logger.info(`📡 WebRTC Backend: ${config.backend.toUpperCase()}`);

module.exports = config;
