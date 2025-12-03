/**
 * Screen Capture Service - Handles browser screen capture API
 * Provides methods for screen sharing in the streaming application
 */

export interface ScreenCaptureOptions {
  cursor?: 'always' | 'motion' | 'never';
  displaySurface?: 'monitor' | 'window' | 'browser';
  audio?: boolean;
  systemAudio?: 'include' | 'exclude';
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
}

export interface ScreenShareState {
  isActive: boolean;
  stream: MediaStream | null;
  displaySurface: string | null;
  hasAudio: boolean;
}

export class ScreenCaptureService {
  private screenStream: MediaStream | null = null;
  private onStreamEndCallback: (() => void) | null = null;

  /**
   * Check if screen capture is supported in the current browser
   */
  static isSupported(): boolean {
    return !!(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices);
  }

  /**
   * Check if the browser supports audio capture from screen
   */
  static supportsAudioCapture(): boolean {
    // Audio capture is supported in Chrome, Edge, and some Chromium-based browsers
    const userAgent = navigator.userAgent.toLowerCase();
    const isChrome = userAgent.includes('chrome') && !userAgent.includes('edge');
    const isEdge = userAgent.includes('edg/');
    const isOpera = userAgent.includes('opr/');
    return isChrome || isEdge || isOpera;
  }

  /**
   * Get screen capture stream
   */
  async getScreenStream(options: ScreenCaptureOptions = {}): Promise<MediaStream> {
    if (!ScreenCaptureService.isSupported()) {
      throw new Error('Screen capture is not supported in this browser');
    }

    // Stop any existing screen stream
    if (this.screenStream) {
      this.stopScreenShare();
    }

    // Build video constraints - don't force displaySurface to allow all options
    const videoConstraints: any = {
      cursor: options.cursor || 'always',
    };

    // Only set displaySurface if explicitly specified (don't default to 'monitor')
    if (options.displaySurface) {
      videoConstraints.displaySurface = options.displaySurface;
    }

    const constraints: DisplayMediaStreamOptions = {
      video: videoConstraints,
      audio: options.audio !== false && ScreenCaptureService.supportsAudioCapture() ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
      } : false,
    };

    // IMPORTANT: systemAudio must be at the TOP LEVEL of constraints (not inside audio)
    // This enables the "Share system audio" checkbox for Windows entire screen/window capture
    if (options.audio !== false && ScreenCaptureService.supportsAudioCapture()) {
      (constraints as any).systemAudio = options.systemAudio || 'include';
      // Suppress local playback to avoid echo when capturing system audio
      (constraints as any).suppressLocalAudioPlayback = true;
    }

    // Allow all monitor types (for system audio on entire screen)
    (constraints as any).monitorTypeSurfaces = 'include';

    if (options.selfBrowserSurface) {
      (constraints as any).selfBrowserSurface = options.selfBrowserSurface;
    }
    if (options.surfaceSwitching) {
      (constraints as any).surfaceSwitching = options.surfaceSwitching;
    }

    console.log('🖥️ SCREEN CAPTURE: Requesting screen with constraints:', constraints);

    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // Log what we got
      const videoTrack = this.screenStream.getVideoTracks()[0];
      const audioTrack = this.screenStream.getAudioTracks()[0];

      console.log('🖥️ SCREEN CAPTURE: Got screen stream');
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log('🖥️ SCREEN CAPTURE: Video track settings:', {
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
          displaySurface: (settings as any).displaySurface
        });
      }
      if (audioTrack) {
        console.log('🖥️ SCREEN CAPTURE: Audio track available (system audio)');
      } else {
        console.log('🖥️ SCREEN CAPTURE: No audio track (system audio not captured)');
      }

      // Listen for when user stops sharing via browser UI
      videoTrack?.addEventListener('ended', () => {
        console.log('🖥️ SCREEN CAPTURE: Screen share ended by user');
        this.handleStreamEnd();
      });

      return this.screenStream;
    } catch (error: any) {
      console.error('🖥️ SCREEN CAPTURE: Failed to get screen stream:', error);

      // Provide user-friendly error messages
      if (error.name === 'NotAllowedError') {
        throw new Error('Screen sharing was cancelled or permission was denied');
      } else if (error.name === 'NotFoundError') {
        throw new Error('No screen available for sharing');
      } else if (error.name === 'NotReadableError') {
        throw new Error('Could not read screen - it may be in use by another application');
      }
      throw error;
    }
  }

  /**
   * Stop screen sharing
   */
  stopScreenShare(): void {
    if (this.screenStream) {
      console.log('🖥️ SCREEN CAPTURE: Stopping screen share');
      this.screenStream.getTracks().forEach(track => {
        track.stop();
      });
      this.screenStream = null;
    }
  }

  /**
   * Get current screen stream (if any)
   */
  getStream(): MediaStream | null {
    return this.screenStream;
  }

  /**
   * Check if screen sharing is currently active
   */
  isActive(): boolean {
    if (!this.screenStream) return false;

    // Check if any video track is still active
    const videoTracks = this.screenStream.getVideoTracks();
    return videoTracks.some(track => track.readyState === 'live');
  }

  /**
   * Get the video track from the screen stream
   */
  getVideoTrack(): MediaStreamTrack | null {
    if (!this.screenStream) return null;
    const tracks = this.screenStream.getVideoTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }

  /**
   * Get the audio track from the screen stream (if available)
   */
  getAudioTrack(): MediaStreamTrack | null {
    if (!this.screenStream) return null;
    const tracks = this.screenStream.getAudioTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }

  /**
   * Get the current state of screen sharing
   */
  getState(): ScreenShareState {
    const videoTrack = this.getVideoTrack();
    const settings = videoTrack?.getSettings() as any;

    return {
      isActive: this.isActive(),
      stream: this.screenStream,
      displaySurface: settings?.displaySurface || null,
      hasAudio: !!this.getAudioTrack()
    };
  }

  /**
   * Set callback for when screen share ends
   */
  onStreamEnd(callback: () => void): void {
    this.onStreamEndCallback = callback;
  }

  /**
   * Handle stream end event
   */
  private handleStreamEnd(): void {
    this.screenStream = null;
    if (this.onStreamEndCallback) {
      this.onStreamEndCallback();
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopScreenShare();
    this.onStreamEndCallback = null;
  }
}

// Export singleton instance
export const screenCaptureService = new ScreenCaptureService();

export default ScreenCaptureService;
