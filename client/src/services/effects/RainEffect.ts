import { BaseEffect } from './BaseEffect';

interface Raindrop {
  x: number;
  y: number;
  length: number;
  speed: number;
  opacity: number;
  width: number;
}

interface Lightning {
  x: number;
  y: number;
  width: number;
  height: number;
  branches: Array<{x: number, y: number}>;
  opacity: number;
  duration: number;
  startTime: number;
}

export class RainEffect extends BaseEffect {
  private raindrops: Raindrop[] = [];
  private lightning: Lightning[] = [];
  private nextLightningTime: number = 0;
  private thunderSound: boolean = false;
  private rainIntensity: number = 200; // Number of raindrops
  protected opacity: number = 1;
  
  constructor(config: any = {}) {
    super(config);
    this.rainIntensity = config.rainIntensity || 200;
    this.opacity = config.opacity || 0.8;
    this.initRain();
  }

  private initRain() {
    // Initialize raindrops
    for (let i = 0; i < this.rainIntensity; i++) {
      this.raindrops.push(this.createRaindrop(true));
    }
    
    // Schedule first lightning
    this.nextLightningTime = Date.now() + Math.random() * 3000 + 2000;
  }

  private createRaindrop(initial: boolean = false): Raindrop {
    const canvas = this.getCanvasSize();
    return {
      x: Math.random() * canvas.width,
      y: initial ? Math.random() * canvas.height : -20,
      length: Math.random() * 20 + 10,
      speed: Math.random() * 10 + 15,
      opacity: Math.random() * 0.3 + 0.3,
      width: Math.random() * 2 + 1
    };
  }

  private createLightning(): Lightning {
    const canvas = this.getCanvasSize();
    const x = Math.random() * canvas.width;
    const branches: Array<{x: number, y: number}> = [];
    
    // Create jagged lightning path
    let currentX = x;
    let currentY = 0;
    const segments = Math.floor(Math.random() * 4 + 3);
    
    for (let i = 0; i < segments; i++) {
      currentY += canvas.height / segments;
      currentX += (Math.random() - 0.5) * 100;
      branches.push({ x: currentX, y: currentY });
    }
    
    return {
      x: x,
      y: 0,
      width: Math.random() * 3 + 2,
      height: canvas.height,
      branches: branches,
      opacity: 1,
      duration: 150, // Lightning lasts 150ms
      startTime: Date.now()
    };
  }

  private getCanvasSize() {
    // Get canvas dimensions, default to common size
    return {
      width: this.canvas?.width || 1920,
      height: this.canvas?.height || 1080
    };
  }

  updateEffect(deltaTime: number, progress: number) {
    const canvas = this.getCanvasSize();
    const now = Date.now();
    
    // Update raindrops
    for (let i = 0; i < this.raindrops.length; i++) {
      const drop = this.raindrops[i];
      drop.y += drop.speed * (deltaTime / 16);
      
      // Reset raindrop if it goes off screen
      if (drop.y > canvas.height + drop.length) {
        this.raindrops[i] = this.createRaindrop();
      }
    }
    
    // Check if it's time for lightning
    if (now >= this.nextLightningTime) {
      this.lightning.push(this.createLightning());
      // Schedule next lightning (random interval between 2-8 seconds)
      this.nextLightningTime = now + Math.random() * 6000 + 2000;
    }
    
    // Update lightning (fade out and remove old ones)
    this.lightning = this.lightning.filter(bolt => {
      const elapsed = now - bolt.startTime;
      if (elapsed > bolt.duration) {
        return false;
      }
      bolt.opacity = 1 - (elapsed / bolt.duration);
      return true;
    });
  }

  render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.opacity <= 0) return;
    
    ctx.save();
    ctx.globalAlpha = this.opacity;
    
    // Draw rain
    ctx.strokeStyle = 'rgba(150, 180, 255, 0.6)';
    ctx.lineWidth = 1;
    
    for (const drop of this.raindrops) {
      ctx.save();
      ctx.globalAlpha = drop.opacity * this.opacity;
      ctx.strokeStyle = `rgba(150, 180, 255, ${drop.opacity})`;
      ctx.lineWidth = drop.width;
      ctx.beginPath();
      ctx.moveTo(drop.x, drop.y);
      ctx.lineTo(drop.x - 2, drop.y + drop.length);
      ctx.stroke();
      ctx.restore();
    }
    
    // Draw lightning
    for (const bolt of this.lightning) {
      ctx.save();
      
      // Draw main lightning bolt
      ctx.globalAlpha = bolt.opacity * this.opacity;
      ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
      ctx.lineWidth = bolt.width;
      ctx.shadowColor = 'rgba(200, 200, 255, 1)';
      ctx.shadowBlur = 20;
      
      ctx.beginPath();
      ctx.moveTo(bolt.x, bolt.y);
      
      for (const branch of bolt.branches) {
        ctx.lineTo(branch.x, branch.y);
      }
      
      ctx.stroke();
      
      // Draw lightning glow
      ctx.strokeStyle = 'rgba(200, 200, 255, 0.5)';
      ctx.lineWidth = bolt.width * 3;
      ctx.shadowBlur = 40;
      
      ctx.beginPath();
      ctx.moveTo(bolt.x, bolt.y);
      
      for (const branch of bolt.branches) {
        ctx.lineTo(branch.x, branch.y);
      }
      
      ctx.stroke();
      
      // Flash effect - brighten entire screen briefly
      if (bolt.opacity > 0.8) {
        ctx.fillStyle = `rgba(255, 255, 255, ${bolt.opacity * 0.1})`;
        ctx.fillRect(0, 0, width, height);
      }
      
      ctx.restore();
    }
    
    // Draw thunder emoji at lightning strike points
    ctx.font = '48px Arial';
    for (const bolt of this.lightning) {
      if (bolt.opacity > 0.5) {
        ctx.save();
        ctx.globalAlpha = bolt.opacity * this.opacity;
        ctx.fillText('⚡', bolt.x - 24, 100);
        ctx.restore();
      }
    }
    
    ctx.restore();
  }

  cleanup() {
    this.raindrops = [];
    this.lightning = [];
  }
}