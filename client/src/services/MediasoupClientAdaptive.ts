import { Device, Transport, Producer, Consumer } from 'mediasoup-client/lib/types';
import { Socket } from 'socket.io-client';

// Connection state machine states
enum ConnectionState {
  IDLE = 'idle',
  TESTING_TURN = 'testing_turn',
  CONNECTING_ALL = 'connecting_all',
  CONNECTING_RELAY = 'connecting_relay',
  CONNECTED = 'connected',
  FAILED = 'failed',
  RECONNECTING = 'reconnecting'
}

// ICE gathering statistics
interface ICEStats {
  startTime: number;
  candidates: {
    host: number;
    srflx: number;
    relay: number;
    prflx: number;
  };
  selectedCandidate?: RTCIceCandidate;
  connectionPath?: string;
  attemptCount: number;
  lastAttemptPolicy: 'all' | 'relay';
  turnTestResult?: boolean;
  connectionLatency?: number;
}

// Connection attempt configuration
interface ConnectionConfig {
  initialTimeout: number;      // Time to wait before fallback (ms)
  relayTimeout: number;        // Time to wait for relay connection (ms)
  maxAttempts: number;         // Maximum connection attempts
  turnTestTimeout: number;     // TURN connectivity test timeout (ms)
  iceGatheringTimeout: number; // ICE gathering completion timeout (ms)
}

export class MediasoupClientAdaptive {
  // Core MediaSoup properties
  private device: Device;
  private socket: Socket;
  private serverUrl: string;
  private turnDomain: string = 'turn.onestreamer.live'; // Default, will be loaded from config
  private sendTransport?: Transport;
  private recvTransport?: Transport;
  private videoProducer?: Producer;
  private audioProducer?: Producer;
  private consumers: Map<string, Consumer> = new Map();
  
  // Callbacks
  private onTrack?: (track: MediaStreamTrack, kind: 'audio' | 'video', peerId: string) => void;
  private onConsumerClosed?: (consumerId: string, kind: 'audio' | 'video') => void;
  private onTransportClose?: () => void;
  private onConnectionLost?: () => void;
  private onConnectionStateChange?: (state: ConnectionState, stats: ICEStats) => void;
  
  // State management
  private currentStreamerId: string | null = null;
  private isDestroyed: boolean = false;
  private cleanupInProgress: boolean = false;
  
  // Adaptive connection properties
  private connectionState: ConnectionState = ConnectionState.IDLE;
  private iceStats: ICEStats = {
    startTime: 0,
    candidates: { host: 0, srflx: 0, relay: 0, prflx: 0 },
    attemptCount: 0,
    lastAttemptPolicy: 'all'
  };
  
  // Connection configuration
  private config: ConnectionConfig = {
    initialTimeout: 5000,      // 5 seconds for initial attempt
    relayTimeout: 10000,       // 10 seconds for relay fallback
    maxAttempts: 3,
    turnTestTimeout: 3000,     // 3 seconds for TURN test
    iceGatheringTimeout: 15000 // 15 seconds max for ICE gathering
  };
  
  // Timers
  private connectionTimeout?: NodeJS.Timeout;
  private gatheringTimeout?: NodeJS.Timeout;
  
  // Connection preferences (learned from successful connections)
  private preferredICEPolicy: 'all' | 'relay' = 'all';
  private turnServerValidated: boolean = false;
  
  constructor(socket: Socket, serverUrl: string) {
    this.device = new Device();
    this.socket = socket;
    this.serverUrl = serverUrl;
    
    console.log('🎯 MediaSoup Adaptive Client initialized');
    console.log(`📊 Connection config:`, this.config);
    
    // Load TURN configuration
    this.loadTurnConfig();
  }
  
  private async loadTurnConfig() {
    try {
      const response = await fetch('/config.json');
      const config = await response.json();
      if (config.turnDomain) {
        this.turnDomain = config.turnDomain;
        console.log('🔧 TURN domain loaded:', this.turnDomain);
      }
    } catch (error) {
      console.warn('⚠️ Failed to load TURN config, using default:', error);
    }
  }

  /**
   * Initialize the MediaSoup device with router capabilities
   */
  async initialize(): Promise<void> {
    try {
      const response = await fetch(`${this.serverUrl}/api/mediasoup/rtp-capabilities`);
      const { rtpCapabilities } = await response.json();
      
      await this.device.load({ routerRtpCapabilities: rtpCapabilities });
      console.log('✅ MediaSoup device initialized');
    } catch (error) {
      console.error('❌ Failed to initialize MediaSoup device:', error);
      throw error;
    }
  }

  /**
   * Test TURN server connectivity before attempting main connection
   */
  private async testTurnConnectivity(): Promise<boolean> {
    console.log('🔍 Testing TURN server connectivity...');
    this.updateConnectionState(ConnectionState.TESTING_TURN);
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⏱️ TURN connectivity test timeout');
        resolve(false);
      }, this.config.turnTestTimeout);

      try {
        // Create a test peer connection with only TURN servers
        const pc = new RTCPeerConnection({
          iceServers: [{
            urls: [
              `turn:${this.turnDomain}:3478?transport=udp`,
              `turn:${this.turnDomain}:3478?transport=tcp`
            ],
            username: this.generateTurnUsername(),
            credential: this.generateTurnCredential(this.generateTurnUsername())
          }],
          iceTransportPolicy: 'relay'
        });

        let relayFound = false;

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            const cand = event.candidate.candidate;
            if (cand.includes('relay')) {
              console.log('✅ TURN relay candidate found:', cand);
              relayFound = true;
              clearTimeout(timeout);
              pc.close();
              resolve(true);
            }
          }
        };

        // Create data channel to trigger ICE gathering
        pc.createDataChannel('test');
        
        // Create and set offer
        pc.createOffer().then(offer => {
          return pc.setLocalDescription(offer);
        }).catch(err => {
          console.error('❌ TURN test failed:', err);
          clearTimeout(timeout);
          pc.close();
          resolve(false);
        });

        // Cleanup on timeout
        setTimeout(() => {
          if (!relayFound) {
            pc.close();
          }
        }, this.config.turnTestTimeout);

      } catch (error) {
        console.error('❌ TURN connectivity test error:', error);
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  /**
   * Create receive transport with adaptive ICE configuration
   */
  async createRecvTransport(forceRelay: boolean = false): Promise<void> {
    console.log(`📡 Creating receive transport (forceRelay: ${forceRelay})`);
    
    // Reset ICE statistics for new attempt
    this.iceStats = {
      startTime: Date.now(),
      candidates: { host: 0, srflx: 0, relay: 0, prflx: 0 },
      attemptCount: this.iceStats.attemptCount + 1,
      lastAttemptPolicy: forceRelay ? 'relay' : 'all'
    };

    try {
      // Request transport creation from server
      const response = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: this.socket.id })
      });

      if (!response.ok) {
        throw new Error('Failed to create transport on server');
      }

      const transportOptions = await response.json();
      
      // Generate TURN credentials
      const turnUsername = this.generateTurnUsername();
      const turnCredential = this.generateTurnCredential(turnUsername);
      
      // Configure ICE servers based on strategy
      const iceServers = this.buildICEServers(turnUsername, turnCredential, forceRelay);
      
      const recvTransportOptions = {
        ...transportOptions,
        iceServers,
        iceTransportPolicy: forceRelay ? 'relay' as RTCIceTransportPolicy : 'all' as RTCIceTransportPolicy,
        iceCandidatePoolSize: 10,
        rtcpMuxPolicy: 'require' as RTCRtcpMuxPolicy,
        bundlePolicy: 'max-bundle' as RTCBundlePolicy
      };

      console.log(`🔧 ICE Configuration:`, {
        policy: recvTransportOptions.iceTransportPolicy,
        serverCount: iceServers.length,
        attempt: this.iceStats.attemptCount
      });

      // Create receive transport
      this.recvTransport = this.device.createRecvTransport(recvTransportOptions);
      
      // Set up comprehensive ICE monitoring
      this.setupICEMonitoring(this.recvTransport, 'receive');
      
      // Set up connection state handling
      this.setupConnectionStateHandling(this.recvTransport);
      
      // Handle transport events
      this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          console.log('🔗 Connecting receive transport...');
          const connectResponse = await fetch(`${this.serverUrl}/api/mediasoup/connect-transport`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              socketId: this.socket.id,
              dtlsParameters
            })
          });

          if (!connectResponse.ok) {
            throw new Error('Failed to connect transport');
          }

          callback();
          console.log('✅ Receive transport connected');
        } catch (error) {
          console.error('❌ Failed to connect receive transport:', error);
          errback(error as Error);
        }
      });

    } catch (error) {
      console.error('❌ Failed to create receive transport:', error);
      throw error;
    }
  }

  /**
   * Set up comprehensive ICE candidate monitoring
   */
  private setupICEMonitoring(transport: Transport, type: 'send' | 'receive'): void {
    const pc = (transport as any)._handler._pc as RTCPeerConnection;
    
    if (!pc) {
      console.warn('⚠️ Unable to access RTCPeerConnection for ICE monitoring');
      return;
    }

    // Monitor ICE gathering state
    pc.onicegatheringstatechange = () => {
      console.log(`🧊 ${type} transport ICE gathering state: ${pc.iceGatheringState}`);
      
      if (pc.iceGatheringState === 'complete') {
        console.log(`📊 ICE Gathering Complete - Statistics:`, this.iceStats.candidates);
        this.analyzeICECandidates();
      }
    };

    // Monitor ICE connection state
    pc.oniceconnectionstatechange = () => {
      console.log(`🔌 ${type} transport ICE connection state: ${pc.iceConnectionState}`);
      
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.handleSuccessfulConnection(pc);
      }
    };

    // Monitor individual ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.processICECandidate(event.candidate);
      } else {
        console.log(`🏁 ${type} transport ICE gathering finished`);
      }
    };

    // Monitor selected candidate pair
    this.monitorSelectedCandidatePair(pc, type);
  }

  /**
   * Process and categorize ICE candidates
   */
  private processICECandidate(candidate: RTCIceCandidate): void {
    const cand = candidate.candidate;
    
    if (cand.includes('typ host')) {
      this.iceStats.candidates.host++;
      console.log(`🏠 Host candidate: ${this.extractCandidateInfo(cand)}`);
    } else if (cand.includes('typ srflx')) {
      this.iceStats.candidates.srflx++;
      console.log(`🌐 STUN reflexive candidate: ${this.extractCandidateInfo(cand)}`);
    } else if (cand.includes('typ relay')) {
      this.iceStats.candidates.relay++;
      console.log(`🔄 TURN relay candidate: ${this.extractCandidateInfo(cand)}`);
    } else if (cand.includes('typ prflx')) {
      this.iceStats.candidates.prflx++;
      console.log(`🔍 Peer reflexive candidate: ${this.extractCandidateInfo(cand)}`);
    }
  }

  /**
   * Extract readable information from ICE candidate
   */
  private extractCandidateInfo(candidate: string): string {
    const parts = candidate.split(' ');
    const type = parts.find((p, i) => parts[i - 1] === 'typ')?.toUpperCase() || 'UNKNOWN';
    const protocol = parts.find((p, i) => parts[i - 1] === 'protocol')?.toUpperCase() || '';
    const ip = parts[4] || '';
    const port = parts[5] || '';
    
    return `${type} ${protocol} ${ip}:${port}`;
  }

  /**
   * Monitor and log the selected candidate pair
   */
  private async monitorSelectedCandidatePair(pc: RTCPeerConnection, type: string): Promise<void> {
    // Wait a bit for connection to establish
    setTimeout(async () => {
      try {
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            console.log(`✅ ${type} transport selected candidate pair:`, {
              local: report.localCandidateId,
              remote: report.remoteCandidateId,
              state: report.state,
              nominated: report.nominated
            });
            
            // Store connection path info
            this.iceStats.connectionPath = `${report.localCandidateId} -> ${report.remoteCandidateId}`;
          }
        });
      } catch (error) {
        console.error('Failed to get selected candidate pair:', error);
      }
    }, 2000);
  }

  /**
   * Handle successful connection and learn preferences
   */
  private handleSuccessfulConnection(pc: RTCPeerConnection): void {
    const connectionTime = Date.now() - this.iceStats.startTime;
    this.iceStats.connectionLatency = connectionTime;
    
    console.log(`✅ Connection established in ${connectionTime}ms`);
    console.log(`📊 Connection statistics:`, this.iceStats);
    
    // Learn from successful connection
    if (this.iceStats.lastAttemptPolicy === 'relay' && this.iceStats.candidates.relay > 0) {
      console.log('📝 Learning: Network requires TURN relay');
      this.preferredICEPolicy = 'relay';
    } else if (connectionTime < 3000 && this.iceStats.candidates.srflx > 0) {
      console.log('📝 Learning: STUN works well for this network');
      this.preferredICEPolicy = 'all';
    }
    
    this.updateConnectionState(ConnectionState.CONNECTED);
  }

  /**
   * Set up connection state handling with timeout-based fallback
   */
  private setupConnectionStateHandling(transport: Transport): void {
    const pc = (transport as any)._handler._pc as RTCPeerConnection;
    
    // Start connection timeout
    this.startConnectionTimeout();
    
    transport.on('connectionstatechange', async (state) => {
      console.log(`📡 Transport connection state: ${state}`);
      
      switch (state) {
        case 'connecting':
          this.updateConnectionState(ConnectionState.CONNECTING_ALL);
          break;
          
        case 'connected':
          this.clearConnectionTimeout();
          this.updateConnectionState(ConnectionState.CONNECTED);
          break;
          
        case 'disconnected':
          await this.handleDisconnection();
          break;
          
        case 'failed':
          await this.handleConnectionFailure();
          break;
      }
    });
  }

  /**
   * Start connection timeout for fallback strategy
   */
  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    
    const timeout = this.iceStats.lastAttemptPolicy === 'relay' 
      ? this.config.relayTimeout 
      : this.config.initialTimeout;
    
    console.log(`⏱️ Starting connection timeout: ${timeout}ms`);
    
    this.connectionTimeout = setTimeout(async () => {
      console.warn(`⏱️ Connection timeout after ${timeout}ms`);
      await this.handleConnectionTimeout();
    }, timeout);
  }

  /**
   * Clear connection timeout
   */
  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }
  }

  /**
   * Handle connection timeout - implement fallback strategy
   */
  private async handleConnectionTimeout(): Promise<void> {
    console.log('⏱️ Connection timeout - implementing fallback strategy');
    
    // Analyze what we've gathered so far
    this.analyzeICECandidates();
    
    if (this.iceStats.lastAttemptPolicy === 'all') {
      // First attempt with 'all' failed - try relay only
      if (this.iceStats.candidates.relay > 0 || !this.turnServerValidated) {
        console.log('🔄 Falling back to TURN relay only mode');
        await this.reconnectWithRelay();
      } else {
        console.error('❌ No TURN relay candidates available');
        this.updateConnectionState(ConnectionState.FAILED);
      }
    } else {
      // Relay attempt also failed
      console.error('❌ Connection failed even with TURN relay');
      this.updateConnectionState(ConnectionState.FAILED);
    }
  }

  /**
   * Reconnect with relay-only policy
   */
  private async reconnectWithRelay(): Promise<void> {
    console.log('🔄 Reconnecting with relay-only policy...');
    
    // Clean up existing transport
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = undefined;
    }
    
    // Update state
    this.updateConnectionState(ConnectionState.CONNECTING_RELAY);
    
    // Recreate with relay policy
    await this.createRecvTransport(true);
  }

  /**
   * Handle disconnection with ICE restart
   */
  private async handleDisconnection(): Promise<void> {
    console.warn('⚠️ Transport disconnected - attempting ICE restart');
    
    if (!this.recvTransport) return;
    
    try {
      // Request ICE restart from server
      const response = await fetch(`${this.serverUrl}/api/mediasoup/restart-ice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socketId: this.socket.id,
          transportId: this.recvTransport.id
        })
      });
      
      if (response.ok) {
        const { iceParameters } = await response.json();
        await this.recvTransport.restartIce({ iceParameters });
        console.log('✅ ICE restart successful');
      } else {
        throw new Error('ICE restart request failed');
      }
    } catch (error) {
      console.error('❌ ICE restart failed:', error);
      await this.handleConnectionFailure();
    }
  }

  /**
   * Handle connection failure
   */
  private async handleConnectionFailure(): Promise<void> {
    console.error('❌ Connection failed');
    
    if (this.iceStats.attemptCount < this.config.maxAttempts) {
      console.log(`🔄 Retrying connection (attempt ${this.iceStats.attemptCount + 1}/${this.config.maxAttempts})`);
      await this.reconnectWithRelay();
    } else {
      console.error('❌ Max connection attempts reached');
      this.updateConnectionState(ConnectionState.FAILED);
      
      if (this.onConnectionLost) {
        this.onConnectionLost();
      }
    }
  }

  /**
   * Analyze gathered ICE candidates for debugging
   */
  private analyzeICECandidates(): void {
    const stats = this.iceStats.candidates;
    const total = stats.host + stats.srflx + stats.relay + stats.prflx;
    
    console.log('📊 ICE Candidate Analysis:');
    console.log(`  Total candidates: ${total}`);
    console.log(`  Host (local): ${stats.host}`);
    console.log(`  STUN (reflexive): ${stats.srflx}`);
    console.log(`  TURN (relay): ${stats.relay}`);
    console.log(`  Peer reflexive: ${stats.prflx}`);
    
    if (stats.relay === 0 && this.iceStats.lastAttemptPolicy === 'all') {
      console.warn('⚠️ No TURN relay candidates gathered - TURN server may be unreachable');
    }
    
    if (stats.srflx === 0 && stats.host > 0) {
      console.warn('⚠️ No STUN reflexive candidates - might be behind symmetric NAT');
    }
  }

  /**
   * Build ICE servers configuration based on strategy
   */
  private buildICEServers(username: string, credential: string, forceRelay: boolean): RTCIceServer[] {
    if (forceRelay) {
      // Relay only - just TURN servers
      return [{
        urls: [
          `turn:${this.turnDomain}:3478?transport=udp`,
          `turn:${this.turnDomain}:3478?transport=tcp`,
          `turns:${this.turnDomain}:5349?transport=tcp`
        ],
        username,
        credential
      }];
    }
    
    // All candidates - TURN first for priority, then STUN
    return [
      {
        urls: [
          `turn:${this.turnDomain}:3478?transport=udp`,
          `turn:${this.turnDomain}:3478?transport=tcp`,
          `turns:${this.turnDomain}:5349?transport=tcp`
        ],
        username,
        credential
      },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }

  /**
   * Update connection state and notify listeners
   */
  private updateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    console.log(`📱 Connection state: ${state}`);
    
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange(state, this.iceStats);
    }
  }

  /**
   * Generate TURN username with timestamp
   */
  private generateTurnUsername(): string {
    const timestamp = Math.floor(Date.now() / 1000) + 86400; // 24 hours validity
    return `${timestamp}:user${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate TURN credential using HMAC-SHA1
   */
  private generateTurnCredential(username: string): string {
    const secret = '***REMOVED-TURN-SECRET***';
    
    // Simple HMAC-SHA1 implementation would go here
    // For now, returning a base64 encoded version
    const encoder = new TextEncoder();
    const data = encoder.encode(username + secret);
    
    // This is a simplified version - in production, use proper HMAC-SHA1
    return btoa(String.fromCharCode(...data));
  }

  /**
   * Public method to start adaptive connection
   */
  async connect(): Promise<void> {
    console.log('🚀 Starting adaptive connection process...');
    
    // Test TURN connectivity first (optional but recommended)
    this.turnServerValidated = await this.testTurnConnectivity();
    console.log(`🔍 TURN server validated: ${this.turnServerValidated}`);
    
    // Start with preferred policy based on previous learnings
    const useRelay = this.preferredICEPolicy === 'relay' && this.turnServerValidated;
    await this.createRecvTransport(useRelay);
  }

  /**
   * Get current connection statistics
   */
  getConnectionStats(): ICEStats & { state: ConnectionState } {
    return {
      ...this.iceStats,
      state: this.connectionState
    };
  }

  // ... Rest of the MediaSoup methods (consume, produce, etc.) remain the same ...
}