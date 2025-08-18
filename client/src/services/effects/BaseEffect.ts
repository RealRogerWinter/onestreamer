export interface EffectConfig {
  id: string;
  position: { x: number; y: number };
  duration: number;
  canvas: HTMLCanvasElement;
  [key: string]: any;
}

export abstract class BaseEffect {
  protected id: string;
  protected position: { x: number; y: number };
  protected duration: number;
  protected startTime: number;
  protected elapsed: number;
  protected canvas: HTMLCanvasElement;
  protected complete: boolean;
  protected alpha: number;

  constructor(config: EffectConfig) {
    this.id = config.id;
    this.position = config.position;
    this.duration = config.duration;
    this.canvas = config.canvas;
    this.startTime = performance.now();
    this.elapsed = 0;
    this.complete = false;
    this.alpha = 1;
    
    // console.log(`🎯 BaseEffect: Created effect with position:`, this.position, config.position);
  }

  public update(deltaTime: number): void {
    this.elapsed += deltaTime;
    
    // Calculate progress (0 to 1)
    const progress = Math.min(this.elapsed / this.duration, 1);
    
    // Fade out in the last 20% of duration
    if (progress > 0.8) {
      this.alpha = 1 - ((progress - 0.8) / 0.2);
    }
    
    // Mark as complete when duration is reached
    if (this.elapsed >= this.duration) {
      this.complete = true;
    }
    
    // Call subclass update
    this.updateEffect(deltaTime, progress);
  }

  protected abstract updateEffect(deltaTime: number, progress: number): void;

  public abstract render(ctx: CanvasRenderingContext2D, width: number, height: number): void;

  public isComplete(): boolean {
    return this.complete;
  }

  public cleanup(): void {
    // Override in subclasses if needed
  }

  // Utility methods
  protected getAbsolutePosition(width: number, height: number): { x: number; y: number } {
    const result = {
      x: this.position.x * width,
      y: this.position.y * height
    };
    // console.log(`🎯 BaseEffect: getAbsolutePosition - relative:`, this.position, `canvas:`, {width, height}, `absolute:`, result);
    return result;
  }

  protected easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  protected easeInOutQuad(t: number): number {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  protected randomInRange(min: number, max: number): number {
    return Math.random() * (max - min) + min;
  }
}