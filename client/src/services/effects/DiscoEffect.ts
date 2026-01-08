import { BaseEffect, EffectConfig } from './BaseEffect';

interface DiscoBeam {
  angle: number;
  length: number;
  width: number;
  color: string;
  intensity: number;
  rotation: number;
}

interface DiscoSparkle {
  x: number;
  y: number;
  size: number;
  color: string;
  life: number;
  twinkle: number;
  rotation: number;
  rotationSpeed: number;
}

interface ReflectionSpot {
  x: number;
  y: number;
  size: number;
  color: string;
  intensity: number;
  oscillation: number;
  oscillationSpeed: number;
}

export class DiscoEffect extends BaseEffect {
  private beams: DiscoBeam[];
  private sparkles: DiscoSparkle[];
  private reflectionSpots: ReflectionSpot[];
  private colors: string[];
  private rotationSpeed: number;
  private currentRotation: number;
  private colorCycleProgress: number;
  private colorCycleSpeed: number;
  private glitterDensity: number;
  private beamCount: number;
  private sparkleCount: number;
  private reflectionCount: number;
  private pulsate: boolean;
  private pulsePhase: number;

  constructor(config: EffectConfig) {
    super(config);
    
    // Configuration from server
    this.colors = config.colors || [
      '#ff00ff', '#00ff00', '#ffff00', '#00ffff', '#ff0080', '#8000ff',
      '#ff3333', '#33ff33', '#3333ff', '#ffff33', '#ff33ff', '#33ffff'
    ];
    this.rotationSpeed = (config.rotationSpeed || 2.5) * 0.001; // Convert to radians per ms
    this.colorCycleSpeed = (config.colorCycleSpeed || 1.5) * 0.001;
    this.beamCount = config.lightBeams || 16;
    this.sparkleCount = config.glitterCount || 200;
    this.reflectionCount = config.reflectionSpots || 30;
    this.pulsate = config.pulsate !== false;
    this.glitterDensity = config.glitterDensity || 0.8;
    
    // State
    this.currentRotation = 0;
    this.colorCycleProgress = 0;
    this.pulsePhase = 0;
    
    this.beams = [];
    this.sparkles = [];
    this.reflectionSpots = [];
    
    this.initializeBeams();
    this.initializeSparkles();
    this.initializeReflectionSpots();
  }

  private initializeBeams(): void {
    const angleStep = (Math.PI * 2) / this.beamCount;
    
    for (let i = 0; i < this.beamCount; i++) {
      this.beams.push({
        angle: i * angleStep + Math.random() * 0.2,
        length: this.randomInRange(200, 400),
        width: this.randomInRange(20, 40),
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        intensity: this.randomInRange(0.6, 1.0),
        rotation: Math.random() * Math.PI * 2
      });
    }
  }

  private initializeSparkles(): void {
    for (let i = 0; i < this.sparkleCount; i++) {
      // Create sparkles in a rough circle around the disco ball center
      const angle = Math.random() * Math.PI * 2;
      const distance = this.randomInRange(50, 300);
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      
      this.sparkles.push({
        x,
        y,
        size: this.randomInRange(2, 8),
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        life: this.randomInRange(0.5, 1.0),
        twinkle: Math.random() * Math.PI * 2,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: this.randomInRange(-0.05, 0.05)
      });
    }
  }

  private initializeReflectionSpots(): void {
    for (let i = 0; i < this.reflectionCount; i++) {
      // Position reflection spots randomly across the canvas
      const x = this.randomInRange(-400, 400);
      const y = this.randomInRange(-300, 300);
      
      this.reflectionSpots.push({
        x,
        y,
        size: this.randomInRange(10, 25),
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        intensity: this.randomInRange(0.4, 0.9),
        oscillation: Math.random() * Math.PI * 2,
        oscillationSpeed: this.randomInRange(0.001, 0.003)
      });
    }
  }

  private getCycledColor(baseColor: string, progress: number): string {
    // Create color cycling effect by shifting hue
    const hueShift = Math.sin(progress * Math.PI * 2) * 60; // ±60 degree hue shift
    
    // Simple color transformation - in a real implementation you'd convert to HSL
    const colors = [
      '#ff00ff', '#ff0080', '#ff0000', '#ff8000', '#ffff00',
      '#80ff00', '#00ff00', '#00ff80', '#00ffff', '#0080ff',
      '#0000ff', '#8000ff'
    ];
    
    const cycleIndex = Math.floor(progress * colors.length) % colors.length;
    return colors[cycleIndex];
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    // Update rotation
    this.currentRotation += this.rotationSpeed * deltaTime;
    
    // Update color cycling
    this.colorCycleProgress += this.colorCycleSpeed * deltaTime;
    if (this.colorCycleProgress > 1) this.colorCycleProgress -= 1;
    
    // Update pulse phase
    if (this.pulsate) {
      this.pulsePhase += 0.005 * deltaTime;
    }
    
    // Update beams
    this.beams.forEach(beam => {
      beam.rotation += this.rotationSpeed * deltaTime * 0.5;
      beam.color = this.getCycledColor(beam.color, this.colorCycleProgress);
      
      if (this.pulsate) {
        beam.intensity = 0.3 + 0.7 * (1 + Math.sin(this.pulsePhase + beam.angle)) * 0.5;
      }
    });
    
    // Update sparkles
    this.sparkles.forEach(sparkle => {
      sparkle.twinkle += 0.01 * deltaTime;
      sparkle.rotation += sparkle.rotationSpeed * deltaTime;
      sparkle.color = this.getCycledColor(sparkle.color, this.colorCycleProgress);
      
      // Sparkles fade in and out
      const twinkleIntensity = (Math.sin(sparkle.twinkle) + 1) * 0.5;
      sparkle.life = 0.3 + twinkleIntensity * 0.7;
    });
    
    // Update reflection spots
    this.reflectionSpots.forEach(spot => {
      spot.oscillation += spot.oscillationSpeed * deltaTime;
      spot.color = this.getCycledColor(spot.color, this.colorCycleProgress);
      spot.intensity = 0.2 + 0.8 * (Math.sin(spot.oscillation) + 1) * 0.5;
    });
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    
    ctx.save();
    
    // Set up disco ball center
    ctx.translate(pos.x, pos.y);
    ctx.rotate(this.currentRotation);
    
    // Render light beams first (behind everything)
    this.renderBeams(ctx);
    
    ctx.restore();
    ctx.save();
    ctx.translate(pos.x, pos.y);
    
    // Render reflection spots across the canvas
    this.renderReflectionSpots(ctx, width, height);
    
    // Render the disco ball itself
    this.renderDiscoBall(ctx);
    
    // Render sparkles around the ball
    this.renderSparkles(ctx);
    
    ctx.restore();
  }

  private renderBeams(ctx: CanvasRenderingContext2D): void {
    this.beams.forEach(beam => {
      ctx.save();
      
      const gradient = ctx.createLinearGradient(0, 0, beam.length, 0);
      gradient.addColorStop(0, beam.color);
      gradient.addColorStop(1, 'transparent');
      
      ctx.globalAlpha = beam.intensity * this.alpha * 0.6;
      ctx.fillStyle = gradient;
      ctx.shadowColor = beam.color;
      ctx.shadowBlur = beam.width;
      
      ctx.rotate(beam.angle + beam.rotation);
      
      // Create tapered beam shape
      ctx.beginPath();
      ctx.moveTo(0, -beam.width / 2);
      ctx.lineTo(beam.length, -beam.width / 4);
      ctx.lineTo(beam.length, beam.width / 4);
      ctx.lineTo(0, beam.width / 2);
      ctx.closePath();
      ctx.fill();
      
      ctx.restore();
    });
  }

  private renderDiscoBall(ctx: CanvasRenderingContext2D): void {
    const ballSize = 40;
    
    // Draw main disco ball sphere
    ctx.save();
    ctx.globalAlpha = this.alpha * 0.8;
    
    // Ball shadow/depth
    const gradient = ctx.createRadialGradient(-5, -5, 0, 0, 0, ballSize);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.6, '#cccccc');
    gradient.addColorStop(1, '#666666');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, ballSize, 0, Math.PI * 2);
    ctx.fill();
    
    // Add mirror facets
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const radius = ballSize * 0.7;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + this.currentRotation);
      
      ctx.fillStyle = this.getCycledColor('#ffffff', this.colorCycleProgress + i * 0.1);
      ctx.globalAlpha = this.alpha * (0.3 + 0.4 * Math.sin(this.pulsePhase + angle));
      
      ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
    }
    
    ctx.restore();
  }

  private renderSparkles(ctx: CanvasRenderingContext2D): void {
    this.sparkles.forEach(sparkle => {
      if (sparkle.life <= 0) return;
      
      ctx.save();
      ctx.globalAlpha = sparkle.life * this.alpha;
      ctx.fillStyle = sparkle.color;
      ctx.shadowColor = sparkle.color;
      ctx.shadowBlur = sparkle.size * 2;
      
      ctx.translate(sparkle.x, sparkle.y);
      ctx.rotate(sparkle.rotation);
      
      // Draw sparkle as a star
      this.drawSparkle(ctx, sparkle.size);
      
      ctx.restore();
    });
  }

  private renderReflectionSpots(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    this.reflectionSpots.forEach(spot => {
      ctx.save();
      
      // Position spots relative to canvas size
      const x = spot.x + width * 0.5;
      const y = spot.y + height * 0.5;
      
      // Keep spots within canvas bounds
      if (x < 0 || x > width || y < 0 || y > height) {
        ctx.restore();
        return;
      }
      
      ctx.globalAlpha = spot.intensity * this.alpha * 0.7;
      
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, spot.size);
      gradient.addColorStop(0, spot.color);
      gradient.addColorStop(1, 'transparent');
      
      ctx.fillStyle = gradient;
      ctx.shadowColor = spot.color;
      ctx.shadowBlur = spot.size;
      
      ctx.beginPath();
      ctx.arc(x, y, spot.size, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.restore();
    });
  }

  private drawSparkle(ctx: CanvasRenderingContext2D, size: number): void {
    const spikes = 4;
    const outerRadius = size;
    const innerRadius = size * 0.3;
    
    ctx.beginPath();
    
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (i * Math.PI) / spikes;
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    
    ctx.closePath();
    ctx.fill();
    
    // Add bright center
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha *= 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
}