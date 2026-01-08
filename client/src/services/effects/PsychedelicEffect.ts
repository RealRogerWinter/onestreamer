import { BaseEffect, EffectConfig } from './BaseEffect';

interface PsychedelicConfig extends EffectConfig {
  config: {
    tripType?: string;
    emoji?: string;
    intensity?: string;
    waveAmplitude?: number;
    waveFrequency?: number;
    colorShiftSpeed?: number;
    hueRotationSpeed?: number;
    saturationBoost?: number;
    fractalDepth?: number;
    kaleidoscopeSegments?: number;
    trailLength?: number;
    pulseSpeed?: number;
    chromaShift?: boolean;
    melting?: boolean;
    breathing?: boolean;
    fadeIn?: boolean;
    fadeOut?: boolean;
    fadeInDuration?: number;
    fadeOutDuration?: number;
  };
}

interface Trail {
  x: number;
  y: number;
  hue: number;
  size: number;
  alpha: number;
}

interface FractalPoint {
  x: number;
  y: number;
  angle: number;
  distance: number;
  level: number;
  hue: number;
}

export class PsychedelicEffect extends BaseEffect {
  private config: PsychedelicConfig['config'];
  private time: number = 0;
  private hueRotation: number = 0;
  private trails: Trail[] = [];
  private fractals: FractalPoint[] = [];
  private wavePhase: number = 0;
  private pulsePhase: number = 0;
  private breathingPhase: number = 0;
  private kaleidoscopeAngle: number = 0;
  private fadeInDuration: number;
  private fadeOutDuration: number;
  private intensity: number = 0;

  constructor(config: PsychedelicConfig) {
    super(config);
    this.config = config.config;
    this.fadeInDuration = this.config.fadeInDuration || 2000;
    this.fadeOutDuration = this.config.fadeOutDuration || 3000;
    
    // Initialize fractals
    this.initializeFractals();
  }

  private initializeFractals(): void {
    const depth = this.config.fractalDepth || 5;
    const segments = this.config.kaleidoscopeSegments || 6;
    
    for (let level = 0; level < depth; level++) {
      const pointsPerLevel = segments * Math.pow(2, level);
      const radius = 50 + level * 30;
      
      for (let i = 0; i < pointsPerLevel; i++) {
        const angle = (Math.PI * 2 * i) / pointsPerLevel;
        this.fractals.push({
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          angle: angle,
          distance: radius,
          level: level,
          hue: (360 / pointsPerLevel) * i
        });
      }
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    this.time += deltaTime;
    
    // Calculate intensity based on fade in/out
    if (this.elapsed < this.fadeInDuration) {
      this.intensity = this.elapsed / this.fadeInDuration;
    } else if (this.elapsed > this.duration - this.fadeOutDuration) {
      const fadeOutProgress = (this.elapsed - (this.duration - this.fadeOutDuration)) / this.fadeOutDuration;
      this.intensity = 1 - fadeOutProgress;
      this.alpha = 1 - fadeOutProgress;
    } else {
      this.intensity = 1;
    }
    
    // Update various animation phases
    this.hueRotation += (this.config.hueRotationSpeed || 2) * deltaTime * 0.1;
    this.wavePhase += (this.config.waveFrequency || 0.02) * deltaTime;
    this.pulsePhase += (this.config.pulseSpeed || 0.005) * deltaTime;
    this.breathingPhase += deltaTime * 0.001;
    this.kaleidoscopeAngle += deltaTime * 0.0005;
    
    // Update fractals
    this.fractals.forEach((fractal, index) => {
      fractal.angle += deltaTime * 0.0001 * (fractal.level + 1);
      fractal.x = Math.cos(fractal.angle) * fractal.distance;
      fractal.y = Math.sin(fractal.angle) * fractal.distance;
      fractal.hue = (fractal.hue + deltaTime * 0.1) % 360;
    });
    
    // Generate rainbow trails
    if (Math.random() < 0.3 * this.intensity) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * 200;
      this.trails.push({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        hue: Math.random() * 360,
        size: this.randomInRange(20, 60),
        alpha: 0.5
      });
    }
    
    // Update trails
    this.trails = this.trails.filter(trail => {
      trail.alpha *= 0.95;
      trail.size *= 1.02;
      trail.hue = (trail.hue + 2) % 360;
      return trail.alpha > 0.01;
    });
    
    // Keep trail count limited
    if (this.trails.length > (this.config.trailLength || 10)) {
      this.trails.shift();
    }
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    // LSD effect should cover the entire canvas, not just click position
    const pos = { x: width / 2, y: height / 2 };
    
    ctx.save();
    
    // Apply overall intensity
    ctx.globalAlpha = this.alpha * this.intensity;
    
    // Create psychedelic overlay
    if (this.intensity > 0) {
      // Wave distortion background
      if (this.config.melting) {
        this.renderMeltingEffect(ctx, width, height);
      }
      
      // Kaleidoscope pattern
      if (this.config.kaleidoscopeSegments && this.config.kaleidoscopeSegments > 0) {
        this.renderKaleidoscope(ctx, width, height, pos);
      }
      
      // Rainbow trails
      this.renderTrails(ctx, width, height, pos);
      
      // Fractal patterns
      this.renderFractals(ctx, width, height, pos);
      
      // Chromatic aberration effect
      if (this.config.chromaShift) {
        this.renderChromaticAberration(ctx, width, height);
      }
      
      // Breathing effect overlay
      if (this.config.breathing) {
        this.renderBreathingEffect(ctx, width, height);
      }
      
      // Color shift overlay
      this.renderColorShift(ctx, width, height);
    }
    
    ctx.restore();
  }
  
  private renderMeltingEffect(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const amplitude = (this.config.waveAmplitude || 30) * this.intensity;
    const frequency = this.config.waveFrequency || 0.02;
    
    ctx.globalAlpha = 0.3 * this.intensity;
    ctx.globalCompositeOperation = 'screen';
    
    for (let y = 0; y < height; y += 20) {
      const waveX = Math.sin(y * frequency + this.wavePhase) * amplitude;
      const gradient = ctx.createLinearGradient(waveX, y, width + waveX, y);
      
      const hue = (this.hueRotation + y * 0.5) % 360;
      gradient.addColorStop(0, `hsla(${hue}, 100%, 50%, 0)`);
      gradient.addColorStop(0.5, `hsla(${hue + 60}, 100%, 50%, 0.3)`);
      gradient.addColorStop(1, `hsla(${hue + 120}, 100%, 50%, 0)`);
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, y, width, 20);
    }
    
    ctx.globalCompositeOperation = 'source-over';
  }
  
  private renderKaleidoscope(ctx: CanvasRenderingContext2D, width: number, height: number, pos: {x: number, y: number}): void {
    const segments = this.config.kaleidoscopeSegments || 6;
    const centerX = width / 2;
    const centerY = height / 2;
    
    ctx.globalAlpha = 0.4 * this.intensity;
    ctx.globalCompositeOperation = 'screen';
    
    for (let i = 0; i < segments; i++) {
      const angle = (Math.PI * 2 * i) / segments + this.kaleidoscopeAngle;
      
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      
      // Draw triangular segment
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(300, -100);
      ctx.lineTo(300, 100);
      ctx.closePath();
      
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 300);
      const hue = (this.hueRotation + i * 60) % 360;
      gradient.addColorStop(0, `hsla(${hue}, 100%, 50%, 0.5)`);
      gradient.addColorStop(0.5, `hsla(${hue + 30}, 100%, 60%, 0.3)`);
      gradient.addColorStop(1, `hsla(${hue + 60}, 100%, 70%, 0.1)`);
      
      ctx.fillStyle = gradient;
      ctx.fill();
      
      ctx.restore();
    }
    
    ctx.globalCompositeOperation = 'source-over';
  }
  
  private renderTrails(ctx: CanvasRenderingContext2D, width: number, height: number, pos: {x: number, y: number}): void {
    ctx.globalCompositeOperation = 'screen';
    
    this.trails.forEach(trail => {
      ctx.globalAlpha = trail.alpha * this.intensity;
      
      const gradient = ctx.createRadialGradient(
        pos.x + trail.x,
        pos.y + trail.y,
        0,
        pos.x + trail.x,
        pos.y + trail.y,
        trail.size
      );
      
      gradient.addColorStop(0, `hsla(${trail.hue}, 100%, 50%, 0.8)`);
      gradient.addColorStop(0.3, `hsla(${trail.hue + 30}, 100%, 60%, 0.5)`);
      gradient.addColorStop(0.6, `hsla(${trail.hue + 60}, 100%, 70%, 0.3)`);
      gradient.addColorStop(1, `hsla(${trail.hue + 90}, 100%, 80%, 0)`);
      
      ctx.fillStyle = gradient;
      ctx.fillRect(
        pos.x + trail.x - trail.size,
        pos.y + trail.y - trail.size,
        trail.size * 2,
        trail.size * 2
      );
    });
    
    ctx.globalCompositeOperation = 'source-over';
  }
  
  private renderFractals(ctx: CanvasRenderingContext2D, width: number, height: number, pos: {x: number, y: number}): void {
    ctx.globalAlpha = 0.3 * this.intensity;
    ctx.globalCompositeOperation = 'screen';
    
    const centerX = width / 2;
    const centerY = height / 2;
    
    this.fractals.forEach(fractal => {
      const x = centerX + fractal.x + Math.sin(this.time * 0.001 + fractal.angle) * 20;
      const y = centerY + fractal.y + Math.cos(this.time * 0.001 + fractal.angle) * 20;
      const size = 5 + fractal.level * 2;
      
      ctx.fillStyle = `hsla(${fractal.hue + this.hueRotation}, 100%, ${50 + fractal.level * 10}%, ${0.5 - fractal.level * 0.1})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      
      // Connect to neighbors
      if (fractal.level > 0) {
        ctx.strokeStyle = `hsla(${fractal.hue + this.hueRotation}, 100%, 70%, 0.2)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    });
    
    ctx.globalCompositeOperation = 'source-over';
  }
  
  private renderChromaticAberration(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.globalAlpha = 0.2 * this.intensity;
    ctx.globalCompositeOperation = 'screen';
    
    // Red channel shift
    ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
    ctx.fillRect(5, 0, width, height);
    
    // Blue channel shift
    ctx.fillStyle = 'rgba(0, 0, 255, 0.3)';
    ctx.fillRect(-5, 0, width, height);
    
    ctx.globalCompositeOperation = 'source-over';
  }
  
  private renderBreathingEffect(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const breathScale = 1 + Math.sin(this.breathingPhase) * 0.05;
    const centerX = width / 2;
    const centerY = height / 2;
    
    ctx.globalAlpha = 0.15 * this.intensity;
    ctx.globalCompositeOperation = 'screen';
    
    const gradient = ctx.createRadialGradient(
      centerX,
      centerY,
      0,
      centerX,
      centerY,
      Math.max(width, height) * 0.5 * breathScale
    );
    
    const hue = (this.hueRotation + 180) % 360;
    gradient.addColorStop(0, `hsla(${hue}, 100%, 50%, 0)`);
    gradient.addColorStop(0.5, `hsla(${hue + 60}, 100%, 60%, 0.3)`);
    gradient.addColorStop(1, `hsla(${hue + 120}, 100%, 70%, 0)`);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    
    ctx.globalCompositeOperation = 'source-over';
  }
  
  private renderColorShift(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.globalAlpha = 0.2 * this.intensity;
    ctx.globalCompositeOperation = 'multiply';
    
    // Create HSL color overlay
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    const saturation = Math.min(100, 50 * (this.config.saturationBoost || 1.5));
    
    gradient.addColorStop(0, `hsla(${this.hueRotation}, ${saturation}%, 50%, 0.5)`);
    gradient.addColorStop(0.33, `hsla(${this.hueRotation + 120}, ${saturation}%, 50%, 0.5)`);
    gradient.addColorStop(0.66, `hsla(${this.hueRotation + 240}, ${saturation}%, 50%, 0.5)`);
    gradient.addColorStop(1, `hsla(${this.hueRotation}, ${saturation}%, 50%, 0.5)`);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    
    // Pulse effect
    const pulseAlpha = 0.1 + Math.sin(this.pulsePhase) * 0.1;
    ctx.globalAlpha = pulseAlpha * this.intensity;
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = `hsla(${this.hueRotation + 90}, 100%, 50%, 0.3)`;
    ctx.fillRect(0, 0, width, height);
    
    ctx.globalCompositeOperation = 'source-over';
  }

  public cleanup(): void {
    this.trails = [];
    this.fractals = [];
  }
}