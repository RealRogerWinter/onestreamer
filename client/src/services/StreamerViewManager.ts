/**
 * StreamerViewManager - Manages switching between local preview and self-stream viewing
 * 
 * When visual effects are active that require stream processing (resolution, bitrate, etc.),
 * the streamer switches from viewing their local camera to consuming their own processed stream.
 * This allows them to see exactly what viewers see, including all MediaSoup effects.
 */

import { WebRTCClientAdapter } from './WebRTCClientAdapter';
import { Socket } from 'socket.io-client';

export interface StreamerViewState {
  mode: 'local-preview' | 'self-stream';
  activeEffects: string[];
  hasStreamProcessingEffects: boolean;
  lastSwitchTime: number;
}

export class StreamerViewManager {
  private socket: Socket;
  private mediasoupClient: WebRTCClientAdapter | null = null;
  private videoElement: HTMLVideoElement;
  private originalStream: MediaStream | null = null;
  private currentState: StreamerViewState;
  private effectsRequiringStreamProcessing: Set<string>;
  private switchTimeout: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;
  private viewerSocket: Socket | null = null;
  private processingEffect: boolean = false;
  private activeCSSFilters: Map<string, string> = new Map();
  private isSwitching: boolean = false;
  private switchDebounceTimer: NodeJS.Timeout | null = null;
  private lastEffectProcessedTime: number = 0;
  private processedEffectIds: Set<string> = new Set();

  constructor(socket: Socket, videoElement: HTMLVideoElement) {
    this.socket = socket;
    this.videoElement = videoElement;
    
    this.currentState = {
      mode: 'local-preview',
      activeEffects: [],
      hasStreamProcessingEffects: false,
      lastSwitchTime: 0
    };

    // Effects that require MediaSoup server-side stream processing (NOT client-side CSS)
    this.effectsRequiringStreamProcessing = new Set([
      'resolution_240p',
      'resolution_360p', 
      'resolution_480p',
      'bitrate_potato',
      'bitrate_low',
      'bitrate_throttle',
      'framerate_slideshow',
      'framerate_choppy',
      'framerate_cinematic',
      'packet_loss_mild',
      'packet_loss_severe',
      'jitter',
      // FFmpeg server-side processing effects only (NOT client-side CSS)
      'pixelate',
      'static_noise',
      'glitch',
      'audio_pitch_high',
      'audio_pitch_low',
      'audio_echo',
      'freeze_frame',
      'stutter'
      // NOTE: blur, grayscale, sepia are handled client-side with CSS, not server-side
    ]);

    this.initialize();
  }
  
  // CSS filter mappings for client-side effects
  private getCSSFilterForEffect(effectId: string): string | null {
    const cssFilters: Record<string, string> = {
      // Basic filters
      'blur': 'blur(8px)',
      'grayscale': 'grayscale(100%)',
      'sepia': 'sepia(100%)',
      'invert': 'invert(100%)',
      
      // Brightness variations
      'brightness_dark': 'brightness(0.4)',
      'brightness_bright': 'brightness(1.6)',
      
      // Contrast variations
      'contrast_low': 'contrast(0.5)',
      'contrast_high': 'contrast(2)',
      
      // Saturation variations
      'saturate': 'saturate(2.5)',
      'desaturate': 'saturate(0.3)',
      
      // Color shifts
      'hue_rotate': 'hue-rotate(90deg)',
      
      // Transform effects (CSS can handle these)
      'mirror': 'scaleX(-1)',
      'flip_vertical': 'scaleY(-1)',
      'rotate_90': 'rotate(90deg)',
      
      // Combined effects for more interesting visuals
      'vintage': 'sepia(0.5) contrast(1.2) brightness(0.9)',
      'thermal': 'hue-rotate(180deg) saturate(2) contrast(1.5)',
      'vignette': 'brightness(0.8)', // Simplified vignette with CSS
      'edge_detect': 'contrast(3) grayscale(100%)', // Simplified edge effect
      'emboss': 'contrast(1.5) brightness(1.1)', // Simplified emboss
      
      // Wave and wobble can't be done with CSS, but we can approximate
      'wave': 'skew(2deg, 2deg)',
      'wobble': 'rotate(1deg)'
    };
    
    return cssFilters[effectId] || null;
  }
  
  // Apply combined CSS filters to video element
  private updateVideoFilters() {
    if (!this.videoElement) {
      // console.log('🎬 STREAMER VIEW: Cannot update filters - no video element');
      return;
    }
    
    const filterValues = Array.from(this.activeCSSFilters.values());
    const combinedFilter = filterValues.join(' ');
    
    // console.log(`🎬 STREAMER VIEW: Updating video filters: "${combinedFilter || 'none'}"`);
    // console.log(`🎬 STREAMER VIEW: Active CSS filters count: ${this.activeCSSFilters.size}`);
    
    // Clear filter completely if no active filters
    if (combinedFilter === '') {
      this.videoElement.style.filter = '';
      // console.log('🎬 STREAMER VIEW: Cleared all CSS filters from video element');
    } else {
      this.videoElement.style.filter = combinedFilter;
      // console.log(`🎬 STREAMER VIEW: Applied CSS filters to video element: ${combinedFilter}`);
    }
  }
  
  // Clear specific CSS filter
  private removeCSSFilter(effectId: string) {
    if (this.activeCSSFilters.has(effectId)) {
      // console.log(`🎬 STREAMER VIEW: Removing CSS filter for ${effectId}`);
      this.activeCSSFilters.delete(effectId);
      this.updateVideoFilters();
    }
  }

  private initialize() {
    if (this.isInitialized) {
      // console.log('🎬 STREAMER VIEW: Already initialized, skipping');
      return;
    }

    // Store original stream if available
    if (this.videoElement.srcObject instanceof MediaStream) {
      this.originalStream = this.videoElement.srcObject;
    }

    // Set up socket event listeners
    this.setupSocketListeners();
    
    this.isInitialized = true;
    // console.log('🎬 STREAMER VIEW: Manager initialized for socket:', this.socket.id);
  }

  private setupSocketListeners() {
    // console.log('🎬 STREAMER VIEW: Setting up socket listeners for socket:', this.socket.id);

    // Listen for stream status changes
    this.socket.on('stream-status', (data) => {
      // If we lose streaming status, reset to local preview
      if (!data.isStreaming && this.currentState.mode === 'self-stream') {
        this.switchToLocalPreview();
      }
    });
  }

  private handleEffectApplied(effectId: string, duration: number) {
    // Prevent duplicate processing with time-based debouncing
    const now = Date.now();
    const timeSinceLastProcess = now - this.lastEffectProcessedTime;
    
    // Create unique key for this effect instance
    const effectKey = `${effectId}_${Math.floor(now / 1000)}`;
    
    if (this.processedEffectIds.has(effectKey) || timeSinceLastProcess < 100) {
      // console.log(`🎬 STREAMER VIEW: Skipping duplicate effect processing for ${effectId} (already processed or too soon)`);
      return;
    }
    
    if (this.processingEffect || this.isSwitching) {
      // console.log(`🎬 STREAMER VIEW: Already processing/switching, queuing ${effectId} for later`);
      // Queue the effect to be processed after current operation
      setTimeout(() => this.handleEffectApplied(effectId, duration), 500);
      return;
    }
    
    this.processingEffect = true;
    this.lastEffectProcessedTime = now;
    this.processedEffectIds.add(effectKey);
    
    // Clean up old effect keys after 5 seconds
    setTimeout(() => {
      this.processedEffectIds.delete(effectKey);
    }, 5000);
    
    // console.log(`🎬 STREAMER VIEW: handleEffectApplied called - Effect: ${effectId}, Duration: ${duration}ms`);
    // console.log(`🎬 STREAMER VIEW: Current state - Mode: ${this.currentState.mode}, Active effects: ${this.currentState.activeEffects.length}`);
    
    // Add to active effects
    if (!this.currentState.activeEffects.includes(effectId)) {
      this.currentState.activeEffects.push(effectId);
      // console.log(`🎬 STREAMER VIEW: Added ${effectId} to active effects list`);
    }

    // Check if this effect requires stream processing
    const requiresStreamProcessing = this.effectsRequiringStreamProcessing.has(effectId);
    // console.log(`🎬 STREAMER VIEW: Effect ${effectId} requires stream processing: ${requiresStreamProcessing}`);
    
    // Check if this is a client-side CSS effect
    const cssFilter = this.getCSSFilterForEffect(effectId);
    
    if (cssFilter) {
      // Apply CSS filter directly to the video element
      // console.log(`🎬 STREAMER VIEW: Applying client-side CSS filter for ${effectId}: ${cssFilter}`);
      this.activeCSSFilters.set(effectId, cssFilter);
      this.updateVideoFilters();
    } else if (requiresStreamProcessing) {
      this.currentState.hasStreamProcessingEffects = true;
      // console.log(`🎬 STREAMER VIEW: Stream processing effects flag set to true`);
      
      // Switch to self-stream viewing if not already
      if (this.currentState.mode === 'local-preview') {
        // console.log(`🎬 STREAMER VIEW: Currently in local-preview mode, switching to self-stream view for effect: ${effectId}`);
        this.switchToSelfStream();
      } else {
        // console.log(`🎬 STREAMER VIEW: Already in ${this.currentState.mode} mode, no switch needed`);
      }
    } else {
      // console.log(`🎬 STREAMER VIEW: Effect ${effectId} doesn't require stream processing or CSS, keeping local preview`);
    }

    // Set timeout to remove effect
    if (duration > 0) {
      // console.log(`🎬 STREAMER VIEW: Setting timeout to remove effect after ${duration}ms`);
      setTimeout(() => {
        this.handleEffectRemoved(effectId);
      }, duration);
    }
    
    // Reset processing flag after a short delay
    setTimeout(() => {
      this.processingEffect = false;
    }, 100);
  }

  private handleEffectRemoved(effectId: string) {
    // console.log(`🎬 STREAMER VIEW: Effect removed: ${effectId}`);
    
    // Remove from active effects
    this.currentState.activeEffects = this.currentState.activeEffects.filter(id => id !== effectId);
    
    // Remove CSS filter if it was a client-side effect
    this.removeCSSFilter(effectId);
    
    // Check if we still have stream processing effects
    const hasStreamEffects = this.currentState.activeEffects.some(id => 
      this.effectsRequiringStreamProcessing.has(id)
    );

    this.currentState.hasStreamProcessingEffects = hasStreamEffects;

    // If no more stream processing effects, switch back to local preview
    if (!hasStreamEffects && this.currentState.mode === 'self-stream') {
      // Add a small delay to avoid rapid switching
      if (this.switchTimeout) {
        clearTimeout(this.switchTimeout);
      }
      
      this.switchTimeout = setTimeout(() => {
        // console.log('🎬 STREAMER VIEW: No more stream effects, switching back to local preview');
        this.switchToLocalPreview();
      }, 1000);
    }
  }

  private handleAllEffectsCleared() {
    // console.log('🎬 STREAMER VIEW: handleAllEffectsCleared called - Clearing all effects');
    // console.log('🎬 STREAMER VIEW: Active CSS filters before clear:', Array.from(this.activeCSSFilters.keys()));
    // console.log('🎬 STREAMER VIEW: Active effects before clear:', this.currentState.activeEffects);
    
    // Clear active effects list
    this.currentState.activeEffects = [];
    this.currentState.hasStreamProcessingEffects = false;
    
    // Clear all CSS filters
    this.activeCSSFilters.clear();
    this.updateVideoFilters();
    
    // console.log('🎬 STREAMER VIEW: All CSS filters and effects cleared');
    
    // Switch back to local preview if we were viewing processed stream
    if (this.currentState.mode === 'self-stream') {
      // console.log('🎬 STREAMER VIEW: Switching back to local preview after clearing effects');
      this.switchToLocalPreview();
    }
  }

  private async switchToSelfStream() {
    if (this.currentState.mode === 'self-stream') {
      // console.log('🎬 STREAMER VIEW: Already in self-stream mode');
      return;
    }
    
    if (this.isSwitching) {
      // console.log('🎬 STREAMER VIEW: Already switching, aborting duplicate switch');
      return;
    }
    
    // Debounce rapid switches
    if (this.switchDebounceTimer) {
      clearTimeout(this.switchDebounceTimer);
    }
    
    this.switchDebounceTimer = setTimeout(async () => {
      await this.performSwitchToSelfStream();
    }, 300);
  }
  
  private async performSwitchToSelfStream() {
    this.isSwitching = true;

    try {
      // console.log('🎬 STREAMER VIEW: Starting switch to self-stream view...');
      // console.log('🎬 STREAMER VIEW: Video element exists:', !!this.videoElement);
      // console.log('🎬 STREAMER VIEW: Current video srcObject:', this.videoElement.srcObject);
      
      // Store current local stream and pause video to prevent AbortError
      if (this.videoElement.srcObject instanceof MediaStream) {
        this.originalStream = this.videoElement.srcObject;
        // console.log('🎬 STREAMER VIEW: Stored original stream with', this.originalStream.getTracks().length, 'tracks');
        
        // Pause the video element before switching sources
        this.videoElement.pause();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Create separate viewer socket connection (no auth token - anonymous viewer)
      // Use the actual backend server URL, not the React dev server
      // Use the existing socket connection instead of creating a new one
      // The socket is already connected and authenticated
      this.viewerSocket = this.socket;
      
      // console.log('🎬 STREAMER VIEW: Using existing socket connection:', this.socket.id);
      
      // Ensure socket is connected
      if (!this.socket.connected) {
        // console.log('🎬 STREAMER VIEW: Socket not connected, waiting for connection...');
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
          
          const handleConnect = () => {
            clearTimeout(timeout);
            this.socket.off('connect', handleConnect);
            resolve(void 0);
          };
          
          if (this.socket.connected) {
            clearTimeout(timeout);
            resolve(void 0);
          } else {
            this.socket.on('connect', handleConnect);
          }
        });
      }

      // Create MediasoupClient with the viewer socket
      const mediasoupServerUrl = process.env.REACT_APP_SERVER_URL || 
        (process.env.NODE_ENV === 'development' 
          ? 'http://localhost:8080' 
          : window.location.origin);
        
      // console.log('🎬 STREAMER VIEW: Creating MediasoupClient with server URL:', mediasoupServerUrl);
      
      this.mediasoupClient = new WebRTCClientAdapter({
        socket: this.viewerSocket,
        serverUrl: mediasoupServerUrl,
      });

      // Initialize and consume the stream as a viewer
      await this.mediasoupClient.initialize();
      await this.mediasoupClient.createRecvTransport();
      
      // Join as viewer first
      this.viewerSocket.emit('join-as-viewer');
      
      // Wait a moment for viewer setup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Consume the processed stream
      const processedStream = await this.mediasoupClient.consume();
      
      if (processedStream && processedStream.getTracks().length > 0) {
        // console.log('🎬 STREAMER VIEW: Received processed stream with', processedStream.getTracks().length, 'tracks');
        
        // Ensure video element is ready for new stream
        this.videoElement.srcObject = null;
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Switch video element to processed stream
        this.videoElement.srcObject = processedStream;
        
        // Wait for video to be ready then play
        await new Promise((resolve, reject) => {
          const playTimeout = setTimeout(() => {
            reject(new Error('Video play timeout'));
          }, 5000);
          
          const handleCanPlay = () => {
            clearTimeout(playTimeout);
            this.videoElement.removeEventListener('canplay', handleCanPlay);
            resolve(undefined);
          };
          
          this.videoElement.addEventListener('canplay', handleCanPlay);
          
          // If video is already ready, resolve immediately
          if (this.videoElement.readyState >= 2) {
            clearTimeout(playTimeout);
            this.videoElement.removeEventListener('canplay', handleCanPlay);
            resolve(undefined);
          }
        });
        
        // Now play the video
        try {
          await this.videoElement.play();
          // console.log('✅ STREAMER VIEW: Video playing processed stream');
        } catch (playError) {
          console.error('❌ STREAMER VIEW: Error playing video:', playError);
          // Try to play again after a short delay
          await new Promise(resolve => setTimeout(resolve, 500));
          await this.videoElement.play();
        }
        
        // Reapply CSS filters after switching streams
        this.updateVideoFilters();
        
        this.currentState.mode = 'self-stream';
        this.currentState.lastSwitchTime = Date.now();
        
        // console.log('✅ STREAMER VIEW: Successfully switched to consuming own stream');
        
        // Visual indicator is handled by the React component (WebRTCStreamer)
        // No need to add it here to avoid duplicates
      } else {
        throw new Error('No processed stream available');
      }
      
    } catch (error) {
      console.error('❌ STREAMER VIEW: Failed to switch to self-stream:', error);
      // Cleanup viewer connection on failure
      await this.cleanupViewerConnection();
      // Fallback to local preview
      await this.performSwitchToLocalPreview();
    } finally {
      this.isSwitching = false;
    }
  }

  private async switchToLocalPreview() {
    if (this.currentState.mode === 'local-preview') {
      // console.log('🎬 STREAMER VIEW: Already in local preview mode');
      return;
    }
    
    if (this.isSwitching) {
      // console.log('🎬 STREAMER VIEW: Already switching, aborting duplicate switch');
      return;
    }
    
    // Debounce rapid switches
    if (this.switchDebounceTimer) {
      clearTimeout(this.switchDebounceTimer);
    }
    
    this.switchDebounceTimer = setTimeout(async () => {
      await this.performSwitchToLocalPreview();
    }, 300);
  }
  
  private async performSwitchToLocalPreview() {
    this.isSwitching = true;

    try {
      // console.log('🎬 STREAMER VIEW: Switching back to local preview...');
      
      // Pause video before switching
      this.videoElement.pause();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Clean up viewer connection and MediasoupClient
      await this.cleanupViewerConnection();

      // Clear current source first
      this.videoElement.srcObject = null;
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Restore original stream
      if (this.originalStream && this.originalStream.getTracks().some(t => t.readyState === 'live')) {
        this.videoElement.srcObject = this.originalStream;
        
        // Wait for video to be ready
        await new Promise((resolve) => {
          const handleCanPlay = () => {
            this.videoElement.removeEventListener('canplay', handleCanPlay);
            resolve(undefined);
          };
          
          this.videoElement.addEventListener('canplay', handleCanPlay);
          
          // If video is already ready, resolve immediately
          if (this.videoElement.readyState >= 2) {
            this.videoElement.removeEventListener('canplay', handleCanPlay);
            resolve(undefined);
          }
        });
        
        // Now play the video
        try {
          await this.videoElement.play();
          // console.log('✅ STREAMER VIEW: Video playing local preview');
        } catch (playError) {
          console.error('❌ STREAMER VIEW: Error playing local preview:', playError);
        }
      } else {
        console.warn('⚠️ STREAMER VIEW: Original stream not available or no live tracks');
      }
      
      // Reapply CSS filters after switching streams
      this.updateVideoFilters();

      this.currentState.mode = 'local-preview';
      this.currentState.lastSwitchTime = Date.now();
      
      // console.log('✅ STREAMER VIEW: Successfully switched back to local preview');
      
      // Visual indicator is handled by the React component (WebRTCStreamer)
      // No need to remove it here
      
    } catch (error) {
      console.error('❌ STREAMER VIEW: Failed to switch to local preview:', error);
    } finally {
      this.isSwitching = false;
    }
  }

  private async cleanupViewerConnection() {
    // console.log('🎬 STREAMER VIEW: Starting viewer connection cleanup...');
    
    try {
      // Clean up MediasoupClient first
      if (this.mediasoupClient) {
        // console.log('🎬 STREAMER VIEW: Cleaning up MediasoupClient...');
        await this.mediasoupClient.cleanup();
        this.mediasoupClient = null;
        // Wait for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Reset viewer socket reference (don't disconnect since it's the main socket)
      if (this.viewerSocket) {
        // console.log('🎬 STREAMER VIEW: Resetting viewer socket reference');
        this.viewerSocket = null;
        // Small delay for cleanup
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // console.log('✅ STREAMER VIEW: Viewer connection cleanup completed');
    } catch (error) {
      console.error('❌ STREAMER VIEW: Error during cleanup:', error);
    }
  }

  // These methods are deprecated - visual indicators are handled by the React component
  // Keeping them as empty methods to avoid breaking any potential references
  private addStreamViewIndicator() {
    // Visual indicator is handled by the React component (WebRTCStreamer)
  }

  private removeStreamViewIndicator() {
    // Visual indicator is handled by the React component (WebRTCStreamer)
  }

  // Public methods
  public getState(): StreamerViewState {
    return { ...this.currentState };
  }

  public forceLocalPreview() {
    // console.log('🎬 STREAMER VIEW: Force switching to local preview');
    this.switchToLocalPreview();
  }

  public forceSelfStream() {
    // console.log('🎬 STREAMER VIEW: Force switching to self-stream view');
    this.switchToSelfStream();
  }

  public async cleanup() {
    // console.log('🎬 STREAMER VIEW: Cleaning up manager');
    
    this.isSwitching = false;
    this.processingEffect = false;
    
    if (this.switchTimeout) {
      clearTimeout(this.switchTimeout);
    }
    
    if (this.switchDebounceTimer) {
      clearTimeout(this.switchDebounceTimer);
    }
    
    // Clear all CSS filters
    this.activeCSSFilters.clear();
    this.updateVideoFilters();
    
    // Clean up viewer connection
    await this.cleanupViewerConnection();
    
    this.removeStreamViewIndicator();
    
    // Remove socket listeners
    this.socket.off('stream-status');
  }

  public getStats() {
    return {
      currentMode: this.currentState.mode,
      activeEffects: this.currentState.activeEffects.length,
      hasStreamEffects: this.currentState.hasStreamProcessingEffects,
      lastSwitchTime: this.currentState.lastSwitchTime,
      effectsRequiringProcessing: Array.from(this.effectsRequiringStreamProcessing)
    };
  }
}