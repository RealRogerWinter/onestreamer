import { EventEmitter } from 'events';
import { SplatEffect } from './effects/SplatEffect';
import { ParticleEffect } from './effects/ParticleEffect';
import { OverlayEffect } from './effects/OverlayEffect';
import { ConfettiEffect } from './effects/ConfettiEffect';
import { DiscoEffect } from './effects/DiscoEffect';
import { SmokeEffect } from './effects/SmokeEffect';
import { DrawingEffect } from './effects/DrawingEffect';
import { BaseEffect } from './effects/BaseEffect';

export interface EffectData {
  id: string;
  userId: string;
  itemId: string;
  itemName: string;
  displayName: string;
  emoji: string;
  type: string;
  duration: number;
  config: any;
  startTime: number;
  position: { x: number; y: number };
  mainEffectId?: string; // For multi-phase effects to share data
}

export class EffectEngine extends EventEmitter {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private videoElement: HTMLVideoElement;
  private activeEffects: Map<string, BaseEffect>;
  private animationId: number | null;
  private isRunning: boolean;
  private lastFrameTime: number;
  private fps: number;
  private frameCount: number;
  private fpsUpdateTime: number;
  private sharedDrawingData: Map<string, any>; // Store drawing data between phases
  private socket: any | null; // Socket.io instance for real-time drawing sync

  constructor(canvas: HTMLCanvasElement, videoElement: HTMLVideoElement) {
    super();
    this.canvas = canvas;
    this.videoElement = videoElement;
    this.activeEffects = new Map();
    this.animationId = null;
    this.isRunning = false;
    this.lastFrameTime = 0;
    this.fps = 0;
    this.frameCount = 0;
    this.fpsUpdateTime = 0;
    this.sharedDrawingData = new Map();
    this.socket = null;
    
    // SOLUTION 1: Force Canvas Alpha Channel Reset - Recreate context multiple times until transparency works
    this.ctx = this.createTransparentContext()!;
    
    // Force transparent CSS properties on canvas element
    this.forceCanvasTransparency();
    
    // Set initial canvas size immediately with fallbacks
    this.setupCanvas();
    
    // Initialize canvas as completely transparent
    this.initializeTransparentCanvas();
    
// console.log('🎨 EffectEngine: Initialized with canvas size:', {width: this.canvas.width, height: this.canvas.height});
    
    // Transparency tests disabled - working now
    // this.performTransparencyUnitTest();
    
    // SOLUTION: Move canvas to document.body to escape container stacking context
    this.escapeContainerContext();
    
    // Force immediate resize to ensure proper sizing
    this.forceCanvasResize();
    
    // Start render loop only if we have valid dimensions
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      this.startRenderLoop();
    } else {
      console.warn('⚠️ EffectEngine: Canvas has no dimensions, render loop not started');
    }
  }

  private setupCanvas(): void {
    // Match canvas size to video element
    const rect = this.videoElement.getBoundingClientRect();
    
    // Get video element computed style to handle CSS sizing
    const computedStyle = window.getComputedStyle(this.videoElement);
    const styleWidth = parseInt(computedStyle.width) || 0;
    const styleHeight = parseInt(computedStyle.height) || 0;
    
// console.log('🎨 EffectEngine: setupCanvas - sizing info:', {
    //   rect: { width: rect.width, height: rect.height },
    //   computedStyle: { width: styleWidth, height: styleHeight },
    //   videoElement: {
    //     clientWidth: this.videoElement.clientWidth,
    //     clientHeight: this.videoElement.clientHeight,
    //     offsetWidth: this.videoElement.offsetWidth,
    //     offsetHeight: this.videoElement.offsetHeight
    //   },
    //   canvasParent: {
    //     clientWidth: this.canvas.parentElement?.clientWidth,
    //     clientHeight: this.canvas.parentElement?.clientHeight,
    //     offsetWidth: this.canvas.parentElement?.offsetWidth,
    //     offsetHeight: this.canvas.parentElement?.offsetHeight
    //   }
    // });
    
    // Use best available dimensions, with priority: rect > computed style > client > offset > defaults
    let width = rect.width;
    let height = rect.height;
    
    if (width <= 0) width = styleWidth;
    if (height <= 0) height = styleHeight;
    
    if (width <= 0) width = this.videoElement.clientWidth;
    if (height <= 0) height = this.videoElement.clientHeight;
    
    if (width <= 0) width = this.videoElement.offsetWidth;
    if (height <= 0) height = this.videoElement.offsetHeight;
    
    // Fallback to reasonable defaults if all else fails - match CanvasEffectOverlay defaults
    if (width <= 0) width = 800;
    if (height <= 0) height = 600;
    
// console.log('🎨 EffectEngine: Setting canvas dimensions to:', {width, height});
    this.canvas.width = width;
    this.canvas.height = height;
    
    // CRITICAL: Set CSS dimensions to match canvas dimensions to prevent scaling issues
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    
    // Set up canvas rendering context
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  private initializeTransparentCanvas(): void {
    // Ensure canvas starts completely transparent
    this.ctx.save();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    
    // Set proper blend mode for transparent rendering
    this.ctx.globalCompositeOperation = 'source-over';
    
    // Force transparent background by drawing transparent rectangle
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    
    // Additional transparency checks
// console.log('🎨 EffectEngine: Canvas initialized as transparent', {
    //   canvasWidth: this.canvas.width,
    //   canvasHeight: this.canvas.height,
    //   contextAlpha: this.ctx.globalAlpha,
    //   compositeOperation: this.ctx.globalCompositeOperation,
    //   canvasStyle: this.canvas.style.cssText
    // });
  }

  private performTransparencyUnitTest(): void {
// console.log('🧪 TRANSPARENCY UNIT TEST: Starting comprehensive canvas transparency test');
    
    // Test 1: Verify context has alpha channel
    const contextAttributes = this.ctx.getContextAttributes();
    const hasAlpha = !!contextAttributes?.alpha;
// console.log(`🧪 TEST 1 - Alpha channel: ${hasAlpha ? '✅ PASS' : '❌ FAIL'} - Context alpha: ${contextAttributes?.alpha}`);
    
    // Test 2: Clear and verify transparency
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const clearedPixel = this.ctx.getImageData(10, 10, 1, 1).data;
    const isTransparentAfterClear = clearedPixel[3] === 0;
// console.log(`🧪 TEST 2 - Clear transparency: ${isTransparentAfterClear ? '✅ PASS' : '❌ FAIL'} - Pixel: rgba(${clearedPixel[0]}, ${clearedPixel[1]}, ${clearedPixel[2]}, ${clearedPixel[3]})`);
    
    // Test 3: Draw transparent shape and verify
    this.ctx.save();
    this.ctx.globalAlpha = 0.5;
    this.ctx.fillStyle = '#ff0000';
    this.ctx.fillRect(0, 0, 50, 50);
    this.ctx.restore();
    
    const semiTransparentPixel = this.ctx.getImageData(25, 25, 1, 1).data;
    const hasSemiTransparent = semiTransparentPixel[3] > 0 && semiTransparentPixel[3] < 255;
// console.log(`🧪 TEST 3 - Semi-transparent draw: ${hasSemiTransparent ? '✅ PASS' : '❌ FAIL'} - Pixel: rgba(${semiTransparentPixel[0]}, ${semiTransparentPixel[1]}, ${semiTransparentPixel[2]}, ${semiTransparentPixel[3]})`);
    
    // Test 4: CSS Transparency
    const computedStyle = window.getComputedStyle(this.canvas);
    const cssBackground = computedStyle.backgroundColor;
    const cssOpacity = computedStyle.opacity;
    const hasCSSTransparency = cssBackground === 'rgba(0, 0, 0, 0)' || cssBackground === 'transparent';
// console.log(`🧪 TEST 4 - CSS transparency: ${hasCSSTransparency ? '✅ PASS' : '❌ FAIL'} - Background: ${cssBackground}, Opacity: ${cssOpacity}`);
    
    // Test 5: Z-index and positioning
    const zIndex = this.canvas.style.zIndex || computedStyle.zIndex;
    const position = computedStyle.position;
    const isProperlyPositioned = position === 'absolute' && parseInt(zIndex) > 0;
// console.log(`🧪 TEST 5 - Positioning: ${isProperlyPositioned ? '✅ PASS' : '❌ FAIL'} - Position: ${position}, Z-index: ${zIndex}`);
    
    // Test 6: Parent container transparency
    const parent = this.canvas.parentElement;
    if (parent) {
      const parentStyle = window.getComputedStyle(parent);
      const parentBackground = parentStyle.backgroundColor;
      const parentOpacity = parentStyle.opacity;
// console.log(`🧪 TEST 6 - Parent transparency: Background: ${parentBackground}, Opacity: ${parentOpacity}`);
    }
    
    // Test 7: Create REPLACEMENT canvas with different approach
// console.log('🧪 TEST 7 - Creating replacement canvas with nuclear transparency approach');
    
    const testCanvas = document.createElement('canvas');
    testCanvas.width = this.canvas.width;
    testCanvas.height = this.canvas.height;
    testCanvas.style.position = 'absolute';
    testCanvas.style.top = '0px';
    testCanvas.style.left = '0px';
    testCanvas.style.backgroundColor = 'rgba(0,0,0,0)';
    testCanvas.style.background = 'none';
    testCanvas.style.opacity = '1';
    testCanvas.style.pointerEvents = 'none';
    testCanvas.style.zIndex = '10000';
    testCanvas.style.border = '1px solid cyan'; // Visible border to see canvas
    
    const testCtx = testCanvas.getContext('2d', { 
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      colorSpace: 'srgb'
    }) as CanvasRenderingContext2D;
    
    // Clear and draw test pattern
    testCtx.clearRect(0, 0, testCanvas.width, testCanvas.height);
    testCtx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    testCtx.fillRect(50, 50, 100, 100);
    
    this.canvas.parentElement?.appendChild(testCanvas);
// console.log('🧪 TEST 7 - Created replacement canvas with cyan border - should show transparent red square');
    
    // Test 8: Create canvas directly on document.body (completely isolated)
    const isolatedCanvas = document.createElement('canvas');
    isolatedCanvas.width = 200;
    isolatedCanvas.height = 200;
    isolatedCanvas.style.position = 'fixed';
    isolatedCanvas.style.top = '10px';
    isolatedCanvas.style.right = '10px';
    isolatedCanvas.style.backgroundColor = 'transparent';
    isolatedCanvas.style.border = '3px solid magenta';
    isolatedCanvas.style.zIndex = '99999';
    isolatedCanvas.style.pointerEvents = 'none';
    
    const isolatedCtx = isolatedCanvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D;
    isolatedCtx.clearRect(0, 0, 200, 200);
    isolatedCtx.fillStyle = 'rgba(0, 255, 0, 0.7)';
    isolatedCtx.fillRect(20, 20, 160, 160);
    
    document.body.appendChild(isolatedCanvas);
// console.log('🧪 TEST 8 - Created ISOLATED canvas on body with magenta border - should show transparent green square');
    
    // Remove test canvases after 10 seconds
    setTimeout(() => {
      if (testCanvas.parentElement) {
        testCanvas.parentElement.removeChild(testCanvas);
      }
      if (isolatedCanvas.parentElement) {
        isolatedCanvas.parentElement.removeChild(isolatedCanvas);
      }
    }, 10000);
    
    // Clear the test drawing from our main canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
// console.log('🧪 TRANSPARENCY UNIT TEST: Completed - check console for results');
  }

  private escapeContainerContext(): void {
// console.log('🚀 ESCAPE CONTEXT: Moving canvas to document.body to escape stacking context');
    
    // Store original container and positioning info
    const originalParent = this.canvas.parentElement;
    const originalPosition = {
      position: this.canvas.style.position,
      top: this.canvas.style.top,
      left: this.canvas.style.left,
      right: this.canvas.style.right,
      bottom: this.canvas.style.bottom,
      width: this.canvas.style.width,
      height: this.canvas.style.height,
      zIndex: this.canvas.style.zIndex
    };
    
// console.log('🚀 Original parent:', originalParent?.className);
// console.log('🚀 Original position:', originalPosition);
    
    // Remove from current container
    if (originalParent) {
      originalParent.removeChild(this.canvas);
    }
    
    // CRITICAL FIX: Wait for DOM to be ready before positioning
    const positionCanvas = () => {
      const videoRect = this.getVideoDisplayRect();
      
      this.canvas.style.position = 'fixed';
      this.canvas.style.top = `${videoRect.top}px`;
      this.canvas.style.left = `${videoRect.left}px`;
      this.canvas.style.width = `${videoRect.width}px`;
      this.canvas.style.height = `${videoRect.height}px`;
      this.canvas.style.zIndex = '999999'; // Very high z-index
      // Pointer events are managed by CanvasEffectOverlay component
      this.canvas.style.pointerEvents = 'none';
      
      // Update canvas internal dimensions to match
      this.canvas.width = videoRect.width;
      this.canvas.height = videoRect.height;
      
// console.log('🚀 Canvas positioned initially:', {
      //   top: videoRect.top,
      //   left: videoRect.left,
      //   width: videoRect.width,
      //   height: videoRect.height
      // });
    };
    
    // Position immediately
    positionCanvas();
    
    // Also position after a short delay to handle cases where video loads async
    setTimeout(positionCanvas, 50);
    setTimeout(positionCanvas, 200);
    
// console.log('🚀 Canvas styled for click events:', {
    //   position: this.canvas.style.position,
    //   zIndex: this.canvas.style.zIndex,
    //   pointerEvents: this.canvas.style.pointerEvents,
    //   top: this.canvas.style.top,
    //   left: this.canvas.style.left,
    //   width: this.canvas.style.width,
    //   height: this.canvas.style.height
    // });
    
// console.log('🚀 Canvas positioned over video/stream area:', {
    //   top: videoRect.top,
    //   left: videoRect.left, 
    //   width: videoRect.width,
    //   height: videoRect.height
    // });
    
    // Move to document.body (like the working magenta canvas)
    document.body.appendChild(this.canvas);
    
// console.log('🚀 Canvas moved to document.body with fixed positioning');
    
    // Store reference for potential cleanup
    (this.canvas as any).__originalParent = originalParent;
    (this.canvas as any).__originalPosition = originalPosition;
    
    // Canvas click handling is now managed by CanvasEffectOverlay component
    
    // Add resize listener to keep canvas positioned over video
    this.addVideoTrackingListener();
  }

  private getVideoDisplayRect(): DOMRect {
// console.log('🎯 Getting video display rectangle...');
    
    // CRITICAL FIX: Wait for video to be properly loaded before calculating dimensions
    const ensureVideoLoaded = () => {
      // Check if video has actual dimensions
      if (this.videoElement.videoWidth > 0 && this.videoElement.videoHeight > 0) {
        return true;
      }
      // Check if video element has CSS dimensions
      const rect = this.videoElement.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    
    // Method 1: Try video element dimensions
    const videoRect = this.videoElement.getBoundingClientRect();
// console.log('🎯 Video element rect:', videoRect);
    
    // Method 2: Try parent container
    const parentRect = this.videoElement.parentElement?.getBoundingClientRect();
// console.log('🎯 Parent container rect:', parentRect);
    
    // Method 3: Try finding stream container by class - expand search
    const streamContainer = this.videoElement.closest('.webrtc-streamer, .stream-viewer, .video-container, .stream-container, .webrtc-video-container');
    const streamRect = streamContainer?.getBoundingClientRect();
// console.log('🎯 Stream container rect:', streamRect);
    
    // Method 4: Try finding main content area
    const mainContent = document.querySelector('.main-content, .stream-content, .video-main');
    const mainRect = mainContent?.getBoundingClientRect();
// console.log('🎯 Main content rect:', mainRect);
    
    // Method 5: Use video element's actual rendered size (accounting for object-fit)
    const videoStyle = window.getComputedStyle(this.videoElement);
    
    // CRITICAL FIX: Better dimension calculation
    let computedWidth = parseFloat(videoStyle.width) || 0;
    let computedHeight = parseFloat(videoStyle.height) || 0;
    
    // If video style dimensions are not set, use natural video dimensions if available
    if (computedWidth <= 0 && this.videoElement.videoWidth > 0) {
      computedWidth = this.videoElement.videoWidth;
    }
    if (computedHeight <= 0 && this.videoElement.videoHeight > 0) {
      computedHeight = this.videoElement.videoHeight;
    }
    
    // Fallback to client dimensions
    if (computedWidth <= 0) computedWidth = this.videoElement.clientWidth || videoRect.width;
    if (computedHeight <= 0) computedHeight = this.videoElement.clientHeight || videoRect.height;
    
    const videoComputedRect = {
      top: videoRect.top,
      left: videoRect.left,
      width: computedWidth,
      height: computedHeight,
      right: videoRect.left + computedWidth,
      bottom: videoRect.top + computedHeight
    } as DOMRect;
// console.log('🎯 Video computed rect:', videoComputedRect);
    
    // Choose the best rectangle prioritizing video element itself since it defines the actual stream area
    const candidates = [
      { rect: videoComputedRect, name: 'video-computed', priority: 1 },
      { rect: videoRect, name: 'video-element', priority: 2 },
      { rect: parentRect, name: 'parent-container', priority: 3 },
      { rect: streamRect, name: 'stream-container', priority: 4 },
      { rect: mainRect, name: 'main-content', priority: 5 }
    ].filter(c => c.rect && c.rect.width > 0 && c.rect.height > 0);
    
// console.log('🎯 Valid rectangle candidates:', candidates);
    
    // Choose by priority first (lower number = higher priority), then by area if same priority
    const bestCandidate = candidates.reduce((best, current) => {
      if (!best || !best.rect || !current.rect) return current;
      
      // Prioritize by priority level first
      if (current.priority < best.priority) return current;
      if (current.priority > best.priority) return best;
      
      // If same priority, choose larger area
      const bestArea = best.rect.width * best.rect.height;
      const currentArea = current.rect.width * current.rect.height;
      return currentArea > bestArea ? current : best;
    }, candidates[0]);
    
// console.log('🎯 Selected rectangle:', bestCandidate?.name, bestCandidate?.rect);
    
    // CRITICAL FIX: Better fallback handling
    let finalRect = bestCandidate?.rect || videoRect;
    
    // Last resort fallbacks if we still don't have valid dimensions
    if (!finalRect || finalRect.width <= 0 || finalRect.height <= 0) {
      // Try to use default streaming dimensions
      const fallbackWidth = 800;
      const fallbackHeight = 600;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      const fallbackTop = Math.max(0, (viewportHeight - fallbackHeight) / 2);
      const fallbackLeft = Math.max(0, (viewportWidth - fallbackWidth) / 2);
      const fallbackWidth_final = Math.min(fallbackWidth, viewportWidth * 0.8);
      const fallbackHeight_final = Math.min(fallbackHeight, viewportHeight * 0.8);
      
      finalRect = {
        top: fallbackTop,
        left: fallbackLeft,
        width: fallbackWidth_final,
        height: fallbackHeight_final,
        right: fallbackLeft + fallbackWidth_final,
        bottom: fallbackTop + fallbackHeight_final,
        x: fallbackLeft,
        y: fallbackTop,
        toJSON: () => ({})
      } as DOMRect;
      
// console.log('🎯 Using fallback dimensions:', finalRect);
    }
    
    // Log final positioning info
// console.log('🎯 Final canvas positioning:', {
    //   top: finalRect.top,
    //   left: finalRect.left,
    //   width: finalRect.width,
    //   height: finalRect.height,
    //   source: bestCandidate?.name || 'fallback'
    // });
    
    return finalRect;
  }


  private addVideoTrackingListener(): void {
    const updateCanvasPosition = () => {
      if (this.canvas.parentElement === document.body) {
        const videoRect = this.getVideoDisplayRect();
        this.canvas.style.top = `${videoRect.top}px`;
        this.canvas.style.left = `${videoRect.left}px`;
        this.canvas.style.width = `${videoRect.width}px`;
        this.canvas.style.height = `${videoRect.height}px`;
        
        // Update canvas internal dimensions
        this.canvas.width = videoRect.width;
        this.canvas.height = videoRect.height;
        
// console.log('🎯 Canvas position updated:', {
        //   top: videoRect.top,
        //   left: videoRect.left,
        //   width: videoRect.width,
        //   height: videoRect.height
        // });
      }
    };

    // CRITICAL FIX: Use RAF to ensure position updates happen at optimal times
    let positionUpdateRAF: number | null = null;
    const requestPositionUpdate = () => {
      if (positionUpdateRAF !== null) {
        cancelAnimationFrame(positionUpdateRAF);
      }
      positionUpdateRAF = requestAnimationFrame(() => {
        updateCanvasPosition();
        positionUpdateRAF = null;
      });
    };

    // Track window resize with RAF
    window.addEventListener('resize', requestPositionUpdate);
    
    // Track scroll with RAF
    window.addEventListener('scroll', requestPositionUpdate);
    
    // CRITICAL FIX: Also track when video element changes size or position
    const observeVideo = () => {
      if (window.ResizeObserver) {
        const resizeObserver = new ResizeObserver(() => {
          requestPositionUpdate();
        });
        
        // Observe video element size changes
        resizeObserver.observe(this.videoElement);
        
        // Store reference for cleanup
        (this.canvas as any).__resizeObserver = resizeObserver;
      }
      
      // Also use MutationObserver to track when video container changes
      if (window.MutationObserver) {
        const mutationObserver = new MutationObserver(() => {
          requestPositionUpdate();
        });
        
        // Watch for changes to video parent container
        const videoParent = this.videoElement.parentElement;
        if (videoParent) {
          mutationObserver.observe(videoParent, {
            attributes: true,
            attributeFilter: ['style', 'class'],
            childList: true
          });
        }
        
        // Store reference for cleanup
        (this.canvas as any).__mutationObserver = mutationObserver;
      }
    };
    
    // Start observing immediately
    observeVideo();
    
    // CRITICAL FIX: Force initial position update with multiple timing strategies
    // Immediate update
    requestPositionUpdate();
    
    // Short delay for DOM settling
    setTimeout(requestPositionUpdate, 50);
    
    // Medium delay for video element initialization
    setTimeout(requestPositionUpdate, 200);
    
    // Longer delay for async video loading
    setTimeout(requestPositionUpdate, 500);
    
    // Final retry for stubborn cases
    setTimeout(requestPositionUpdate, 1000);
    
    // Store references for cleanup
    (this.canvas as any).__positionUpdater = updateCanvasPosition;
    (this.canvas as any).__positionUpdateRAF = () => {
      if (positionUpdateRAF !== null) {
        cancelAnimationFrame(positionUpdateRAF);
      }
    };
  }

  private createTransparentContext(): CanvasRenderingContext2D | null {
// console.log('🎨 EffectEngine: Creating transparent canvas context...');
    
    // Try multiple context creation approaches
    const contextOptions = [
      { alpha: true, desynchronized: true, willReadFrequently: false },
      { alpha: true, desynchronized: false, willReadFrequently: false },
      { alpha: true, premultipliedAlpha: false },
      { alpha: true }
    ];
    
    for (let i = 0; i < contextOptions.length; i++) {
      const options = contextOptions[i];
// console.log(`🎨 EffectEngine: Trying context creation attempt ${i + 1}:`, options);
      
      // Get context with current options
      const ctx = this.canvas.getContext('2d', options) as CanvasRenderingContext2D | null;
      
      if (ctx) {
// console.log(`✅ EffectEngine: Successfully created context on attempt ${i + 1}`);
        
        // Test if context supports transparency
        if (this.testContextTransparency(ctx)) {
// console.log('✅ EffectEngine: Context supports transparency');
          return ctx;
        } else {
          console.warn(`⚠️ EffectEngine: Context does not support transparency on attempt ${i + 1}`);
        }
      }
    }
    
    console.error('❌ EffectEngine: Failed to create transparent context after all attempts');
    // Return basic context as fallback
    return this.canvas.getContext('2d', { alpha: true });
  }

  private testContextTransparency(ctx: CanvasRenderingContext2D): boolean {
    try {
      // Save current state
      ctx.save();
      
      // Clear a small area
      ctx.clearRect(0, 0, 10, 10);
      
      // Get image data for the cleared area
      const imageData = ctx.getImageData(0, 0, 1, 1);
      const alpha = imageData.data[3]; // Alpha channel
      
      // Restore state
      ctx.restore();
      
// console.log(`🎨 EffectEngine: Transparency test - alpha value: ${alpha}`);
      return alpha === 0; // Should be fully transparent
    } catch (error) {
      console.warn('🎨 EffectEngine: Transparency test failed:', error);
      return false;
    }
  }

  private forceCanvasTransparency(): void {
// console.log('🎨 EffectEngine: Forcing canvas element transparency...');
    
    // SOLUTION 2: CSS mix-blend-mode override
    this.canvas.style.backgroundColor = 'transparent';
    this.canvas.style.background = 'transparent';
    this.canvas.style.opacity = '1'; // Full opacity for transparency
    this.canvas.style.mixBlendMode = 'normal';
    
    // NUCLEAR: Every possible CSS override to force transparency
    this.canvas.style.isolation = 'auto'; // Don't isolate
    this.canvas.style.transform = 'none'; // Disable hardware acceleration
    this.canvas.style.willChange = 'auto'; // Remove optimization hints
    this.canvas.style.backfaceVisibility = 'visible';
    this.canvas.style.filter = 'none';
    this.canvas.style.backdropFilter = 'none';
    (this.canvas.style as any).webkitBackdropFilter = 'none';
    this.canvas.style.maskImage = 'none';
    (this.canvas.style as any).webkitMaskImage = 'none';
    this.canvas.style.clipPath = 'none';
    this.canvas.style.contain = 'none';
    
    // Force isolation on parent
    const parent = this.canvas.parentElement;
    if (parent) {
      parent.style.isolation = 'isolate';
    }
    
// console.log('🎨 EffectEngine: Canvas transparency CSS applied');
  }


  public triggerEffect(effectData: EffectData): void {
    try {
      console.log(`🎬 ENGINE: triggerEffect called with:`, {
        itemName: effectData.itemName,
        type: effectData.type,
        id: effectData.id
      });
      
      if (effectData.itemName === 'smoke_bomb') {
        console.log(`🔥 ENGINE: Triggering smoke bomb effect - ${effectData.config.phaseName || effectData.type}`);
      }
      
      const effect = this.createEffectRenderer(effectData);
      
      if (effect) {
        this.activeEffects.set(effectData.id, effect);
        this.emit('effectCountChange', this.activeEffects.size);
        
        // Ensure render loop is running and canvas has valid dimensions
        if (!this.isRunning) {
          this.handleResize();
          this.startRenderLoop();
        }
        
        // Force immediate render to test effect
        this.renderFrame();
        
        // Auto-remove after duration
        setTimeout(() => {
          this.removeEffect(effectData.id);
        }, effectData.duration);
      } else {
        console.warn(`⚠️ EffectEngine: Failed to create effect for type: ${effectData.type}`);
      }
    } catch (error) {
      console.error('❌ EffectEngine: Error triggering effect:', error);
    }
  }

  private createEffectRenderer(effectData: EffectData): BaseEffect | null {
    
    const commonConfig = {
      id: effectData.id,
      position: effectData.position,
      duration: effectData.duration,
      canvas: this.canvas,
      ...effectData.config
    };

    // SPECIAL CASE: Force smoke bomb items to use SmokeEffect regardless of type
    if (effectData.itemName === 'smoke_bomb') {
      console.log('🔥 ENGINE: FORCING SmokeEffect for smoke_bomb item!');
      const isInitialPuff = effectData.config.phaseName === 'initial_puff';
      return new SmokeEffect({
        ...commonConfig,
        effectType: isInitialPuff ? 'puff' : 'persistent',
        particleCount: isInitialPuff ? 80 : undefined, // Much more particles for dramatic puff
        cloudCount: isInitialPuff ? undefined : 15,
        turbulenceStrength: 0.5,
        windDirection: { x: 0.15, y: -0.1 },
        color: effectData.config.color ? this.parseColor(effectData.config.color) : { r: 60, g: 60, b: 60 }
      });
    }

    switch (effectData.type) {
      case 'splat':
        return new SplatEffect(commonConfig);
      
      case 'confetti':
        return new ConfettiEffect({
          ...commonConfig,
          particleCount: effectData.config.particleCount || 50,
          colors: effectData.config.colors,
          spread: effectData.config.spread || 60
        });
      
      case 'particles':
        console.log('🔥 ENGINE: Creating particle effect with animation:', effectData.config.animation);
        // Check if this is a smoke-related particle effect
        if (effectData.config.animation === 'smoke-puff') {
          console.log('🔥 ENGINE: Creating SmokeEffect for smoke-puff!');
          return new SmokeEffect({
            ...commonConfig,
            effectType: 'puff',
            particleCount: effectData.config.particleCount || 40,
            turbulenceStrength: effectData.config.turbulence || 0.3,
            color: effectData.config.color ? this.parseColor(effectData.config.color) : undefined
          });
        }
        
        return new ParticleEffect({
          ...commonConfig,
          particleCount: effectData.config.particleCount || 50,
          colors: effectData.config.colors,
          animation: effectData.config.animation || 'default',
          startVelocity: effectData.config.startVelocity || 20
        });
      
      case 'disco':
        return new DiscoEffect({
          ...commonConfig,
          colors: effectData.config.colors || ['#ff00ff', '#00ff00', '#ffff00', '#00ffff'],
          rotationSpeed: effectData.config.rotationSpeed || 2.5,
          lightBeams: effectData.config.lightBeams || 16,
          glitterCount: effectData.config.glitterCount || 200,
          reflectionSpots: effectData.config.reflectionSpots || 30,
          colorCycleSpeed: effectData.config.colorCycleSpeed || 1.5,
          pulsate: effectData.config.pulsate !== false,
          glitterDensity: effectData.config.glitterDensity || 0.8,
          beamIntensity: effectData.config.beamIntensity || 0.8
        });
      
      case 'overlay':
        console.log('🔥 ENGINE: Creating overlay effect with animation:', effectData.config.animation, 'smokeClouds:', effectData.config.smokeClouds, 'full config:', effectData.config);
        // Check if this is a smoke-related overlay effect
        if (effectData.config.animation === 'smoke-fill') {
          console.log('🔥 ENGINE: Creating SmokeEffect for smoke-fill!');
          return new SmokeEffect({
            ...commonConfig,
            effectType: 'persistent',
            cloudCount: effectData.config.cloudCount || 12,
            turbulenceStrength: effectData.config.turbulence?.strength || 0.4,
            windDirection: { x: 0.1, y: -0.05 },
            color: effectData.config.color ? this.parseColor(effectData.config.color) : undefined
          });
        }
        
        return new OverlayEffect({
          ...commonConfig,
          overlayType: effectData.config.animation || effectData.config.overlayType,
          color: effectData.config.color,
          opacity: effectData.config.opacity,
          ...effectData.config
        });
      
      case 'freeze':
        // Freeze frame effect - pauses rendering temporarily
        this.applyFreezeEffect(effectData.config.freezeDuration || 1000);
        return null;
      
      case 'speedLines':
        return new ParticleEffect({
          ...commonConfig,
          particleCount: effectData.config.lineCount || 20,
          colors: [effectData.config.color || '#00ff00'],
          animation: 'speedLines'
        });
      
      case 'filter':
        return new OverlayEffect({
          ...commonConfig,
          filterType: effectData.config.filterType || 'rainbow'
        });
      
      case 'aura':
        return new OverlayEffect({
          ...commonConfig,
          overlayType: 'aura',
          color: effectData.config.color || '#ffd700'
        });
      
      case 'composite':
        // Create multiple effects for composite type
        if (effectData.config.effects) {
          effectData.config.effects.forEach((subEffect: string, index: number) => {
            const subEffectData = {
              ...effectData,
              id: `${effectData.id}_${subEffect}_${index}`,
              type: subEffect
            };
            this.triggerEffect(subEffectData);
          });
        }
        return null;
      
      case 'drawing':
        console.log('✏️ ENGINE: Creating DrawingEffect for drawing phase', effectData.config);
        // Check for shared drawing data key based on main effect ID
        // Use the full mainEffectId to ensure uniqueness per drawing session
        const drawingKey = effectData.mainEffectId || effectData.id;
        const existingDrawingData = this.sharedDrawingData.get(drawingKey);
        
        return new DrawingEffect({
          ...commonConfig,
          lineWidth: effectData.config.lineWidth || 3,
          lineColor: effectData.config.lineColor || effectData.config.default_color || '#FF0000',
          lineCap: effectData.config.lineCap || 'round',
          lineJoin: effectData.config.lineJoin || 'round',
          enableDrawing: effectData.config.enableDrawing !== false,
          opacity: effectData.config.opacity || 1.0,
          rainbowMode: effectData.config.rainbowMode || false,
          existingPaths: existingDrawingData || [],
          effectId: effectData.id,
          socket: this.socket
        });
      
      case 'static_drawing':
        console.log('✏️ ENGINE: Creating DrawingEffect for display phase');
        // Retrieve shared drawing data
        // Use the full mainEffectId to ensure uniqueness per drawing session
        const displayKey = effectData.mainEffectId || effectData.id;
        const sharedPaths = this.sharedDrawingData.get(displayKey) || [];
        console.log(`✏️ ENGINE: Display phase using ${sharedPaths.length} shared paths`);
        
        return new DrawingEffect({
          ...commonConfig,
          enableDrawing: false, // No drawing in display phase
          preserveDrawing: effectData.config.preserveDrawing !== false,
          fadeOut: effectData.config.fadeOut !== false,
          fadeOutDuration: effectData.config.fadeOutDuration || 2000,
          fadeStartDelay: effectData.config.fadeStartDelay || 8000,
          opacity: effectData.config.opacity || 1.0,
          rainbowMode: effectData.config.rainbowMode || false,
          existingPaths: sharedPaths, // Pass the shared paths to display phase
          effectId: effectData.id,
          socket: this.socket
        });
      
      default:
        console.warn(`⚠️ EffectEngine: Unknown effect type: ${effectData.type}`);
        console.warn(`🐛 DEBUG: Full effectData received by EffectEngine:`, effectData);
        return new ParticleEffect(commonConfig); // Default to particle effect
    }
  }

  private applyFreezeEffect(duration: number): void {
    // Pause the render loop temporarily
    const wasRunning = this.isRunning;
    if (wasRunning) {
      this.isRunning = false;
      
      // Draw a freeze overlay
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(100, 200, 255, 0.3)';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      
      // Add glitch lines
      for (let i = 0; i < 5; i++) {
        const y = Math.random() * this.canvas.height;
        const height = Math.random() * 10 + 2;
        this.ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.5})`;
        this.ctx.fillRect(0, y, this.canvas.width, height);
      }
      this.ctx.restore();
      
      // Resume after duration
      setTimeout(() => {
        this.isRunning = true;
        this.startRenderLoop();
      }, duration);
    }
  }

  private parseColor(colorStr: string): { r: number; g: number; b: number } | undefined {
    // Parse rgba(r, g, b, a) format
    const rgbaMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
    if (rgbaMatch) {
      return {
        r: parseInt(rgbaMatch[1]),
        g: parseInt(rgbaMatch[2]),
        b: parseInt(rgbaMatch[3])
      };
    }
    
    // Parse hex format
    const hexMatch = colorStr.match(/^#([a-f\d]{6})$/i);
    if (hexMatch) {
      const hex = hexMatch[1];
      return {
        r: parseInt(hex.substr(0, 2), 16),
        g: parseInt(hex.substr(2, 2), 16),
        b: parseInt(hex.substr(4, 2), 16)
      };
    }
    
    // Default to gray smoke
    return { r: 120, g: 120, b: 120 };
  }

  public removeEffect(effectId: string): void {
// console.log(`🧹 EffectEngine: Attempting to remove effect ${effectId}`);
// console.log(`🧹 EffectEngine: Effect exists in map:`, this.activeEffects.has(effectId));
// console.log(`🧹 EffectEngine: Current active effects:`, Array.from(this.activeEffects.keys()));
    
    if (this.activeEffects.has(effectId)) {
      const effect = this.activeEffects.get(effectId);
      if (effect) {
// console.log(`🧹 EffectEngine: Cleaning up effect ${effectId}`);
        
        // Save drawing data if this is a drawing effect
        if (effect instanceof DrawingEffect && effectId.includes('phase0')) {
          const drawingData = (effect as DrawingEffect).exportDrawingData();
          if (drawingData && drawingData.length > 0) {
            // Extract the main effect ID from phase ID (remove _phase0 suffix)
            const mainEffectId = effectId.replace(/_phase\d+$/, '');
            const dataKey = mainEffectId;
            
            console.log(`✏️ ENGINE: Saving ${drawingData.length} drawing paths with key ${dataKey}`);
            this.sharedDrawingData.set(dataKey, drawingData);
            
            // Clean up old data after 30 seconds
            setTimeout(() => {
              this.sharedDrawingData.delete(dataKey);
              console.log(`✏️ ENGINE: Cleaned up drawing data for ${dataKey}`);
            }, 30000);
          }
        }
        
        effect.cleanup();
      }
      this.activeEffects.delete(effectId);
      this.emit('effectCountChange', this.activeEffects.size);
// console.log(`🧹 EffectEngine: Removed effect ${effectId}. Remaining effects:`, this.activeEffects.size);
    } else {
      console.warn(`⚠️ EffectEngine: Attempted to remove non-existent effect ${effectId}`);
    }
  }

  public clearAllEffects(): void {
    this.activeEffects.forEach(effect => effect.cleanup());
    this.activeEffects.clear();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.emit('effectCountChange', 0);
// console.log('🧹 EffectEngine: Cleared all effects');
  }

  public clearEffectsByType(itemNames: string[]): void {
    const effectsToRemove: string[] = [];
    
    this.activeEffects.forEach((effect, effectId) => {
      // Check if this effect matches any of the item names to clear
      const effectData = (effect as any).effectData;
      if (effectData && itemNames.includes(effectData.itemName)) {
        effectsToRemove.push(effectId);
      }
    });

    // Remove the matching effects
    effectsToRemove.forEach(effectId => {
      const effect = this.activeEffects.get(effectId);
      if (effect) {
        effect.cleanup();
        this.activeEffects.delete(effectId);
      }
    });

    // Clear canvas if effects were removed
    if (effectsToRemove.length > 0) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.emit('effectCountChange', this.activeEffects.size);
      console.log(`🧹 EffectEngine: Cleared ${effectsToRemove.length} effects by type:`, itemNames);
    }
  }

  private startRenderLoop(): void {
// console.log(`🎬 EffectEngine: Starting render loop. Already running:`, this.isRunning);
    
    if (this.isRunning) {
// console.log(`🎬 EffectEngine: Render loop already running, skipping start`);
      return;
    }
    
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.fpsUpdateTime = this.lastFrameTime;
    this.frameCount = 0;
    
// console.log(`🎬 EffectEngine: Render loop started. Calling first renderFrame...`);
    this.renderFrame();
  }

  private renderFrame = (currentTime: number = performance.now()): void => {
    if (!this.isRunning) return;

    // Calculate delta time
    const deltaTime = currentTime - this.lastFrameTime;
    this.lastFrameTime = currentTime;
    
    // Update FPS counter
    this.frameCount++;
    if (currentTime - this.fpsUpdateTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsUpdateTime = currentTime;
      
      // Debug log every second when effects are active
      if (this.activeEffects.size > 0) {
// console.log(`🎨 EffectEngine: Rendering frame, active effects: ${this.activeEffects.size}, FPS: ${this.fps}`);
      }
    }
    
    // CRITICAL: Clear canvas with explicit transparency operations
    this.ctx.save();
    
    // Method 1: Clear with transparent composite operation
    this.ctx.globalCompositeOperation = 'copy';
    this.ctx.globalAlpha = 0;
    this.ctx.fillStyle = '#000000'; // Color doesn't matter with alpha=0
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    this.ctx.restore();
    
    // Method 2: Standard clear
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Method 3: Explicit transparent fill
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 0;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    
    // Log transparency debug info every 60 frames when effects are active
    if (this.activeEffects.size > 0 && this.frameCount % 60 === 0) {
      const pixelData = this.ctx.getImageData(0, 0, 1, 1).data;
      const centerPixel = this.ctx.getImageData(Math.floor(this.canvas.width/2), Math.floor(this.canvas.height/2), 1, 1).data;
      
// console.log('🔍 TRANSPARENCY DEBUG:', {
      //   canvasSize: `${this.canvas.width}x${this.canvas.height}`,
      //   cssSize: `${this.canvas.style.width} x ${this.canvas.style.height}`,
      //   canvasBackground: this.canvas.style.backgroundColor,
      //   canvasOpacity: this.canvas.style.opacity,
      //   contextAlpha: this.ctx.globalAlpha,
      //   contextComposite: this.ctx.globalCompositeOperation,
      //   topLeftPixel: `rgba(${pixelData[0]}, ${pixelData[1]}, ${pixelData[2]}, ${pixelData[3]})`,
      //   centerPixel: `rgba(${centerPixel[0]}, ${centerPixel[1]}, ${centerPixel[2]}, ${centerPixel[3]})`,
      //   hasAlphaChannel: !!this.ctx.getContextAttributes()?.alpha,
      //   canvasPosition: {
      //     left: this.canvas.offsetLeft,
      //     top: this.canvas.offsetTop,
      //     zIndex: this.canvas.style.zIndex || 'auto'
      //   },
      //   parentInfo: {
      //     className: this.canvas.parentElement?.className,
      //     background: this.canvas.parentElement ? window.getComputedStyle(this.canvas.parentElement).backgroundColor : 'none'
      //   }
      // });
    }
    
    // Render all active effects
    const completedEffects: string[] = [];
    
// console.log(`🎨 EffectEngine: Rendering ${this.activeEffects.size} active effects`);
    this.activeEffects.forEach((effect, id) => {
      try {
        effect.update(deltaTime);
        
        if (effect.isComplete()) {
          completedEffects.push(id);
// console.log(`🎨 EffectEngine: Effect ${id} completed`);
        } else {
// console.log(`🎨 EffectEngine: Rendering effect ${id} with canvas dimensions:`, {width: this.canvas.width, height: this.canvas.height});
          
          // Save context state before rendering
          this.ctx.save();
          effect.render(this.ctx, this.canvas.width, this.canvas.height);
          this.ctx.restore();
          
// console.log(`🎨 EffectEngine: Effect ${id} rendered successfully`);
        }
      } catch (error) {
        console.error(`❌ EffectEngine: Error rendering effect ${id}:`, error);
        completedEffects.push(id);
      }
    });
    
    // Remove completed effects
    completedEffects.forEach(id => this.removeEffect(id));
    
    // Continue animation loop
    this.animationId = requestAnimationFrame(this.renderFrame);
  };

  private forceCanvasResize(): void {
// console.log('🔄 EffectEngine: Forcing canvas resize to fix black mask issue');
    
    // Try multiple resize attempts with delays to handle async video loading
    const resizeAttempts = [0, 100, 500, 1000, 2000]; // milliseconds
    
    resizeAttempts.forEach(delay => {
      setTimeout(() => {
// console.log(`🔄 EffectEngine: Resize attempt after ${delay}ms`);
        const oldSize = { width: this.canvas.width, height: this.canvas.height };
        
        this.setupCanvas();
        this.initializeTransparentCanvas();
        
        const newSize = { width: this.canvas.width, height: this.canvas.height };
        
        if (oldSize.width !== newSize.width || oldSize.height !== newSize.height) {
// console.log(`📐 EffectEngine: Canvas resized from ${oldSize.width}x${oldSize.height} to ${newSize.width}x${newSize.height}`);
        }
      }, delay);
    });
  }

  public handleResize(): void {
    this.setupCanvas();
    this.initializeTransparentCanvas();
// console.log(`📐 EffectEngine: Canvas resized to ${this.canvas.width}x${this.canvas.height}`);
  }

  public setSocket(socket: any): void {
    this.socket = socket;
    console.log('🔌 EffectEngine: Socket connection set');
  }

  public handleRemoteDrawingPath(data: { effectId: string; path: any }): void {
    // Find the active drawing effect with matching ID
    this.activeEffects.forEach((effect, id) => {
      if (id === data.effectId && effect instanceof DrawingEffect) {
        console.log('✏️ ENGINE: Adding remote drawing path to effect', data.effectId);
        (effect as DrawingEffect).addPath(data.path);
      }
    });
  }

  public handleRemoteDrawingStart(data: { effectId: string; point: any; color: string; lineWidth: number }): void {
    // Find the active drawing effect with matching ID
    this.activeEffects.forEach((effect, id) => {
      if (id === data.effectId && effect instanceof DrawingEffect) {
        console.log('✏️ ENGINE: Adding drawing start point to effect', data.effectId);
        (effect as DrawingEffect).addDrawingStart(data);
      }
    });
  }

  public handleRemoteDrawingSegment(data: { effectId: string; segment: any }): void {
    // Find the active drawing effect with matching ID
    this.activeEffects.forEach((effect, id) => {
      if (id === data.effectId && effect instanceof DrawingEffect) {
        console.log('✏️ ENGINE: Adding real-time drawing segment to effect', data.effectId);
        (effect as DrawingEffect).addDrawingSegment(data.segment);
      }
    });
  }

  public cleanup(): void {
// console.log('🧹 EffectEngine: Cleaning up');
    
    // Stop animation loop
    this.isRunning = false;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    
    // Clear all effects
    this.clearAllEffects();
    
    // Direct event listeners are now managed by CanvasEffectOverlay component
    
    // Remove position tracking listeners
    const positionUpdater = (this.canvas as any).__positionUpdater;
    if (positionUpdater) {
      window.removeEventListener('resize', positionUpdater);
      window.removeEventListener('scroll', positionUpdater);
    }
    
    // Cancel any pending RAF updates
    const positionUpdateRAF = (this.canvas as any).__positionUpdateRAF;
    if (positionUpdateRAF) {
      positionUpdateRAF();
    }
    
    // Cleanup observers
    const resizeObserver = (this.canvas as any).__resizeObserver;
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    
    const mutationObserver = (this.canvas as any).__mutationObserver;
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    
    // Restore canvas to original container if moved
    const originalParent = (this.canvas as any).__originalParent;
    const originalPosition = (this.canvas as any).__originalPosition;
    
    if (originalParent && originalPosition) {
// console.log('🧹 Restoring canvas to original container');
      
      // Remove from document.body
      if (this.canvas.parentElement === document.body) {
        document.body.removeChild(this.canvas);
      }
      
      // Restore original positioning
      Object.assign(this.canvas.style, originalPosition);
      
      // Return to original parent
      originalParent.appendChild(this.canvas);
    }
    
    // Remove all event listeners
    this.removeAllListeners();
  }

  public getStats(): { fps: number; activeEffects: number } {
    return {
      fps: this.fps,
      activeEffects: this.activeEffects.size
    };
  }
}
