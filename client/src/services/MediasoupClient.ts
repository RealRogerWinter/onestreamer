import * as mediasoupClient from 'mediasoup-client';
import { Device, detectDevice } from 'mediasoup-client';
import { Socket } from 'socket.io-client';
import * as crypto from 'crypto-js';
import { isIOSSafari, isIOS, isMobile } from '../utils/browserDetection';

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
  private operationTimeout: number = 30000; // 30 seconds for mobile networks
  private reconnectionAttempts: number = 0;
  private maxReconnectionAttempts: number = 5;
  private reconnectionDelay: number = 1000; // Start with 1 second
  private maxReconnectionDelay: number = 30000; // Max 30 seconds
  private reconnectionTimer?: NodeJS.Timeout;
  private isReconnecting: boolean = false;
  private lastConnectionState: 'connected' | 'disconnected' = 'disconnected';
  private healthCheckInterval?: NodeJS.Timeout;
  private onConnectionRecovered?: () => void;
  private currentStreamerId: string | null = null;
  private onConnectionLost?: () => void;
  private onReconnectionFailed?: (error: Error) => void;
  public onDebugInfo?: (info: any) => void;
  
  constructor(config: MediasoupClientConfig) {
    this.socket = config.socket;
    this.serverUrl = config.serverUrl || process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';
    
    // CRITICAL: Use detectDevice for proper iOS Safari detection
    // This performs feature detection which is essential for Safari
    try {
      const detectedDevice = detectDevice();
      console.log('🔍 MEDIASOUP CLIENT: Detected device handler:', detectedDevice || 'unknown');
      if (isIOSSafari() || isIOS()) {
        console.log('📱 MEDIASOUP CLIENT: iOS Safari detected, using appropriate handler');
      }
    } catch (e) {
      console.warn('⚠️ MEDIASOUP CLIENT: Device detection warning:', e);
    }
    
    this.device = new Device();
    this.onConnectionRecovered = config.onConnectionRecovered;
    this.onConnectionLost = config.onConnectionLost;
    this.onReconnectionFailed = config.onReconnectionFailed;
    this.onDebugInfo = (config as any).onDebugInfo;
    
    // Set up connection monitoring
    this.setupConnectionMonitoring();
  }

  private generateTurnCredential(username: string): string {
    // Generate time-limited TURN credentials using HMAC-SHA1
    const secret = '***REMOVED-TURN-SECRET***';
    const hash = crypto.HmacSHA1(username, secret);
    return crypto.enc.Base64.stringify(hash);
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
      // console.log('🔗 MEDIASOUP CLIENT: Socket connected');
      if (this.lastConnectionState === 'disconnected') {
        this.handleConnectionRecovered();
      }
      this.lastConnectionState = 'connected';
    });

    this.socket.on('disconnect', (reason: string) => {
      // console.log('🔌 MEDIASOUP CLIENT: Socket disconnected:', reason);
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
        // Also perform transport stats check to keep connection alive
        this.performTransportStatsCheck();
      }
    }, 5000);
  }

  private async performTransportStatsCheck(): Promise<void> {
    try {
      // Get stats from transport to keep ICE connection active
      if (this.recvTransport && !this.recvTransport.closed) {
        const stats = await this.recvTransport.getStats();
        // Getting stats helps maintain the ICE connection
        // by triggering ICE consent checks
        
        // Check if any transport is in a bad state
        stats.forEach((stat) => {
          if (stat.type === 'transport' && stat.state === 'failed') {
            console.warn('⚠️ MEDIASOUP CLIENT: Transport stats show failed state');
            this.handleTransportFailure();
          }
        });
      }
      
      // Also check consumer stats to ensure media is flowing
      const consumerEntries = Array.from(this.consumers.entries());
      for (const [id, consumer] of consumerEntries) {
        if (!consumer.closed) {
          try {
            const consumerStats = await consumer.getStats();
            // Getting consumer stats also helps keep the connection alive
          } catch (error) {
            console.warn(`⚠️ MEDIASOUP CLIENT: Failed to get stats for consumer ${id}:`, error);
          }
        }
      }
    } catch (error) {
      // Stats errors are not critical, just log them
      // console.debug('Stats check error (non-critical):', error);
    }
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
      
      // Check transport health
      if (this.recvTransport) {
        const transportState = this.recvTransport.connectionState;
        if (transportState === 'failed' || transportState === 'disconnected') {
          console.warn(`⚠️ MEDIASOUP CLIENT: Transport in bad state: ${transportState}`);
          // Trigger recovery for failed transport
          if (transportState === 'failed') {
            await this.handleTransportFailure();
          }
        }
      }
      
      // Check consumer health
      let hasActiveConsumer = false;
      const consumersList = Array.from(this.consumers.entries());
      for (const [id, consumer] of consumersList) {
        if (!consumer.closed && consumer.track?.readyState === 'live') {
          hasActiveConsumer = true;
          break;
        }
      }
      
      // If we should have consumers but don't, trigger recovery
      if (this.currentStreamerId && !hasActiveConsumer && this.consumers.size === 0) {
        console.warn('⚠️ MEDIASOUP CLIENT: No active consumers detected, may need recovery');
      }
      
      // Reset reconnection attempts on successful health check
      if (this.reconnectionAttempts > 0) {
        // console.log('✅ MEDIASOUP CLIENT: Health check passed, resetting reconnection counter');
        this.reconnectionAttempts = 0;
        this.reconnectionDelay = 1000;
      }
      
    } catch (error) {
      console.warn('⚠️ MEDIASOUP CLIENT: Health check failed:', error);
      this.handleConnectionError(error as Error);
    }
  }

  private handleConnectionLost(): void {
    // console.log('📡 MEDIASOUP CLIENT: Connection lost, starting recovery...');
    
    if (this.onConnectionLost) {
      this.onConnectionLost();
    }
    
    if (!this.isReconnecting && !this.isDestroyed) {
      this.startReconnection();
    }
  }

  private handleConnectionRecovered(): void {
    // console.log('🎉 MEDIASOUP CLIENT: Connection recovered');
    
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

  private async handleTransportFailure(): Promise<void> {
    // console.log('🔴 MEDIASOUP CLIENT: Transport failure detected, initiating recovery...');
    
    // Don't attempt recovery if already destroyed or reconnecting
    if (this.isDestroyed || this.isReconnecting) {
      return;
    }

    // Notify about connection loss
    if (this.onConnectionLost) {
      this.onConnectionLost();
    }

    // Close existing transports
    try {
      if (this.recvTransport) {
        this.recvTransport.close();
        this.recvTransport = undefined;
      }
      if (this.sendTransport) {
        this.sendTransport.close();
        this.sendTransport = undefined;
      }
    } catch (error) {
      console.error('Error closing transports:', error);
    }

    // Clear consumers
    this.consumers.clear();

    // Start reconnection process
    this.startReconnection();
  }

  private startReconnection(): void {
    if (this.isReconnecting || this.isDestroyed) {
      return;
    }
    
    this.isReconnecting = true;
    // console.log(`🔄 MEDIASOUP CLIENT: Starting reconnection attempt ${this.reconnectionAttempts + 1}/${this.maxReconnectionAttempts}`);
    
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
    
    // console.log(`⏳ MEDIASOUP CLIENT: Waiting ${delay}ms before reconnection attempt`);
    
    this.reconnectionTimer = setTimeout(() => {
      this.attemptReconnection();
    }, delay);
    
    this.reconnectionAttempts++;
  }

  private async attemptReconnection(): Promise<void> {
    try {
      // console.log('🔄 MEDIASOUP CLIENT: Attempting to reconnect...');
      
      // First check if socket is connected
      if (!this.socket.connected) {
        // console.log('🔌 MEDIASOUP CLIENT: Socket not connected, waiting for socket reconnection...');
        this.isReconnecting = false;
        return;
      }
      
      // Try to recreate the connection
      await this.recreateTransports();
      
      // Reset reconnection state on success
      this.reconnectionAttempts = 0;
      this.reconnectionDelay = 1000;
      this.isReconnecting = false;
      
      // console.log('✅ MEDIASOUP CLIENT: Reconnection successful');
      
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
    // console.log('🔄 MEDIASOUP CLIENT: Attempting stream recovery...');
    
    try {
      // Check if we need to recreate transports
      const needsRecreation = !this.sendTransport?.closed === false || 
                             !this.recvTransport?.closed === false ||
                             !this.device.loaded;
      
      if (needsRecreation) {
        await this.recreateTransports();
      }
      
      // console.log('✅ MEDIASOUP CLIENT: Stream recovery completed');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Stream recovery failed:', error);
    }
  }

  async initialize(forceReload: boolean = false): Promise<void> {
    if (!this.validateState()) {
      throw new Error('MediasoupClient is in invalid state for initialization');
    }

    // Check if we already have a healthy transport (unless force reload)
    if (!forceReload && this.device?.loaded && this.recvTransport && !this.recvTransport.closed) {
      const state = this.recvTransport.connectionState;
      if (state === 'connected' || state === 'connecting') {
        console.log('🔄 MEDIASOUP CLIENT: Already initialized with healthy transport, skipping');
        return;
      }
    }
    
    // If force reload, reset the device
    if (forceReload && this.device?.loaded) {
      console.log('🔄 MEDIASOUP CLIENT: Force reloading device with fresh RTP capabilities');
      this.device = new Device();
    }

    this.setProcessing(true);
    // console.log('🎬 MEDIASOUP CLIENT: Initializing device...');
    
    try {
      // Check if device is already loaded
      if (this.device.loaded && !this.recvTransport) {
        // console.log('🔄 MEDIASOUP CLIENT: Device already loaded, creating transport');
      } else if (this.device.loaded) {
        // console.log('🔄 MEDIASOUP CLIENT: Device already loaded, checking transport');
        return;
      }

      // Detect browser capabilities for iOS Safari
      const isIOSDevice = isIOS() || isIOSSafari();
      
      // Get router RTP capabilities from server with timeout
      // Include iOS flag to get H264-prioritized capabilities
      const url = new URL(`${this.serverUrl}/api/mediasoup/router-capabilities`);
      if (isIOSDevice) {
        url.searchParams.set('preferH264', 'true');
        console.log('📱 MEDIASOUP CLIENT: Requesting H264-prioritized capabilities for iOS');
      }
      
      const response = await this.withTimeout(
        fetch(url.toString())
      );
      
      if (!response.ok) {
        throw new Error(`Failed to get router capabilities: ${response.status} ${response.statusText}`);
      }
      
      const { rtpCapabilities } = await response.json();
      
      if (!rtpCapabilities) {
        throw new Error('No RTP capabilities received from server');
      }
      
      // For iOS, ensure H264 is available and prioritized
      if (isIOSDevice) {
        const codecs = rtpCapabilities.codecs || [];
        const hasH264 = codecs.some((codec: any) => 
          codec.mimeType?.toLowerCase() === 'video/h264'
        );
        
        if (!hasH264) {
          console.warn('⚠️ MEDIASOUP CLIENT: H264 codec not available for iOS device');
        } else {
          console.log('✅ MEDIASOUP CLIENT: H264 codec available for iOS');
        }
      }
      
      // console.log('📊 MEDIASOUP CLIENT: Received RTP capabilities from server');
      
      // Load the device with router capabilities (only if not already loaded)
      if (!this.device.loaded) {
        await this.withTimeout(
          this.device.load({ routerRtpCapabilities: rtpCapabilities })
        );
        
        // Log the handler being used (important for iOS debugging)
        const handler = (this.device as any)._handler || (this.device as any).handler;
        console.log('🎯 MEDIASOUP CLIENT: Using handler:', handler?.name || handler?.constructor?.name || 'unknown');
      }
      
      // console.log('✅ MEDIASOUP CLIENT: Device loaded successfully');
      // console.log('📊 MEDIASOUP CLIENT: RTP Capabilities:', this.device.rtpCapabilities);
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
    
    // CRITICAL FIX: Complete reset to avoid MID=0 conflicts
    console.warn('🔄 MEDIASOUP CLIENT: Performing complete reset for streaming...');
    
    // Close ALL existing transports and producers
    if (this.sendTransport && !this.sendTransport.closed) {
      console.log('🔄 Closing existing send transport...');
      this.sendTransport.close();
    }
    if (this.recvTransport && !this.recvTransport.closed) {
      console.log('🔄 Closing existing receive transport...');
      this.recvTransport.close();
    }
    
    // Reset all references
    this.sendTransport = undefined;
    this.recvTransport = undefined;
    this.videoProducer = undefined;
    this.audioProducer = undefined;
    this.consumers.clear();
    
    // Create completely fresh device
    this.device = new Device();
    
    // Initialize with fresh RTP capabilities
    await this.initialize(true); // Force reload to get fresh capabilities
    
    if (!this.device.loaded) {
      throw new Error('Failed to load MediaSoup device');
    }
    
    // Log device state for debugging
    console.log('📊 Device loaded:', this.device.loaded);
    console.log('📊 Can produce video:', this.device.canProduce('video'));
    console.log('📊 Can produce audio:', this.device.canProduce('audio'));
    
    try {
      // Detect if this is a mobile client
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      
      // Request transport creation from server with mobile flag
      const response = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          socketId: this.socket.id,
          isMobile: isMobile
        })
      });
      
      const transportOptions = await response.json();
      
      // Optimized ICE servers configuration with priority
      // TURN username must be timestamp:username where timestamp is when it expires
      const turnExpiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
      const turnUsername = `${turnExpiry}:webrtc`;
      const turnCredential = this.generateTurnCredential(turnUsername);
      
      // TURN Config set - Enhanced for iOS Safari
      const iceServersConfig = [
        // STUN servers for NAT discovery
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Our TURN server - using direct IP to bypass Cloudflare
        {
          urls: 'turn:<SERVER_IP>:3478',
          username: turnUsername,
          credential: turnCredential
        },
        {
          urls: 'turn:<SERVER_IP>:3478?transport=tcp',
          username: turnUsername,
          credential: turnCredential
        }
      ];
      
      // iOS Safari needs explicit TURN relay in some cases
      const iceTransportPolicyValue = isIOS() ? 'all' : 'all'; // Keep 'all' but iOS may need 'relay' in some cases
      
      const sendTransportOptions = {
        ...transportOptions,
        iceServers: iceServersConfig,
        iceTransportPolicy: iceTransportPolicyValue as RTCIceTransportPolicy,
        iceCandidatePoolSize: 10, // Pre-gather ICE candidates
        rtcpMuxPolicy: 'require', // Multiplex RTP and RTCP
        bundlePolicy: 'max-bundle' // Bundle media streams
      };
      
      // Create send transport (MediaSoup ignores iceServers in options)
      this.sendTransport = this.device.createSendTransport(transportOptions);
      
      // Configure TURN servers on send transport too
      // Configuring TURN servers on send transport
      try {
        const sendIceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          {
            urls: 'turn:<SERVER_IP>:3478',
            username: turnUsername,
            credential: turnCredential
          },
          {
            urls: 'turn:<SERVER_IP>:3478?transport=tcp',
            username: turnUsername,
            credential: turnCredential
          }
        ];
        await this.sendTransport.updateIceServers({ iceServers: sendIceServers });
        // TURN servers configured on send transport
      } catch (error) {
        console.error('❌ MEDIASOUP CLIENT: Failed to configure TURN on send transport:', error);
      }
      
      // Handle transport events
      this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          // console.log('🔗 MEDIASOUP CLIENT: Connecting send transport...');
          
          if (!this.socket.id) {
            throw new Error('Socket ID not available during transport connect');
          }
          
          // console.log(`🔗 MEDIASOUP CLIENT: Connecting transport for socket: ${this.socket.id}`);
          
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
                // console.log(`🔄 MEDIASOUP CLIENT: Connect attempt ${attempts + 1}/${maxAttempts} failed, retrying...`);
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

      this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          console.log(`🎬 MEDIASOUP CLIENT: Produce handler called for ${kind}`);
          console.log(`📡 Socket connected: ${this.socket.connected}, ID: ${this.socket.id}`);
          console.log(`🎬 RTP Parameters:`, rtpParameters);
          
          // If socket.id is not available, this will fail
          if (!this.socket.id) {
            throw new Error('Socket ID not available - socket not connected');
          }
          
          // Use HTTP API instead of Socket.IO for produce (more reliable)
          const response = await fetch(`${this.serverUrl}/api/mediasoup/produce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              socketId: this.socket.id,
              kind,
              rtpParameters,
              appData
            })
          });
          
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to produce');
          }
          
          const data = await response.json();
          callback({ id: data.producerId });
          console.log(`✅ MEDIASOUP CLIENT: Producer created for ${kind}: ${data.producerId}`);
        } catch (error) {
          console.error('❌ MEDIASOUP CLIENT: Produce handler error:', error);
          errback(error as Error);
        }
      });

      // console.log('✅ MEDIASOUP CLIENT: Send transport created');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to create send transport:', error);
      throw error;
    }
  }

  async createRecvTransport(): Promise<void> {
    // console.log('📡 MEDIASOUP CLIENT: Creating receive transport...');
    
    // Check if transport already exists and is connected
    if (this.recvTransport && !this.recvTransport.closed) {
      const state = this.recvTransport.connectionState;
      if (state === 'connected' || state === 'connecting') {
        console.log('📡 MEDIASOUP CLIENT: Receive transport already exists and is active, skipping creation');
        return;
      }
    }
    
    try {
      // Detect if this is a mobile client
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      
      // Request transport creation from server with mobile flag
      const response = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          socketId: this.socket.id,
          isMobile: isMobile
        })
      });
      
      const transportOptions = await response.json();
      
      // Add ICE servers to transport options for client-side WebRTC
      // TURN username must be timestamp:username where timestamp is when it expires
      const turnExpiry = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
      const recvTurnUsername = `${turnExpiry}:webrtc`;
      const recvTurnCredential = this.generateTurnCredential(recvTurnUsername);
      
      // Debug: Receive TURN Config
      
      const recvTransportOptions = {
        ...transportOptions,
        iceServers: [
          // STUN servers for NAT discovery
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          // Our TURN server - using direct IP to bypass Cloudflare
          {
            urls: 'turn:<SERVER_IP>:3478',
            username: recvTurnUsername,
            credential: recvTurnCredential
          },
          {
            urls: 'turn:<SERVER_IP>:3478?transport=tcp',
            username: recvTurnUsername,
            credential: recvTurnCredential
          }
        ],
        // CRITICAL: Android Chrome needs relay when consuming from Plain RTP producers (viewbots)
        // Detect if we're likely consuming from a viewbot based on context
        iceTransportPolicy: 'all', // Will be overridden for viewbot consumption
        iceCandidatePoolSize: 10,
        rtcpMuxPolicy: 'require',
        bundlePolicy: 'max-bundle'
      };
      
      // Create receive transport (MediaSoup ignores iceServers in options)
      this.recvTransport = this.device.createRecvTransport(transportOptions);
      
      // CRITICAL: Configure TURN servers on the transport AFTER creation
      // MediaSoup-client provides updateIceServers() to configure TURN
      // Detect if we're likely connecting to a viewbot (mobile on cellular)
      const isAndroidDevice = /Android/i.test(navigator.userAgent);
      const isCellular = isMobile && !navigator.onLine; // Simple heuristic
      // DON'T force relay - MediaSoup ICE-lite cannot receive from TURN relay
      // Instead, let the browser choose the best path (TURN will be used if needed)
      const forceRelay = false;
      
      const iceServers = [
        // STUN servers for NAT discovery
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Our TURN server with proper credentials - multiple URLs for redundancy
        {
          urls: ['turn:<SERVER_IP>:3478', 'turn:<SERVER_IP>:3478?transport=udp'],
          username: recvTurnUsername,
          credential: recvTurnCredential
        },
        {
          urls: 'turn:<SERVER_IP>:3478?transport=tcp',
          username: recvTurnUsername,
          credential: recvTurnCredential
        }
      ];
      
      // Configure ICE transport policy based on client type
      const iceConfig = {
        iceServers,
        iceTransportPolicy: forceRelay ? 'relay' : 'all' as RTCIceTransportPolicy,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle' as RTCBundlePolicy
      };
      
      // Update ICE servers on the transport
      // Configuring TURN servers on receive transport...
      const iceStartTime = Date.now();
      
      try {
        await this.recvTransport.updateIceServers(iceConfig);
        // TURN servers configured successfully
      } catch (error) {
        console.error('❌ MEDIASOUP CLIENT: Failed to configure TURN servers:', error);
      }
      
      // Collect debug info for mobile 5G issues with timestamps
      const debugCandidates: string[] = [];
      let turnCandidateFound = false;
      let relayCandidate: string | null = null;
      const candidateTimestamps: { type: string; time: number; candidate: string }[] = [];
      
      // Debug browser and connection info
      const isAndroid = /Android/i.test(navigator.userAgent);
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isSafari = /Safari/i.test(navigator.userAgent) && !/Chrome/i.test(navigator.userAgent);
      
      if (this.onDebugInfo) {
        this.onDebugInfo({
          browser: isAndroid ? 'Android' : (isIOS ? 'iOS' : 'Desktop'),
          browserEngine: isSafari ? 'Safari' : 'Chrome',
          turnUrls: recvTransportOptions.iceServers?.[2]?.urls || 'No TURN'
        });
      }
      
      // Wait a moment for the PC to be created, then access it
      const configurePeerConnection = async () => {
        // Try multiple times to get the PC as it might not be immediately available
        let pc: any = null;
        for (let i = 0; i < 10; i++) {
          pc = (this.recvTransport as any)._handler?._pc || (this.recvTransport as any)._pc;
          if (pc) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        if (!pc) {
          console.warn('⚠️ Could not access internal RTCPeerConnection');
          return;
        }
        
        // Accessing internal RTCPeerConnection for debugging
        
        // Configure TURN on the RTCPeerConnection but don't force relay
        // MediaSoup ICE-lite cannot receive from TURN relay
        if (isAndroidDevice) {
          try {
            const currentConfig = pc.getConfiguration();
            // Current ICE config check
            
            // Set the configuration with TURN servers but allow all candidates
            pc.setConfiguration({
              iceServers,
              iceTransportPolicy: 'all', // Allow all types - browser will use TURN if needed
              iceCandidatePoolSize: 10,
              bundlePolicy: 'max-bundle'
            });
            
            const newConfig = pc.getConfiguration();
            // Configured TURN servers on RTCPeerConnection for Android
          } catch (e) {
            console.error('Failed to configure TURN:', e);
          }
        }
        
        // Monitor real ICE connection state with timing
        let lastStateChange = Date.now();
        pc.oniceconnectionstatechange = () => {
          const now = Date.now();
          const timeSinceStart = (now - iceStartTime) / 1000;
          const timeSinceLastChange = (now - lastStateChange) / 1000;
          lastStateChange = now;
          
          // ICE State Change: ${pc.iceConnectionState}
          
          if (this.onDebugInfo) {
            this.onDebugInfo({
              iceState: pc.iceConnectionState,
              gatheringState: pc.iceGatheringState,
              connectionTime: `${timeSinceStart}s`
            });
          }
          
          // Log stats when connected
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            pc.getStats().then((stats: any) => {
              stats.forEach((stat: any) => {
                if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
                  // Active ICE candidate pair found
                }
                if (stat.type === 'local-candidate' && stat.isRemote === false) {
                  if (stat.candidateType === 'relay') {
                    // Using TURN relay
                  }
                }
              });
            });
          }
        };
        
        // Monitor ICE candidates directly from RTCPeerConnection
        pc.onicecandidate = (event: any) => {
          if (event.candidate) {
            const cand = event.candidate.candidate;
            const elapsed = (Date.now() - iceStartTime) / 1000;
            
            let candType = 'unknown';
            if (cand.includes('typ relay')) {
              candType = 'RELAY';
              debugCandidates.push('TURN');
              turnCandidateFound = true;
              relayCandidate = cand;
              // TURN RELAY candidate found
            } else if (cand.includes('typ srflx')) {
              candType = 'SRFLX';
              debugCandidates.push('STUN');
              // STUN candidate found
            } else if (cand.includes('typ host')) {
              candType = 'HOST';
              debugCandidates.push('HOST');
              // HOST candidate found
            }
            
            candidateTimestamps.push({
              type: candType,
              time: elapsed,
              candidate: cand.substring(0, 100)
            });
            
            if (this.onDebugInfo) {
              this.onDebugInfo({
                candidates: debugCandidates,
                turnStatus: turnCandidateFound ? 'TURN found' : 'No TURN',
                lastCandidate: `${candType} at ${elapsed}s`,
                candidateCount: candidateTimestamps.length
              });
            }
          } else {
            // ICE gathering complete
            const elapsed = (Date.now() - iceStartTime) / 1000;
            // ICE gathering complete
            
            if (!turnCandidateFound) {
              // WARNING: No TURN relay candidates found! Connection may fail on mobile networks.
            }
          }
        };
        
        // Monitor gathering state
        pc.onicegatheringstatechange = () => {
          const elapsed = (Date.now() - iceStartTime) / 1000;
          // ICE Gathering State: ${pc.iceGatheringState}
        };
      };
      
      // Execute the peer connection configuration
      configurePeerConnection();
      
      // Monitor ICE candidates for debugging (backup method)
      (this.recvTransport as any).on('icecandidate', (candidate: any) => {
        if (candidate && candidate.candidate) {
          const cand = candidate.candidate;
          if (cand.includes('relay')) {
            debugCandidates.push('TURN-RELAY: ' + cand.substring(0, 50));
            turnCandidateFound = true;
            if (this.onDebugInfo) {
              this.onDebugInfo({
                turnStatus: 'TURN relay found',
                candidates: debugCandidates
              });
            }
          } else if (cand.includes('srflx')) {
            debugCandidates.push('STUN: ' + cand.substring(0, 50));
          } else if (cand.includes('host')) {
            debugCandidates.push('HOST: ' + cand.substring(0, 50));
          }
        }
      });
      
      // Monitor ICE gathering state
      (this.recvTransport as any).on('icegatheringstatechange', (state: string) => {
        if (this.onDebugInfo) {
          this.onDebugInfo({
            iceState: state,
            turnStatus: turnCandidateFound ? 'TURN ready' : 'No TURN yet',
            candidates: debugCandidates
          });
        }
      });
      
      // Handle connection state changes to detect issues
      this.recvTransport.on('connectionstatechange', (state) => {
        if (this.onDebugInfo) {
          this.onDebugInfo({
            transportState: state,
            iceState: (this.recvTransport as any).iceConnectionState,
            turnStatus: turnCandidateFound ? 'TURN active' : 'No TURN'
          });
        }
        // console.log(`📡 MEDIASOUP CLIENT: Receive transport connection state changed to: ${state}`);
        
        // Don't close transport on temporary disconnections
        if (state === 'disconnected') {
          console.log('⚠️ MEDIASOUP CLIENT: Transport disconnected, waiting for reconnection...');
          // For mobile/relay connections, give more time to reconnect
          const isAndroid = /Android/i.test(navigator.userAgent);
          const timeout = isAndroid ? 15000 : 5000; // 15s for Android, 5s for others
          
          setTimeout(async () => {
            if (this.recvTransport?.connectionState === 'disconnected') {
              console.log('❌ MEDIASOUP CLIENT: Transport still disconnected after timeout');
              // Trigger reconnection
              await this.handleTransportFailure();
            }
          }, timeout);
        } else if (state === 'failed') {
          console.error('❌ MEDIASOUP CLIENT: Transport connection failed');
          // Immediately trigger reconnection on failure
          this.handleTransportFailure();
        } else if (state === 'connected') {
          // Transport connected successfully
        }
      });
      
      // Handle transport events
      this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          // console.log('🔗 MEDIASOUP CLIENT: Connecting receive transport...');
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

      // console.log('✅ MEDIASOUP CLIENT: Receive transport created');
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
    console.log('📊 Stream tracks - Video:', stream.getVideoTracks().length, 'Audio:', stream.getAudioTracks().length);
    console.log('🌐 Browser:', navigator.userAgent);
    
    try {
      // CRITICAL FIX: Produce AUDIO FIRST to get MID=0, then VIDEO gets MID=1
      // This prevents the MID=0 conflict that causes SDP negotiation failure
      
      // Get both tracks
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      if (audioTrack) {
        console.log('🎤 MEDIASOUP CLIENT: Creating audio producer FIRST...');
        console.log('🎙️ Audio track settings:', audioTrack.getSettings());
        console.log('🎙️ Audio track state:', audioTrack.readyState, 'enabled:', audioTrack.enabled);
        
        try {
          console.log('🎤 Producing audio to claim MID=0...');
          
          this.audioProducer = await this.sendTransport.produce({
            track: audioTrack
          });
          
          console.log('✅ Audio produce succeeded with MID=0!');
          
        } catch (audioError: any) {
          console.error('❌ Audio produce failed:', audioError.message);
          console.warn('⚠️ Continuing without audio producer');
          this.audioProducer = undefined;
        }
        
        if (this.audioProducer) {
          console.log('✅ MEDIASOUP CLIENT: Audio producer created:', this.audioProducer.id);
          console.log('🎤 Audio producer paused:', this.audioProducer.paused);
        }
      } else {
        console.warn('⚠️ No audio track found in stream');
      }
      
      // Now produce video track SECOND
      if (videoTrack) {
        console.log('📺 MEDIASOUP CLIENT: Creating video producer SECOND...');
        console.log('📹 Video track settings:', videoTrack.getSettings());
        console.log('📹 Video track state:', videoTrack.readyState, 'enabled:', videoTrack.enabled);
        
        // Simple produce - MediaSoup will assign MID=1 since audio took MID=0
        try {
          console.log('🎬 Producing video SECOND (will get MID=1)...');
          
          this.videoProducer = await this.sendTransport.produce({
            track: videoTrack
          });
          
          console.log('✅ Video produce succeeded with MID=1!');
          
        } catch (produceError: any) {
          console.error('❌ Video produce failed:', produceError.message);
          console.error('Full error:', produceError);
          this.videoProducer = undefined;
        }
        
        if (this.videoProducer) {
          console.log('✅ MEDIASOUP CLIENT: Video producer created:', this.videoProducer.id);
          console.log('📺 Video producer paused:', this.videoProducer.paused);
        } else {
          console.warn('⚠️ No video producer created, continuing with audio only');
        }
      }


    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Failed to produce:', error);
      console.error('Error details:', {
        name: (error as any).name,
        message: (error as any).message,
        stack: (error as any).stack
      });
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
      // console.log('🎤 MEDIASOUP CLIENT: Replacing audio track...');
      await this.audioProducer.replaceTrack({ track: newTrack });
      // console.log('✅ MEDIASOUP CLIENT: Audio track replaced successfully');
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
      // console.log('📹 MEDIASOUP CLIENT: Replacing video track...');
      await this.videoProducer.replaceTrack({ track: newTrack });
      // console.log('✅ MEDIASOUP CLIENT: Video track replaced successfully');
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

    // console.log('📺 MEDIASOUP CLIENT: Starting to consume media...');
    
    try {
      // Request to consume video and audio from server with timeout
      const consumePromises = [
        this.consumeTrack('video'),
        this.consumeTrack('audio')
      ];
      
      // Add overall timeout for both tracks
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Overall consume timeout after 10 seconds')), 10000);
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
            // console.log(`📺 MEDIASOUP CLIENT: Added cloned video track (id: ${clonedTrack.id}, state: ${clonedTrack.readyState})`);
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
            // console.log(`🎤 MEDIASOUP CLIENT: Added cloned audio track (id: ${clonedTrack.id}, state: ${clonedTrack.readyState})`);
          } else {
            console.warn('⚠️ MEDIASOUP CLIENT: Skipping audio track in non-live state:', track.readyState);
          }
        });
      }
      
      if (trackCount > 0) {
        // console.log(`✅ MEDIASOUP CLIENT: Media stream ready with ${trackCount} live tracks`);
        
        // Set up stream event handlers
        combinedStream.getTracks().forEach(track => {
          track.addEventListener('ended', () => {
            // console.log(`📺 MEDIASOUP CLIENT: Track ${track.kind} ended`);
          });
          
          track.addEventListener('mute', () => {
            // console.log(`🔇 MEDIASOUP CLIENT: Track ${track.kind} muted`);
          });
          
          track.addEventListener('unmute', () => {
            // console.log(`🔊 MEDIASOUP CLIENT: Track ${track.kind} unmuted`);
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
      // console.log(`📺 MEDIASOUP CLIENT: Consume attempt ${attempt}/${maxAttempts} for ${kind}`);
      
      try {
        const stream = await this.attemptConsumeTrack(kind, attempt);
        if (stream) {
          // console.log(`✅ MEDIASOUP CLIENT: Successfully consumed ${kind} on attempt ${attempt}`);
          return stream;
        }
      } catch (error) {
        console.warn(`⚠️ MEDIASOUP CLIENT: Consume attempt ${attempt} failed for ${kind}:`, error);
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < maxAttempts) {
        const delay = attempt * 500; // 500ms, 1000ms delays
        // console.log(`⏳ MEDIASOUP CLIENT: Waiting ${delay}ms before retry for ${kind}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.error(`❌ MEDIASOUP CLIENT: Failed to consume ${kind} after ${maxAttempts} attempts`);
    return null;
  }
  
  private async attemptConsumeTrack(kind: 'video' | 'audio', attempt: number): Promise<MediaStream | null> {
    // Validate transport state before attempting consumption
    if (!this.recvTransport) {
      throw new Error(`No receive transport available for ${kind} consumption`);
    }
    
    if (this.recvTransport.closed) {
      throw new Error(`Receive transport is closed, cannot consume ${kind}`);
    }
    
    // Check transport connection state
    const transportState = this.recvTransport.connectionState;
    if (transportState === 'failed') {
      throw new Error(`Transport in failed state, cannot consume ${kind}`);
    }
    
    if (transportState !== 'connected' && attempt > 2) {
      // After 2 attempts, require transport to be fully connected
      console.warn(`⚠️ MEDIASOUP CLIENT: Transport not fully connected (${transportState}) after ${attempt} attempts`);
      throw new Error(`Transport not ready (${transportState}), cannot consume ${kind}`);
    }
    
    return new Promise((resolve, reject) => {
      // Add timeout to prevent hanging
      const timeout = setTimeout(() => {
        reject(new Error(`Consume timeout for ${kind} on attempt ${attempt}`));
      }, 5000); // 5 second timeout
      
      this.socket.emit('mediasoup:consume', { 
        rtpCapabilities: this.device.rtpCapabilities,
        kind: kind // Request specific track kind
      }, async (response: any) => {
        clearTimeout(timeout);
        
        if (!response.success) {
          // console.log(`⚠️ MEDIASOUP CLIENT: No ${kind} stream available: ${response.error}`);
          resolve(null);
          return;
        }

        try {
          const { consumer: consumerData, streamerId, isViewbotStream } = response;
          
          // CRITICAL FIX: Android Chrome needs TURN relay for viewbot streams
          if (isViewbotStream && /Android/i.test(navigator.userAgent)) {
            console.warn('🤖 Android detected consuming viewbot stream - forcing TURN relay');
            if (this.onDebugInfo) {
              this.onDebugInfo({
                androidViewbotFix: 'Forcing TURN relay for viewbot stream'
              });
            }
            
            // Force ICE restart with relay-only policy for this consumer
            if (this.recvTransport) {
              // Set relay policy on the transport's underlying PC
              const pc = (this.recvTransport as any)._handler?._pc || (this.recvTransport as any)._pc;
              if (pc && pc.setConfiguration) {
                try {
                  pc.setConfiguration({
                    iceTransportPolicy: 'relay'
                  });
                  console.log('✅ Forced TURN relay for Android viewbot consumption');
                } catch (e) {
                  console.error('Failed to force relay:', e);
                }
              }
            }
          }
          
          // Store the streamer ID
          if (streamerId) {
            this.currentStreamerId = streamerId;
            // console.log(`📝 MEDIASOUP CLIENT: Current streamer ID set to ${streamerId}`);
          }
          
          // Validate consumer data
          if (!consumerData || !consumerData.id || !consumerData.rtpParameters) {
            throw new Error(`Invalid consumer data received for ${kind}`);
          }
          
          // console.log(`📺 MEDIASOUP CLIENT: Creating ${kind} consumer:`, consumerData.id);
          
          // Check if transport is still available (race condition protection)
          if (!this.recvTransport || this.recvTransport.closed) {
            throw new Error(`Receive transport unavailable for ${kind} consumer (${this.recvTransport ? 'closed' : 'undefined'})`);
          }
          
          // Create consumer with error handling
          let consumer: mediasoupClient.types.Consumer;
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
            // console.log(`🔒 MEDIASOUP CLIENT: ${kind} consumer transport closed`);
            this.consumers.delete(consumerId);
          });

          consumer.on('trackended', () => {
            // console.log(`🔒 MEDIASOUP CLIENT: ${kind} consumer track ended`);
            this.consumers.delete(consumerId);
          });

          this.consumers.set(consumer.id, consumer);
          // console.log(`✅ MEDIASOUP CLIENT: ${kind} consumer created:`, consumer.id);

          // Wait for transport to be connected before resuming consumer
          // console.log(`🔄 MEDIASOUP CLIENT: Waiting for transport connection before resuming ${kind} consumer...`);
          await new Promise<void>((connectResolve, connectReject) => {
            const connectTimeout = setTimeout(() => {
              const currentState = this.recvTransport?.connectionState || 'undefined';
              console.error(`❌ MEDIASOUP CLIENT: Transport connection timeout for ${kind} consumer (state: ${currentState})`);
              connectReject(new Error(`Transport connection timeout for ${kind} consumer (state: ${currentState})`));
            }, 15000); // Increased timeout for slower connections
            
            let checkCount = 0;
            const checkConnection = () => {
              checkCount++;
              const transportState = this.recvTransport?.connectionState;
              
              if (this.recvTransport && transportState === 'connected') {
                clearTimeout(connectTimeout);
                // console.log(`✅ MEDIASOUP CLIENT: Transport connected for ${kind} consumer after ${checkCount} checks`);
                connectResolve();
              } else if (this.recvTransport && transportState === 'failed') {
                clearTimeout(connectTimeout);
                connectReject(new Error(`Transport connection failed for ${kind} consumer`));
              } else if (transportState === 'connecting' || transportState === 'new') {
                // Still connecting, check again
                if (checkCount % 10 === 0) {
                  console.log(`⏳ MEDIASOUP CLIENT: Transport still ${transportState} for ${kind} consumer (check ${checkCount})`);
                }
                setTimeout(checkConnection, 200); // Check every 200ms instead of 100ms
              } else {
                // Unknown state
                console.warn(`⚠️ MEDIASOUP CLIENT: Unknown transport state: ${transportState}`);
                setTimeout(checkConnection, 200);
              }
            };
            
            checkConnection();
          });

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
                // console.log(`▶️ MEDIASOUP CLIENT: ${kind} consumer resumed:`, consumerId);
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
          
          // iOS FIX: Force consumer to request keyframe on video tracks
          if (kind === 'video' && (isIOS() || isIOSSafari())) {
            console.log('📱 iOS: Setting up video consumer for keyframe handling');
            
            // Monitor consumer stats for iOS
            const statsInterval = setInterval(async () => {
              if (!consumer || consumer.closed) {
                clearInterval(statsInterval);
                return;
              }
              
              try {
                const stats = await consumer.getStats();
                stats.forEach((stat: any) => {
                  if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
                    // Check for decoder issues
                    if (stat.pliCount > 0 || stat.firCount > 0 || stat.nackCount > 0) {
                      console.log(`📱 iOS Video Stats: PLI=${stat.pliCount}, FIR=${stat.firCount}, NACK=${stat.nackCount}`);
                    }
                    
                    // Check frame rate
                    if (stat.framesPerSecond !== undefined && stat.framesPerSecond < 1) {
                      console.warn('📱 iOS: Low frame rate detected:', stat.framesPerSecond);
                      // Request keyframe
                      this.socket.emit('mediasoup:request-keyframe', { 
                        consumerId: consumerId 
                      });
                    }
                  }
                });
              } catch (e) {
                // Stats collection failed, stop monitoring
                clearInterval(statsInterval);
              }
            }, 3000); // Check every 3 seconds
            
            // Store interval for cleanup
            (consumer as any)._statsInterval = statsInterval;
          }
          
          // Create media stream from consumer track
          const stream = new MediaStream([consumer.track]);
          
          // console.log(`✅ MEDIASOUP CLIENT: ${kind} stream created with track state: ${consumer.track.readyState}`);
          
          // CRITICAL FIX for iOS: Request keyframe immediately for video
          if (kind === 'video' && (isIOS() || isIOSSafari())) {
            console.log('📱 iOS: Setting up aggressive keyframe requests for video track');
            
            // Request initial keyframes multiple times
            const requestKeyframe = () => {
              this.socket.emit('mediasoup:request-keyframe', { 
                consumerId: consumerId 
              }, (response: any) => {
                if (response?.success) {
                  console.log('✅ iOS: Keyframe requested successfully');
                } else {
                  console.warn('⚠️ iOS: Keyframe request failed:', response?.error);
                }
              });
            };
            
            // Request keyframes at 100ms, 200ms, 500ms, 1s to ensure we get one
            setTimeout(requestKeyframe, 100);
            setTimeout(requestKeyframe, 200);
            setTimeout(requestKeyframe, 500);
            setTimeout(requestKeyframe, 1000);
            
            // Set up aggressive periodic keyframe requests for iOS
            let frameCheckCount = 0;
            let lastFrameCount = 0;
            let stuckFrameCount = 0;
            
            const keyframeInterval = setInterval(() => {
              if (!consumer || consumer.closed || consumer.track.readyState !== 'live') {
                clearInterval(keyframeInterval);
                return;
              }
              
              frameCheckCount++;
              
              // Check if video is actually playing
              const video = document.querySelector('video') as HTMLVideoElement;
              if (video && video.srcObject) {
                const videoTracks = (video.srcObject as MediaStream).getVideoTracks();
                if (videoTracks.length > 0 && videoTracks[0].readyState === 'live') {
                  // Check if we're getting frames
                  if ('getVideoPlaybackQuality' in video) {
                    const quality = (video as any).getVideoPlaybackQuality();
                    const totalFrames = quality.totalVideoFrames;
                    
                    // Check if frames are advancing
                    if (totalFrames === lastFrameCount) {
                      stuckFrameCount++;
                      console.log(`📱 iOS: Frames stuck at ${totalFrames} (stuck count: ${stuckFrameCount})`);
                      
                      // Request keyframe if stuck
                      if (stuckFrameCount >= 1) { // Request immediately when stuck
                        console.log('📱 iOS: Requesting keyframe due to stuck frames');
                        this.socket.emit('mediasoup:request-keyframe', { 
                          consumerId: consumerId 
                        });
                        stuckFrameCount = 0; // Reset counter after request
                      }
                    } else {
                      // Frames are advancing
                      if (stuckFrameCount > 0) {
                        console.log(`📱 iOS: Frames recovered, now at ${totalFrames}`);
                      }
                      stuckFrameCount = 0;
                    }
                    
                    lastFrameCount = totalFrames;
                    
                    // Also request keyframe every 5 checks (2.5 seconds) regardless
                    if (frameCheckCount % 5 === 0) {
                      console.log('📱 iOS: Periodic keyframe request');
                      this.socket.emit('mediasoup:request-keyframe', { 
                        consumerId: consumerId 
                      });
                    }
                  }
                }
              }
            }, 500); // Check every 500ms for faster response
            
            // Store interval for cleanup
            (consumer as any)._keyframeInterval = keyframeInterval;
          }
          
          resolve(stream);
          
        } catch (error) {
          console.error(`❌ MEDIASOUP CLIENT: Failed to create ${kind} consumer:`, error);
          reject(error);
        }
      });
    });
  }

  async stopProducing(): Promise<void> {
    // console.log('⏹️ MEDIASOUP CLIENT: Stopping producers...');
    
    const stopTasks: Promise<void>[] = [];
    
    if (this.videoProducer && !this.videoProducer.closed) {
      stopTasks.push(
        Promise.resolve().then(() => {
          this.videoProducer!.close();
          this.videoProducer = undefined;
          // console.log('⏹️ MEDIASOUP CLIENT: Video producer stopped');
        })
      );
    }
    
    if (this.audioProducer && !this.audioProducer.closed) {
      stopTasks.push(
        Promise.resolve().then(() => {
          this.audioProducer!.close();
          this.audioProducer = undefined;
          // console.log('⏹️ MEDIASOUP CLIENT: Audio producer stopped');
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
    // console.log('⏹️ MEDIASOUP CLIENT: Stopping consumers...');
    
    if (this.consumers.size === 0) {
      return;
    }
    
    const stopTasks: Promise<void>[] = [];
    
    this.consumers.forEach((consumer, id) => {
      if (!consumer.closed) {
        stopTasks.push(
          Promise.resolve().then(() => {
            // Clean up iOS keyframe interval if it exists
            if ((consumer as any)._keyframeInterval) {
              clearInterval((consumer as any)._keyframeInterval);
              (consumer as any)._keyframeInterval = null;
            }
            consumer.close();
            // console.log('⏹️ MEDIASOUP CLIENT: Consumer stopped:', id);
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
    // console.log('✅ MEDIASOUP CLIENT: All consumers stopped');
  }

  async cleanup(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }
    
    this.isDestroyed = true;
    // console.log('🧹 MEDIASOUP CLIENT: Starting cleanup...');
    
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
        // console.log('🧹 MEDIASOUP CLIENT: Send transport closed');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (this.recvTransport && !this.recvTransport.closed) {
        this.recvTransport.close();
        this.recvTransport = undefined;
        // console.log('🧹 MEDIASOUP CLIENT: Receive transport closed');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // console.log('✅ MEDIASOUP CLIENT: Cleanup completed');
    } catch (error) {
      console.error('❌ MEDIASOUP CLIENT: Error during cleanup:', error);
    } finally {
      this.setProcessing(false);
    }
  }

  async recreateTransports(): Promise<void> {
    // console.log('🔄 MEDIASOUP CLIENT: Recreating transports...');
    
    if (!this.validateState()) {
      throw new Error('Cannot recreate transports in current state');
    }
    
    this.setProcessing(true);
    
    // Store the current streamer ID before cleanup
    const previousStreamerId = this.currentStreamerId;
    
    try {
      // Complete cleanup first
      await this.cleanup();
      
      // Reset destroyed state to allow reinitialization
      this.isDestroyed = false;
      
      // Restore the streamer ID
      this.currentStreamerId = previousStreamerId;
      
      // Wait for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Reinitialize everything
      await this.initialize();
      await this.createSendTransport();
      await this.createRecvTransport();
      
      // console.log('✅ MEDIASOUP CLIENT: Transports recreated successfully');
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

  getCurrentStreamer(): string | null {
    return this.currentStreamerId;
  }

  // Force a reconnection attempt (useful for manual recovery)
  async forceReconnection(): Promise<void> {
    // console.log('🔄 MEDIASOUP CLIENT: Force reconnection requested');
    this.stopReconnection();
    this.reconnectionAttempts = 0;
    await this.attemptReconnection();
  }
}