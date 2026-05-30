import { EventEmitter } from 'events';
import { SplatEffect } from './effects/SplatEffect';
import { ParticleEffect } from './effects/ParticleEffect';
import { OverlayEffect } from './effects/OverlayEffect';
import { ConfettiEffect } from './effects/ConfettiEffect';
import { DiscoEffect } from './effects/DiscoEffect';
import { SmokeEffect } from './effects/SmokeEffect';
import { DrawingEffect } from './effects/DrawingEffect';
import { ProjectileEffect } from './effects/ProjectileEffect';
import { FireEffect } from './effects/FireEffect';
import { PsychedelicEffect } from './effects/PsychedelicEffect';
import { BugsEffect } from './effects/BugsEffect';
import { RainEffect } from './effects/RainEffect';
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
    
    // DISABLED: Moving canvas to document.body causes issues on mobile
    // The canvas should stay within its container for proper stacking
    // this.escapeContainerContext();
    
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
    // Get the parent container first (most reliable for viewbot streams)
    const parentElement = this.canvas.parentElement;
    const parentRect = parentElement?.getBoundingClientRect();
    
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
    
    // Prioritize parent container dimensions (most reliable for viewbot streams)
    let width = parentRect?.width || 0;
    let height = parentRect?.height || 0;
    
    // Fall back to video element rect if parent not available or too small
    if (width <= 100 || height <= 100) {
      width = rect.width;
      height = rect.height;
    }
    
    // Then try computed style dimensions
    if (width <= 0) width = styleWidth;
    if (height <= 0) height = styleHeight;
    
    // Then try video element client dimensions
    if (width <= 0) width = this.videoElement.clientWidth;
    if (height <= 0) height = this.videoElement.clientHeight;
    
    // Then try video element offset dimensions
    if (width <= 0) width = this.videoElement.offsetWidth;
    if (height <= 0) height = this.videoElement.offsetHeight;
    
    // Fallback to reasonable defaults if all else fails - match CanvasEffectOverlay defaults
    if (width <= 0) width = 800;
    if (height <= 0) height = 600;
    
// console.log('🎨 EffectEngine: Setting canvas dimensions to:', {width, height});
    this.canvas.width = width;
    this.canvas.height = height;
    
    // CRITICAL: Set CSS dimensions to 100% to fill the parent container
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    
    // Ensure canvas is properly positioned
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    
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

  private createTransparentContext(): CanvasRenderingContext2D | null {
// console.log('🎨 EffectEngine: Creating transparent canvas context...');
    
    // Use simple alpha: true for best mobile compatibility
    // Complex options can cause issues on mobile browsers
    const ctx = this.canvas.getContext('2d', { 
      alpha: true,
      // Avoid desynchronized on mobile as it can cause rendering issues
      desynchronized: false
    }) as CanvasRenderingContext2D | null;
    
    if (ctx) {
// console.log('✅ EffectEngine: Successfully created context with alpha support');
      
      // Ensure transparency is properly set
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      
      return ctx;
    }
    
    console.error('❌ EffectEngine: Failed to create transparent context after all attempts');
    // Return basic context as fallback
    return this.canvas.getContext('2d', { alpha: true });
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
      // console.log(`🎬 ENGINE: triggerEffect called with:`, {
      //   itemName: effectData.itemName,
      //   type: effectData.type,
      //   id: effectData.id
      // });
      
      if (effectData.itemName === 'smoke_bomb') {
        // console.log(`🔥 ENGINE: Triggering smoke bomb effect - ${effectData.config.phaseName || effectData.type}`);
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
      // console.log('🔥 ENGINE: FORCING SmokeEffect for smoke_bomb item!');
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
      
      case 'fart_clouds':
        // Fart clouds effect - massive cartoonish green clouds
        return new ParticleEffect({
          ...commonConfig,
          duration: 12000, // Last 12 seconds
          particleCount: 20, // Lots of clouds for maximum effect
          colors: ['#6B8E23', '#556B2F', '#8FBC8F', '#9ACD32', '#7CFC00'], // Various green shades
          animation: 'float-up', // Clouds float upward
          startVelocity: 4, // Very slow for massive clouds
          gravity: -0.012, // Very gentle upward float
          fadeOut: true,
          particleSize: { min: 200, max: 350 }, // Massive cloud sizes (200-350px)
          spread: 200, // Very wide spread for massive clouds
          opacity: 0.45 // Semi-transparent clouds
        });
      
      case 'thunderstorm_rain':
        // Thunderstorm effect - rain and lightning
        return new RainEffect({
          ...commonConfig,
          duration: 68000, // 68 seconds to match sound effect
          rainIntensity: 200, // Number of raindrops
          opacity: 0.8
        });
      
      case 'particles':
        // console.log('🔥 ENGINE: Creating particle effect with animation:', effectData.config.animation);
        // Check if this is a smoke-related particle effect
        if (effectData.config.animation === 'smoke-puff') {
          // console.log('🔥 ENGINE: Creating SmokeEffect for smoke-puff!');
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
        // console.log('🔥 ENGINE: Creating overlay effect with animation:', effectData.config.animation, 'smokeClouds:', effectData.config.smokeClouds, 'full config:', effectData.config);
        // Check if this is a smoke-related overlay effect
        if (effectData.config.animation === 'smoke-fill') {
          // console.log('🔥 ENGINE: Creating SmokeEffect for smoke-fill!');
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
        // console.log('✏️ ENGINE: Creating DrawingEffect for drawing phase', effectData.config);
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
        // console.log('✏️ ENGINE: Creating DrawingEffect for display phase');
        // Retrieve shared drawing data
        // Use the full mainEffectId to ensure uniqueness per drawing session
        const displayKey = effectData.mainEffectId || effectData.id;
        const sharedPaths = this.sharedDrawingData.get(displayKey) || [];
        // console.log(`✏️ ENGINE: Display phase using ${sharedPaths.length} shared paths`);
        
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
      
      case 'projectile':
        // console.log('🏹 ENGINE: Creating ProjectileEffect', effectData.config);
        return new ProjectileEffect({
          ...commonConfig,
          config: effectData.config
        });
      
      case 'fire':
        // console.log('🔥 ENGINE: Creating FireEffect', effectData.config);
        return new FireEffect({
          ...commonConfig,
          config: effectData.config
        });
      
      case 'psychedelic':
        // console.log('🌈 ENGINE: Creating PsychedelicEffect', effectData.config);
        return new PsychedelicEffect({
          ...commonConfig,
          config: effectData.config
        });
      
      case 'bugs':
        // console.log('🐛 ENGINE: Creating BugsEffect', effectData.config);
        return new BugsEffect({
          ...commonConfig,
          config: effectData.config
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
            
            // console.log(`✏️ ENGINE: Saving ${drawingData.length} drawing paths with key ${dataKey}`);
            this.sharedDrawingData.set(dataKey, drawingData);
            
            // Clean up old data after 30 seconds
            setTimeout(() => {
              this.sharedDrawingData.delete(dataKey);
              // console.log(`✏️ ENGINE: Cleaned up drawing data for ${dataKey}`);
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
      // console.log(`🧹 EffectEngine: Cleared ${effectsToRemove.length} effects by type:`, itemNames);
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
    
    // CRITICAL: Clear canvas properly for mobile compatibility
    // Use standard clearRect which works best on mobile browsers
    // The multiple clear methods were causing black overlay on mobile
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    
    // CPU Optimization: Removed debug getImageData() calls
    // getImageData() reads pixels from GPU which is extremely expensive
    // Only enable in development mode if needed for debugging
    
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

    // CPU Optimization: Stop render loop when no effects are active
    // The loop will restart automatically when a new effect is added
    if (this.activeEffects.size === 0) {
      this.isRunning = false;
      if (this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      return;
    }

    // Continue animation loop
    this.animationId = requestAnimationFrame(this.renderFrame);
  };

  private forceCanvasResize(): void {
    // CPU Optimization: Removed 5x setTimeout cascade (was 0, 100, 500, 1000, 2000ms)
    // Now uses single immediate call + ResizeObserver for async video loading

    // Immediate resize attempt
    this.setupCanvas();
    this.initializeTransparentCanvas();

    // If dimensions are still 0, set up a ResizeObserver to detect when video loads
    if (this.canvas.width === 0 || this.canvas.height === 0) {
      if ('ResizeObserver' in window) {
        const resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
              this.setupCanvas();
              this.initializeTransparentCanvas();
              // Start render loop if not already running
              if (!this.isRunning && this.canvas.width > 0 && this.canvas.height > 0) {
                this.startRenderLoop();
              }
              resizeObserver.disconnect();
              break;
            }
          }
        });
        resizeObserver.observe(this.videoElement);
      } else {
        // Fallback: single retry after 500ms for browsers without ResizeObserver
        setTimeout(() => {
          this.setupCanvas();
          this.initializeTransparentCanvas();
          if (!this.isRunning && this.canvas.width > 0 && this.canvas.height > 0) {
            this.startRenderLoop();
          }
        }, 500);
      }
    }
  }

  public handleResize(): void {
    this.setupCanvas();
    this.initializeTransparentCanvas();
// console.log(`📐 EffectEngine: Canvas resized to ${this.canvas.width}x${this.canvas.height}`);
  }

  public setSocket(socket: any): void {
    this.socket = socket;
    // console.log('🔌 EffectEngine: Socket connection set');
  }

  public handleRemoteDrawingPath(data: { effectId: string; path: any }): void {
    // Find the active drawing effect with matching ID
    this.activeEffects.forEach((effect, id) => {
      if (id === data.effectId && effect instanceof DrawingEffect) {
        // console.log('✏️ ENGINE: Adding remote drawing path to effect', data.effectId);
        (effect as DrawingEffect).addPath(data.path);
      }
    });
  }

  public handleRemoteDrawingStart(data: { effectId: string; point: any; color: string; lineWidth: number }): void {
    // Find the active drawing effect with matching ID
    this.activeEffects.forEach((effect, id) => {
      if (id === data.effectId && effect instanceof DrawingEffect) {
        // console.log('✏️ ENGINE: Adding drawing start point to effect', data.effectId);
        (effect as DrawingEffect).addDrawingStart(data);
      }
    });
  }

  public handleRemoteDrawingSegment(data: { effectId: string; segment: any }): void {
    // Find the active drawing effect with matching ID
    this.activeEffects.forEach((effect, id) => {
      if (id === data.effectId && effect instanceof DrawingEffect) {
        // console.log('✏️ ENGINE: Adding real-time drawing segment to effect', data.effectId);
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
