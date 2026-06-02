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
  private webrtcClient: WebRTCClientAdapter | null = null;
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
      if (this.webrtcClient) {
        // console.log('🎬 STREAMER VIEW: Cleaning up MediasoupClient...');
        await this.webrtcClient.cleanup();
        this.webrtcClient = null;
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

  // Deprecated - visual indicators are handled by the React component (WebRTCStreamer).
  // Kept as an empty method to avoid breaking the cleanup() reference.
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