/**
 * LiveKit Client - Provides MediaSoup-compatible API using LiveKit
 */

import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
  VideoPresets,
  VideoQuality,
  createLocalTracks,
  RoomOptions,
  RoomConnectOptions,
  LocalTrack,
  LocalVideoTrack,
  LocalAudioTrack,
  TrackPublication,
  DisconnectReason
} from 'livekit-client';
import { Socket } from 'socket.io-client';

export interface LiveKitClientConfig {
  socket: Socket;
  serverUrl?: string;
  onConnectionRecovered?: () => void;
  onConnectionLost?: () => void;
  onReconnectionFailed?: (error: Error) => void;
  onDebugInfo?: (info: any) => void;
  onStreamUpdate?: () => void;
}

interface LiveKitTokenResponse {
  token: string;
  url: string;
  roomName: string;
  identity: string;
}

export class LiveKitClient {
  private room: Room | null = null;
  private socket: Socket;
  private serverUrl: string;
  private wsUrl: string = '';
  private token: string = '';
  private roomName: string = 'onestreamer-main';
  private identity: string = '';
  
  // MediaSoup compatibility properties
  public sendTransport: any = null;
  public recvTransport: any = null;
  public videoProducer: LocalVideoTrack | null = null;
  public audioProducer: LocalAudioTrack | null = null;
  public consumers: Map<string, RemoteTrack> = new Map();
  public isDestroyed: boolean = false;
  public currentStreamerId: string | null = null;

  // Active participant tracking for stream switching
  private activeParticipant: RemoteParticipant | null = null;
  private currentStream: MediaStream | null = null;
  private isSwitchingStream: boolean = false;
  private pendingStreamUpdates: Set<string> = new Set();
  private streamUpdateDebounceTimer: NodeJS.Timeout | null = null;

  // Timeout tracking for cleanup
  private activeTimeouts: Set<NodeJS.Timeout> = new Set();

  // Connection management
  private isProcessing: boolean = false;
  private operationTimeout: number = 30000;
  private reconnectionAttempts: number = 0;
  private maxReconnectionAttempts: number = 5;
  private reconnectionDelay: number = 1000;
  private maxReconnectionDelay: number = 30000;
  private reconnectionTimer?: NodeJS.Timeout;
  private isReconnecting: boolean = false;
  private lastConnectionState: 'connected' | 'disconnected' = 'disconnected';
  
  // Callbacks
  private onConnectionRecovered?: () => void;
  private onConnectionLost?: () => void;
  private onReconnectionFailed?: (error: Error) => void;
  public onDebugInfo?: (info: any) => void;
  public onStreamUpdate?: () => void;

  // Local tracks
  private localVideoTrack: LocalVideoTrack | null = null;
  private localAudioTrack: LocalAudioTrack | null = null;
  private localStream: MediaStream | null = null;

  constructor(config: LiveKitClientConfig) {
    this.socket = config.socket;
    this.serverUrl = config.serverUrl || process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';
    this.onConnectionRecovered = config.onConnectionRecovered;
    this.onConnectionLost = config.onConnectionLost;
    this.onReconnectionFailed = config.onReconnectionFailed;
    this.onDebugInfo = config.onDebugInfo;
    this.onStreamUpdate = config.onStreamUpdate;

    console.log('🚀 LIVEKIT CLIENT: Initializing LiveKit client');
  }

  /**
   * Initialize LiveKit client (MediaSoup compatible)
   */
  async init(): Promise<void> {
    try {
      console.log('📡 LIVEKIT CLIENT: Getting router capabilities (LiveKit mode)');
      
      // Get "router capabilities" - in LiveKit mode, this returns LiveKit config
      const response = await fetch(`${this.serverUrl}/api/mediasoup/router-capabilities`);
      const capabilities = await response.json();
      
      // LiveKit doesn't need to load device capabilities like MediaSoup
      console.log('✅ LIVEKIT CLIENT: LiveKit initialized (no device loading needed)');
      
      // Create room instance but don't connect yet
      // Disable ALL adaptive features to prevent any layer switching
      this.room = new Room({
        adaptiveStream: false,
        dynacast: false,
        simulcast: false,
        videoCaptureDefaults: {
          resolution: VideoPresets.h720.resolution,
        },
      } as RoomOptions);
      
      this.setupRoomEventHandlers();
      
      // Create fake transports for MediaSoup compatibility
      this.sendTransport = { id: 'livekit-send-transport', state: 'new' };
      this.recvTransport = { id: 'livekit-recv-transport', state: 'new' };
      
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Initialize with force reload option (MediaSoup compatible)
   */
  async initialize(forceReload: boolean = false): Promise<void> {
    // In LiveKit, we just call init - no device reloading needed
    return this.init();
  }

  /**
   * Create a tracked timeout that will be cleaned up on destroy
   */
  private createTrackedTimeout(callback: () => void, delay: number): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      this.activeTimeouts.delete(timeout);
      try {
        callback();
      } catch (error) {
        console.error('❌ LIVEKIT CLIENT: Error in tracked timeout callback:', error);
      }
    }, delay);
    this.activeTimeouts.add(timeout);
    return timeout;
  }

  /**
   * Clear a tracked timeout
   */
  private clearTrackedTimeout(timeout: NodeJS.Timeout | null): void {
    if (timeout) {
      clearTimeout(timeout);
      this.activeTimeouts.delete(timeout);
    }
  }

  /**
   * Clear all tracked timeouts
   */
  private clearAllTimeouts(): void {
    this.activeTimeouts.forEach(timeout => clearTimeout(timeout));
    this.activeTimeouts.clear();

    if (this.streamUpdateDebounceTimer) {
      clearTimeout(this.streamUpdateDebounceTimer);
      this.streamUpdateDebounceTimer = null;
    }

    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer);
      this.reconnectionTimer = undefined;
    }
  }

  /**
   * Safely trigger stream update with debouncing and queueing
   */
  private triggerStreamUpdate(participantId: string, delay: number = 200): void {
    // Add to pending updates
    this.pendingStreamUpdates.add(participantId);

    // Clear existing debounce timer
    if (this.streamUpdateDebounceTimer) {
      clearTimeout(this.streamUpdateDebounceTimer);
      this.streamUpdateDebounceTimer = null;
    }

    // Set new debounced timer
    this.streamUpdateDebounceTimer = this.createTrackedTimeout(() => {
      if (this.onStreamUpdate && !this.isSwitchingStream && !this.isDestroyed) {
        console.log(`🔄 LIVEKIT CLIENT: Triggering debounced stream update for pending participants: ${Array.from(this.pendingStreamUpdates).join(', ')}`);
        this.pendingStreamUpdates.clear();
        try {
          this.onStreamUpdate();
        } catch (error) {
          console.error('❌ LIVEKIT CLIENT: Error in onStreamUpdate callback:', error);
        }
      }
      this.streamUpdateDebounceTimer = null;
    }, delay);
  }

  /**
   * Set up LiveKit room event handlers with proper error handling
   */
  private setupRoomEventHandlers(): void {
    if (!this.room) return;
    
    this.room.on(RoomEvent.Connected, () => {
      console.log('✅ LIVEKIT CLIENT: Connected to room');
      this.lastConnectionState = 'connected';
      this.sendTransport = { ...this.sendTransport, state: 'connected' };
      this.recvTransport = { ...this.recvTransport, state: 'connected' };
      
      if (this.onConnectionRecovered) {
        this.onConnectionRecovered();
      }
    });
    
    this.room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      console.log('🔌 LIVEKIT CLIENT: Disconnected from room:', reason);
      this.lastConnectionState = 'disconnected';
      this.sendTransport = { ...this.sendTransport, state: 'disconnected' };
      this.recvTransport = { ...this.recvTransport, state: 'disconnected' };
      
      if (this.onConnectionLost) {
        this.onConnectionLost();
      }
    });
    
    this.room.on(RoomEvent.TrackSubscribed, (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      try {
        console.log(`📺 LIVEKIT CLIENT: Subscribed to ${track.kind} track from ${participant.identity}`);
        this.consumers.set(`${participant.identity}-${track.kind}`, track);

        // For video tracks, trigger a stream update to ensure we're displaying the best participant
        // The consume() method will intelligently select which participant to display
        if (track.kind === 'video') {
          const isNewParticipant = !this.activeParticipant ||
                                   this.activeParticipant.identity !== participant.identity;

          if (isNewParticipant) {
            console.log(`🔄 LIVEKIT CLIENT: New video track from ${participant.identity}, current: ${this.activeParticipant?.identity || 'none'}`);
            // Use safe debounced trigger
            this.triggerStreamUpdate(participant.identity, 200);
          }
        }

        // Force video tracks to start playing immediately
        if (track.kind === 'video' && track.mediaStreamTrack) {
          track.mediaStreamTrack.enabled = true;
          console.log(`▶️ LIVEKIT CLIENT: Enabled video track from ${participant.identity}`);
        }

        // Debug info
        if (this.onDebugInfo) {
          try {
            this.onDebugInfo({
              type: 'track_subscribed',
              participant: participant.identity,
              trackKind: track.kind,
              trackSid: track.sid
            });
          } catch (error) {
            console.error('❌ LIVEKIT CLIENT: Error in onDebugInfo callback:', error);
          }
        }
      } catch (error) {
        console.error('❌ LIVEKIT CLIENT: Error in TrackSubscribed handler:', error);
      }
    });
    
    this.room.on(RoomEvent.TrackUnsubscribed, (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      console.log(`🔇 LIVEKIT CLIENT: Unsubscribed from ${track.kind} track from ${participant.identity}`);
      this.consumers.delete(`${participant.identity}-${track.kind}`);
    });
    
    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      console.log(`👤 LIVEKIT CLIENT: Participant connected: ${participant.identity}`);
      
      // If this is the first participant and we're not streaming, they might be the streamer
      if (!this.currentStreamerId && this.consumers.size === 0) {
        this.currentStreamerId = participant.identity;
      }
    });
    
    this.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      try {
        console.log(`👋 LIVEKIT CLIENT: Participant disconnected: ${participant.identity}`);

        // Clean up consumers for this participant
        this.consumers.forEach((track, key) => {
          if (key.startsWith(participant.identity)) {
            this.consumers.delete(key);
          }
        });

        // If the active participant disconnected, we need to switch to another one
        if (this.activeParticipant && this.activeParticipant.identity === participant.identity) {
          console.log(`🔄 LIVEKIT CLIENT: Active participant ${participant.identity} disconnected, switching to next available`);

          // Clean up the old stream since this participant is gone
          this.cleanupOldStream();
          this.activeParticipant = null;
          this.currentStreamerId = null;

          // Use safe debounced trigger for participant switch
          this.triggerStreamUpdate(participant.identity, 200);
        }
      } catch (error) {
        console.error('❌ LIVEKIT CLIENT: Error in ParticipantDisconnected handler:', error);
      }
    });
    
    this.room.on(RoomEvent.Reconnecting, () => {
      console.log('🔄 LIVEKIT CLIENT: Reconnecting to room...');
      this.isReconnecting = true;
    });
    
    this.room.on(RoomEvent.Reconnected, () => {
      console.log('✅ LIVEKIT CLIENT: Reconnected to room');
      this.isReconnecting = false;
      this.reconnectionAttempts = 0;
    });
  }

  /**
   * Get LiveKit token and connection info from server
   */
  private async getLiveKitToken(): Promise<LiveKitTokenResponse> {
    try {
      // Use socket ID as identity for consistency with MediaSoup
      const identity = this.socket.id || `user-${Date.now()}`;
      
      // First try the transport endpoint (which returns LiveKit data in LiveKit mode)
      const transportResponse = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socketId: identity,
          isMobile: false
        })
      });
      
      if (transportResponse.ok) {
        const transportData = await transportResponse.json();
        
        // Check if LiveKit data is present
        if (transportData.livekitData) {
          console.log('📋 LIVEKIT CLIENT: Got token from transport endpoint');
          return {
            token: transportData.livekitData.token,
            url: transportData.livekitData.url,
            roomName: transportData.livekitData.roomName,
            identity: identity
          };
        }
      }
      
      // Fallback to dedicated LiveKit token endpoint
      const tokenResponse = await fetch(
        `${this.serverUrl}/api/livekit/token?identity=${identity}&room=${this.roomName}`
      );
      
      if (!tokenResponse.ok) {
        throw new Error(`Failed to get LiveKit token: ${tokenResponse.status}`);
      }
      
      const tokenData = await tokenResponse.json();
      console.log('📋 LIVEKIT CLIENT: Got token from LiveKit endpoint');
      
      return tokenData;
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to get token:', error);
      throw error;
    }
  }

  /**
   * Create send transport (MediaSoup compatible)
   * In LiveKit, this gets a token and prepares for connection
   */
  async createSendTransport(): Promise<void> {
    console.log('📡 LIVEKIT CLIENT: Creating send transport (getting LiveKit token)...');
    
    try {
      // Get LiveKit token and connection info
      const tokenInfo = await this.getLiveKitToken();
      this.token = tokenInfo.token;
      this.wsUrl = tokenInfo.url;
      this.roomName = tokenInfo.roomName;
      this.identity = tokenInfo.identity;
      
      console.log(`✅ LIVEKIT CLIENT: Got token for room ${this.roomName} as ${this.identity}`);
      
      // Update fake transport state
      this.sendTransport = { 
        id: 'livekit-send-transport', 
        state: 'ready',
        token: this.token,
        url: this.wsUrl
      };
      
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to create send transport:', error);
      throw error;
    }
  }

  /**
   * Create receive transport (MediaSoup compatible)
   * In LiveKit, this is a no-op as connection handles both send and receive
   */
  async createRecvTransport(): Promise<void> {
    console.log('📡 LIVEKIT CLIENT: Creating receive transport (no-op in LiveKit)');
    // LiveKit handles send and receive in the same connection
    // Update fake transport state for compatibility
    this.recvTransport = { 
      id: 'livekit-recv-transport', 
      state: 'ready'
    };
  }

  /**
   * Produce media (MediaSoup compatible)
   * In LiveKit, this connects to room and publishes tracks
   */
  async produce(stream: MediaStream): Promise<void> {
    console.log('🎬 LIVEKIT CLIENT: Starting to produce media...');
    console.log(`📊 Stream tracks - Video: ${stream.getVideoTracks().length} Audio: ${stream.getAudioTracks().length}`);
    
    try {
      // Ensure we have token
      if (!this.token) {
        await this.createSendTransport();
      }
      
      // Connect to room if not connected
      if (!this.room || this.room.state !== 'connected') {
        console.log('🔗 LIVEKIT CLIENT: Connecting to room...');
        
        if (!this.room) {
          this.room = new Room({
            adaptiveStream: false,
            dynacast: false,
            simulcast: false,
            videoCaptureDefaults: {
              resolution: VideoPresets.h720.resolution,
            },
          } as RoomOptions);
          this.setupRoomEventHandlers();
        }
        
        // Add connection timeout
        const connectPromise = this.room.connect(this.wsUrl, this.token, {
          autoSubscribe: true,
        } as RoomConnectOptions);
        
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection timeout')), 10000);
        });
        
        await Promise.race([connectPromise, timeoutPromise]);
        
        console.log('✅ LIVEKIT CLIENT: Connected to room');
      }
      
      // Store the stream
      this.localStream = stream;
      
      // Get tracks from stream
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      
      // Publish video track
      if (videoTrack) {
        console.log('📹 LIVEKIT CLIENT: Publishing video track...');
        try {
          const publication = await this.room.localParticipant.publishTrack(videoTrack);
          this.localVideoTrack = publication.track as LocalVideoTrack;
          this.videoProducer = this.localVideoTrack;
          console.log('✅ LIVEKIT CLIENT: Video track published successfully');
        } catch (error) {
          console.error('❌ LIVEKIT CLIENT: Failed to publish video track:', error);
          throw error;
        }
      }

      // Publish audio track
      if (audioTrack) {
        console.log('🎤 LIVEKIT CLIENT: Publishing audio track...');
        try {
          const publication = await this.room.localParticipant.publishTrack(audioTrack);
          this.localAudioTrack = publication.track as LocalAudioTrack;
          this.audioProducer = this.localAudioTrack;
          console.log('✅ LIVEKIT CLIENT: Audio track published successfully');
        } catch (error) {
          console.error('❌ LIVEKIT CLIENT: Failed to publish audio track:', error);
          throw error;
        }
      }
      
      // Update current streamer ID
      this.currentStreamerId = this.identity;
      
      console.log('✅ LIVEKIT CLIENT: Media production started');
      
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to produce media:', error);
      throw error;
    }
  }

  /**
   * Check if room is in a valid state for operations
   */
  private isRoomReady(): boolean {
    if (this.isDestroyed) {
      console.warn('⚠️ LIVEKIT CLIENT: Client is destroyed');
      return false;
    }

    if (!this.room) {
      console.warn('⚠️ LIVEKIT CLIENT: Room not initialized');
      return false;
    }

    if (this.room.state !== 'connected') {
      console.warn(`⚠️ LIVEKIT CLIENT: Room not connected (state: ${this.room.state})`);
      return false;
    }

    return true;
  }

  /**
   * Clean up old stream reference before switching
   * NOTE: Don't stop LiveKit tracks - LiveKit manages track lifecycle
   */
  private cleanupOldStream(): void {
    if (this.currentStream) {
      console.log('🧹 LIVEKIT CLIENT: Releasing old stream reference');
      // Just release the reference, don't stop tracks
      // LiveKit manages track lifecycle internally
      this.currentStream = null;
    }
  }

  /**
   * Select the best participant to display based on current state
   */
  private selectActiveParticipant(): RemoteParticipant | null {
    if (!this.room) return null;

    const allParticipants = Array.from(this.room.remoteParticipants.values());

    // CRITICAL FIX: Filter out disconnecting/disconnected participants to prevent flip-flopping
    const connectedParticipants = allParticipants.filter((p) => {
      // Check connection state - exclude participants that are disconnecting or disconnected
      const isDisconnecting = p.connectionQuality === 'lost';
      const hasMetadata = p.metadata && p.metadata !== '';

      // Filter out participants marked as disconnecting
      if (isDisconnecting) {
        console.log(`🔻 LIVEKIT CLIENT: Filtering out disconnecting participant: ${p.identity}`);
        return false;
      }

      return true;
    });

    console.log(`📊 LIVEKIT CLIENT: ${allParticipants.length} total participants, ${connectedParticipants.length} connected`);

    // Helper function to check if participant has active video tracks
    const hasActiveVideoTracks = (p: RemoteParticipant): boolean => {
      const publications = Array.from(p.trackPublications.values());
      return publications.some((pub: any) =>
        pub.kind === 'video' && pub.track && pub.subscribed && pub.track.mediaStreamTrack
      );
    };

    // Separate real streamers from viewbots (only from connected participants)
    const realStreamers = connectedParticipants.filter((p) => !p.identity.startsWith('viewbot-'));
    const viewbotParticipants = connectedParticipants.filter((p) => p.identity.startsWith('viewbot-'));

    // Filter real streamers to only those with active tracks
    const realStreamersWithTracks = realStreamers.filter(hasActiveVideoTracks);

    // Prefer real streamers with tracks over viewbots
    if (realStreamersWithTracks.length > 0) {
      const selected = realStreamersWithTracks[0];

      // If we're switching from viewbot to real streamer, log it
      if (this.activeParticipant?.identity.startsWith('viewbot-')) {
        console.log(`🔄 LIVEKIT CLIENT: Switching from viewbot to real streamer with tracks: ${selected.identity}`);
      } else if (this.activeParticipant?.identity !== selected.identity) {
        console.log(`📺 LIVEKIT CLIENT: Selected real streamer with tracks: ${selected.identity}`);
      }

      return selected;
    }

    // If real streamers exist but don't have tracks yet, log it
    if (realStreamers.length > 0) {
      console.log(`⏳ LIVEKIT CLIENT: Real streamer(s) present but no tracks yet: ${realStreamers.map(p => p.identity).join(', ')}`);
    }

    // Handle viewbots
    if (viewbotParticipants.length > 0) {
      // Filter to only viewbots with active video tracks
      const viewbotsWithTracks = viewbotParticipants.filter(hasActiveVideoTracks);

      if (viewbotsWithTracks.length === 0) {
        console.log('⚠️ LIVEKIT CLIENT: No viewbots with active tracks');
        return null;
      }

      // If we have a current active viewbot with tracks, keep it for stability
      // UNLESS there's a new viewbot (indicates rotation in progress)
      if (this.activeParticipant &&
          this.activeParticipant.identity.startsWith('viewbot-') &&
          viewbotsWithTracks.includes(this.activeParticipant)) {

        // Check if there's a newer viewbot (different from current)
        const otherViewbots = viewbotsWithTracks.filter(
          (p) => p.identity !== this.activeParticipant!.identity
        );

        if (otherViewbots.length > 0) {
          // There's another viewbot - this indicates rotation
          // Use deterministic selection to pick the "best" one
          const allViewbotsSorted = viewbotsWithTracks.sort((a, b) =>
            a.identity.localeCompare(b.identity)
          );
          const selected = allViewbotsSorted[0];

          if (selected.identity !== this.activeParticipant.identity) {
            console.log(`🔄 LIVEKIT CLIENT: Viewbot rotation detected, switching from ${this.activeParticipant.identity} to ${selected.identity}`);
            return selected;
          } else {
            // Current is still the best choice
            return this.activeParticipant;
          }
        } else {
          // Only one viewbot with tracks (the current one), keep it
          return this.activeParticipant;
        }
      }

      // No active participant or it's not in the list, select deterministically
      viewbotsWithTracks.sort((a, b) => a.identity.localeCompare(b.identity));
      const selected = viewbotsWithTracks[0];

      if (viewbotsWithTracks.length > 1) {
        console.log(`⚠️ LIVEKIT CLIENT: Multiple viewbots with tracks (${viewbotsWithTracks.length}), selected: ${selected.identity}`);
      } else {
        console.log(`📺 LIVEKIT CLIENT: Selected viewbot: ${selected.identity}`);
      }

      return selected;
    }

    return null;
  }

  /**
   * Wait for a participant's tracks to be ready
   * CRITICAL FIX: Actually enforces track readiness before returning
   */
  private async waitForParticipantTracks(participant: RemoteParticipant, timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 200; // Check every 200ms

    console.log(`⏳ LIVEKIT CLIENT: Waiting for tracks from ${participant.identity} (timeout: ${timeoutMs}ms)...`);

    while (Date.now() - startTime < timeoutMs) {
      const publications = Array.from(participant.trackPublications.values());
      const readyTracks = publications.filter((pub: any) =>
        pub.track && pub.subscribed && pub.track.mediaStreamTrack
      );

      if (readyTracks.length > 0) {
        const elapsed = Date.now() - startTime;
        console.log(`✅ LIVEKIT CLIENT: Participant ${participant.identity} has ${readyTracks.length} ready tracks (waited ${elapsed}ms)`);
        return true;
      }

      // Log progress every second
      const elapsed = Date.now() - startTime;
      if (elapsed % 1000 < pollInterval) {
        console.log(`⏳ LIVEKIT CLIENT: Still waiting for tracks... (${Math.floor(elapsed/1000)}s/${Math.floor(timeoutMs/1000)}s)`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.error(`❌ LIVEKIT CLIENT: Timeout waiting for tracks from ${participant.identity} after ${timeoutMs}ms`);
    return false;
  }

  /**
   * Consume media (MediaSoup compatible)
   * In LiveKit, this returns a MediaStream with subscribed tracks
   */
  async consume(): Promise<MediaStream | null> {
    console.log('📺 LIVEKIT CLIENT: Starting to consume media...');

    // Check if destroyed
    if (this.isDestroyed) {
      console.error('❌ LIVEKIT CLIENT: Cannot consume - client is destroyed');
      return null;
    }

    // Prevent concurrent consume operations
    if (this.isSwitchingStream) {
      console.log('⏳ LIVEKIT CLIENT: Stream switch in progress, waiting...');
      // Wait for current switch to complete
      let waitTime = 0;
      while (this.isSwitchingStream && waitTime < 5000 && !this.isDestroyed) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitTime += 100;
      }

      // If still switching or destroyed, return null
      if (this.isSwitchingStream || this.isDestroyed) {
        console.warn('⚠️ LIVEKIT CLIENT: Consume aborted - still switching or destroyed');
        return null;
      }
    }

    this.isSwitchingStream = true;

    try {
      // Ensure we have token
      if (!this.token) {
        // Get token as a viewer
        const tokenInfo = await this.getLiveKitToken();
        this.token = tokenInfo.token;
        this.wsUrl = tokenInfo.url;
        this.roomName = tokenInfo.roomName;
        this.identity = tokenInfo.identity;
      }

      // Connect to room if not connected
      if (!this.room || this.room.state !== 'connected') {
        console.log('🔗 LIVEKIT CLIENT: Connecting to room as viewer...');

        if (!this.room) {
          this.room = new Room({
            adaptiveStream: false,
            dynacast: false,
            simulcast: false,
            videoCaptureDefaults: {
              resolution: VideoPresets.h720.resolution,
            },
            stopLocalTrackOnUnpublish: false,
          } as RoomOptions);
          this.setupRoomEventHandlers();
        }

        // Add connection timeout
        const connectPromise = this.room.connect(this.wsUrl, this.token, {
          autoSubscribe: true,
          maxRetries: 3,
        } as RoomConnectOptions);

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection timeout')), 10000);
        });

        await Promise.race([connectPromise, timeoutPromise]);

        console.log('✅ LIVEKIT CLIENT: Connected to room as viewer');
      }

      // Wait for tracks to be available or timeout
      let waitTime = 0;
      const maxWait = 5000; // 5 seconds max wait

      while (this.consumers.size === 0 && waitTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitTime += 100;
      }

      // Select the best participant to display
      const selectedParticipant = this.selectActiveParticipant();

      if (!selectedParticipant) {
        console.log('⚠️ LIVEKIT CLIENT: No participants available to consume');
        this.isSwitchingStream = false;
        return new MediaStream(); // Return empty stream
      }

      // If this is a different participant, switch to them
      const isNewParticipant = !this.activeParticipant ||
                               this.activeParticipant.identity !== selectedParticipant.identity;

      if (isNewParticipant) {
        console.log(`🔄 LIVEKIT CLIENT: Switching from ${this.activeParticipant?.identity || 'none'} to ${selectedParticipant.identity}`);

        // CRITICAL FIX: Wait for new participant's tracks to be ready with longer timeout
        const tracksReady = await this.waitForParticipantTracks(selectedParticipant, 10000); // Increased from 3s to 10s
        if (!tracksReady) {
          // FIX: Don't proceed if tracks aren't ready - throw an error instead
          console.error(`❌ LIVEKIT CLIENT: Cannot consume - tracks not ready for ${selectedParticipant.identity}`);
          this.isSwitchingStream = false;
          throw new Error(`Tracks not ready for participant ${selectedParticipant.identity}`);
        }

        // Clean up old stream
        this.cleanupOldStream();

        // Update active participant
        this.activeParticipant = selectedParticipant;
        this.currentStreamerId = selectedParticipant.identity;
      }

      // Create a new MediaStream with tracks from the active participant
      const stream = new MediaStream();

      if (this.activeParticipant) {
        this.activeParticipant.trackPublications.forEach((publication: any) => {
          if (publication.track && publication.subscribed && publication.track.mediaStreamTrack) {
            stream.addTrack(publication.track.mediaStreamTrack);
            console.log(`➕ LIVEKIT CLIENT: Added ${publication.kind} track from ${this.activeParticipant!.identity}`);
          }
        });
      }

      // CRITICAL FIX: Enforce that we have tracks before returning
      if (stream.getTracks().length === 0) {
        console.error('❌ LIVEKIT CLIENT: No tracks available after waiting - cannot consume empty stream');
        this.isSwitchingStream = false;
        throw new Error('No tracks available to consume');
      }

      // Store the current stream reference
      this.currentStream = stream;

      console.log(`✅ LIVEKIT CLIENT: Consuming ${stream.getTracks().length} tracks from ${this.activeParticipant?.identity}`);
      return stream;

    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to consume media:', error);
      // Reset state on error
      this.activeParticipant = null;
      this.currentStreamerId = null;
      return null;
    } finally {
      // Always reset the switching flag
      this.isSwitchingStream = false;
    }
  }

  /**
   * Stop producing media
   */
  async stopProducing(): Promise<void> {
    console.log('🛑 LIVEKIT CLIENT: Stopping media production...');
    
    try {
      if (this.room && this.room.localParticipant) {
        // Unpublish all tracks
        this.room.localParticipant.trackPublications.forEach((publication) => {
          if (publication.track) {
            this.room!.localParticipant.unpublishTrack(publication.track as LocalTrack);
          }
        });
      }
      
      // Stop local tracks
      if (this.localVideoTrack) {
        this.localVideoTrack.stop();
        this.localVideoTrack = null;
        this.videoProducer = null;
      }
      
      if (this.localAudioTrack) {
        this.localAudioTrack.stop();
        this.localAudioTrack = null;
        this.audioProducer = null;
      }
      
      // Stop local stream tracks
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => track.stop());
        this.localStream = null;
      }
      
      this.currentStreamerId = null;
      console.log('✅ LIVEKIT CLIENT: Media production stopped');
      
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to stop producing:', error);
      throw error;
    }
  }

  /**
   * Attempt reconnection
   */
  async attemptReconnection(): Promise<void> {
    if (this.isReconnecting) {
      console.log('⏳ LIVEKIT CLIENT: Already reconnecting, skipping');
      return;
    }
    
    this.isReconnecting = true;
    this.reconnectionAttempts++;
    
    console.log(`🔄 LIVEKIT CLIENT: Reconnection attempt ${this.reconnectionAttempts}/${this.maxReconnectionAttempts}`);
    
    try {
      if (this.room) {
        // LiveKit handles reconnection automatically
        // We just need to wait for it
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Reconnection timeout'));
          }, this.operationTimeout);
          
          const handleReconnected = () => {
            clearTimeout(timeout);
            this.room!.off(RoomEvent.Reconnected, handleReconnected);
            resolve(undefined);
          };
          
          this.room!.once(RoomEvent.Reconnected, handleReconnected);
        });
        
        console.log('✅ LIVEKIT CLIENT: Reconnected successfully');
        this.reconnectionAttempts = 0;
        this.isReconnecting = false;
        
        if (this.onConnectionRecovered) {
          this.onConnectionRecovered();
        }
      }
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Reconnection failed:', error);
      this.isReconnecting = false;
      
      if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
        if (this.onReconnectionFailed) {
          this.onReconnectionFailed(new Error('Max reconnection attempts reached'));
        }
      } else {
        // Exponential backoff
        const delay = Math.min(
          this.reconnectionDelay * Math.pow(2, this.reconnectionAttempts - 1),
          this.maxReconnectionDelay
        );
        
        console.log(`⏱️ LIVEKIT CLIENT: Retrying in ${delay}ms`);
        
        this.reconnectionTimer = setTimeout(() => {
          this.attemptReconnection();
        }, delay);
      }
    }
  }

  /**
   * Handle connection recovery
   */
  async handleConnectionRecovery(): Promise<void> {
    console.log('🔧 LIVEKIT CLIENT: Handling connection recovery...');
    
    // LiveKit handles most recovery automatically
    if (this.onConnectionRecovered) {
      this.onConnectionRecovered();
    }
  }

  /**
   * Restart ICE (MediaSoup compatible)
   * LiveKit handles ICE automatically
   */
  async restartIce(): Promise<void> {
    console.log('🔄 LIVEKIT CLIENT: ICE restart requested (handled automatically by LiveKit)');
    // LiveKit handles ICE restarts automatically
  }

  /**
   * Reset client with proper cleanup
   */
  async reset(): Promise<void> {
    console.log('🔄 LIVEKIT CLIENT: Performing complete reset...');

    // Clear all pending timeouts
    this.clearAllTimeouts();

    // Clear pending updates
    this.pendingStreamUpdates.clear();

    // Clean up stream before resetting
    this.cleanupOldStream();

    // Stop producing
    try {
      await this.stopProducing();
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Error stopping production during reset:', error);
    }

    // Disconnect from room if connected
    if (this.room) {
      try {
        this.room.disconnect();
      } catch (error) {
        console.error('❌ LIVEKIT CLIENT: Error disconnecting during reset:', error);
      }
    }

    // Clear state
    this.consumers.clear();
    this.token = '';
    this.wsUrl = '';
    this.currentStreamerId = null;
    this.activeParticipant = null;
    this.reconnectionAttempts = 0;
    this.isReconnecting = false;
    this.isSwitchingStream = false;

    console.log('✅ LIVEKIT CLIENT: Reset complete');
  }

  /**
   * Replace audio track (MediaSoup compatible)
   */
  async replaceAudioTrack(newTrack: MediaStreamTrack): Promise<void> {
    console.log('🔄 LIVEKIT CLIENT: Replacing audio track...');
    
    try {
      if (this.room && this.room.localParticipant && this.localAudioTrack) {
        // Unpublish old track
        this.room.localParticipant.unpublishTrack(this.localAudioTrack);
        
        // Publish new track
        this.localAudioTrack = this.room.localParticipant.publishTrack(newTrack) as any;
        this.audioProducer = this.localAudioTrack;
        
        console.log('✅ LIVEKIT CLIENT: Audio track replaced');
      } else {
        console.warn('⚠️ LIVEKIT CLIENT: No audio track to replace');
      }
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to replace audio track:', error);
      throw error;
    }
  }

  /**
   * Replace video track (MediaSoup compatible)
   */
  async replaceVideoTrack(newTrack: MediaStreamTrack): Promise<void> {
    console.log('🔄 LIVEKIT CLIENT: Replacing video track...');
    
    try {
      if (this.room && this.room.localParticipant && this.localVideoTrack) {
        // Unpublish old track
        this.room.localParticipant.unpublishTrack(this.localVideoTrack);
        
        // Publish new track
        this.localVideoTrack = this.room.localParticipant.publishTrack(newTrack) as any;
        this.videoProducer = this.localVideoTrack;
        
        console.log('✅ LIVEKIT CLIENT: Video track replaced');
      } else {
        console.warn('⚠️ LIVEKIT CLIENT: No video track to replace');
      }
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to replace video track:', error);
      throw error;
    }
  }

  /**
   * Check if audio producer exists
   */
  get hasAudioProducer(): boolean {
    return this.audioProducer !== null && this.audioProducer !== undefined;
  }

  /**
   * Check if video producer exists
   */
  get hasVideoProducer(): boolean {
    return this.videoProducer !== null && this.videoProducer !== undefined;
  }

  /**
   * Cleanup client (MediaSoup compatible)
   */
  async cleanup(): Promise<void> {
    console.log('🧹 LIVEKIT CLIENT: Cleaning up...');
    await this.destroy();
  }

  /**
   * Get current streamer ID (MediaSoup compatible)
   */
  getCurrentStreamer(): string | null {
    return this.currentStreamerId;
  }

  /**
   * Force reconnection (MediaSoup compatible)
   */
  async forceReconnection(): Promise<void> {
    console.log('🔄 LIVEKIT CLIENT: Forcing reconnection...');
    if (this.room) {
      this.room.disconnect();
      // Re-connect with same token
      if (this.token && this.wsUrl) {
        await this.room.connect(this.wsUrl, this.token);
      }
    }
  }

  /**
   * Get connection state (MediaSoup compatible)
   */
  get connectionState(): 'connected' | 'disconnected' | 'reconnecting' {
    if (!this.room) return 'disconnected';
    switch (this.room.state) {
      case 'connected':
        return 'connected';
      case 'connecting':
        return 'reconnecting'; // Map connecting to reconnecting for compatibility
      case 'reconnecting':
        return 'reconnecting';
      default:
        return 'disconnected';
    }
  }

  /**
   * Get reconnection info (MediaSoup compatible)
   */
  get reconnectionInfo(): { attempts: number } {
    return { attempts: this.reconnectionAttempts };
  }

  /**
   * Check if client is ready (MediaSoup compatible)
   */
  get isReady(): boolean {
    return this.room !== null && !this.isDestroyed;
  }

  /**
   * Destroy client with comprehensive cleanup
   */
  async destroy(): Promise<void> {
    console.log('💥 LIVEKIT CLIENT: Destroying client...');

    // Set destroyed flag first to prevent new operations
    this.isDestroyed = true;

    // Clear all pending timeouts
    this.clearAllTimeouts();

    // Clear pending stream updates
    this.pendingStreamUpdates.clear();

    // Clean up stream reference
    this.cleanupOldStream();

    // Stop producing if we were
    try {
      await this.stopProducing();
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Error stopping production during destroy:', error);
    }

    // Disconnect and cleanup room
    if (this.room) {
      try {
        // Remove all event listeners before disconnecting
        this.room.removeAllListeners();
        // Disconnect from room
        this.room.disconnect();
      } catch (error) {
        console.error('❌ LIVEKIT CLIENT: Error disconnecting room:', error);
      }
      this.room = null;
    }

    // Clear all state
    this.consumers.clear();
    this.activeParticipant = null;
    this.currentStreamerId = null;
    this.isSwitchingStream = false;
    this.isReconnecting = false;
    this.reconnectionAttempts = 0;

    // Clear local tracks
    this.localVideoTrack = null;
    this.localAudioTrack = null;
    this.localStream = null;

    console.log('✅ LIVEKIT CLIENT: Client destroyed');
  }
}

export default LiveKitClient;