/**
 * Stream Switch Manager - Handles graceful degradation for failed stream switches
 * Provides fallback mechanisms and recovery strategies for WebRTC streaming
 */

import { MediasoupClient } from './MediasoupClient';
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
  private mediasoupClient: MediasoupClient;
  private socket: Socket;
  private config: StreamSwitchConfig;
  private state: StreamSwitchState = 'idle';
  private currentRetryCount = 0;
  private switchStartTime = 0;
  private fallbackMode = false;
  private lastSuccessfulStreamId: string | null = null;
  private switchTimeoutId?: NodeJS.Timeout;
  private retryTimeoutId?: NodeJS.Timeout;
  
  private callbacks: {
    onSwitchStart?: () => void;
    onSwitchSuccess?: (result: StreamSwitchResult) => void;
    onSwitchFail?: (result: StreamSwitchResult) => void;
    onFallbackActivated?: (reason: string) => void;
    onRetryAttempt?: (attempt: number, maxAttempts: number) => void;
    onStateChange?: (newState: StreamSwitchState) => void;
  } = {};

  constructor(mediasoupClient: MediasoupClient, socket: Socket, config?: Partial<StreamSwitchConfig>) {
    this.mediasoupClient = mediasoupClient;
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
  setCallbacks(callbacks: typeof this.callbacks): void {
    Object.assign(this.callbacks, callbacks);
  }

  // Get current state
  getState(): StreamSwitchState {
    return this.state;
  }

  // Check if currently in fallback mode
  isFallbackMode(): boolean {
    return this.fallbackMode;
  }

  // Attempt stream switch with graceful degradation
  async switchStream(newStreamId: string): Promise<StreamSwitchResult> {
    if (this.state === 'switching' || this.state === 'retrying') {
      console.warn('⚠️ STREAM SWITCH: Switch already in progress, ignoring request');
      return {
        success: false,
        error: 'Switch already in progress',
        fallbackActivated: false,
        retryCount: 0,
        switchDuration: 0
      };
    }

    console.log(`🔄 STREAM SWITCH: Attempting switch to ${newStreamId}`);
    
    this.switchStartTime = Date.now();
    this.currentRetryCount = 0;
    this.setState('switching');
    
    if (this.callbacks.onSwitchStart) {
      this.callbacks.onSwitchStart();
    }

    // Quick check - if switching to the same stream we're already on successfully, skip
    if (newStreamId === this.lastSuccessfulStreamId && !this.fallbackMode) {
      console.log(`📺 STREAM SWITCH: Already connected to ${newStreamId}, no switch needed`);
      this.setState('idle');
      
      const result: StreamSwitchResult = {
        success: true,
        fallbackActivated: false,
        retryCount: 0,
        switchDuration: Date.now() - this.switchStartTime
      };
      
      if (this.callbacks.onSwitchSuccess) {
        this.callbacks.onSwitchSuccess(result);
      }
      
      return result;
    }

    return this.performSwitchWithRetry(newStreamId);
  }

  // Perform switch with retry logic
  private async performSwitchWithRetry(streamId: string): Promise<StreamSwitchResult> {
    for (let attempt = 0; attempt <= this.config.maxRetryAttempts; attempt++) {
      this.currentRetryCount = attempt;

      if (attempt > 0) {
        console.log(`🔄 STREAM SWITCH: Retry attempt ${attempt}/${this.config.maxRetryAttempts}`);
        this.setState('retrying');
        
        if (this.callbacks.onRetryAttempt) {
          this.callbacks.onRetryAttempt(attempt, this.config.maxRetryAttempts);
        }

        // Wait before retry
        await this.delay(this.config.retryDelay * Math.pow(2, attempt - 1)); // Exponential backoff
      }

      try {
        const result = await this.attemptStreamSwitch(streamId);
        
        if (result.success) {
          this.setState('idle');
          this.lastSuccessfulStreamId = streamId;
          this.fallbackMode = false;
          
          const switchResult: StreamSwitchResult = {
            ...result,
            retryCount: attempt,
            switchDuration: Date.now() - this.switchStartTime
          };

          console.log(`✅ STREAM SWITCH: Successfully switched to ${streamId} after ${attempt} attempts`);
          
          if (this.callbacks.onSwitchSuccess) {
            this.callbacks.onSwitchSuccess(switchResult);
          }

          return switchResult;
        }

        // If this was the last attempt, proceed to fallback
        if (attempt === this.config.maxRetryAttempts) {
          console.warn(`❌ STREAM SWITCH: All retry attempts failed for ${streamId}`);
          return this.activateFallbackMode(streamId, result.error || 'Max retry attempts exceeded');
        }

      } catch (error) {
        console.error(`❌ STREAM SWITCH: Attempt ${attempt} failed:`, error);
        
        if (attempt === this.config.maxRetryAttempts) {
          return this.activateFallbackMode(streamId, error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    // Should never reach here, but fallback just in case
    return this.activateFallbackMode(streamId, 'Unexpected error in retry loop');
  }

  // Attempt a single stream switch
  private async attemptStreamSwitch(streamId: string): Promise<StreamSwitchResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          success: false,
          error: 'Switch operation timeout',
          fallbackActivated: false,
          retryCount: this.currentRetryCount,
          switchDuration: Date.now() - this.switchStartTime
        });
      }, this.config.fallbackTimeout);

      // Attempt to recreate transports and consume new stream
      this.performActualSwitch(streamId)
        .then((success) => {
          clearTimeout(timeout);
          resolve({
            success,
            error: success ? undefined : 'Stream switch failed',
            fallbackActivated: false,
            retryCount: this.currentRetryCount,
            switchDuration: Date.now() - this.switchStartTime
          });
        })
        .catch((error) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            error: error.message,
            fallbackActivated: false,
            retryCount: this.currentRetryCount,
            switchDuration: Date.now() - this.switchStartTime
          });
        });
    });
  }

  // Perform the actual WebRTC stream switch
  private async performActualSwitch(streamId: string): Promise<boolean> {
    try {
      console.log(`📡 STREAM SWITCH: Recreating transports for ${streamId}`);
      
      // Recreate transports to ensure clean state
      await this.mediasoupClient.recreateTransports();
      
      // Small delay to allow transport stabilization
      await this.delay(100);
      
      // Check if we're trying to switch to a specific stream that might not exist
      if (streamId && streamId !== 'test-stream') {
        // For non-test streams, we need to verify the streamer is available
        // This is likely why we're getting no tracks - the streamId doesn't correspond to an active streamer
        console.log(`⚠️ STREAM SWITCH: Attempting switch to ${streamId}, but may not be active`);
      }
      
      // Attempt to consume the new stream
      console.log(`📺 STREAM SWITCH: Consuming stream ${streamId}`);
      const stream = await this.mediasoupClient.consume();
      
      if (!stream) {
        throw new Error(`No stream available for ${streamId}. Streamer may not be active or producing media.`);
      }
      
      if (stream.getTracks().length === 0) {
        throw new Error(`Stream ${streamId} exists but has no tracks. Streamer may not be sending media.`);
      }

      console.log(`✅ STREAM SWITCH: Successfully obtained stream with ${stream.getTracks().length} tracks`);
      return true;

    } catch (error) {
      console.error('❌ STREAM SWITCH: Switch operation failed:', error);
      throw error;
    }
  }

  // Activate fallback mode
  private async activateFallbackMode(streamId: string, reason: string): Promise<StreamSwitchResult> {
    if (!this.config.enableFallbackMode) {
      console.warn('⚠️ STREAM SWITCH: Fallback mode disabled, marking as failed');
      this.setState('failed');
      
      const result: StreamSwitchResult = {
        success: false,
        error: reason,
        fallbackActivated: false,
        retryCount: this.currentRetryCount,
        switchDuration: Date.now() - this.switchStartTime
      };

      if (this.callbacks.onSwitchFail) {
        this.callbacks.onSwitchFail(result);
      }

      return result;
    }

    console.log(`🔄 STREAM SWITCH: Activating fallback mode for ${streamId}`);
    this.setState('fallback');
    this.fallbackMode = true;

    if (this.callbacks.onFallbackActivated) {
      this.callbacks.onFallbackActivated(reason);
    }

    // Try fallback strategies
    const fallbackSuccess = await this.tryFallbackStrategies(streamId);

    const result: StreamSwitchResult = {
      success: fallbackSuccess,
      error: fallbackSuccess ? undefined : `${reason}. All fallback strategies failed.`,
      fallbackActivated: true,
      retryCount: this.currentRetryCount,
      switchDuration: Date.now() - this.switchStartTime
    };

    if (fallbackSuccess) {
      console.log('✅ STREAM SWITCH: Fallback successful');
      this.setState('idle');
      if (this.callbacks.onSwitchSuccess) {
        this.callbacks.onSwitchSuccess(result);
      }
    } else {
      console.error('❌ STREAM SWITCH: All fallback strategies failed');
      this.setState('failed');
      if (this.callbacks.onSwitchFail) {
        this.callbacks.onSwitchFail(result);
      }
    }

    return result;
  }

  // Try various fallback strategies
  private async tryFallbackStrategies(streamId: string): Promise<boolean> {
    const strategies = [
      () => this.fallbackToLastKnownStream(),
      () => this.fallbackToLowerQuality(streamId),
      () => this.fallbackToTestStream(),
      () => this.fallbackToBasicConnection()
    ];

    const failureReasons: string[] = [];

    for (let i = 0; i < strategies.length; i++) {
      const strategyName = ['LastKnownStream', 'LowerQuality', 'TestStream', 'BasicConnection'][i];
      
      try {
        console.log(`🔄 STREAM SWITCH: Trying fallback strategy: ${strategyName}`);
        const success = await strategies[i]();
        
        if (success) {
          console.log(`✅ STREAM SWITCH: Fallback strategy ${strategyName} succeeded`);
          return true;
        }
        
        const reason = `${strategyName} failed`;
        failureReasons.push(reason);
        console.warn(`⚠️ STREAM SWITCH: ${reason}, trying next`);
      } catch (error) {
        const reason = `${strategyName} threw error: ${error instanceof Error ? error.message : String(error)}`;
        failureReasons.push(reason);
        console.error(`❌ STREAM SWITCH: ${reason}`);
      }
    }

    console.error(`❌ STREAM SWITCH: All fallback strategies failed: ${failureReasons.join(', ')}`);
    return false;
  }

  // Fallback to last known working stream
  private async fallbackToLastKnownStream(): Promise<boolean> {
    if (!this.lastSuccessfulStreamId) {
      return false;
    }

    try {
      console.log(`🔄 STREAM SWITCH: Falling back to last known stream: ${this.lastSuccessfulStreamId}`);
      return await this.performActualSwitch(this.lastSuccessfulStreamId);
    } catch (error) {
      return false;
    }
  }

  // Fallback to lower quality stream
  private async fallbackToLowerQuality(streamId: string): Promise<boolean> {
    if (!this.config.qualityFallback) {
      return false;
    }

    try {
      console.log('🔄 STREAM SWITCH: Attempting lower quality fallback');
      
      // This would typically involve requesting a lower quality version
      // For now, we'll just try the regular switch with more lenient settings
      await this.delay(500); // Give more time for stabilization
      return await this.performActualSwitch(streamId);
    } catch (error) {
      return false;
    }
  }

  // Fallback to test stream
  private async fallbackToTestStream(): Promise<boolean> {
    try {
      console.log('🔄 STREAM SWITCH: Attempting test stream fallback');
      
      // Emit request for test stream and wait for confirmation
      const testStreamPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000); // 5 second timeout
        
        const handleTestStreamAvailable = (data: { streamId: string }) => {
          clearTimeout(timeout);
          this.socket.off('test-stream-available', handleTestStreamAvailable);
          console.log(`🧪 STREAM SWITCH: Test stream available: ${data.streamId}`);
          resolve(true);
        };
        
        this.socket.on('test-stream-available', handleTestStreamAvailable);
        this.socket.emit('request-test-stream');
      });
      
      const testStreamReady = await testStreamPromise;
      
      if (!testStreamReady) {
        console.warn('⚠️ STREAM SWITCH: Test stream setup timed out');
        return false;
      }
      
      // Wait a bit more for test stream to stabilize
      await this.delay(1000);
      
      return await this.performActualSwitch('test-stream');
    } catch (error) {
      console.error('❌ STREAM SWITCH: Test stream fallback error:', error);
      return false;
    }
  }

  // Fallback to basic connection (no media)
  private async fallbackToBasicConnection(): Promise<boolean> {
    try {
      console.log('🔄 STREAM SWITCH: Attempting basic connection fallback');
      
      // Just ensure we have a valid MediaSoup device connection
      await this.mediasoupClient.initialize();
      
      // Ensure transport is available but don't try to consume non-existent streams
      if (!this.mediasoupClient.isReady) {
        console.warn('⚠️ STREAM SWITCH: MediaSoup client not ready for basic connection');
        return false;
      }
      
      console.log('✅ STREAM SWITCH: Basic connection fallback successful - maintaining connection without media consumption');
      // Don't actually consume media, just maintain connection
      return true;
    } catch (error) {
      console.error('❌ STREAM SWITCH: Basic connection fallback failed:', error);
      return false;
    }
  }

  // Cancel ongoing switch operation
  cancelSwitch(): void {
    if (this.state === 'idle') return;

    console.log('🛑 STREAM SWITCH: Canceling ongoing switch operation');
    
    if (this.switchTimeoutId) {
      clearTimeout(this.switchTimeoutId);
      this.switchTimeoutId = undefined;
    }

    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = undefined;
    }

    this.setState('idle');
    this.currentRetryCount = 0;
  }

  // Exit fallback mode and return to normal operation
  async exitFallbackMode(): Promise<boolean> {
    if (!this.fallbackMode) {
      return true;
    }

    console.log('🔄 STREAM SWITCH: Attempting to exit fallback mode');
    
    try {
      // Try to restore normal operation
      await this.mediasoupClient.recreateTransports();
      
      this.fallbackMode = false;
      this.setState('idle');
      
      console.log('✅ STREAM SWITCH: Successfully exited fallback mode');
      return true;
    } catch (error) {
      console.error('❌ STREAM SWITCH: Failed to exit fallback mode:', error);
      return false;
    }
  }

  // Clean up resources
  cleanup(): void {
    this.cancelSwitch();
    this.callbacks = {};
  }

  // Set state and notify callbacks
  private setState(newState: StreamSwitchState): void {
    if (this.state === newState) return;
    
    console.log(`🔄 STREAM SWITCH: State change: ${this.state} -> ${newState}`);
    this.state = newState;
    
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(newState);
    }
  }

  // Utility function for delays
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default StreamSwitchManager;