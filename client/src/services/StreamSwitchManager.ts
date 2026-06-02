/**
 * Stream Switch Manager - Handles graceful degradation for failed stream switches
 * Provides fallback mechanisms and recovery strategies for WebRTC streaming
 */

import { WebRTCClientAdapter } from './WebRTCClientAdapter';
import { Socket } from 'socket.io-client';

export interface StreamSwitchConfig {
  maxRetryAttempts: number;
  retryDelay: number;
  fallbackTimeout: number;
  enableFallbackMode: boolean;
  qualityFallback: boolean;
}

export interface StreamSwitchResult {
  success: boolean;
  error?: string;
  fallbackActivated: boolean;
  retryCount: number;
  switchDuration: number;
}

export type StreamSwitchState = 'idle' | 'switching' | 'retrying' | 'fallback' | 'fallback-no-media' | 'failed';

export class StreamSwitchManager {
  private webrtcClient: WebRTCClientAdapter;
  private socket: Socket;
  private config: StreamSwitchConfig;
  private state: StreamSwitchState = 'idle';
  private fallbackMode = false;

  private callbacks: {
    onSwitchStart?: () => void;
    onSwitchSuccess?: (result: StreamSwitchResult) => void;
    onSwitchFail?: (result: StreamSwitchResult) => void;
    onFallbackActivated?: (reason: string) => void;
    onRetryAttempt?: (attempt: number, maxAttempts: number) => void;
    onStateChange?: (newState: StreamSwitchState) => void;
  } = {};

  constructor(webrtcClient: WebRTCClientAdapter, socket: Socket, config?: Partial<StreamSwitchConfig>) {
    this.webrtcClient = webrtcClient;
    this.socket = socket;
    this.config = {
      maxRetryAttempts: 3,
      retryDelay: 1000,
      fallbackTimeout: 10000,
      enableFallbackMode: true,
      qualityFallback: true,
      ...config
    };
  }

  // Set callback handlers
  setCallbacks(callbacks: Partial<StreamSwitchManager['callbacks']>): void {
    Object.assign(this.callbacks, callbacks);
  }

  // Exit fallback mode and return to normal operation
  async exitFallbackMode(): Promise<boolean> {
    if (!this.fallbackMode) {
      return true;
    }

    try {
      // Try to restore normal operation
      await this.webrtcClient.recreateTransports();

      this.fallbackMode = false;
      this.setState('idle');

      return true;
    } catch (error) {
      console.error('❌ STREAM SWITCH: Failed to exit fallback mode:', error);
      return false;
    }
  }

  // Clean up resources
  cleanup(): void {
    this.setState('idle');
    this.callbacks = {};
  }

  // Set state and notify callbacks
  private setState(newState: StreamSwitchState): void {
    if (this.state === newState) return;

    this.state = newState;

    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(newState);
    }
  }
}

export default StreamSwitchManager;
