/**
 * VideoCompositor - Composites multiple video sources using Canvas
 * Used to create Picture-in-Picture overlay of webcam on screen share
 */

export type PipPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface VideoCompositorOptions {
  pipEnabled: boolean;
  pipPosition: PipPosition;
  pipSize: number;        // 0-100, percentage of main video width
  pipBorderRadius: number; // pixels
  pipPadding: number;     // pixels from edge
  frameRate?: number;     // target frame rate, default 30
}

export const DEFAULT_COMPOSITOR_OPTIONS: VideoCompositorOptions = {
  pipEnabled: true,
  pipPosition: 'bottom-right',
  pipSize: 25,
  pipBorderRadius: 8,
  pipPadding: 20,
  frameRate: 30
};

export class VideoCompositor {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private mainVideo: HTMLVideoElement | null = null;
  private pipVideo: HTMLVideoElement | null = null;
  private outputStream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private isActive: boolean = false;
  private options: VideoCompositorOptions = { ...DEFAULT_COMPOSITOR_OPTIONS };
  private lastFrameTime: number = 0;
  private frameInterval: number = 1000 / 30; // ~30 fps

  // CPU Optimization: Cache PiP dimensions to avoid recalculating every frame
  private cachedPipDimensions: {
    x: number;
    y: number;
    width: number;
    height: number;
    canvasWidth: number;
    canvasHeight: number;
    videoWidth: number;
    videoHeight: number;
  } | null = null;

  /**
   * Check if Canvas compositing is supported
   */
  static isSupported(): boolean {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext && canvas.getContext('2d') && canvas.captureStream);
  }

  /**
   * Composite screen share with webcam overlay
   * @param screenTrack - Video track from screen share
   * @param webcamTrack - Video track from webcam (PiP overlay)
   * @param options - Compositing options
   * @returns Composited MediaStream with video track
   */
  async composite(
    screenTrack: MediaStreamTrack,
    webcamTrack: MediaStreamTrack | null,
    options: Partial<VideoCompositorOptions> = {}
  ): Promise<MediaStream | null> {
    console.log('🎬 VIDEO COMPOSITOR: Starting composition...', {
      hasScreenTrack: !!screenTrack,
      hasWebcamTrack: !!webcamTrack,
      screenState: screenTrack?.readyState,
      webcamState: webcamTrack?.readyState,
      options
    });

    // Clean up any previous composition
    this.cleanup();

    // Merge options with defaults
    this.options = { ...DEFAULT_COMPOSITOR_OPTIONS, ...options };
    this.frameInterval = 1000 / (this.options.frameRate || 30);

    // If PiP disabled or no webcam, just return the screen stream directly
    if (!this.options.pipEnabled || !webcamTrack) {
      console.log('🎬 VIDEO COMPOSITOR: PiP disabled or no webcam, returning screen directly');
      return new MediaStream([screenTrack]);
    }

    try {
      // Create canvas
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false });

      if (!this.ctx) {
        throw new Error('Failed to get canvas 2D context');
      }

      // Create video elements for source tracks
      this.mainVideo = await this.createVideoElement(screenTrack, 'screen');
      this.pipVideo = await this.createVideoElement(webcamTrack, 'webcam');

      // Set canvas size to match screen share
      const screenSettings = screenTrack.getSettings();
      this.canvas.width = screenSettings.width || 1920;
      this.canvas.height = screenSettings.height || 1080;

      console.log('🎬 VIDEO COMPOSITOR: Canvas created', {
        width: this.canvas.width,
        height: this.canvas.height
      });

      // Start rendering loop
      this.isActive = true;
      this.lastFrameTime = performance.now();
      this.renderFrame();

      // Capture canvas as stream
      this.outputStream = this.canvas.captureStream(this.options.frameRate || 30);

      console.log('🎬 VIDEO COMPOSITOR: ✅ Composition started', {
        outputTracks: this.outputStream.getTracks().length
      });

      // Listen for track ended events
      screenTrack.addEventListener('ended', () => {
        console.log('🎬 VIDEO COMPOSITOR: Screen track ended');
        this.cleanup();
      });

      webcamTrack.addEventListener('ended', () => {
        console.log('🎬 VIDEO COMPOSITOR: Webcam track ended, continuing with screen only');
        this.pipVideo = null;
      });

      return this.outputStream;

    } catch (error) {
      console.error('🎬 VIDEO COMPOSITOR: ❌ Failed to composite:', error);
      this.cleanup();
      return null;
    }
  }

  /**
   * Create a video element from a media track
   */
  private async createVideoElement(track: MediaStreamTrack, label: string): Promise<HTMLVideoElement> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;

      const stream = new MediaStream([track]);
      video.srcObject = stream;

      video.onloadedmetadata = () => {
        video.play().then(() => {
          console.log(`🎬 VIDEO COMPOSITOR: ${label} video ready`, {
            width: video.videoWidth,
            height: video.videoHeight
          });
          resolve(video);
        }).catch(reject);
      };

      video.onerror = () => {
        reject(new Error(`Failed to load ${label} video`));
      };

      // Timeout if video doesn't load
      setTimeout(() => {
        if (video.readyState < 2) {
          reject(new Error(`${label} video load timeout`));
        }
      }, 5000);
    });
  }

  /**
   * Render a single frame to the canvas
   */
  private renderFrame = (): void => {
    if (!this.isActive || !this.canvas || !this.ctx || !this.mainVideo) {
      return;
    }

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    // Throttle to target frame rate
    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = now - (elapsed % this.frameInterval);

      // Draw main video (screen share) as background
      if (this.mainVideo.readyState >= 2) {
        this.ctx.drawImage(this.mainVideo, 0, 0, this.canvas.width, this.canvas.height);
      }

      // Draw PiP overlay (webcam) if available
      if (this.pipVideo && this.pipVideo.readyState >= 2 && this.options.pipEnabled) {
        this.drawPipOverlay();
      }
    }

    // Schedule next frame
    this.animationFrameId = requestAnimationFrame(this.renderFrame);
  };

  /**
   * Get cached PiP dimensions, recalculating only when needed
   */
  private getPipDimensions(): { x: number; y: number; width: number; height: number } {
    if (!this.canvas || !this.pipVideo) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    // Check if cache is valid
    if (
      this.cachedPipDimensions &&
      this.cachedPipDimensions.canvasWidth === this.canvas.width &&
      this.cachedPipDimensions.canvasHeight === this.canvas.height &&
      this.cachedPipDimensions.videoWidth === this.pipVideo.videoWidth &&
      this.cachedPipDimensions.videoHeight === this.pipVideo.videoHeight
    ) {
      return this.cachedPipDimensions;
    }

    // Recalculate dimensions
    const { pipPosition, pipSize, pipPadding } = this.options;
    const pipWidth = (this.canvas.width * pipSize) / 100;
    const aspectRatio = this.pipVideo.videoWidth / this.pipVideo.videoHeight || 16 / 9;
    const pipHeight = pipWidth / aspectRatio;

    let x: number, y: number;
    switch (pipPosition) {
      case 'top-left':
        x = pipPadding;
        y = pipPadding;
        break;
      case 'top-right':
        x = this.canvas.width - pipWidth - pipPadding;
        y = pipPadding;
        break;
      case 'bottom-left':
        x = pipPadding;
        y = this.canvas.height - pipHeight - pipPadding;
        break;
      case 'bottom-right':
      default:
        x = this.canvas.width - pipWidth - pipPadding;
        y = this.canvas.height - pipHeight - pipPadding;
        break;
    }

    // Cache the results
    this.cachedPipDimensions = {
      x,
      y,
      width: pipWidth,
      height: pipHeight,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      videoWidth: this.pipVideo.videoWidth,
      videoHeight: this.pipVideo.videoHeight
    };

    return this.cachedPipDimensions;
  }

  /**
   * Draw the PiP webcam overlay
   */
  private drawPipOverlay(): void {
    if (!this.ctx || !this.canvas || !this.pipVideo) return;

    // CPU Optimization: Use cached dimensions instead of recalculating every frame
    const { x, y, width: pipWidth, height: pipHeight } = this.getPipDimensions();
    const { pipBorderRadius } = this.options;

    // Save context state
    this.ctx.save();

    // Create rounded rectangle clip path
    this.ctx.beginPath();
    this.roundRect(x, y, pipWidth, pipHeight, pipBorderRadius);
    this.ctx.clip();

    // Draw border/shadow background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    this.ctx.fillRect(x - 2, y - 2, pipWidth + 4, pipHeight + 4);

    // Draw the webcam video
    this.ctx.drawImage(this.pipVideo, x, y, pipWidth, pipHeight);

    // Restore context state
    this.ctx.restore();

    // Draw border outline
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.roundRect(x, y, pipWidth, pipHeight, pipBorderRadius);
    this.ctx.stroke();
  }

  /**
   * Helper to draw rounded rectangle path
   */
  private roundRect(x: number, y: number, width: number, height: number, radius: number): void {
    if (!this.ctx) return;

    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
  }

  /**
   * Update PiP options in real-time
   */
  updateOptions(options: Partial<VideoCompositorOptions>): void {
    this.options = { ...this.options, ...options };
    // CPU Optimization: Invalidate cached dimensions when options change
    this.cachedPipDimensions = null;
    console.log('🎬 VIDEO COMPOSITOR: Options updated', this.options);
  }

  /**
   * Update the webcam track in real-time (e.g., when camera is switched)
   * @param newWebcamTrack - New video track from webcam
   */
  async updateWebcamTrack(newWebcamTrack: MediaStreamTrack | null): Promise<void> {
    if (!this.isActive) {
      console.log('🎬 VIDEO COMPOSITOR: Not active, skipping webcam update');
      return;
    }

    console.log('🎬 VIDEO COMPOSITOR: Updating webcam track...', {
      hasNewTrack: !!newWebcamTrack,
      newTrackState: newWebcamTrack?.readyState
    });

    // Clean up old pip video element
    if (this.pipVideo) {
      this.pipVideo.srcObject = null;
      this.pipVideo = null;
    }

    // If no new track, just continue without PiP
    if (!newWebcamTrack || newWebcamTrack.readyState !== 'live') {
      console.log('🎬 VIDEO COMPOSITOR: No valid webcam track, continuing without PiP');
      return;
    }

    try {
      // Create new video element for the new webcam track
      this.pipVideo = await this.createVideoElement(newWebcamTrack, 'webcam');
      console.log('🎬 VIDEO COMPOSITOR: ✅ Webcam track updated successfully');

      // Listen for track ended
      newWebcamTrack.addEventListener('ended', () => {
        console.log('🎬 VIDEO COMPOSITOR: New webcam track ended');
        this.pipVideo = null;
      });

    } catch (error) {
      console.error('🎬 VIDEO COMPOSITOR: ❌ Failed to update webcam track:', error);
      this.pipVideo = null;
    }
  }

  /**
   * Get current composited stream
   */
  getOutputStream(): MediaStream | null {
    return this.outputStream;
  }

  /**
   * Get the composited video track
   */
  getVideoTrack(): MediaStreamTrack | null {
    if (!this.outputStream) return null;
    const tracks = this.outputStream.getVideoTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }

  /**
   * Check if compositor is active
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Clean up all resources
   */
  cleanup(): void {
    console.log('🎬 VIDEO COMPOSITOR: Cleaning up...');

    this.isActive = false;

    // Cancel animation frame
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Stop output stream tracks
    if (this.outputStream) {
      this.outputStream.getTracks().forEach(track => track.stop());
      this.outputStream = null;
    }

    // Clear video elements
    if (this.mainVideo) {
      this.mainVideo.srcObject = null;
      this.mainVideo = null;
    }

    if (this.pipVideo) {
      this.pipVideo.srcObject = null;
      this.pipVideo = null;
    }

    // Clear canvas
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.canvas = null;
    this.ctx = null;

    console.log('🎬 VIDEO COMPOSITOR: Cleanup complete');
  }
}

// Export singleton instance
export const videoCompositor = new VideoCompositor();

export default VideoCompositor;
