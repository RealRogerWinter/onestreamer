/**
 * WebRTC Client Adapter — thin wrapper over the LiveKit client.
 * LiveKit is the sole WebRTC backend (ADR-0024); this seam is retained so the
 * stream components don't import the client class directly.
 */

import { LiveKitClient } from './LiveKitClient';
import { Socket } from 'socket.io-client';

export interface WebRTCClientConfig {
  socket: Socket;
  serverUrl?: string;
  onConnectionRecovered?: () => void;
  onConnectionLost?: () => void;
  onReconnectionFailed?: (error: Error) => void;
  onDebugInfo?: (info: any) => void;
  onStreamUpdate?: () => void;
}

/**
 * Unified WebRTC client that automatically switches between MediaSoup and LiveKit
 * based on server configuration
 */
export class WebRTCClientAdapter {
  private client: LiveKitClient | null = null;
  private config: WebRTCClientConfig;
  private backendType: 'livekit' | null = null;
  private serverUrl: string;
  private isInitializing: boolean = false;

  constructor(config: WebRTCClientConfig) {
    this.config = config;
    this.serverUrl = config.serverUrl || process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';
    console.log('🎯 WEBRTC ADAPTER: Initializing WebRTC client adapter');
  }


  /**
   * Get current backend type
   */
  getBackendType(): string | null {
    return this.backendType;
  }

  /**
   * Ensure client is initialized before operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.client) {
      await this.performInitialization();
    }
  }

  // Proxy all MediasoupClient methods to the underlying implementation
  async init(): Promise<void> {
    await this.ensureInitialized();
  }
  
  // Merge the two initialize methods - use the one with forceReload parameter
  async initialize(forceReload: boolean = false): Promise<void> {
    // If client not initialized yet, do the full initialization
    if (!this.client) {
      await this.performInitialization();
    } else if (forceReload && this.client && 'initialize' in this.client) {
      // If forceReload requested and client supports it, call client's initialize
      return (this.client as any).initialize(forceReload);
    }
  }

  /**
   * Perform the actual initialization (extracted from duplicate method)
   */
  private async performInitialization(): Promise<void> {
    if (this.isInitializing) {
      console.log('⏳ WEBRTC ADAPTER: Already initializing, skipping duplicate call');
      return;
    }

    this.isInitializing = true;

    try {
      // LiveKit is the sole WebRTC backend (ADR-0024).
      this.client = new LiveKitClient(this.config);
      this.backendType = 'livekit';

      if ('init' in this.client) {
        await (this.client as any).init();
      } else if ('initialize' in this.client) {
        await (this.client as any).initialize();
      }
      console.log('✅ WEBRTC ADAPTER: LiveKit client initialized');
    } catch (error) {
      console.error('❌ WEBRTC ADAPTER: Failed to initialize LiveKit client:', error);
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.client) {
      if ('destroy' in this.client) {
        await (this.client as any).destroy();
      } else if ('cleanup' in this.client) {
        await (this.client as any).cleanup();
      }
      this.client = null;
      this.backendType = null;
    }
  }

  async produce(stream: MediaStream): Promise<void> {
    await this.ensureInitialized();
    return (this.client as any).produce(stream);
  }

  async consume(): Promise<MediaStream | null> {
    await this.ensureInitialized();
    return (this.client as any).consume();
  }

  async stopProducing(): Promise<void> {
    await this.ensureInitialized();
    return (this.client as any).stopProducing();
  }

  async createSendTransport(): Promise<void> {
    await this.ensureInitialized();
    return (this.client as any).createSendTransport();
  }

  async createRecvTransport(): Promise<void> {
    await this.ensureInitialized();
    if (this.client && 'createRecvTransport' in this.client) {
      return (this.client as any).createRecvTransport();
    }
    // LiveKit doesn't need separate recv transport
    return Promise.resolve();
  }

  async reset(): Promise<void> {
    await this.ensureInitialized();
    return (this.client as any).reset();
  }

  async cleanup(): Promise<void> {
    if (this.client && 'cleanup' in this.client) {
      return (this.client as any).cleanup();
    }
    // Fallback to destroy if cleanup doesn't exist
    return this.destroy();
  }

  getCurrentStreamer(): string | null {
    if (this.client && 'getCurrentStreamer' in this.client) {
      return (this.client as any).getCurrentStreamer();
    }
    return this.currentStreamerId;
  }

  async forceReconnection(): Promise<void> {
    await this.ensureInitialized();
    if (this.client && 'forceReconnection' in this.client) {
      return (this.client as any).forceReconnection();
    }
  }

  async recreateTransports(): Promise<void> {
    if (this.client && 'recreateTransports' in this.client) {
      return (this.client as any).recreateTransports();
    }
    // Fallback to resetting and creating transports
    await this.reset();
    await this.createSendTransport();
    await this.createRecvTransport();
  }

  async replaceAudioTrack(newTrack: MediaStreamTrack): Promise<void> {
    await this.ensureInitialized();
    if (this.client && 'replaceAudioTrack' in this.client) {
      return (this.client as any).replaceAudioTrack(newTrack);
    }
  }

  async replaceVideoTrack(newTrack: MediaStreamTrack): Promise<void> {
    await this.ensureInitialized();
    if (this.client && 'replaceVideoTrack' in this.client) {
      return (this.client as any).replaceVideoTrack(newTrack);
    }
  }

  /**
   * Switch from camera to screen share (replaces main video)
   */
  async switchToScreenShare(screenStream: MediaStream): Promise<void> {
    await this.ensureInitialized();
    if (this.client && 'switchToScreenShare' in this.client) {
      return (this.client as any).switchToScreenShare(screenStream);
    }
    throw new Error('Screen share switch not supported by current backend');
  }

  /**
   * Switch from screen share back to camera
   */
  async switchToCamera(cameraStream: MediaStream): Promise<void> {
    await this.ensureInitialized();
    if (this.client && 'switchToCamera' in this.client) {
      return (this.client as any).switchToCamera(cameraStream);
    }
  }

  // Proxy getters
  get isDestroyed(): boolean {
    return (this.client as any)?.isDestroyed || false;
  }

  get destroyed(): boolean {
    return this.isDestroyed;
  }

  get isReady(): boolean {
    if (this.client && 'isReady' in this.client) {
      return (this.client as any).isReady;
    }
    // Default to checking if client exists and is initialized
    return this.client !== null && !this.isDestroyed;
  }

  get hasAudioProducer(): boolean {
    if (this.client && 'hasAudioProducer' in this.client) {
      return (this.client as any).hasAudioProducer;
    }
    return (this.client as any)?.audioProducer !== null && (this.client as any)?.audioProducer !== undefined;
  }

  get hasVideoProducer(): boolean {
    if (this.client && 'hasVideoProducer' in this.client) {
      return (this.client as any).hasVideoProducer;
    }
    return (this.client as any)?.videoProducer !== null && (this.client as any)?.videoProducer !== undefined;
  }

  get isScreenSharing(): boolean {
    return (this.client as any)?.isScreenSharing || false;
  }

  get consumers(): Map<string, any> {
    return (this.client as any)?.consumers || new Map();
  }

  get currentStreamerId(): string | null {
    return (this.client as any)?.currentStreamerId || null;
  }

  set currentStreamerId(id: string | null) {
    if (this.client) {
      (this.client as any).currentStreamerId = id;
    }
  }

  get onDebugInfo(): ((info: any) => void) | undefined {
    return (this.client as any)?.onDebugInfo;
  }

  set onDebugInfo(callback: ((info: any) => void) | undefined) {
    if (this.client) {
      (this.client as any).onDebugInfo = callback;
    }
  }

  get connectionState(): 'connected' | 'disconnected' | 'reconnecting' {
    if (this.client && 'connectionState' in this.client) {
      return (this.client as any).connectionState;
    }
    return 'disconnected';
  }

  get reconnectionInfo(): { attempts: number } {
    if (this.client && 'reconnectionInfo' in this.client) {
      return (this.client as any).reconnectionInfo;
    }
    return { attempts: 0 };
  }
}

// Export as default for easier migration
export default WebRTCClientAdapter;