import { BaseEffect, EffectConfig } from './BaseEffect';

interface SmokeParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  growth: number;
}

export class OverlayEffect extends BaseEffect {
  private color: string;
  private overlayType: string;
  private opacity: number;
  private smokeParticles: SmokeParticle[];
  private pulsePhase: number;
  private rainbowHue: number;
  private config: any;

  constructor(config: EffectConfig) {
    super(config);
    
    this.config = config;
    this.color = config.color || 'rgba(100, 100, 100, 0.7)';
    this.overlayType = config.overlayType || config.animation || 'smoke';
    this.opacity = config.opacity || 0.7;
    this.smokeParticles = [];
    this.pulsePhase = 0;
    this.rainbowHue = 0;
    
    if (this.overlayType === 'smoke') {
      this.initializeSmokeParticles();
    }
  }

  private initializeSmokeParticles(): void {
    const particleCount = this.config.particleCount || 50;
    const width = this.config.width === 'full' ? 400 : 200;
    
    for (let i = 0; i < particleCount; i++) {
      this.smokeParticles.push({
        x: this.randomInRange(-width, width),
        y: this.randomInRange(-100, 100),
        vx: this.randomInRange(-2, 2),
        vy: this.randomInRange(-3, -1), // Stronger upward bias
        size: this.randomInRange(30, 80),
        alpha: this.randomInRange(0.3, 0.7),
        growth: this.randomInRange(1.0, 2.0)
      });
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    // Update based on overlay type
    switch (this.overlayType) {
      case 'smoke':
        this.updateSmoke(deltaTime, progress);
        break;
        
      case 'aura':
        this.pulsePhase += deltaTime * 0.003; // Slow pulse
        break;
        
      case 'rainbow':
        this.rainbowHue = (this.rainbowHue + deltaTime * (this.config.speed || 1.5) * 0.1) % 360;
        break;
        
      case 'spotlight':
        this.pulsePhase += deltaTime * (this.config.sweepSpeed || 2) * 0.001;
        break;
    }
  }

  private updateSmoke(deltaTime: number, progress: number): void {
    this.smokeParticles.forEach(particle => {
      // Update position
      particle.x += particle.vx * (deltaTime / 16);
      particle.y += particle.vy * (deltaTime / 16);
      
      // Expand and rise
      particle.size += particle.growth * (deltaTime / 16);
      particle.vy -= 0.02; // Accelerate upward
      
      // Fade out
      particle.alpha = Math.max(0, particle.alpha * (1 - progress * 0.5));
      
      // Add turbulence
      particle.vx += this.randomInRange(-0.1, 0.1);
    });
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    
    ctx.save();
    
    switch (this.overlayType) {
      case 'smoke':
        this.renderSmoke(ctx, pos, width, height);
        break;
        
      case 'aura':
        this.renderAura(ctx, pos, width, height);
        break;
        
      case 'rainbow':
        this.renderRainbow(ctx, width, height);
        break;
        
      case 'spotlight':
        this.renderSpotlight(ctx, pos, width, height);
        break;
        
      default:
        this.renderBasicOverlay(ctx, width, height);
    }
    
    ctx.restore();
  }

  private renderSmoke(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, width: number, height: number): void {
    ctx.globalCompositeOperation = 'screen';
    
    this.smokeParticles.forEach(particle => {
      if (particle.alpha <= 0) return;
      
      const gradient = ctx.createRadialGradient(
        pos.x + particle.x, pos.y + particle.y, 0,
        pos.x + particle.x, pos.y + particle.y, particle.size
      );
      
      const baseColor = this.parseColor(this.color);
      gradient.addColorStop(0, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${particle.alpha * this.alpha})`);
      gradient.addColorStop(0.5, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${particle.alpha * this.alpha * 0.5})`);
      gradient.addColorStop(1, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0)`);
      
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(pos.x + particle.x, pos.y + particle.y, particle.size, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  private renderAura(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, width: number, height: number): void {
    const pulseSize = 1 + Math.sin(this.pulsePhase) * 0.2;
    const maxRadius = Math.min(width, height) * 0.3 * pulseSize;
    
    // Create multiple layers for depth
    for (let i = 3; i > 0; i--) {
      const layerRadius = maxRadius * (i / 3);
      const layerAlpha = this.alpha * this.opacity * (0.3 / i);
      
      const gradient = ctx.createRadialGradient(
        pos.x, pos.y, 0,
        pos.x, pos.y, layerRadius
      );
      
      const color = this.color.startsWith('#') ? this.hexToRgb(this.color) : this.parseColor(this.color);
      gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, ${layerAlpha})`);
      gradient.addColorStop(0.5, `rgba(${color.r}, ${color.g}, ${color.b}, ${layerAlpha * 0.5})`);
      gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
  }

  private renderRainbow(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.globalCompositeOperation = 'screen';
    
    const waveWidth = this.config.waveWidth || 200;
    const waveOffset = (this.rainbowHue * 3) % (width + waveWidth * 2);
    const intensity = this.config.intensity || 0.6;
    
    // Create animated rainbow wave that moves across screen
    for (let x = -waveWidth; x < width + waveWidth; x += 5) {
      const waveX = x + waveOffset - waveWidth;
      const distanceFromCenter = Math.abs(waveX - width / 2);
      const waveIntensity = Math.max(0, 1 - (distanceFromCenter / waveWidth));
      
      if (waveIntensity > 0) {
        const gradient = ctx.createLinearGradient(x, 0, x, height);
        const colors = 7;
        
        for (let i = 0; i <= colors; i++) {
          const hue = (this.rainbowHue + (i * 360 / colors) + (x * 0.5)) % 360;
          const alpha = this.alpha * this.opacity * intensity * waveIntensity;
          gradient.addColorStop(i / colors, `hsla(${hue}, 100%, 60%, ${alpha})`);
        }
        
        ctx.fillStyle = gradient;
        ctx.fillRect(x, 0, 5, height);
      }
    }
  }

  private renderSpotlight(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, width: number, height: number): void {
    ctx.globalCompositeOperation = 'screen';
    
    const beamWidth = this.config.beamWidth || 150;
    const intensity = this.config.intensity || 0.9;
    const sweepAngle = this.pulsePhase * (this.config.sweepSpeed || 2);
    
    // Create rotating spotlight beam
    const centerX = pos.x;
    const centerY = pos.y;
    const beamLength = Math.max(width, height);
    
    // Calculate beam direction
    const beamX = centerX + Math.cos(sweepAngle) * beamLength;
    const beamY = centerY + Math.sin(sweepAngle) * beamLength;
    
    // Create spotlight gradient
    const gradient = ctx.createRadialGradient(
      centerX, centerY, 0,
      centerX, centerY, beamLength
    );
    
    gradient.addColorStop(0, `rgba(255, 255, 255, ${this.alpha * intensity})`);
    gradient.addColorStop(0.3, `rgba(255, 255, 150, ${this.alpha * intensity * 0.8})`);
    gradient.addColorStop(0.7, `rgba(255, 255, 100, ${this.alpha * intensity * 0.4})`);
    gradient.addColorStop(1, `rgba(255, 255, 100, 0)`);
    
    // Draw spotlight beam
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(sweepAngle);
    
    // Create beam shape
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, beamLength, -beamWidth * Math.PI / 360, beamWidth * Math.PI / 360);
    ctx.closePath();
    
    ctx.fillStyle = gradient;
    ctx.fill();
    
    ctx.restore();
    
    // Add center glow
    const centerGradient = ctx.createRadialGradient(
      centerX, centerY, 0,
      centerX, centerY, beamWidth / 2
    );
    centerGradient.addColorStop(0, `rgba(255, 255, 255, ${this.alpha * intensity})`);
    centerGradient.addColorStop(1, `rgba(255, 255, 255, 0)`);
    
    ctx.fillStyle = centerGradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, beamWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private renderBasicOverlay(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.globalAlpha = this.alpha * this.opacity;
    ctx.fillStyle = this.color;
    ctx.fillRect(0, 0, width, height);
  }

  private parseColor(color: string): { r: number; g: number; b: number } {
    // Parse rgba() format
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      return {
        r: parseInt(match[1]),
        g: parseInt(match[2]),
        b: parseInt(match[3])
      };
    }
    
    // Default gray
    return { r: 128, g: 128, b: 128 };
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 128, g: 128, b: 128 };
  }
}