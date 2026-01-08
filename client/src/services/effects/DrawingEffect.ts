import { BaseEffect, EffectConfig } from './BaseEffect';

export interface DrawingPath {
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
  timestamp: number;
}

export interface DrawingEffectConfig extends EffectConfig {
  lineWidth?: number;
  lineColor?: string;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
  enableDrawing?: boolean;
  preserveDrawing?: boolean;
  fadeOut?: boolean;
  fadeOutDuration?: number;
  fadeStartDelay?: number;
  opacity?: number;
  existingPaths?: DrawingPath[]; // For importing paths from previous phase
  effectId?: string; // Effect ID for broadcasting
  socket?: any; // Socket instance for real-time sync
  rainbowMode?: boolean; // Enable rainbow coloring
}

export class DrawingEffect extends BaseEffect {
  private paths: DrawingPath[] = [];
  private currentPath: DrawingPath | null = null;
  private lineWidth: number;
  private lineColor: string;
  private lineCap: CanvasLineCap;
  private lineJoin: CanvasLineJoin;
  private enableDrawing: boolean;
  private preserveDrawing: boolean;
  private fadeOut: boolean;
  private fadeOutDuration: number;
  private fadeStartDelay: number;
  private baseOpacity: number;
  private isDrawing: boolean = false;
  private drawingCanvas: HTMLCanvasElement | null = null;
  private drawingCtx: CanvasRenderingContext2D | null = null;
  private mouseDownHandler: ((e: MouseEvent) => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseUpHandler: ((e: MouseEvent) => void) | null = null;
  private touchStartHandler: ((e: TouchEvent) => void) | null = null;
  private touchMoveHandler: ((e: TouchEvent) => void) | null = null;
  private touchEndHandler: ((e: TouchEvent) => void) | null = null;
  private effectId: string;
  private socket: any; // Socket.io instance for broadcasting
  private rainbowMode: boolean;
  private rainbowHue: number = 0; // Current hue for rainbow mode

  constructor(config: DrawingEffectConfig) {
    super(config);
    this.lineWidth = config.lineWidth || 3;
    this.lineColor = config.lineColor || '#FF0000';
    this.lineCap = config.lineCap || 'round';
    this.lineJoin = config.lineJoin || 'round';
    this.enableDrawing = config.enableDrawing !== false;
    this.preserveDrawing = config.preserveDrawing !== false;
    this.fadeOut = config.fadeOut || false;
    this.fadeOutDuration = config.fadeOutDuration || 2000;
    this.fadeStartDelay = config.fadeStartDelay || 8000;
    this.baseOpacity = config.opacity || 1.0;
    this.effectId = config.effectId || `drawing_${Date.now()}`;
    this.socket = config.socket || null;
    this.rainbowMode = config.rainbowMode || false;
    
    // Import existing paths if provided (for display phase)
    if (config.existingPaths && config.existingPaths.length > 0) {
      this.paths = [...config.existingPaths];
      // console.log(`✏️ DrawingEffect: Imported ${this.paths.length} existing paths`);
    }
    
    // Create offscreen canvas for persistent drawing
    this.drawingCanvas = document.createElement('canvas');
    this.drawingCanvas.width = this.canvas.width;
    this.drawingCanvas.height = this.canvas.height;
    this.drawingCtx = this.drawingCanvas.getContext('2d', { alpha: true });
    
    // Draw imported paths onto the offscreen canvas
    if (this.paths.length > 0 && this.drawingCtx) {
      this.redrawAllPaths();
    }
    
    if (this.enableDrawing) {
      this.setupDrawingListeners();
    }
    
    // console.log('✏️ DrawingEffect: Initialized with drawing enabled:', this.enableDrawing);
  }

  private setupDrawingListeners(): void {
    // console.log('✏️ DrawingEffect: Setting up drawing listeners on canvas:', this.canvas);
    
    // The canvas already exists and is positioned correctly by EffectEngine
    // We just need to temporarily enable pointer events like click-to-throw does
    this.canvas.style.pointerEvents = 'auto';
    this.canvas.style.cursor = 'crosshair';
    
    // Also check parent container
    const parent = this.canvas.parentElement;
    if (parent && parent.classList.contains('canvas-effect-overlay-container')) {
      parent.style.pointerEvents = 'auto';
    }
    
    // Mouse events
    this.mouseDownHandler = (e: MouseEvent) => {
      // console.log('✏️ DrawingEffect: Mouse down event', e);
      this.startDrawing(e.clientX, e.clientY);
    };
    this.mouseMoveHandler = (e: MouseEvent) => {
      if (this.isDrawing) {
        this.draw(e.clientX, e.clientY);
      }
    };
    this.mouseUpHandler = () => {
      if (this.isDrawing) {
        // console.log('✏️ DrawingEffect: Mouse up event');
        this.stopDrawing();
      }
    };
    
    // Touch events with passive: false for preventDefault to work
    this.touchStartHandler = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      // console.log('✏️ DrawingEffect: Touch start event', touch);
      this.startDrawing(touch.clientX, touch.clientY);
    };
    this.touchMoveHandler = (e: TouchEvent) => {
      e.preventDefault();
      if (this.isDrawing && e.touches[0]) {
        const touch = e.touches[0];
        this.draw(touch.clientX, touch.clientY);
      }
    };
    this.touchEndHandler = (e: TouchEvent) => {
      e.preventDefault();
      if (this.isDrawing) {
        // console.log('✏️ DrawingEffect: Touch end event');
        this.stopDrawing();
      }
    };
    
    // Add listeners to the main canvas with options
    this.canvas.addEventListener('mousedown', this.mouseDownHandler);
    this.canvas.addEventListener('mousemove', this.mouseMoveHandler);
    this.canvas.addEventListener('mouseup', this.mouseUpHandler);
    this.canvas.addEventListener('mouseleave', this.mouseUpHandler);
    
    // Use passive: false for touch events to allow preventDefault
    this.canvas.addEventListener('touchstart', this.touchStartHandler, { passive: false });
    this.canvas.addEventListener('touchmove', this.touchMoveHandler, { passive: false });
    this.canvas.addEventListener('touchend', this.touchEndHandler, { passive: false });
    this.canvas.addEventListener('touchcancel', this.touchEndHandler, { passive: false });
    
    // console.log('✏️ DrawingEffect: Canvas setup complete. Canvas dimensions:', {
    //   width: this.canvas.width,
    //   height: this.canvas.height,
    //   clientWidth: this.canvas.clientWidth,
    //   clientHeight: this.canvas.clientHeight,
    //   pointerEvents: this.canvas.style.pointerEvents,
    //   parentPointerEvents: this.canvas.parentElement?.style.pointerEvents
    // });
  }

  private startDrawing(clientX: number, clientY: number): void {
    if (!this.enableDrawing || this.elapsed > 10000) return; // Only allow drawing in first 10 seconds
    
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    
    // Get current color (rainbow or static)
    const currentColor = this.rainbowMode ? this.getRainbowColor() : this.lineColor;
    
    this.isDrawing = true;
    this.currentPath = {
      points: [{ x, y }],
      color: currentColor,
      lineWidth: this.lineWidth,
      timestamp: Date.now()
    };
    
    // console.log('✏️ DrawingEffect: Started drawing at', { x, y }, 'with color', currentColor);
    
    // Broadcast the drawing start point to all viewers
    if (this.socket && this.enableDrawing) {
      this.socket.emit('drawing-path-start', {
        effectId: this.effectId,
        point: { x, y },
        color: currentColor,
        lineWidth: this.lineWidth
      });
    }
  }

  private draw(clientX: number, clientY: number): void {
    if (!this.isDrawing || !this.currentPath || !this.enableDrawing || this.elapsed > 10000) return;
    
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    
    this.currentPath.points.push({ x, y });
    
    // Draw the new segment immediately on the offscreen canvas
    if (this.drawingCtx && this.currentPath.points.length > 1) {
      const prevPoint = this.currentPath.points[this.currentPath.points.length - 2];
      const currPoint = this.currentPath.points[this.currentPath.points.length - 1];
      
      // Get current color (rainbow mode updates continuously)
      const segmentColor = this.rainbowMode ? this.getRainbowColor() : this.currentPath.color;
      
      this.drawingCtx.save();
      this.drawingCtx.strokeStyle = segmentColor;
      this.drawingCtx.lineWidth = this.currentPath.lineWidth;
      this.drawingCtx.lineCap = this.lineCap;
      this.drawingCtx.lineJoin = this.lineJoin;
      
      this.drawingCtx.beginPath();
      this.drawingCtx.moveTo(prevPoint.x * this.drawingCanvas!.width, prevPoint.y * this.drawingCanvas!.height);
      this.drawingCtx.lineTo(currPoint.x * this.drawingCanvas!.width, currPoint.y * this.drawingCanvas!.height);
      this.drawingCtx.stroke();
      this.drawingCtx.restore();
      
      // Update path color for current segment in rainbow mode
      if (this.rainbowMode) {
        this.currentPath.color = segmentColor;
      }
      
      // Broadcast the drawing update in real-time to all viewers
      if (this.socket && this.enableDrawing) {
        this.socket.emit('drawing-path-update', {
          effectId: this.effectId,
          segment: {
            from: prevPoint,
            to: currPoint,
            color: segmentColor,
            lineWidth: this.currentPath.lineWidth
          }
        });
      }
    }
  }

  private stopDrawing(): void {
    if (!this.isDrawing || !this.currentPath) return;
    
    this.isDrawing = false;
    if (this.currentPath.points.length > 1) {
      this.paths.push(this.currentPath);
      // console.log('✏️ DrawingEffect: Completed path with', this.currentPath.points.length, 'points');
      
      // Broadcast the completed path to all viewers
      if (this.socket && this.enableDrawing) {
        // console.log('✏️ DrawingEffect: Broadcasting path to all viewers');
        this.socket.emit('drawing-path-complete', {
          effectId: this.effectId,
          path: this.currentPath
        });
      }
    }
    this.currentPath = null;
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    // Update rainbow hue in rainbow mode
    if (this.rainbowMode) {
      this.rainbowHue = (this.rainbowHue + deltaTime * 0.1) % 360; // Cycle through colors
    }
    
    // Disable drawing after 10 seconds
    if (this.elapsed > 10000 && this.enableDrawing) {
      this.enableDrawing = false;
      this.removeDrawingListeners();
      // console.log('✏️ DrawingEffect: Drawing phase ended, entering display phase');
    }
    
    // Handle fade out in display phase
    if (this.fadeOut && this.elapsed > this.fadeStartDelay) {
      const fadeProgress = (this.elapsed - this.fadeStartDelay) / this.fadeOutDuration;
      this.alpha = this.baseOpacity * (1 - Math.min(fadeProgress, 1));
    } else {
      this.alpha = this.baseOpacity;
    }
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.paths.length === 0 && !this.currentPath) return;
    
    // Resize offscreen canvas if needed
    if (this.drawingCanvas && (this.drawingCanvas.width !== width || this.drawingCanvas.height !== height)) {
      const imageData = this.drawingCtx?.getImageData(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
      this.drawingCanvas.width = width;
      this.drawingCanvas.height = height;
      if (imageData && this.drawingCtx) {
        this.drawingCtx.putImageData(imageData, 0, 0);
      }
    }
    
    ctx.save();
    ctx.globalAlpha = this.alpha;
    
    // Draw the offscreen canvas onto the main canvas
    if (this.drawingCanvas) {
      ctx.drawImage(this.drawingCanvas, 0, 0, width, height);
    }
    
    // Draw current path if actively drawing
    if (this.isDrawing && this.currentPath && this.currentPath.points.length > 1) {
      ctx.strokeStyle = this.currentPath.color;
      ctx.lineWidth = this.currentPath.lineWidth;
      ctx.lineCap = this.lineCap;
      ctx.lineJoin = this.lineJoin;
      
      ctx.beginPath();
      for (let i = 0; i < this.currentPath.points.length; i++) {
        const point = this.currentPath.points[i];
        const x = point.x * width;
        const y = point.y * height;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    
    ctx.restore();
  }

  private removeDrawingListeners(): void {
    if (this.mouseDownHandler) {
      this.canvas.removeEventListener('mousedown', this.mouseDownHandler);
      this.canvas.removeEventListener('mousemove', this.mouseMoveHandler!);
      this.canvas.removeEventListener('mouseup', this.mouseUpHandler!);
      this.canvas.removeEventListener('mouseleave', this.mouseUpHandler!);
    }
    
    if (this.touchStartHandler) {
      this.canvas.removeEventListener('touchstart', this.touchStartHandler);
      this.canvas.removeEventListener('touchmove', this.touchMoveHandler!);
      this.canvas.removeEventListener('touchend', this.touchEndHandler!);
      this.canvas.removeEventListener('touchcancel', this.touchEndHandler!);
    }
    
    // Restore canvas to default state (let EffectEngine manage it)
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.cursor = '';
    
    // Also restore parent container
    const parent = this.canvas.parentElement;
    if (parent && parent.classList.contains('canvas-effect-overlay-container')) {
      parent.style.pointerEvents = 'none';
    }
    
    // console.log('✏️ DrawingEffect: Removed drawing listeners and restored pointer events');
  }

  public cleanup(): void {
    this.removeDrawingListeners();
    this.drawingCanvas = null;
    this.drawingCtx = null;
    this.paths = [];
    this.currentPath = null;
  }

  // Export drawing data for persistence between phases
  public exportDrawingData(): DrawingPath[] {
    return [...this.paths];
  }
  
  // Import drawing data from another effect
  public importDrawingData(paths: DrawingPath[]): void {
    this.paths = [...this.paths, ...paths];
    if (this.drawingCtx) {
      this.redrawAllPaths();
    }
  }
  
  // Redraw all paths onto the offscreen canvas
  private redrawAllPaths(): void {
    if (!this.drawingCtx || !this.drawingCanvas) return;
    
    // Clear canvas first
    this.drawingCtx.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
    
    // Redraw all paths
    for (const path of this.paths) {
      if (path.points.length > 1) {
        this.drawingCtx.save();
        this.drawingCtx.strokeStyle = path.color;
        this.drawingCtx.lineWidth = path.lineWidth;
        this.drawingCtx.lineCap = this.lineCap;
        this.drawingCtx.lineJoin = this.lineJoin;
        
        this.drawingCtx.beginPath();
        for (let i = 0; i < path.points.length; i++) {
          const point = path.points[i];
          const x = point.x * this.drawingCanvas.width;
          const y = point.y * this.drawingCanvas.height;
          
          if (i === 0) {
            this.drawingCtx.moveTo(x, y);
          } else {
            this.drawingCtx.lineTo(x, y);
          }
        }
        this.drawingCtx.stroke();
        this.drawingCtx.restore();
      }
    }
  }
  
  // Method to add drawing data from other users (for multiplayer drawing)
  public addPath(path: DrawingPath): void {
    this.paths.push(path);
    
    // Draw the path on the offscreen canvas
    if (this.drawingCtx && path.points.length > 1) {
      this.drawingCtx.save();
      this.drawingCtx.strokeStyle = path.color;
      this.drawingCtx.lineWidth = path.lineWidth;
      this.drawingCtx.lineCap = this.lineCap;
      this.drawingCtx.lineJoin = this.lineJoin;
      
      this.drawingCtx.beginPath();
      for (let i = 0; i < path.points.length; i++) {
        const point = path.points[i];
        const x = point.x * this.drawingCanvas!.width;
        const y = point.y * this.drawingCanvas!.height;
        
        if (i === 0) {
          this.drawingCtx.moveTo(x, y);
        } else {
          this.drawingCtx.lineTo(x, y);
        }
      }
      this.drawingCtx.stroke();
      this.drawingCtx.restore();
    }
  }
  
  // Method to add a drawing start point from remote user
  public addDrawingStart(data: { point: { x: number; y: number }; color: string; lineWidth: number }): void {
    // Draw a small dot at the start point to make it visible immediately
    if (this.drawingCtx && this.drawingCanvas) {
      this.drawingCtx.save();
      this.drawingCtx.fillStyle = data.color;
      this.drawingCtx.beginPath();
      this.drawingCtx.arc(
        data.point.x * this.drawingCanvas.width,
        data.point.y * this.drawingCanvas.height,
        data.lineWidth / 2,
        0,
        Math.PI * 2
      );
      this.drawingCtx.fill();
      this.drawingCtx.restore();
    }
  }
  
  // Method to add a real-time drawing segment from remote user
  public addDrawingSegment(segment: { from: { x: number; y: number }; to: { x: number; y: number }; color: string; lineWidth: number }): void {
    // Draw the segment immediately on the offscreen canvas
    if (this.drawingCtx && this.drawingCanvas) {
      this.drawingCtx.save();
      this.drawingCtx.strokeStyle = segment.color;
      this.drawingCtx.lineWidth = segment.lineWidth;
      this.drawingCtx.lineCap = this.lineCap;
      this.drawingCtx.lineJoin = this.lineJoin;
      
      this.drawingCtx.beginPath();
      this.drawingCtx.moveTo(segment.from.x * this.drawingCanvas.width, segment.from.y * this.drawingCanvas.height);
      this.drawingCtx.lineTo(segment.to.x * this.drawingCanvas.width, segment.to.y * this.drawingCanvas.height);
      this.drawingCtx.stroke();
      this.drawingCtx.restore();
    }
  }
  
  // Get current rainbow color based on hue
  private getRainbowColor(): string {
    // Convert HSL to RGB for rainbow effect
    const hue = this.rainbowHue;
    const saturation = 100; // Full saturation for vibrant colors
    const lightness = 50; // Medium lightness for good visibility
    
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }
}