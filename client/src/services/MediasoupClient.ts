import * as mediasoupClient from 'mediasoup-client';
import { Device } from 'mediasoup-client';
import { Socket } from 'socket.io-client';

export interface MediasoupClientConfig {
  socket: Socket;
  serverUrl?: string;
  onConnectionRecovered?: () => void;
  onConnectionLost?: () => void;
  onReconnectionFailed?: (error: Error) => void;
}

export class MediasoupClient {
  private device: Device;
  private socket: Socket;
  private serverUrl: string;
  private sendTransport?: mediasoupClient.types.Transport;
  private recvTransport?: mediasoupClient.types.Transport;
  private videoProducer?: mediasoupClient.types.Producer;
  private audioProducer?: mediasoupClient.types.Producer;
  private consumers: Map<string, mediasoupClient.types.Consumer> = new Map();
  private isDestroyed: boolean = false;
  private isProcessing: boolean = false;
  private operationTimeout: number = 10000; // 10 seconds
  private reconnectionAttempts: number = 0;
  private maxReconnectionAttempts: number = 5;
  private reconnectionDelay: number = 1000; // Start with 1 second
  private maxReconnectionDelay: number = 30000; // Max 30 seconds
  private reconnectionTimer?: NodeJS.Timeout;
  private isReconnecting: boolean = false;
  private lastConnectionState: 'connected' | 'disconnected' = 'disconnected';
  private healthCheckInterval?: NodeJS.Timeout;
  private onConnectionRecovered?: () => void;
  private onConnectionLost?: () => void;
  private onReconnectionFailed?: (error: Error) => void;
  
  constructor(config: MediasoupClientConfig) {
    this.socket = config.socket;
    this.serverUrl = config.serverUrl || 'http://localhost:8080';
    this.device = new Device();
    this.onConnectionRecovered = config.onConnectionRecovered;
    this.onConnectionLost = config.onConnectionLost;
    this.onReconnectionFailed = config.onReconnectionFailed;
    
    // Set up connection monitoring
    this.setupConnectionMonitoring();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number = this.operationTimeout): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Operation timeout after ${ms}ms`)), ms)
      )
    ]);
  }

  private validateState(): boolean {
    return !this.isDestroyed && this.socket?.connected && !this.isProcessing;
  }

  private setProcessing(value: boolean): void {
    this.isProcessing = value;
  }

  private setupConnectionMonitoring(): void {
    // Monitor socket connection state
    this.socket.on('connect', () => {
      console.log('🔗 MEDIASOUP CLIENT: Socket connected');
      if (this.lastConnectionState === 'disconnected') {
        this.handleConnectionRecovered();
      }
      this.lastConnectionState = 'connected';
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('🔌 MEDIASOUP CLIENT: Socket disconnected:', reason);
      this.lastConnectionState = 'disconnected';
      this.handleConnectionLost();
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('❌ MEDIASOUP CLIENT: Socket connection error:', error);
      this.handleConnectionError(error);
    });

    // Start health check monitoring
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    // Check connection health every 5 seconds
    this.healthCheckInterval = setInterval(() => {
      if (this.socket.connected && this.device.loaded && !this.isDestroyed) {
        this.performHealthCheck();
      }
    }, 5000);
  }

  private async performHealthCheck(): Promise<void> {
    try {
      // Check if we can reach the server
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch(`${this.serverUrl}/health`, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      
      // Reset reconnection attempts on successful health check
      if (this.reconnectionAttempts > 0) {
        console.log('✅ MEDIASOUP CLIENT: Health check passed, resetting reconnection counter');
        this.reconnectionAttempts = 0;
        this.reconnectionDelay = 1000;
      }
      
    } catch (error) {
      console.warn('⚠️ MEDIASOUP CLIENT: Health check failed:', error);
      this.handleConnectionError(error as Error);
    }
  }

  private handleConnectionLost(): void {
    console.log('📡 MEDIASOUP CLIENT: Connection lost, starting recovery...');
    
    if (this.onConnectionLost) {
      this.onConnectionLost();
    }
    
    if (!this.isReconnecting && !this.isDestroyed) {
      this.startReconnection();
    }
  }

  private handleConnectionRecovered(): void {
    console.log('🎉 MEDIASOUP CLIENT: Connection recovered');
    
    // Clear any pending reconnection
    this.stopReconnection();
    
    if (this.onConnectionRecovered) {
      this.onConnectionRecovered();
    }
    
    // Attempt to restore media streams
    this.attemptStreamRecovery();
  }

  private handleConnectionError(error: Error): void {
    console.error('⚠️ MEDIASOUP CLIENT: Connection error:', error);
    
    if (!this.isReconnecting && !this.isDestroyed && this.lastConnectionState === 'connected') {
      this.startReconnection();
    }
  }

  private startReconnection(): void {
    if (this.isReconnecting || this.isDestroyed) {
      return;
    }
    
    this.isReconnecting = true;
    console.log(`🔄 MEDIASOUP CLIENT: Starting reconnection attempt ${this.reconnectionAttempts + 1}/${this.maxReconnectionAttempts}`);
    
    if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
      console.error('❌ MEDIASOUP CLIENT: Max reconnection attempts reached');
      this.isReconnecting = false;
      
      if (this.onReconnectionFailed) {
        this.onReconnectionFailed(new Error('Max reconnection attempts reached'));
      }
      return;
    }
    
    const delay = Math.min(
      this.reconnectionDelay * Math.pow(2, this.reconnectionAttempts),
      this.maxReconnectionDelay
    );
    
    console.log(`⏳ MEDIASOUP CLIENT: Waiting ${delay}ms before reconnection attempt`);
    
    this.reconnectionTimer = setTimeout(() => {
      this.attemptReconnection();
    }, delay);
    
    this.reconnectionAttempts++;
  }

  private async attemptReconnection(): Promise<void> {
    try {
      console.log('🔄 MEDIASOUP CLIENT: Attempting to reconnect...');
      
      // First check if socket is connected
      if (!this.socket.connected) {
        console.log('🔌 MEDIASOUP CLIENT: Socket not connected, waiting for socket reconnection...');
        this.isReconnecting = false;
        return;
      }
      
      // Try to recreate the connection
      await this.recreateTransports();
      
      // Reset reconnection state on success
      this.reconnectionAttempts = 0;
      this.reconnectionDelay = 1000;
      this.isReconnecting = false;
      
      console.log('✅ MEDIASOUP CLIENT: Reconnection successful');
      
      if (this.onConnectionRecovered) {
        this.onConnectionRecovered();
      }
      
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Reconnection attempt failed:', error);
      this.isReconnecting = false;
      
      // Start next reconnection attempt
      setTimeout(() => {
        if (!this.isDestroyed) {
          this.startReconnection();
        }
      }, 1000);
    }
  }

  private stopReconnection(): void {
    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer);
      this.reconnectionTimer = undefined;
    }
    
    this.isReconnecting = false;
    this.reconnectionAttempts = 0;
    this.reconnectionDelay = 1000;
  }

  private async attemptStreamRecovery(): Promise<void> {
    // This method can be overridden by consumers to implement custom stream recovery
    console.log('🔄 MEDIASOUP CLIENT: Attempting stream recovery...');
    
    try {
      // Check if we need to recreate transports
      const needsRecreation = !this.sendTransport?.closed === false || 
                             !this.recvTransport?.closed === false ||
                             !this.device.loaded;
      
      if (needsRecreation) {
        await this.recreateTransports();
      }
      
      console.log('✅ MEDIASOUP CLIENT: Stream recovery completed');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Stream recovery failed:', error);
    }
  }

  async initialize(): Promise<void> {
    if (!this.validateState()) {
      throw new Error('MediasoupClient is in invalid state for initialization');
    }

    this.setProcessing(true);
    console.log('🎬 MEDIASOUP CLIENT: Initializing device...');
    
    try {
      // Check if device is already loaded
      if (this.device.loaded) {
        console.log('🔄 MEDIASOUP CLIENT: Device already loaded, skipping initialization');
        return;
      }

      // Get router RTP capabilities from server with timeout
      const response = await this.withTimeout(
        fetch(`${this.serverUrl}/api/mediasoup/router-capabilities`)
      );
      
      if (!response.ok) {
        throw new Error(`Failed to get router capabilities: ${response.status} ${response.statusText}`);
      }
      
      const { rtpCapabilities } = await response.json();
      
      if (!rtpCapabilities) {
        throw new Error('No RTP capabilities received from server');
      }
      
      console.log('📊 MEDIASOUP CLIENT: Received RTP capabilities from server');
      
      // Load the device with router capabilities
      await this.withTimeout(
        this.device.load({ routerRtpCapabilities: rtpCapabilities })
      );
      
      console.log('✅ MEDIASOUP CLIENT: Device loaded successfully');
      console.log('📊 MEDIASOUP CLIENT: RTP Capabilities:', this.device.rtpCapabilities);
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to initialize device:', error);
      throw error;
    } finally {
      this.setProcessing(false);
    }
  }

  async createSendTransport(): Promise<void> {
    console.log('📡 MEDIASOUP CLIENT: Creating send transport...');
    
    if (!this.socket.id) {
      throw new Error('Socket ID not available. Ensure socket is connected.');
    }
    
    console.log(`📡 MEDIASOUP CLIENT: Using socket ID: ${this.socket.id}`);
    
    try {
      // Request transport creation from server
      const response = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: this.socket.id })
      });
      
      const transportOptions = await response.json();
      
      // Optimized ICE servers configuration with priority
      const sendTransportOptions = {
        ...transportOptions,
        iceServers: process.env.NODE_ENV === 'production' ? [
          // Production: prioritize low-latency STUN servers
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' }
        ] : [
          // Development: include TURN for NAT traversal
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceTransportPolicy: 'all', // Use all available candidates
        iceCandidatePoolSize: 10, // Pre-gather ICE candidates
        rtcpMuxPolicy: 'require' // Multiplex RTP and RTCP
      };
      
      // Create send transport
      this.sendTransport = this.device.createSendTransport(sendTransportOptions);
      
      // Handle transport events
      this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          console.log('🔗 MEDIASOUP CLIENT: Connecting send transport...');
          
          if (!this.socket.id) {
            throw new Error('Socket ID not available during transport connect');
          }
          
          console.log(`🔗 MEDIASOUP CLIENT: Connecting transport for socket: ${this.socket.id}`);
          
          // Add timeout and retry logic
          const connectWithRetry = async (attempts = 0): Promise<Response> => {
            const maxAttempts = 3;
            
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 5000);
              
              const response = await fetch(`${this.serverUrl}/api/mediasoup/connect-transport`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  socketId: this.socket.id,
                  dtlsParameters
                }),
                signal: controller.signal
              });
              
              clearTimeout(timeoutId);
              
              if (!response.ok) {
                throw new Error(`Transport connection failed: ${response.status} ${response.statusText}`);
              }
              
              return response;
            } catch (error) {
              if (attempts < maxAttempts - 1 && !this.isDestroyed) {
                console.log(`🔄 MEDIASOUP CLIENT: Connect attempt ${attempts + 1}/${maxAttempts} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 500 * (attempts + 1)));
                return connectWithRetry(attempts + 1);
              }
              throw error;
            }
          };
          
          await connectWithRetry();
          callback();
        } catch (error) {
          console.error('❌ MEDIASOUP CLIENT: Send transport connect failed:', error);
          errback(error as Error);
        }
      });

      this.sendTransport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        try {
          console.log(`🎬 MEDIASOUP CLIENT: Producing ${kind}...`);
          
          // Send produce request via socket.io for real-time handling
          this.socket.emit('mediasoup:produce', { kind, rtpParameters }, (response: any) => {
            if (response.success) {
              callback({ id: response.producerId });
              console.log(`✅ MEDIASOUP CLIENT: Producer created for ${kind}`);
            } else {
              errback(new Error(response.error));
            }
          });
        } catch (error) {
          console.error('❌ MEDIASOUP CLIENT: Produce failed:', error);
          errback(error as Error);
        }
      });

      console.log('✅ MEDIASOUP CLIENT: Send transport created');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to create send transport:', error);
      throw error;
    }
  }

  async createRecvTransport(): Promise<void> {
    console.log('📡 MEDIASOUP CLIENT: Creating receive transport...');
    
    try {
      // Request transport creation from server
      const response = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: this.socket.id })
      });
      
      const transportOptions = await response.json();
      
      // Add ICE servers to transport options for client-side WebRTC
      const recvTransportOptions = {
        ...transportOptions,
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ]
      };
      
      // Create receive transport
      this.recvTransport = this.device.createRecvTransport(recvTransportOptions);
      
      // Handle connection state changes to detect issues
      this.recvTransport.on('connectionstatechange', (state) => {
        console.log(`📡 MEDIASOUP CLIENT: Receive transport connection state changed to: ${state}`);
        
        // Don't close transport on temporary disconnections
        if (state === 'disconnected') {
          console.log('⚠️ MEDIASOUP CLIENT: Transport disconnected, waiting for reconnection...');
          // Give it time to reconnect before considering it failed
          setTimeout(() => {
            if (this.recvTransport?.connectionState === 'disconnected') {
              console.log('❌ MEDIASOUP CLIENT: Transport still disconnected after timeout');
            }
          }, 5000);
        } else if (state === 'failed') {
          console.error('❌ MEDIASOUP CLIENT: Transport connection failed');
        }
      });
      
      // Handle transport events
      this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          console.log('🔗 MEDIASOUP CLIENT: Connecting receive transport...');
          const response = await fetch(`${this.serverUrl}/api/mediasoup/connect-transport`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              socketId: this.socket.id,
              dtlsParameters
            })
          });
          
          if (!response.ok) throw new Error('Failed to connect transport');
          callback();
        } catch (error) {
          console.error('❌ MEDIASOUP CLIENT: Receive transport connect failed:', error);
          errback(error as Error);
        }
      });

      console.log('✅ MEDIASOUP CLIENT: Receive transport created');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to create receive transport:', error);
      throw error;
    }
  }

  async produce(stream: MediaStream): Promise<void> {
    if (!this.sendTransport) {
      throw new Error('Send transport not created. Call createSendTransport() first.');
    }

    // Clean up any existing producers first
    await this.stopProducing();

    console.log('🎬 MEDIASOUP CLIENT: Starting to produce media...');
    
    try {
      // Produce video track
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        console.log('📺 MEDIASOUP CLIENT: Creating video producer...');
        // Back to single high-quality stream - simulcast was causing quality issues
        this.videoProducer = await this.sendTransport.produce({
          track: videoTrack,
          codecOptions: {
            videoGoogleStartBitrate: 2500, // Good starting bitrate
            videoGoogleMaxBitrate: 5000, // Max 5 Mbps for high quality
            videoGoogleMinBitrate: 500 // Min 500 kbps
          },
          encodings: [
            {
              maxBitrate: 5000000, // 5 Mbps for good quality
              scaleResolutionDownBy: 1, // Full resolution
              maxFramerate: 30
            }
          ],
          appData: { mediaType: 'video' }
        });
        
        console.log('📺 MEDIASOUP CLIENT: Video producer created:', this.videoProducer.id);
      }

      // Produce audio track
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        console.log('🎤 MEDIASOUP CLIENT: Creating audio producer...');
        this.audioProducer = await this.sendTransport.produce({
          track: audioTrack,
          codecOptions: {
            opusStereo: true,
            opusFec: true, // Forward error correction
            opusDtx: true, // Discontinuous transmission
            opusMaxPlaybackRate: 48000,
            opusMaxAverageBitrate: 128000,
            opusPtime: 20 // Packet time
          },
          appData: { mediaType: 'audio' }
        });
        
        console.log('🎤 MEDIASOUP CLIENT: Audio producer created:', this.audioProducer.id);
      }

    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to produce:', error);
      // Clean up on error
      await this.stopProducing();
      throw error;
    }
  }

  async replaceAudioTrack(newTrack: MediaStreamTrack): Promise<void> {
    if (!this.audioProducer) {
      console.warn('⚠️ MEDIASOUP CLIENT: No audio producer to replace track');
      return;
    }

    try {
      console.log('🎤 MEDIASOUP CLIENT: Replacing audio track...');
      await this.audioProducer.replaceTrack({ track: newTrack });
      console.log('✅ MEDIASOUP CLIENT: Audio track replaced successfully');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to replace audio track:', error);
      throw error;
    }
  }

  async replaceVideoTrack(newTrack: MediaStreamTrack): Promise<void> {
    if (!this.videoProducer) {
      console.warn('⚠️ MEDIASOUP CLIENT: No video producer to replace track');
      return;
    }

    try {
      console.log('📹 MEDIASOUP CLIENT: Replacing video track...');
      await this.videoProducer.replaceTrack({ track: newTrack });
      console.log('✅ MEDIASOUP CLIENT: Video track replaced successfully');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to replace video track:', error);
      throw error;
    }
  }

  get hasAudioProducer(): boolean {
    return !!this.audioProducer;
  }

  get hasVideoProducer(): boolean {
    return !!this.videoProducer;
  }

  async consume(): Promise<MediaStream | null> {
    if (!this.recvTransport) {
      throw new Error('Receive transport not created. Call createRecvTransport() first.');
    }

    if (this.isDestroyed) {
      throw new Error('MediasoupClient is destroyed, cannot consume');
    }

    // Clean up existing consumers first
    await this.stopConsuming();
    
    // Small delay to ensure cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('📺 MEDIASOUP CLIENT: Starting to consume media...');
    
    try {
      // Request to consume video and audio from server with timeout
      const consumePromises = [
        this.consumeTrack('video'),
        this.consumeTrack('audio')
      ];
      
      // Add overall timeout for both tracks
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Overall consume timeout after 15 seconds')), 15000);
      });
      
      const [videoStream, audioStream] = await Promise.race([
        Promise.all(consumePromises),
        timeoutPromise
      ]);
      
      // Combine tracks into one stream
      const combinedStream = new MediaStream();
      let trackCount = 0;
      
      if (videoStream) {
        const videoTracks = videoStream.getTracks();
        videoTracks.forEach(track => {
          if (track.readyState === 'live') {
            // Clone the track to avoid issues with multiple consumers
            const clonedTrack = track.clone();
            combinedStream.addTrack(clonedTrack);
            trackCount++;
            console.log(`📺 MEDIASOUP CLIENT: Added cloned video track (id: ${clonedTrack.id}, state: ${clonedTrack.readyState})`);
          } else {
            console.warn('⚠️ MEDIASOUP CLIENT: Skipping video track in non-live state:', track.readyState);
          }
        });
      }
      
      if (audioStream) {
        const audioTracks = audioStream.getTracks();
        audioTracks.forEach(track => {
          if (track.readyState === 'live') {
            // Clone the track to avoid issues with multiple consumers
            const clonedTrack = track.clone();
            combinedStream.addTrack(clonedTrack);
            trackCount++;
            console.log(`🎤 MEDIASOUP CLIENT: Added cloned audio track (id: ${clonedTrack.id}, state: ${clonedTrack.readyState})`);
          } else {
            console.warn('⚠️ MEDIASOUP CLIENT: Skipping audio track in non-live state:', track.readyState);
          }
        });
      }
      
      if (trackCount > 0) {
        console.log(`✅ MEDIASOUP CLIENT: Media stream ready with ${trackCount} live tracks`);
        
        // Set up stream event handlers
        combinedStream.getTracks().forEach(track => {
          track.addEventListener('ended', () => {
            console.log(`📺 MEDIASOUP CLIENT: Track ${track.kind} ended`);
          });
          
          track.addEventListener('mute', () => {
            console.log(`🔇 MEDIASOUP CLIENT: Track ${track.kind} muted`);
          });
          
          track.addEventListener('unmute', () => {
            console.log(`🔊 MEDIASOUP CLIENT: Track ${track.kind} unmuted`);
          });
        });
        
        return combinedStream;
      } else {
        console.warn('⚠️ MEDIASOUP CLIENT: No live tracks available to consume');
        return null;
      }
      
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to consume:', error);
      
      // Clean up any partial consumers on failure
      await this.stopConsuming();
      
      throw error;
    }
  }

  private async consumeTrack(kind: 'video' | 'audio'): Promise<MediaStream | null> {
    // Enhanced consume with retry logic
    const maxAttempts = 3;
    let attempt = 0;
    
    while (attempt < maxAttempts) {
      attempt++;
      console.log(`📺 MEDIASOUP CLIENT: Consume attempt ${attempt}/${maxAttempts} for ${kind}`);
      
      try {
        const stream = await this.attemptConsumeTrack(kind, attempt);
        if (stream) {
          console.log(`✅ MEDIASOUP CLIENT: Successfully consumed ${kind} on attempt ${attempt}`);
          return stream;
        }
      } catch (error) {
        console.warn(`⚠️ MEDIASOUP CLIENT: Consume attempt ${attempt} failed for ${kind}:`, error);
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < maxAttempts) {
        const delay = attempt * 500; // 500ms, 1000ms delays
        console.log(`⏳ MEDIASOUP CLIENT: Waiting ${delay}ms before retry for ${kind}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.error(`❌ MEDIASOUP CLIENT: Failed to consume ${kind} after ${maxAttempts} attempts`);
    return null;
  }
  
  private async attemptConsumeTrack(kind: 'video' | 'audio', attempt: number): Promise<MediaStream | null> {
    return new Promise((resolve, reject) => {
      // Add timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error(`Consume timeout for ${kind} on attempt ${attempt}`));
      }, 8000); // 8 second timeout
      
      this.socket.emit('mediasoup:consume', { 
        rtpCapabilities: this.device.rtpCapabilities,
        kind: kind // Request specific track kind
      }, async (response: any) => {
        clearTimeout(timeout);
        
        if (!response.success) {
          console.log(`⚠️ MEDIASOUP CLIENT: No ${kind} stream available: ${response.error}`);
          resolve(null);
          return;
        }

        try {
          const { consumer: consumerData } = response;
          
          // Validate consumer data
          if (!consumerData || !consumerData.id || !consumerData.rtpParameters) {
            throw new Error(`Invalid consumer data received for ${kind}`);
          }
          
          console.log(`📺 MEDIASOUP CLIENT: Creating ${kind} consumer:`, consumerData.id);
          
          // Check if transport is still available (race condition protection)
          if (!this.recvTransport || this.recvTransport.closed) {
            throw new Error(`Receive transport unavailable for ${kind} consumer (${this.recvTransport ? 'closed' : 'undefined'})`);
          }
          
          // Create consumer with error handling
          let consumer;
          try {
            consumer = await this.recvTransport.consume({
              id: consumerData.id,
              producerId: consumerData.producerId,
              kind: consumerData.kind,
              rtpParameters: consumerData.rtpParameters
            });
          } catch (consumeError) {
            console.error(`❌ MEDIASOUP CLIENT: Failed to create consumer for ${kind}:`, consumeError);
            reject(consumeError);
            return;
          }

          // Set up consumer event handlers
          const consumerId = consumer.id;
          consumer.on('transportclose', () => {
            console.log(`🔒 MEDIASOUP CLIENT: ${kind} consumer transport closed`);
            this.consumers.delete(consumerId);
          });

          consumer.on('trackended', () => {
            console.log(`🔒 MEDIASOUP CLIENT: ${kind} consumer track ended`);
            this.consumers.delete(consumerId);
          });

          this.consumers.set(consumer.id, consumer);
          console.log(`✅ MEDIASOUP CLIENT: ${kind} consumer created:`, consumer.id);

          // Resume the consumer with promise-based approach
          await new Promise<void>((resumeResolve, resumeReject) => {
            const resumeTimeout = setTimeout(() => {
              resumeReject(new Error(`Resume timeout for ${kind} consumer`));
            }, 5000);
            
            this.socket.emit('mediasoup:resume-consumer', { 
              consumerId: consumerId 
            }, (resumeResponse: any) => {
              clearTimeout(resumeTimeout);
              
              if (resumeResponse.success) {
                console.log(`▶️ MEDIASOUP CLIENT: ${kind} consumer resumed:`, consumerId);
                resumeResolve();
              } else {
                resumeReject(new Error(`Failed to resume ${kind} consumer: ${resumeResponse.error}`));
              }
            });
          });

          // Wait a moment for track to stabilize
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Verify track is active before creating stream
          if (consumer.track.readyState === 'ended') {
            throw new Error(`${kind} track is ended immediately after creation`);
          }
          
          // Create media stream from consumer track
          const stream = new MediaStream([consumer.track]);
          
          console.log(`✅ MEDIASOUP CLIENT: ${kind} stream created with track state: ${consumer.track.readyState}`);
          
          resolve(stream);
          
        } catch (error) {
          console.error(`❌ MEDIASOUP CLIENT: Failed to create ${kind} consumer:`, error);
          reject(error);
        }
      });
    });
  }

  async stopProducing(): Promise<void> {
    console.log('⏹️ MEDIASOUP CLIENT: Stopping producers...');
    
    const stopTasks: Promise<void>[] = [];
    
    if (this.videoProducer && !this.videoProducer.closed) {
      stopTasks.push(
        Promise.resolve().then(() => {
          this.videoProducer!.close();
          this.videoProducer = undefined;
          console.log('⏹️ MEDIASOUP CLIENT: Video producer stopped');
        })
      );
    }
    
    if (this.audioProducer && !this.audioProducer.closed) {
      stopTasks.push(
        Promise.resolve().then(() => {
          this.audioProducer!.close();
          this.audioProducer = undefined;
          console.log('⏹️ MEDIASOUP CLIENT: Audio producer stopped');
        })
      );
    }
    
    if (stopTasks.length > 0) {
      await Promise.all(stopTasks);
      // Allow time for proper cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async stopConsuming(): Promise<void> {
    console.log('⏹️ MEDIASOUP CLIENT: Stopping consumers...');
    
    if (this.consumers.size === 0) {
      return;
    }
    
    const stopTasks: Promise<void>[] = [];
    
    this.consumers.forEach((consumer, id) => {
      if (!consumer.closed) {
        stopTasks.push(
          Promise.resolve().then(() => {
            consumer.close();
            console.log('⏹️ MEDIASOUP CLIENT: Consumer stopped:', id);
          })
        );
      }
    });
    
    if (stopTasks.length > 0) {
      await Promise.all(stopTasks);
      // Allow time for proper cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.consumers.clear();
    console.log('✅ MEDIASOUP CLIENT: All consumers stopped');
  }

  async cleanup(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }
    
    this.isDestroyed = true;
    console.log('🧹 MEDIASOUP CLIENT: Starting cleanup...');
    
    // Stop reconnection and monitoring
    this.stopReconnection();
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    
    try {
      // Stop producing first
      await this.stopProducing();
      
      // Then stop consuming
      await this.stopConsuming();
      
      // Close transports in sequence with delays
      if (this.sendTransport && !this.sendTransport.closed) {
        this.sendTransport.close();
        this.sendTransport = undefined;
        console.log('🧹 MEDIASOUP CLIENT: Send transport closed');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (this.recvTransport && !this.recvTransport.closed) {
        this.recvTransport.close();
        this.recvTransport = undefined;
        console.log('🧹 MEDIASOUP CLIENT: Receive transport closed');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      console.log('✅ MEDIASOUP CLIENT: Cleanup completed');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Error during cleanup:', error);
    } finally {
      this.setProcessing(false);
    }
  }

  async recreateTransports(): Promise<void> {
    console.log('🔄 MEDIASOUP CLIENT: Recreating transports...');
    
    if (!this.validateState()) {
      throw new Error('Cannot recreate transports in current state');
    }
    
    this.setProcessing(true);
    
    try {
      // Complete cleanup first
      await this.cleanup();
      
      // Reset destroyed state to allow reinitialization
      this.isDestroyed = false;
      
      // Wait for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Reinitialize everything
      await this.initialize();
      await this.createSendTransport();
      await this.createRecvTransport();
      
      console.log('✅ MEDIASOUP CLIENT: Transports recreated successfully');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to recreate transports:', error);
      throw error;
    } finally {
      this.setProcessing(false);
    }
  }

  get isReady(): boolean {
    return this.device.loaded;
  }

  get canProduce(): boolean {
    return this.device.canProduce('video');
  }

  get connectionState(): 'connected' | 'disconnected' | 'reconnecting' {
    if (this.isReconnecting) return 'reconnecting';
    return this.lastConnectionState;
  }

  get reconnectionInfo(): { attempts: number; maxAttempts: number; isReconnecting: boolean } {
    return {
      attempts: this.reconnectionAttempts,
      maxAttempts: this.maxReconnectionAttempts,
      isReconnecting: this.isReconnecting
    };
  }

  get destroyed(): boolean {
    return this.isDestroyed;
  }

  // Force a reconnection attempt (useful for manual recovery)
  async forceReconnection(): Promise<void> {
    console.log('🔄 MEDIASOUP CLIENT: Force reconnection requested');
    this.stopReconnection();
    this.reconnectionAttempts = 0;
    await this.attemptReconnection();
  }
}