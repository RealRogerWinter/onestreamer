import { BaseEffect, EffectConfig } from './BaseEffect';

interface FireConfig extends EffectConfig {
  config: {
    fireType?: string;
    emoji?: string;
    spreadRadius?: number;
    flameHeight?: number;
    flameCount?: number;
    colors?: string[];
    smokeEffect?: boolean;
    smokeColor?: string;
    sparkles?: boolean;
    fadeOut?: boolean;
    fadeStartTime?: number;
    heatDistortion?: boolean;
    glowEffect?: boolean;
    glowRadius?: number;
    glowColor?: string;
  };
}

interface Flame {
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  height: number;
  maxHeight: number;
  width: number;
  life: number;
  maxLife: number;
  color: string;
  flickerSpeed: number;
  windOffset: number;
  opacity: number;
}

interface Smoke {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  velocity: { x: number; y: number };
  life: number;
}

interface Sparkle {
  x: number;
  y: number;
  velocity: { x: number; y: number };
  life: number;
  size: number;
  color: string;
}

export class FireEffect extends BaseEffect {
  private config: FireConfig['config'];
  private flames: Flame[] = [];
  private smoke: Smoke[] = [];
  private sparkles: Sparkle[] = [];
  private spreadRadius: number;
  private flameHeight: number;
  private flameCount: number;
  private colors: string[];
  private centerPosition: { x: number; y: number };
  private time: number = 0;
  private fadeStartTime: number;
  private glowIntensity: number = 1;

  constructor(config: FireConfig) {
    super(config);
    this.config = config.config;
    this.spreadRadius = this.config.spreadRadius || 120;
    this.flameHeight = this.config.flameHeight || 80;
    this.flameCount = this.config.flameCount || 25;
    this.colors = this.config.colors || ['#FF4500', '#FF6347', '#FF8C00', '#FFD700', '#FFA500'];
    this.fadeStartTime = this.config.fadeStartTime || 10000;
    this.centerPosition = { x: this.position.x, y: this.position.y };
    
    // Initialize flames
    this.initializeFlames();
  }

  private initializeFlames(): void {
    for (let i = 0; i < this.flameCount; i++) {
      const angle = (Math.PI * 2 * i) / this.flameCount;
      const distance = Math.random() * this.spreadRadius * 0.8;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance * 0.5; // Elliptical spread
      
      this.flames.push({
        x: x,
        y: y,
        baseX: x,
        baseY: y,
        height: this.randomInRange(this.flameHeight * 0.5, this.flameHeight),
        maxHeight: this.randomInRange(this.flameHeight * 0.8, this.flameHeight * 1.2),
        width: this.randomInRange(15, 25),
        life: 1,
        maxLife: this.randomInRange(30, 60),
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        flickerSpeed: this.randomInRange(0.1, 0.3),
        windOffset: 0,
        opacity: 1
      });
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    this.time += deltaTime;
    
    // Update glow intensity
    if (progress < 0.1) {
      this.glowIntensity = progress * 10;
    } else if (this.elapsed > this.fadeStartTime) {
      const fadeProgress = (this.elapsed - this.fadeStartTime) / (this.duration - this.fadeStartTime);
      this.glowIntensity = 1 - fadeProgress;
      this.alpha = 1 - fadeProgress;
    }
    
    // Update flames
    this.flames.forEach((flame, index) => {
      // Flicker effect
      flame.height = flame.maxHeight * (0.7 + Math.sin(this.time * flame.flickerSpeed) * 0.3);
      
      // Wind effect
      flame.windOffset = Math.sin(this.time * 0.002 + index) * 10;
      flame.x = flame.baseX + flame.windOffset;
      
      // Life cycle
      flame.life -= deltaTime / 100;
      if (flame.life <= 0) {
        // Respawn flame if not fading out
        if (this.elapsed < this.fadeStartTime) {
          flame.life = flame.maxLife;
          flame.color = this.colors[Math.floor(Math.random() * this.colors.length)];
          flame.height = this.randomInRange(this.flameHeight * 0.5, this.flameHeight);
        } else {
          flame.opacity = 0;
        }
      }
      
      // Update opacity based on life
      if (flame.life > 0) {
        flame.opacity = Math.min(1, flame.life / 10) * this.alpha;
      }
    });
    
    // Generate smoke
    if (this.config.smokeEffect && Math.random() < 0.3) {
      const smokeX = this.randomInRange(-this.spreadRadius * 0.5, this.spreadRadius * 0.5);
      this.smoke.push({
        x: smokeX,
        y: -this.flameHeight * 0.5,
        radius: this.randomInRange(10, 20),
        opacity: 0.3,
        velocity: { 
          x: this.randomInRange(-0.5, 0.5), 
          y: this.randomInRange(-2, -0.5) 
        },
        life: 100
      });
    }
    
    // Update smoke
    this.smoke = this.smoke.filter(particle => {
      particle.x += particle.velocity.x;
      particle.y += particle.velocity.y;
      particle.radius += 0.2;
      particle.opacity *= 0.98;
      particle.life--;
      return particle.life > 0 && particle.opacity > 0.01;
    });
    
    // Generate sparkles
    if (this.config.sparkles && Math.random() < 0.1) {
      const sparkleX = this.randomInRange(-this.spreadRadius * 0.3, this.spreadRadius * 0.3);
      this.sparkles.push({
        x: sparkleX,
        y: -this.randomInRange(0, this.flameHeight),
        velocity: { 
          x: this.randomInRange(-1, 1), 
          y: this.randomInRange(-3, -1) 
        },
        life: 30,
        size: this.randomInRange(2, 4),
        color: this.colors[Math.floor(Math.random() * this.colors.length)]
      });
    }
    
    // Update sparkles
    this.sparkles = this.sparkles.filter(sparkle => {
      sparkle.x += sparkle.velocity.x;
      sparkle.y += sparkle.velocity.y;
      sparkle.velocity.y += 0.1; // Gravity
      sparkle.life--;
      return sparkle.life > 0;
    });
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    
    ctx.save();
    
    // Draw glow effect
    if (this.config.glowEffect && this.glowIntensity > 0) {
      const glowRadius = (this.config.glowRadius || 150) * this.glowIntensity;
      const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, glowRadius);
      gradient.addColorStop(0, this.config.glowColor || 'rgba(255, 69, 0, 0.3)');
      gradient.addColorStop(0.5, 'rgba(255, 140, 0, 0.1)');
      gradient.addColorStop(1, 'rgba(255, 140, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.globalAlpha = this.alpha * 0.6;
      ctx.fillRect(pos.x - glowRadius, pos.y - glowRadius, glowRadius * 2, glowRadius * 2);
    }
    
    // Draw smoke
    if (this.config.smokeEffect) {
      this.smoke.forEach(particle => {
        ctx.globalAlpha = particle.opacity * this.alpha;
        ctx.fillStyle = this.config.smokeColor || 'rgba(50, 50, 50, 0.4)';
        ctx.beginPath();
        ctx.arc(
          pos.x + particle.x,
          pos.y + particle.y,
          particle.radius,
          0,
          Math.PI * 2
        );
        ctx.fill();
      });
    }
    
    // Draw flames
    ctx.globalCompositeOperation = 'screen'; // Additive blending for fire
    this.flames.forEach(flame => {
      if (flame.opacity <= 0) return;
      
      ctx.globalAlpha = flame.opacity;
      
      // Create flame gradient
      const flameGradient = ctx.createLinearGradient(
        pos.x + flame.x,
        pos.y + flame.y,
        pos.x + flame.x,
        pos.y + flame.y - flame.height
      );
      
      // Dynamic gradient based on flame color
      const baseColor = flame.color;
      flameGradient.addColorStop(0, baseColor);
      flameGradient.addColorStop(0.3, this.adjustBrightness(baseColor, 1.2));
      flameGradient.addColorStop(0.6, this.adjustBrightness(baseColor, 0.8));
      flameGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      
      ctx.fillStyle = flameGradient;
      
      // Draw teardrop-shaped flame
      ctx.beginPath();
      ctx.moveTo(pos.x + flame.x, pos.y + flame.y);
      
      // Left curve
      ctx.quadraticCurveTo(
        pos.x + flame.x - flame.width/2,
        pos.y + flame.y - flame.height * 0.3,
        pos.x + flame.x,
        pos.y + flame.y - flame.height
      );
      
      // Right curve
      ctx.quadraticCurveTo(
        pos.x + flame.x + flame.width/2,
        pos.y + flame.y - flame.height * 0.3,
        pos.x + flame.x,
        pos.y + flame.y
      );
      
      ctx.closePath();
      ctx.fill();
    });
    
    ctx.globalCompositeOperation = 'source-over'; // Reset blend mode
    
    // Draw sparkles
    if (this.config.sparkles) {
      this.sparkles.forEach(sparkle => {
        ctx.globalAlpha = (sparkle.life / 30) * this.alpha;
        ctx.fillStyle = sparkle.color;
        ctx.fillRect(
          pos.x + sparkle.x - sparkle.size/2,
          pos.y + sparkle.y - sparkle.size/2,
          sparkle.size,
          sparkle.size
        );
      });
    }
    
    // Draw heat distortion (simulated with wavy lines)
    if (this.config.heatDistortion && this.alpha > 0.5) {
      ctx.globalAlpha = 0.1 * this.alpha;
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      
      for (let i = 0; i < 5; i++) {
        const waveOffset = Math.sin(this.time * 0.003 + i) * 5;
        ctx.beginPath();
        ctx.moveTo(pos.x - this.spreadRadius/2 + waveOffset, pos.y - this.flameHeight * 1.5);
        ctx.quadraticCurveTo(
          pos.x + waveOffset,
          pos.y - this.flameHeight * 2,
          pos.x + this.spreadRadius/2 + waveOffset,
          pos.y - this.flameHeight * 1.5
        );
        ctx.stroke();
      }
    }
    
    ctx.restore();
  }
  
  private adjustBrightness(color: string, factor: number): string {
    // Simple brightness adjustment for hex colors
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const r = Math.min(255, Math.floor(parseInt(hex.substr(0, 2), 16) * factor));
      const g = Math.min(255, Math.floor(parseInt(hex.substr(2, 2), 16) * factor));
      const b = Math.min(255, Math.floor(parseInt(hex.substr(4, 2), 16) * factor));
      return `rgb(${r}, ${g}, ${b})`;
    }
    return color;
  }

  public cleanup(): void {
    this.flames = [];
    this.smoke = [];
    this.sparkles = [];
  }
}