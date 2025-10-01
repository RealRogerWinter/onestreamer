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
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        simulcast: true,
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
   * Set up LiveKit room event handlers
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
      console.log(`📺 LIVEKIT CLIENT: Subscribed to ${track.kind} track from ${participant.identity}`);
      this.consumers.set(`${participant.identity}-${track.kind}`, track);
      
      // Debug info
      if (this.onDebugInfo) {
        this.onDebugInfo({
          type: 'track_subscribed',
          participant: participant.identity,
          trackKind: track.kind,
          trackSid: track.sid
        });
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
      console.log(`👋 LIVEKIT CLIENT: Participant disconnected: ${participant.identity}`);
      
      // Clean up consumers for this participant
      this.consumers.forEach((track, key) => {
        if (key.startsWith(participant.identity)) {
          this.consumers.delete(key);
        }
      });
      
      if (this.currentStreamerId === participant.identity) {
        this.currentStreamerId = null;
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
            adaptiveStream: true,
            dynacast: true,
            simulcast: true,
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
        this.localVideoTrack = this.room.localParticipant.publishTrack(videoTrack) as any;
        this.videoProducer = this.localVideoTrack;
        console.log('✅ LIVEKIT CLIENT: Video track published');
      }
      
      // Publish audio track
      if (audioTrack) {
        console.log('🎤 LIVEKIT CLIENT: Publishing audio track...');
        this.localAudioTrack = this.room.localParticipant.publishTrack(audioTrack) as any;
        this.audioProducer = this.localAudioTrack;
        console.log('✅ LIVEKIT CLIENT: Audio track published');
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
   * Consume media (MediaSoup compatible)
   * In LiveKit, this returns a MediaStream with subscribed tracks
   */
  async consume(): Promise<MediaStream | null> {
    console.log('📺 LIVEKIT CLIENT: Starting to consume media...');
    
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
            adaptiveStream: true,
            dynacast: true,
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
        
        console.log('✅ LIVEKIT CLIENT: Connected to room as viewer');
      }
      
      // Wait for tracks to be available or timeout
      let waitTime = 0;
      const maxWait = 5000; // 5 seconds max wait
      
      while (this.consumers.size === 0 && waitTime < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitTime += 100;
      }
      
      // Create a MediaStream with all subscribed tracks
      const stream = new MediaStream();
      
      // Get all remote participants
      if (this.room) {
        this.room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((publication: any) => {
            if (publication.track && publication.subscribed && publication.track.mediaStreamTrack) {
              stream.addTrack(publication.track.mediaStreamTrack);
              console.log(`➕ LIVEKIT CLIENT: Added ${publication.kind} track from ${participant.identity} to stream`);
            }
          });
        });
      }
      
      // Also check our consumers map as fallback
      if (stream.getTracks().length === 0) {
        this.consumers.forEach((track: RemoteTrack) => {
          if (track.mediaStreamTrack && !stream.getTracks().includes(track.mediaStreamTrack)) {
            stream.addTrack(track.mediaStreamTrack);
            console.log(`➕ LIVEKIT CLIENT: Added ${track.kind} track to stream (from consumers)`);
          }
        });
      }
      
      if (stream.getTracks().length === 0) {
        console.log('⚠️ LIVEKIT CLIENT: No tracks available to consume yet');
        // Return an empty stream instead of null for compatibility
        return stream;
      }
      
      console.log(`✅ LIVEKIT CLIENT: Consuming ${stream.getTracks().length} tracks`);
      return stream;
      
    } catch (error) {
      console.error('❌ LIVEKIT CLIENT: Failed to consume media:', error);
      return null;
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
   * Reset client
   */
  async reset(): Promise<void> {
    console.log('🔄 LIVEKIT CLIENT: Performing complete reset...');
    
    await this.stopProducing();
    
    if (this.room) {
      this.room.disconnect();
    }
    
    this.consumers.clear();
    this.token = '';
    this.wsUrl = '';
    this.currentStreamerId = null;
    this.reconnectionAttempts = 0;
    this.isReconnecting = false;
    
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
   * Destroy client
   */
  async destroy(): Promise<void> {
    console.log('💥 LIVEKIT CLIENT: Destroying client...');
    
    this.isDestroyed = true;
    
    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer);
      this.reconnectionTimer = undefined;
    }
    
    await this.stopProducing();
    
    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
    
    this.consumers.clear();
    
    console.log('✅ LIVEKIT CLIENT: Client destroyed');
  }
}

export default LiveKitClient;