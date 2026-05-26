/**
 * LiveKit Service - Alternative WebRTC backend to MediaSoup
 * Provides compatible API interface for seamless switching
 */

const { Room, RoomServiceClient, AccessToken, WebhookReceiver } = require('livekit-server-sdk');
const crypto = require('crypto');
const requireEnv = require('../config/requireEnv');

// TURN credential generation for coturn with static-auth-secret
const TURN_SECRET = requireEnv('TURN_SECRET');
const TURN_TTL = 24 * 60 * 60; // 24 hours in seconds

function generateTurnCredentials(username = 'viewer') {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const turnUsername = `${expiry}:${username}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(turnUsername);
  const turnCredential = hmac.digest('base64');
  return { username: turnUsername, credential: turnCredential, ttl: TURN_TTL };
}

class LiveKitService {
  constructor() {
    this.config = require('../config/webrtc.config').livekit;
    this.roomClient = null;
    this.room = null;
    this.participants = new Map(); // socketId -> participant info
    this.transports = new Map(); // socketId -> connection info
    this.producers = new Map(); // socketId -> Map of tracks
    this.consumers = new Map(); // socketId -> Set of subscriptions
    this.currentStreamer = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    console.log('🚀 LIVEKIT: Initializing LiveKit service...');
    
    try {
      // Initialize RoomServiceClient for server-side operations
      // Ensure host has protocol
      const host = this.config.host.startsWith('http') 
        ? this.config.host 
        : `http://${this.config.host}`;
        
      this.roomClient = new RoomServiceClient(
        host,
        this.config.apiKey,
        this.config.apiSecret
      );

      // Test connection by listing rooms
      const rooms = await this.roomClient.listRooms();
      console.log(`✅ LIVEKIT: Connected successfully. ${rooms.length} existing rooms found.`);
      
      // Create or get main room
      await this.ensureMainRoom();
      
      this.initialized = true;
      console.log('✅ LIVEKIT: Service initialized successfully');
    } catch (error) {
      console.error('❌ LIVEKIT: Failed to initialize:', error);
      throw error;
    }
  }

  async ensureMainRoom() {
    try {
      // Check if room exists
      const rooms = await this.roomClient.listRooms();
      const mainRoom = rooms.find(r => r.name === this.config.roomName);
      
      if (!mainRoom) {
        // Create main room
        console.log(`📦 LIVEKIT: Creating main room: ${this.config.roomName}`);
        await this.roomClient.createRoom({
          name: this.config.roomName,
          emptyTimeout: this.config.emptyTimeout,
          maxParticipants: this.config.maxParticipants,
          metadata: JSON.stringify({
            type: 'main',
            createdAt: Date.now()
          })
        });
      }
    } catch (error) {
      console.error('❌ LIVEKIT: Failed to ensure main room:', error);
      throw error;
    }
  }

  /**
   * MediaSoup-compatible API methods
   */

  async getRouterRtpCapabilities() {
    // LiveKit handles codec negotiation internally
    // Return MediaSoup-compatible capabilities for client compatibility
    // CRITICAL: H264 MUST be listed FIRST for iOS Safari compatibility
    // iOS Safari only supports H264 - VP8/VP9 are not supported
    return {
      codecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'transport-cc' }
          ]
        },
        // H264 FIRST - Required for iOS Safari (only supports H264)
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',  // Baseline Profile Level 3.1 - best iOS compatibility
            'level-asymmetry-allowed': 1
          },
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'goog-remb' },
            { type: 'transport-cc' }
          ]
        },
        // VP8 as fallback for other browsers
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
            { type: 'goog-remb' },
            { type: 'transport-cc' }
          ]
        }
      ],
      headerExtensions: [
        {
          kind: 'video',
          uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
          preferredId: 4,
          preferredEncrypt: false,
          direction: 'sendrecv'
        },
        {
          kind: 'audio',
          uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
          preferredId: 1,
          preferredEncrypt: false,
          direction: 'sendrecv'
        }
      ]
    };
  }

  async createWebRtcTransport(socketId, isMobile = false) {
    console.log(`📡 LIVEKIT: Creating transport for ${socketId}`);
    
    // Generate access token for this participant
    const token = await this.generateToken(socketId, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    // Store transport info (LiveKit doesn't use transports like MediaSoup)
    const transportInfo = {
      id: `lk-transport-${socketId}-${Date.now()}`,
      socketId: socketId,
      token: token,
      url: this.config.wsUrl,
      createdAt: Date.now()
    };

    this.transports.set(socketId, transportInfo);

    // Return MediaSoup-compatible transport options
    return {
      id: transportInfo.id,
      iceParameters: {
        usernameFragment: 'livekit',
        password: token.substring(0, 22) // Fake ICE password
      },
      iceCandidates: this.getIceCandidates(),
      dtlsParameters: {
        fingerprints: [
          {
            algorithm: 'sha-256',
            value: 'FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF'
          }
        ],
        role: 'server'
      },
      // LiveKit-specific data for client
      livekitData: {
        token: token,
        url: this.config.wsUrl,
        roomName: this.config.roomName,
        turnServers: {
          urls: [
            'stun:onestreamer.live:3478',
            'turn:onestreamer.live:3478?transport=udp',
            'turn:onestreamer.live:3478?transport=tcp',
            'turns:onestreamer.live:5349?transport=tcp'
          ],
          ...generateTurnCredentials(socketId)
        }
      }
    };
  }

  async connectTransport(socketId, dtlsParameters) {
    console.log(`🔗 LIVEKIT: Connecting transport for ${socketId}`);
    
    // LiveKit handles connection automatically via token
    // This is a no-op for compatibility
    const transport = this.transports.get(socketId);
    if (!transport) {
      throw new Error(`Transport not found for ${socketId}`);
    }

    transport.connected = true;
    transport.dtlsParameters = dtlsParameters;
    
    return { success: true };
  }

  async produce(socketId, kind, rtpParameters, appData) {
    console.log(`🎬 LIVEKIT: Creating ${kind} producer for ${socketId}`);
    
    // In LiveKit, tracks are published client-side
    // We track them here for MediaSoup compatibility
    let producerMap = this.producers.get(socketId);
    if (!producerMap) {
      producerMap = new Map();
      this.producers.set(socketId, producerMap);
    }

    const producerId = `lk-producer-${kind}-${Date.now()}`;
    const producer = {
      id: producerId,
      kind: kind,
      rtpParameters: rtpParameters,
      appData: appData,
      socketId: socketId,
      createdAt: Date.now()
    };

    producerMap.set(kind, producer);

    // Set as current streamer if first producer
    if (!this.currentStreamer && kind === 'video') {
      this.currentStreamer = socketId;
      console.log(`👑 LIVEKIT: Set ${socketId} as current streamer`);
    }

    return producerId;
  }

  async createProducer(socketId, rtpParameters, kind) {
    return this.produce(socketId, kind, rtpParameters, {});
  }

  async consume(socketId, producerId, rtpCapabilities) {
    console.log(`📺 LIVEKIT: Creating consumer for ${socketId} to consume ${producerId}`);
    
    // Find the producer
    let targetProducer = null;
    let producerSocketId = null;
    
    for (const [sid, producerMap] of this.producers.entries()) {
      for (const [kind, producer] of producerMap.entries()) {
        if (producer.id === producerId) {
          targetProducer = producer;
          producerSocketId = sid;
          break;
        }
      }
      if (targetProducer) break;
    }

    if (!targetProducer) {
      throw new Error(`Producer ${producerId} not found`);
    }

    // Create consumer (subscription in LiveKit terms)
    const consumerId = `lk-consumer-${Date.now()}`;
    const consumer = {
      id: consumerId,
      producerId: producerId,
      kind: targetProducer.kind,
      rtpParameters: targetProducer.rtpParameters, // Pass through for now
      producerSocketId: producerSocketId,
      consumerSocketId: socketId
    };

    // Track consumer
    let consumerSet = this.consumers.get(socketId);
    if (!consumerSet) {
      consumerSet = new Set();
      this.consumers.set(socketId, consumerSet);
    }
    consumerSet.add(consumer);

    return consumer;
  }

  async restartTransportIce(socketId, transportId) {
    console.log(`🔄 LIVEKIT: Restarting ICE for ${socketId}`);
    
    // LiveKit handles ICE restart automatically
    // Return fake ICE parameters for compatibility
    return {
      iceParameters: {
        usernameFragment: `livekit-${Date.now()}`,
        password: this.generateRandomString(22)
      }
    };
  }

  async cleanup(socketId) {
    console.log(`🧹 LIVEKIT: Cleaning up resources for ${socketId}`);
    
    // Remove from all tracking maps
    this.transports.delete(socketId);
    this.producers.delete(socketId);
    this.consumers.delete(socketId);
    this.participants.delete(socketId);
    
    // Clear current streamer if it was this socket
    if (this.currentStreamer === socketId) {
      this.currentStreamer = null;
      console.log(`👑 LIVEKIT: Cleared current streamer`);
    }
  }

  async getCurrentStreamer() {
    // If we have a cached current streamer, return it
    if (this.currentStreamer) {
      return this.currentStreamer;
    }

    // Otherwise, query LiveKit for active participants
    // This handles viewbots that connect directly via WHIP
    try {
      const participants = await this.roomClient.listParticipants(this.config.roomName);

      // Find a participant with an audio track (likely a streamer)
      const streamer = participants.find(p =>
        p.tracks.some(t => t.type === 0) // 0 = TRACK_TYPE_AUDIO
      );

      if (streamer) {
        console.log(`🔍 LIVEKIT: Found active streamer via room query: ${streamer.identity}`);
        return streamer.identity;
      }

      return null;
    } catch (err) {
      console.error(`❌ LIVEKIT: Error querying for current streamer:`, err.message);
      return null;
    }
  }

  getRouter() {
    // Return a fake router object for compatibility
    return {
      id: 'livekit-router',
      appData: {}
    };
  }

  getStats() {
    return {
      transportCount: this.transports.size,
      producerCount: this.getTotalProducerCount(),
      consumerCount: this.getTotalConsumerCount(),
      currentStreamer: this.currentStreamer,
      backend: 'livekit',
      initialized: this.initialized
    };
  }

  getTotalProducerCount() {
    let count = 0;
    for (const producerMap of this.producers.values()) {
      count += producerMap.size;
    }
    return count;
  }

  getTotalConsumerCount() {
    let count = 0;
    for (const consumerSet of this.consumers.values()) {
      count += consumerSet.size;
    }
    return count;
  }

  /**
   * LiveKit-specific helper methods
   */

  async generateToken(participantIdentity, grants = {}) {
    const at = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: participantIdentity,
      ttl: '10h', // 10 hours
    });

    at.addGrant({
      roomJoin: true,
      room: this.config.roomName,
      canPublish: grants.canPublish !== false,
      canSubscribe: grants.canSubscribe !== false,
      canPublishData: grants.canPublishData !== false,
    });

    // toJwt() returns a Promise, so we await it
    const token = await at.toJwt();
    return token;
  }

  getIceCandidates() {
    // Return STUN/TURN servers
    const candidates = [
      {
        foundation: 'udpcandidate',
        ip: this.config.host.split(':')[0],
        port: 7882,
        priority: 1000,
        protocol: 'udp',
        type: 'host'
      }
    ];

    if (this.config.enableTurn) {
      candidates.push({
        foundation: 'turncandidate',
        ip: this.config.turnHost,
        port: 3478,
        priority: 100,
        protocol: 'udp',
        type: 'relay'
      });
    }

    return candidates;
  }

  generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  async getParticipants() {
    try {
      const participants = await this.roomClient.listParticipants(this.config.roomName);
      return participants;
    } catch (error) {
      console.error('❌ LIVEKIT: Failed to get participants:', error);
      return [];
    }
  }

  async removeParticipant(participantId) {
    try {
      await this.roomClient.removeParticipant(this.config.roomName, participantId);
      console.log(`✅ LIVEKIT: Removed participant ${participantId}`);
    } catch (error) {
      console.error(`❌ LIVEKIT: Failed to remove participant ${participantId}:`, error);
    }
  }

  async muteTrack(participantId, trackSid, muted) {
    try {
      await this.roomClient.mutePublishedTrack(
        this.config.roomName,
        participantId,
        trackSid,
        muted
      );
      console.log(`✅ LIVEKIT: ${muted ? 'Muted' : 'Unmuted'} track ${trackSid}`);
    } catch (error) {
      console.error(`❌ LIVEKIT: Failed to mute/unmute track:`, error);
    }
  }

  /**
   * Verify that a participant has active publishing tracks
   * This ensures tracks are actually available before viewers try to consume
   */
  async verifyParticipantTracks(participantIdentity, options = {}) {
    const {
      requireVideo = true,
      requireAudio = false,
      maxAttempts = 10,
      retryDelay = 500
    } = options;

    console.log(`🔍 LIVEKIT: Verifying tracks for participant ${participantIdentity}...`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const participants = await this.roomClient.listParticipants(this.config.roomName);
        const participant = participants.find(p => p.identity === participantIdentity);

        if (!participant) {
          console.warn(`⚠️ LIVEKIT: Participant ${participantIdentity} not found (attempt ${attempt + 1}/${maxAttempts})`);
          await this.delay(retryDelay * Math.pow(1.5, attempt)); // Exponential backoff
          continue;
        }

        // Check for required tracks
        const hasVideo = participant.tracks.some(t =>
          t.type === 0 && // TRACK_TYPE_VIDEO = 0
          !t.muted
        );

        const hasAudio = participant.tracks.some(t =>
          t.type === 1 && // TRACK_TYPE_AUDIO = 1
          !t.muted
        );

        // Check if requirements are met
        const videoOk = !requireVideo || hasVideo;
        const audioOk = !requireAudio || hasAudio;

        if (videoOk && audioOk) {
          console.log(`✅ LIVEKIT: Participant ${participantIdentity} has required tracks (video: ${hasVideo}, audio: ${hasAudio})`);
          return {
            verified: true,
            hasVideo,
            hasAudio,
            trackCount: participant.tracks.length,
            attempt: attempt + 1
          };
        }

        console.log(`⏳ LIVEKIT: Waiting for tracks... (video: ${hasVideo}/${requireVideo}, audio: ${hasAudio}/${requireAudio}) - attempt ${attempt + 1}/${maxAttempts}`);
        await this.delay(retryDelay * Math.pow(1.5, attempt));

      } catch (error) {
        console.error(`❌ LIVEKIT: Error verifying tracks (attempt ${attempt + 1}):`, error);
        await this.delay(retryDelay * Math.pow(1.5, attempt));
      }
    }

    console.error(`❌ LIVEKIT: Failed to verify tracks for ${participantIdentity} after ${maxAttempts} attempts`);
    return {
      verified: false,
      hasVideo: false,
      hasAudio: false,
      trackCount: 0,
      attempt: maxAttempts
    };
  }

  /**
   * Helper method for delays
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Lifecycle entry point — uniform name across services for the bootstrap
  // shutdown loop (PR 1.2). Delegates to the existing teardown.
  async stop() {
    this.stopStreamerHealthCheck();
  }

  /**
   * Start periodic health check for streamer tracks
   * Clears stale streamers whose WebRTC connection dropped but socket remains
   */
  startStreamerHealthCheck(streamService, io, interval = 15000) {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    console.log(`✅ LIVEKIT: Starting streamer health check (every ${interval / 1000}s)`);

    this.healthCheckTimer = setInterval(async () => {
      try {
        const currentStreamer = streamService.getCurrentStreamer();

        // Skip if no current streamer or it's a viewbot
        if (!currentStreamer) return;
        if (currentStreamer.startsWith('viewbot-') || currentStreamer.includes('viewbot')) {
          return;
        }

        // CRITICAL: Give new streams a grace period to establish WebRTC connection
        // Don't check health until they've had at least 30 seconds to connect
        const streamStatus = streamService.getStreamStatus();
        const streamAge = streamStatus.streamDuration || 0;
        const GRACE_PERIOD_MS = 30000; // 30 seconds grace period

        if (streamAge < GRACE_PERIOD_MS) {
          // console.log(`⏳ LIVEKIT HEALTH: Skipping check for ${currentStreamer} (stream age: ${Math.round(streamAge/1000)}s < ${GRACE_PERIOD_MS/1000}s grace period)`);
          return;
        }

        // Check if streamer has active tracks in LiveKit
        const participants = await this.roomClient.listParticipants(this.config.roomName);
        const streamerParticipant = participants.find(p => p.identity === currentStreamer);

        if (!streamerParticipant) {
          console.log(`🔍 LIVEKIT HEALTH: Streamer ${currentStreamer} NOT FOUND in LiveKit room`);
          await this.clearStaleStreamer(streamService, io, currentStreamer, 'not_in_room');
          return;
        }

        // Check if they have any published tracks
        const hasTracks = streamerParticipant.tracks && streamerParticipant.tracks.length > 0;
        const hasActiveTracks = streamerParticipant.tracks?.some(t => t.muted === false);

        if (!hasTracks || !hasActiveTracks) {
          console.log(`🔍 LIVEKIT HEALTH: Streamer ${currentStreamer} has NO ACTIVE TRACKS`);
          console.log(`   Tracks: ${JSON.stringify(streamerParticipant.tracks?.map(t => ({ sid: t.sid, type: t.type, muted: t.muted })) || [])}`);
          await this.clearStaleStreamer(streamService, io, currentStreamer, 'no_tracks');
          return;
        }

        // Streamer is healthy
        // console.log(`✅ LIVEKIT HEALTH: Streamer ${currentStreamer} is healthy (${streamerParticipant.tracks?.length || 0} tracks)`);
      } catch (error) {
        console.error(`❌ LIVEKIT HEALTH: Error checking streamer:`, error.message);
      }
    }, interval);
  }

  /**
   * Clear a stale streamer and trigger viewbot rotation
   */
  async clearStaleStreamer(streamService, io, streamerId, reason) {
    console.log(`🧹 LIVEKIT: Clearing stale streamer ${streamerId} (reason: ${reason})`);

    // Clear the streamer status
    streamService.clearStreamer();
    this.currentStreamer = null;

    // Emit stream-ended to all clients
    io.emit('stream-ended', {
      reason: 'webrtc_disconnect',
      message: 'Streamer WebRTC connection lost'
    });

    // Emit stream-update so clients know to look for new stream
    io.emit('stream-update', {
      hasActiveStream: false,
      streamerId: null
    });

    console.log(`✅ LIVEKIT: Stale streamer ${streamerId} cleared, viewbot should take over`);
  }

  /**
   * Stop health check
   */
  stopStreamerHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      console.log(`⏹️ LIVEKIT: Stopped streamer health check`);
    }
  }
}

module.exports = LiveKitService;