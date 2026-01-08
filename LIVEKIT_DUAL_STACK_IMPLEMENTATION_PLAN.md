# LiveKit Dual-Stack Implementation Plan
## Non-Destructive Parallel Deployment with MediaSoup

### Executive Summary
This plan outlines a non-destructive approach to implementing LiveKit alongside the existing MediaSoup infrastructure, allowing runtime switching between implementations while preserving both as fully functional systems.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Client Application                 │
├─────────────────────────────────────────────────────┤
│              WebRTC Abstraction Layer               │
│                 (Protocol Adapter)                  │
├──────────────────┬──────────────────────────────────┤
│                  │        Feature Flag               │
│                  │         Controller                │
│                  └──────────┬───────────────────────┤
│                            │                        │
├──────────────┬─────────────┴────────────┬──────────┤
│  MediaSoup   │    Routing Service       │ LiveKit  │
│   Service    │   (Dynamic Selection)    │ Service  │
├──────────────┴──────────────────────────┴──────────┤
│                 Shared Services Layer               │
│  (ViewBot, Recording, Effects, Database, etc.)     │
└─────────────────────────────────────────────────────┘
```

## Phase 1: Infrastructure Setup (Week 1-2)

### 1.1 Project Structure
```bash
onestreamer/
├── server/
│   ├── services/
│   │   ├── mediasoup/          # Existing MediaSoup code
│   │   │   ├── MediasoupService.js
│   │   │   ├── MediasoupPlainTransportService.js
│   │   │   └── ...
│   │   ├── livekit/            # New LiveKit implementation
│   │   │   ├── LiveKitService.js
│   │   │   ├── LiveKitRoomManager.js
│   │   │   ├── LiveKitTransportService.js
│   │   │   └── LiveKitViewBotService.js
│   │   ├── webrtc/             # Abstraction layer
│   │   │   ├── WebRTCAdapter.js
│   │   │   ├── StreamManager.js
│   │   │   └── ProtocolFactory.js
│   │   └── common/             # Shared services
│   │       ├── FeatureFlags.js
│   │       ├── MetricsCollector.js
│   │       └── ConfigManager.js
│   ├── config/
│   │   ├── mediasoup.config.js
│   │   ├── livekit.config.js
│   │   └── features.config.js
│   └── index.js
├── client/
│   ├── src/
│   │   ├── services/
│   │   │   ├── MediasoupClient.js
│   │   │   ├── LiveKitClient.js
│   │   │   └── WebRTCClient.js  # Unified interface
│   │   └── hooks/
│   │       └── useWebRTC.js     # Protocol-agnostic hook
└── docker/
    ├── docker-compose.yml
    ├── docker-compose.mediasoup.yml
    └── docker-compose.livekit.yml
```

### 1.2 Environment Configuration
```bash
# .env.example
# WebRTC Backend Selection
WEBRTC_BACKEND=mediasoup  # Options: mediasoup, livekit, auto

# MediaSoup Configuration (existing)
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=<SERVER_IP>
MEDIASOUP_MIN_PORT=50000
MEDIASOUP_MAX_PORT=50199

# LiveKit Configuration (new)
LIVEKIT_HOST=localhost:7880
LIVEKIT_API_KEY=APIxxxxx
LIVEKIT_API_SECRET=secret
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_TURN_ENABLED=true

# Feature Flags
FEATURE_FLAG_SERVICE_URL=http://localhost:8080
ENABLE_DUAL_STACK=true
ENABLE_A_B_TESTING=false
DEFAULT_BACKEND_NEW_USERS=mediasoup
```

## Phase 2: Abstraction Layer Implementation (Week 2-3)

### 2.1 WebRTC Adapter Interface
```javascript
// server/services/webrtc/WebRTCAdapter.js
class WebRTCAdapter {
  constructor(config) {
    this.config = config;
    this.backend = null;
    this.metrics = new MetricsCollector();
  }

  async initialize(backendType = 'auto') {
    if (backendType === 'auto') {
      backendType = await this.selectOptimalBackend();
    }

    switch (backendType) {
      case 'livekit':
        const { LiveKitService } = require('../livekit/LiveKitService');
        this.backend = new LiveKitService(this.config.livekit);
        break;
      case 'mediasoup':
      default:
        const { MediasoupService } = require('../mediasoup/MediasoupService');
        this.backend = new MediasoupService(this.config.mediasoup);
        break;
    }

    await this.backend.initialize();
    this.setupMetricsCollection();
    return this.backend.getCapabilities();
  }

  async selectOptimalBackend() {
    // Logic for automatic backend selection based on:
    // - System resources
    // - Current load
    // - User preferences
    // - A/B testing groups
    const factors = {
      cpuUsage: await this.metrics.getCpuUsage(),
      memoryUsage: await this.metrics.getMemoryUsage(),
      activeStreams: await this.metrics.getActiveStreams(),
      userAgent: this.config.userAgent
    };

    if (factors.cpuUsage > 80 && factors.activeStreams > 50) {
      return 'livekit'; // Better for high load
    }

    return process.env.WEBRTC_BACKEND || 'mediasoup';
  }

  // Unified API methods
  async createTransport(peerId, options = {}) {
    return this.backend.createTransport(peerId, options);
  }

  async produce(peerId, kind, rtpParameters, appData) {
    return this.backend.produce(peerId, kind, rtpParameters, appData);
  }

  async consume(peerId, producerId, rtpCapabilities) {
    return this.backend.consume(peerId, producerId, rtpCapabilities);
  }

  getBackendType() {
    return this.backend.constructor.name.replace('Service', '').toLowerCase();
  }

  async switchBackend(newBackend, peerId) {
    // Seamless backend switching for specific peer
    const currentState = await this.backend.exportPeerState(peerId);
    await this.initialize(newBackend);
    await this.backend.importPeerState(peerId, currentState);
  }
}
```

### 2.2 Feature Flag System
```javascript
// server/services/common/FeatureFlags.js
class FeatureFlags {
  constructor() {
    this.flags = new Map();
    this.userOverrides = new Map();
    this.loadFlags();
  }

  loadFlags() {
    this.flags.set('webrtc_backend', {
      default: 'mediasoup',
      rules: [
        {
          condition: { userAgent: /iPhone|iPad/ },
          value: 'livekit' // Better iOS support
        },
        {
          condition: { beta: true },
          value: 'livekit'
        },
        {
          condition: { streamType: 'viewbot' },
          value: 'mediasoup' // Keep existing for now
        }
      ],
      percentage: {
        livekit: 10,  // 10% of users
        mediasoup: 90 // 90% of users
      }
    });
  }

  getBackend(context) {
    // Check user override first
    if (this.userOverrides.has(context.userId)) {
      return this.userOverrides.get(context.userId);
    }

    const flag = this.flags.get('webrtc_backend');
    
    // Check rules
    for (const rule of flag.rules) {
      if (this.matchesCondition(context, rule.condition)) {
        return rule.value;
      }
    }

    // A/B testing distribution
    if (context.userId) {
      const hash = this.hashUserId(context.userId);
      if (hash < flag.percentage.livekit) {
        return 'livekit';
      }
    }

    return flag.default;
  }

  setUserOverride(userId, backend) {
    this.userOverrides.set(userId, backend);
  }

  matchesCondition(context, condition) {
    for (const [key, value] of Object.entries(condition)) {
      if (value instanceof RegExp) {
        if (!value.test(context[key])) return false;
      } else {
        if (context[key] !== value) return false;
      }
    }
    return true;
  }

  hashUserId(userId) {
    // Simple hash for A/B distribution
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash) + userId.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash) % 100;
  }
}
```

## Phase 3: LiveKit Service Implementation (Week 3-5)

### 3.1 LiveKit Service Wrapper
```javascript
// server/services/livekit/LiveKitService.js
const { Room, RoomServiceClient, AccessToken } = require('livekit-server-sdk');

class LiveKitService {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
    this.participants = new Map();
    this.roomClient = new RoomServiceClient(
      config.host,
      config.apiKey,
      config.apiSecret
    );
  }

  async initialize() {
    console.log('🚀 LIVEKIT: Initializing LiveKit service...');
    
    // Test connection
    try {
      const rooms = await this.roomClient.listRooms();
      console.log(`✅ LIVEKIT: Connected. ${rooms.length} existing rooms found.`);
    } catch (error) {
      console.error('❌ LIVEKIT: Failed to connect:', error);
      throw error;
    }
  }

  async createTransport(peerId, options = {}) {
    // LiveKit doesn't use transports like MediaSoup
    // Instead, we create/join rooms
    const roomName = options.roomName || 'main';
    let room = this.rooms.get(roomName);
    
    if (!room) {
      room = await this.createRoom(roomName);
      this.rooms.set(roomName, room);
    }

    const token = this.generateToken(peerId, roomName, options);
    
    return {
      id: `lk-transport-${peerId}`,
      url: this.config.url,
      token: token,
      iceServers: this.getIceServers(),
      type: 'livekit'
    };
  }

  async produce(peerId, kind, rtpParameters, appData) {
    // In LiveKit, producing is handled client-side
    // We track the producer state here
    const participant = this.participants.get(peerId);
    if (!participant) {
      throw new Error(`Participant ${peerId} not found`);
    }

    const track = {
      id: `lk-${kind}-${Date.now()}`,
      kind: kind,
      participantId: peerId,
      metadata: JSON.stringify(appData)
    };

    participant.tracks.set(track.id, track);
    
    return {
      id: track.id,
      type: 'livekit-producer'
    };
  }

  async consume(viewerId, producerId, rtpCapabilities) {
    // LiveKit handles consumption automatically
    // We return subscription info
    return {
      id: `lk-consumer-${viewerId}-${producerId}`,
      producerId: producerId,
      kind: this.getTrackKind(producerId),
      rtpParameters: {}, // LiveKit handles this internally
      type: 'livekit-consumer'
    };
  }

  generateToken(peerId, roomName, options = {}) {
    const at = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: peerId,
      ttl: '10h',
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: options.canPublish !== false,
      canSubscribe: options.canSubscribe !== false,
      canPublishData: true,
    });

    return at.toJwt();
  }

  async createRoom(name) {
    return await this.roomClient.createRoom({
      name: name,
      emptyTimeout: 300, // 5 minutes
      maxParticipants: 1000,
      metadata: JSON.stringify({
        createdAt: Date.now(),
        backend: 'livekit'
      })
    });
  }

  getIceServers() {
    if (!this.config.turnEnabled) {
      return [];
    }

    return [
      {
        urls: ['stun:stun.l.google.com:19302']
      },
      {
        urls: [`turn:${this.config.turnHost}:3478`],
        username: this.config.turnUsername,
        credential: this.config.turnCredential
      }
    ];
  }

  async exportPeerState(peerId) {
    const participant = this.participants.get(peerId);
    return {
      peerId,
      tracks: Array.from(participant.tracks.values()),
      room: participant.room,
      metadata: participant.metadata
    };
  }

  async importPeerState(peerId, state) {
    // Recreate peer state in LiveKit
    this.participants.set(peerId, {
      id: peerId,
      tracks: new Map(state.tracks.map(t => [t.id, t])),
      room: state.room,
      metadata: state.metadata
    });
  }

  // MediaSoup compatibility methods
  async getRouterRtpCapabilities() {
    // LiveKit handles capabilities differently
    return {
      codecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000
        }
      ]
    };
  }

  getStats() {
    return {
      rooms: this.rooms.size,
      participants: this.participants.size,
      backend: 'livekit'
    };
  }
}

module.exports = { LiveKitService };
```

### 3.2 ViewBot Integration for LiveKit
```javascript
// server/services/livekit/LiveKitViewBotService.js
const { TrackSource } = require('livekit-server-sdk');
const { spawn } = require('child_process');

class LiveKitViewBotService {
  constructor(livekitService) {
    this.livekit = livekitService;
    this.activeBots = new Map();
  }

  async createViewBot(options = {}) {
    const botId = `viewbot-${Date.now()}`;
    
    // Create bot participant token with publish permissions
    const token = this.livekit.generateToken(botId, 'main', {
      canPublish: true,
      canSubscribe: false,
      metadata: JSON.stringify({
        type: 'viewbot',
        pattern: options.pattern || 'color-bars'
      })
    });

    // Start GStreamer pipeline with LiveKit WebRTC output
    const pipeline = this.createGStreamerPipeline({
      ...options,
      botId,
      token,
      url: this.livekit.config.url
    });

    const gstProcess = spawn('gst-launch-1.0', pipeline, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.activeBots.set(botId, {
      id: botId,
      process: gstProcess,
      token: token,
      startTime: Date.now()
    });

    return {
      success: true,
      botId: botId,
      token: token
    };
  }

  createGStreamerPipeline(config) {
    // GStreamer pipeline that publishes to LiveKit
    return [
      // Video source
      'videotestsrc',
      `pattern=${config.pattern || 'smpte'}`,
      'is-live=true',
      '!', `video/x-raw,width=1280,height=720,framerate=30/1`,
      
      // Video encoding
      '!', 'vp8enc',
      'deadline=1',
      'cpu-used=4',
      
      // Mux into WebRTC
      '!', 'webrtcbin',
      'name=sendonly',
      'bundle-policy=max-bundle',
      
      // Audio source
      'audiotestsrc',
      'wave=sine',
      'freq=440',
      'is-live=true',
      '!', 'audio/x-raw,rate=48000,channels=2',
      
      // Audio encoding
      '!', 'opusenc',
      
      // Connect to LiveKit using custom sink
      '!', 'sendonly.',
      
      // LiveKit connection parameters
      `livekit-url="${config.url}"`,
      `livekit-token="${config.token}"`
    ];
  }

  async stopViewBot(botId) {
    const bot = this.activeBots.get(botId);
    if (!bot) {
      return { success: false, error: 'Bot not found' };
    }

    bot.process.kill('SIGTERM');
    this.activeBots.delete(botId);

    return { success: true };
  }
}

module.exports = { LiveKitViewBotService };
```

## Phase 4: Client-Side Dual Stack (Week 4-5)

### 4.1 Unified WebRTC Client
```javascript
// client/src/services/WebRTCClient.js
import { MediasoupClient } from './MediasoupClient';
import { LiveKitClient } from './LiveKitClient';

class WebRTCClient {
  constructor(socket) {
    this.socket = socket;
    this.backend = null;
    this.client = null;
    this.initialized = false;
  }

  async initialize() {
    // Get backend type from server
    const response = await fetch('/api/webrtc/backend', {
      credentials: 'include'
    });
    
    const { backend, config } = await response.json();
    this.backend = backend;

    console.log(`🎬 Initializing WebRTC with ${backend} backend`);

    switch (backend) {
      case 'livekit':
        this.client = new LiveKitClient(config);
        break;
      case 'mediasoup':
      default:
        this.client = new MediasoupClient(this.socket, config);
        break;
    }

    await this.client.initialize();
    this.initialized = true;
    
    // Setup backend switching listener
    this.socket.on('backend-switch', this.handleBackendSwitch.bind(this));
  }

  async handleBackendSwitch(data) {
    console.log('🔄 Switching WebRTC backend to:', data.newBackend);
    
    // Save current state
    const state = await this.client.exportState();
    
    // Cleanup old client
    await this.client.cleanup();
    
    // Initialize new backend
    this.backend = data.newBackend;
    await this.initialize();
    
    // Restore state
    await this.client.importState(state);
    
    // Emit switch complete
    this.socket.emit('backend-switch-complete', {
      backend: this.backend,
      success: true
    });
  }

  // Unified API methods
  async startStreaming(stream, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.client.startStreaming(stream, options);
  }

  async stopStreaming() {
    return this.client.stopStreaming();
  }

  async startViewing(streamerId, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.client.startViewing(streamerId, options);
  }

  async stopViewing() {
    return this.client.stopViewing();
  }

  getBackendType() {
    return this.backend;
  }

  getStats() {
    return this.client.getStats();
  }

  // Allow runtime backend switching for testing
  async switchBackend(newBackend) {
    this.socket.emit('request-backend-switch', { backend: newBackend });
  }
}

export default WebRTCClient;
```

### 4.2 React Hook for Dual Stack
```javascript
// client/src/hooks/useWebRTC.js
import { useState, useEffect, useCallback, useRef } from 'react';
import WebRTCClient from '../services/WebRTCClient';

export function useWebRTC(socket) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isViewing, setIsViewing] = useState(false);
  const [backend, setBackend] = useState(null);
  const [stats, setStats] = useState({});
  const clientRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    const client = new WebRTCClient(socket);
    clientRef.current = client;

    client.initialize().then(() => {
      setBackend(client.getBackendType());
    });

    // Stats collection
    const statsInterval = setInterval(() => {
      if (client.initialized) {
        setStats(client.getStats());
      }
    }, 1000);

    return () => {
      clearInterval(statsInterval);
      client.cleanup();
    };
  }, [socket]);

  const startStreaming = useCallback(async (stream, options) => {
    if (!clientRef.current) return;
    
    try {
      await clientRef.current.startStreaming(stream, options);
      setIsStreaming(true);
    } catch (error) {
      console.error('Failed to start streaming:', error);
      throw error;
    }
  }, []);

  const stopStreaming = useCallback(async () => {
    if (!clientRef.current) return;
    
    try {
      await clientRef.current.stopStreaming();
      setIsStreaming(false);
    } catch (error) {
      console.error('Failed to stop streaming:', error);
    }
  }, []);

  const switchBackend = useCallback(async (newBackend) => {
    if (!clientRef.current) return;
    
    try {
      await clientRef.current.switchBackend(newBackend);
      setBackend(newBackend);
    } catch (error) {
      console.error('Failed to switch backend:', error);
    }
  }, []);

  return {
    isStreaming,
    isViewing,
    backend,
    stats,
    startStreaming,
    stopStreaming,
    switchBackend,
    isLiveKit: backend === 'livekit',
    isMediaSoup: backend === 'mediasoup'
  };
}
```

## Phase 5: Testing & Monitoring (Week 5-6)

### 5.1 A/B Testing Framework
```javascript
// server/services/common/ABTestingService.js
class ABTestingService {
  constructor(metricsCollector) {
    this.metrics = metricsCollector;
    this.experiments = new Map();
    this.setupExperiments();
  }

  setupExperiments() {
    this.experiments.set('webrtc_backend', {
      name: 'WebRTC Backend Comparison',
      variants: {
        control: { backend: 'mediasoup', allocation: 0.5 },
        treatment: { backend: 'livekit', allocation: 0.5 }
      },
      metrics: [
        'connection_time',
        'stream_quality',
        'disconnection_rate',
        'cpu_usage',
        'bandwidth_usage',
        'user_satisfaction'
      ],
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    });
  }

  assignVariant(userId, experimentName) {
    const experiment = this.experiments.get(experimentName);
    if (!experiment) return null;

    // Consistent assignment based on user ID
    const hash = this.hashString(userId + experimentName);
    const assignment = hash % 100 / 100;

    let cumulative = 0;
    for (const [variantName, variant] of Object.entries(experiment.variants)) {
      cumulative += variant.allocation;
      if (assignment < cumulative) {
        this.trackAssignment(userId, experimentName, variantName);
        return variant;
      }
    }

    return experiment.variants.control;
  }

  trackAssignment(userId, experimentName, variantName) {
    this.metrics.track('experiment_assignment', {
      userId,
      experiment: experimentName,
      variant: variantName,
      timestamp: Date.now()
    });
  }

  trackMetric(userId, experimentName, metricName, value) {
    const assignment = this.getUserAssignment(userId, experimentName);
    
    this.metrics.track('experiment_metric', {
      userId,
      experiment: experimentName,
      variant: assignment,
      metric: metricName,
      value: value,
      timestamp: Date.now()
    });
  }

  async getResults(experimentName) {
    const experiment = this.experiments.get(experimentName);
    if (!experiment) return null;

    const results = {};
    
    for (const variantName of Object.keys(experiment.variants)) {
      results[variantName] = {};
      
      for (const metric of experiment.metrics) {
        const data = await this.metrics.query({
          experiment: experimentName,
          variant: variantName,
          metric: metric
        });
        
        results[variantName][metric] = {
          mean: this.calculateMean(data),
          median: this.calculateMedian(data),
          p95: this.calculatePercentile(data, 95),
          sampleSize: data.length
        };
      }
    }

    return {
      experiment: experiment.name,
      results: results,
      significance: this.calculateSignificance(results)
    };
  }

  calculateSignificance(results) {
    // Statistical significance calculation
    // Simplified t-test implementation
    const control = results.control;
    const treatment = results.treatment;
    
    const significance = {};
    
    for (const metric in control) {
      const controlMean = control[metric].mean;
      const treatmentMean = treatment[metric].mean;
      const improvement = ((treatmentMean - controlMean) / controlMean) * 100;
      
      significance[metric] = {
        improvement: improvement.toFixed(2) + '%',
        significant: Math.abs(improvement) > 5 // Simplified
      };
    }
    
    return significance;
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  calculateMean(data) {
    return data.reduce((a, b) => a + b, 0) / data.length;
  }

  calculateMedian(data) {
    const sorted = data.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  calculatePercentile(data, percentile) {
    const sorted = data.sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  }
}
```

### 5.2 Monitoring Dashboard
```javascript
// server/routes/monitoring.js
router.get('/api/monitoring/dashboard', async (req, res) => {
  const mediasoupStats = mediasoupService.getStats();
  const livekitStats = livekitService.getStats();
  const abTestResults = await abTestingService.getResults('webrtc_backend');
  
  res.json({
    backends: {
      mediasoup: {
        active: mediasoupStats.transportCount > 0,
        stats: mediasoupStats,
        health: await checkMediasoupHealth()
      },
      livekit: {
        active: livekitStats.rooms > 0,
        stats: livekitStats,
        health: await checkLiveKitHealth()
      }
    },
    distribution: {
      mediasoup: await getBackendUserCount('mediasoup'),
      livekit: await getBackendUserCount('livekit')
    },
    experiments: {
      webrtc_backend: abTestResults
    },
    performance: {
      mediasoup: await getPerformanceMetrics('mediasoup'),
      livekit: await getPerformanceMetrics('livekit')
    }
  });
});

// Real-time backend switching endpoint
router.post('/api/monitoring/switch-backend', async (req, res) => {
  const { userId, backend, permanent } = req.body;
  
  if (permanent) {
    // Store user preference
    await database.saveUserPreference(userId, 'webrtc_backend', backend);
  }
  
  // Trigger live switch
  const socket = io.sockets.sockets.get(userId);
  if (socket) {
    socket.emit('backend-switch', { newBackend: backend });
  }
  
  res.json({ success: true, backend });
});
```

## Phase 6: Deployment Strategy (Week 6-7)

### 6.1 Docker Compose Configuration
```yaml
# docker-compose.yml
version: '3.8'

services:
  # Existing MediaSoup setup
  onestreamer-mediasoup:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - WEBRTC_BACKEND=mediasoup
      - NODE_ENV=production
    ports:
      - "3000:3000"
      - "50000-50199:50000-50199/udp"
    volumes:
      - ./server:/app/server
      - ./client/build:/app/client/build
    networks:
      - webrtc-net

  # New LiveKit setup
  livekit-server:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit.yaml
    ports:
      - "7880:7880"
      - "7881:7881"
      - "7882:7882/udp"
    volumes:
      - ./config/livekit.yaml:/etc/livekit.yaml
    networks:
      - webrtc-net

  onestreamer-livekit:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - WEBRTC_BACKEND=livekit
      - LIVEKIT_HOST=livekit-server:7880
      - NODE_ENV=production
    ports:
      - "3001:3000"
    depends_on:
      - livekit-server
    volumes:
      - ./server:/app/server
      - ./client/build:/app/client/build
    networks:
      - webrtc-net

  # Nginx for routing
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/dual-stack.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    networks:
      - webrtc-net

  # Monitoring stack
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"
    networks:
      - webrtc-net

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3002:3000"
    volumes:
      - ./monitoring/grafana:/etc/grafana/provisioning
    networks:
      - webrtc-net

networks:
  webrtc-net:
    driver: bridge
```

### 6.2 Nginx Routing Configuration
```nginx
# nginx/dual-stack.conf
upstream mediasoup_backend {
    server onestreamer-mediasoup:3000;
}

upstream livekit_backend {
    server onestreamer-livekit:3000;
}

map $cookie_webrtc_backend $backend_pool {
    default mediasoup_backend;
    "livekit" livekit_backend;
    "mediasoup" mediasoup_backend;
}

server {
    listen 80;
    server_name onestreamer.live;

    # WebSocket support
    location /socket.io/ {
        proxy_pass http://$backend_pool;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Backend $backend_pool;
    }

    # API routes
    location /api/ {
        proxy_pass http://$backend_pool;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Backend $backend_pool;
    }

    # LiveKit specific routes
    location /livekit/ {
        proxy_pass http://livekit-server:7880/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Static files
    location / {
        proxy_pass http://mediasoup_backend;
        proxy_set_header Host $host;
    }
}
```

## Phase 7: Rollback & Safety Procedures (Ongoing)

### 7.1 Circuit Breaker Implementation
```javascript
// server/services/common/CircuitBreaker.js
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute
    this.monitoringPeriod = options.monitoringPeriod || 10000; // 10 seconds
    
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  async execute(fn, fallbackFn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        // Circuit is open, use fallback
        return fallbackFn();
      }
    }

    try {
      const result = await fn();
      
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        if (this.successCount >= 3) {
          this.state = 'CLOSED';
          this.failures = 0;
          console.log('✅ Circuit breaker closed - system recovered');
        }
      }
      
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= this.failureThreshold) {
        this.state = 'OPEN';
        console.error(`⚠️ Circuit breaker opened after ${this.failures} failures`);
        
        // Trigger automatic rollback
        await this.triggerRollback();
      }
      
      // Use fallback
      return fallbackFn();
    }
  }

  async triggerRollback() {
    console.log('🔄 Triggering automatic rollback to MediaSoup');
    
    // Force all users back to MediaSoup
    const sockets = await io.fetchSockets();
    for (const socket of sockets) {
      socket.emit('backend-switch', { 
        newBackend: 'mediasoup',
        reason: 'automatic-rollback'
      });
    }
    
    // Update feature flags
    featureFlags.setGlobalOverride('webrtc_backend', 'mediasoup');
    
    // Alert administrators
    await sendAlert({
      level: 'critical',
      message: 'LiveKit circuit breaker triggered - rolled back to MediaSoup',
      details: {
        failures: this.failures,
        lastFailure: this.lastFailureTime
      }
    });
  }
}

// Usage in WebRTC Adapter
class WebRTCAdapter {
  constructor() {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 300000 // 5 minutes
    });
  }

  async createTransport(peerId, options) {
    return this.circuitBreaker.execute(
      // Try LiveKit
      async () => {
        if (this.backend.type === 'livekit') {
          return await this.backend.createTransport(peerId, options);
        }
        throw new Error('Not using LiveKit');
      },
      // Fallback to MediaSoup
      async () => {
        console.log('⚠️ Falling back to MediaSoup for transport creation');
        const mediasoup = new MediasoupService(this.config.mediasoup);
        await mediasoup.initialize();
        return await mediasoup.createTransport(peerId, options);
      }
    );
  }
}
```

### 7.2 Health Check System
```javascript
// server/services/common/HealthCheck.js
class HealthCheckService {
  constructor() {
    this.checks = new Map();
    this.setupHealthChecks();
  }

  setupHealthChecks() {
    // MediaSoup health check
    this.checks.set('mediasoup', async () => {
      try {
        const stats = mediasoupService.getStats();
        const testTransport = await mediasoupService.createTransport('health-check');
        await mediasoupService.cleanup('health-check');
        
        return {
          healthy: true,
          latency: Date.now() - start,
          details: stats
        };
      } catch (error) {
        return {
          healthy: false,
          error: error.message
        };
      }
    });

    // LiveKit health check
    this.checks.set('livekit', async () => {
      try {
        const start = Date.now();
        const rooms = await livekitService.roomClient.listRooms();
        
        return {
          healthy: true,
          latency: Date.now() - start,
          details: {
            rooms: rooms.length
          }
        };
      } catch (error) {
        return {
          healthy: false,
          error: error.message
        };
      }
    });
  }

  async runAllChecks() {
    const results = {};
    
    for (const [name, check] of this.checks) {
      results[name] = await check();
    }
    
    return results;
  }

  async monitorHealth() {
    setInterval(async () => {
      const health = await this.runAllChecks();
      
      // Auto-switch to healthy backend if primary fails
      if (!health.livekit.healthy && health.mediasoup.healthy) {
        console.log('⚠️ LiveKit unhealthy, switching to MediaSoup');
        featureFlags.setGlobalOverride('webrtc_backend', 'mediasoup');
      }
      
      // Store health metrics
      await metricsCollector.store('health_check', health);
    }, 30000); // Every 30 seconds
  }
}
```

## Testing Strategy

### 1. Unit Tests
```javascript
// tests/dual-stack.test.js
describe('Dual Stack WebRTC', () => {
  test('MediaSoup backend initialization', async () => {
    const adapter = new WebRTCAdapter(config);
    await adapter.initialize('mediasoup');
    expect(adapter.getBackendType()).toBe('mediasoup');
  });

  test('LiveKit backend initialization', async () => {
    const adapter = new WebRTCAdapter(config);
    await adapter.initialize('livekit');
    expect(adapter.getBackendType()).toBe('livekit');
  });

  test('Seamless backend switching', async () => {
    const adapter = new WebRTCAdapter(config);
    await adapter.initialize('mediasoup');
    
    const peerId = 'test-peer';
    await adapter.createTransport(peerId);
    
    await adapter.switchBackend('livekit', peerId);
    expect(adapter.getBackendType()).toBe('livekit');
  });

  test('Circuit breaker triggers rollback', async () => {
    const adapter = new WebRTCAdapter(config);
    await adapter.initialize('livekit');
    
    // Simulate failures
    for (let i = 0; i < 6; i++) {
      try {
        await adapter.backend.forceFailure();
      } catch (e) {}
    }
    
    // Should have rolled back to MediaSoup
    expect(adapter.getBackendType()).toBe('mediasoup');
  });
});
```

### 2. Integration Tests
```bash
# scripts/test-dual-stack.sh
#!/bin/bash

echo "Starting dual-stack integration tests..."

# Start both backends
docker-compose up -d

# Wait for services
sleep 10

# Test MediaSoup flow
curl -X POST http://localhost:3000/api/test/stream \
  -H "Cookie: webrtc_backend=mediasoup" \
  -d '{"action": "start"}'

# Test LiveKit flow  
curl -X POST http://localhost:3001/api/test/stream \
  -H "Cookie: webrtc_backend=livekit" \
  -d '{"action": "start"}'

# Test switching
curl -X POST http://localhost/api/monitoring/switch-backend \
  -d '{"userId": "test-user", "backend": "livekit"}'

# Check health
curl http://localhost/api/monitoring/health

echo "Integration tests complete"
```

## Monitoring & Metrics

### Key Metrics to Track
1. **Connection Success Rate** - Compare MediaSoup vs LiveKit
2. **Time to First Frame** - Measure streaming latency
3. **Disconnection Rate** - Track stability
4. **CPU/Memory Usage** - Resource consumption
5. **Bandwidth Efficiency** - Data transfer optimization
6. **User Satisfaction** - Subjective quality scores

### Grafana Dashboard Configuration
```json
{
  "dashboard": {
    "title": "WebRTC Dual Stack Monitoring",
    "panels": [
      {
        "title": "Backend Distribution",
        "type": "piechart",
        "targets": [
          {
            "expr": "count(webrtc_backend{backend='mediasoup'})",
            "legendFormat": "MediaSoup"
          },
          {
            "expr": "count(webrtc_backend{backend='livekit'})",
            "legendFormat": "LiveKit"
          }
        ]
      },
      {
        "title": "Connection Success Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(webrtc_connection_success[5m])",
            "legendFormat": "{{backend}}"
          }
        ]
      },
      {
        "title": "Average Latency",
        "type": "stat",
        "targets": [
          {
            "expr": "avg(webrtc_latency_ms) by (backend)"
          }
        ]
      }
    ]
  }
}
```

## Success Criteria

### Phase 1 Success (Week 2)
- [ ] Both MediaSoup and LiveKit services start successfully
- [ ] Feature flag system correctly routes users
- [ ] No impact on existing MediaSoup users

### Phase 2 Success (Week 4)
- [ ] 10% of users successfully using LiveKit
- [ ] Automatic fallback working
- [ ] Circuit breaker prevents cascading failures

### Phase 3 Success (Week 6)
- [ ] A/B test shows LiveKit performance metrics
- [ ] ViewBot works with both backends
- [ ] Live backend switching functional

### Final Success (Week 8)
- [ ] 50/50 traffic split sustainable
- [ ] Decision data collected for final backend choice
- [ ] Full rollback capability demonstrated
- [ ] Documentation complete

## Rollout Schedule

1. **Week 1-2**: Infrastructure setup and abstraction layer
2. **Week 3-4**: LiveKit service implementation
3. **Week 4-5**: Client-side dual stack
4. **Week 5-6**: Testing and monitoring setup
5. **Week 6-7**: Staged rollout (1% → 5% → 10% → 25% → 50%)
6. **Week 7-8**: Evaluation and decision
7. **Week 8+**: Either complete migration or maintain dual-stack

## Risk Mitigation

1. **Risk**: LiveKit connection failures
   - **Mitigation**: Circuit breaker auto-rollback to MediaSoup

2. **Risk**: Performance degradation
   - **Mitigation**: Real-time monitoring and immediate rollback capability

3. **Risk**: User confusion
   - **Mitigation**: Transparent backend selection, no user-visible changes

4. **Risk**: Resource overhead
   - **Mitigation**: Gradual rollout, resource monitoring, auto-scaling

5. **Risk**: Data loss during switching
   - **Mitigation**: State export/import system, graceful handover

## Conclusion

This dual-stack implementation plan provides a safe, non-destructive path to evaluate and potentially migrate from MediaSoup to LiveKit. The architecture maintains both systems in parallel, allowing for:

- Real-time A/B testing
- Immediate rollback capability
- Gradual migration based on data
- Zero downtime deployment
- Comprehensive monitoring

The plan prioritizes stability and user experience while providing the flexibility to improve the streaming infrastructure based on real-world performance data.