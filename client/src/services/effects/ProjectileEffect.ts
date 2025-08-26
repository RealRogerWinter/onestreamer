import { BaseEffect, EffectConfig } from './BaseEffect';

interface ProjectileConfig extends EffectConfig {
  config: {
    projectileType: string;
    emoji?: string;
    size?: number;
    flightDuration?: number;
    stickDuration?: number;
    color?: string;
    trailEffect?: boolean;
    trailColor?: string;
    rotateToTarget?: boolean;
    impactEffect?: boolean;
    wobbleOnStick?: boolean;
    fadeOut?: boolean;
    fadeStartTime?: number;
  };
}

interface TrailPoint {
  x: number;
  y: number;
  alpha: number;
}

export class ProjectileEffect extends BaseEffect {
  private config: ProjectileConfig['config'];
  private projectileType: string;
  private emoji: string;
  private size: number;
  private flightDuration: number;
  private stickDuration: number;
  private color: string;
  private rotation: number = 0;
  private wobbleAmount: number = 0;
  private trail: TrailPoint[] = [];
  private impactTime: number = 0;
  private stickPosition: { x: number; y: number } | null = null;
  private startPosition: { x: number; y: number };
  private targetPosition: { x: number; y: number };
  private hasImpacted: boolean = false;

  constructor(config: ProjectileConfig) {
    super(config);
    this.config = config.config;
    this.projectileType = this.config.projectileType || 'arrow';
    this.emoji = this.config.emoji || '🏹';
    this.size = this.config.size || 80;
    this.flightDuration = this.config.flightDuration || 500;
    this.stickDuration = this.config.stickDuration || 8000;
    this.color = this.config.color || '#8B4513';
    
    // Set start position to random edge of screen
    const side = Math.floor(Math.random() * 4);
    switch(side) {
      case 0: // Top
        this.startPosition = { x: Math.random(), y: -0.1 };
        break;
      case 1: // Right
        this.startPosition = { x: 1.1, y: Math.random() };
        break;
      case 2: // Bottom
        this.startPosition = { x: Math.random(), y: 1.1 };
        break;
      case 3: // Left
      default:
        this.startPosition = { x: -0.1, y: Math.random() };
        break;
    }
    
    this.targetPosition = { x: this.position.x, y: this.position.y };
    
    // Calculate initial rotation angle
    if (this.config.rotateToTarget) {
      const dx = this.targetPosition.x - this.startPosition.x;
      const dy = this.targetPosition.y - this.startPosition.y;
      this.rotation = Math.atan2(dy, dx);
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    const totalDuration = this.flightDuration + this.stickDuration;
    const actualProgress = this.elapsed / totalDuration;
    
    // Flight phase
    if (this.elapsed < this.flightDuration) {
      const flightProgress = this.elapsed / this.flightDuration;
      const eased = this.easeOutCubic(flightProgress);
      
      // Interpolate position during flight
      this.position.x = this.startPosition.x + (this.targetPosition.x - this.startPosition.x) * eased;
      this.position.y = this.startPosition.y + (this.targetPosition.y - this.startPosition.y) * eased;
      
      // Add to trail
      if (this.config.trailEffect) {
        this.trail.push({
          x: this.position.x,
          y: this.position.y,
          alpha: 1.0
        });
        
        // Keep trail limited in size
        if (this.trail.length > 10) {
          this.trail.shift();
        }
        
        // Fade trail points
        this.trail.forEach((point, i) => {
          point.alpha = (i / this.trail.length) * 0.5;
        });
      }
    } else if (!this.hasImpacted) {
      // Just impacted
      this.hasImpacted = true;
      this.impactTime = this.elapsed;
      this.stickPosition = { x: this.targetPosition.x, y: this.targetPosition.y };
    } else {
      // Stuck phase
      const stickElapsed = this.elapsed - this.flightDuration;
      
      // Wobble effect when stuck
      if (this.config.wobbleOnStick) {
        this.wobbleAmount = Math.sin(stickElapsed * 0.005) * 0.02;
      }
      
      // Clear trail during stick phase
      if (this.trail.length > 0) {
        this.trail = [];
      }
      
      // Handle fade out
      if (this.config.fadeOut && this.config.fadeStartTime) {
        if (this.elapsed > this.config.fadeStartTime) {
          const fadeProgress = (this.elapsed - this.config.fadeStartTime) / (totalDuration - this.config.fadeStartTime);
          this.alpha = Math.max(0, 1 - fadeProgress);
        }
      }
    }
    
    // Mark complete when total duration reached
    if (this.elapsed >= totalDuration) {
      this.complete = true;
    }
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    
    ctx.save();
    ctx.globalAlpha = this.alpha;
    
    // Draw trail
    if (this.config.trailEffect && this.trail.length > 1) {
      ctx.strokeStyle = this.config.trailColor || 'rgba(139, 69, 19, 0.3)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      
      ctx.beginPath();
      for (let i = 0; i < this.trail.length; i++) {
        const point = this.trail[i];
        const pointPos = {
          x: point.x * width,
          y: point.y * height
        };
        
        ctx.globalAlpha = point.alpha * this.alpha;
        
        if (i === 0) {
          ctx.moveTo(pointPos.x, pointPos.y);
        } else {
          ctx.lineTo(pointPos.x, pointPos.y);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = this.alpha;
    }
    
    // Draw arrow
    ctx.translate(pos.x, pos.y);
    
    // Apply wobble if stuck
    if (this.wobbleAmount !== 0) {
      ctx.rotate(this.wobbleAmount);
    }
    
    // Rotate to face direction
    if (this.rotation !== 0) {
      ctx.rotate(this.rotation);
    }
    
    // Draw arrow using emoji or shape
    if (this.projectileType === 'arrow') {
      // Draw arrow shape (reversed so point is at front)
      const arrowLength = this.size;
      const arrowWidth = this.size * 0.3;
      
      // Arrow shaft
      ctx.fillStyle = this.color;
      ctx.fillRect(-arrowLength * 0.2, -arrowWidth/8, arrowLength * 0.7, arrowWidth/4);
      
      // Arrow head (now at positive x, pointing forward)
      ctx.beginPath();
      ctx.moveTo(arrowLength/2, 0);  // Tip of arrow
      ctx.lineTo(arrowLength/2 - arrowLength * 0.3, -arrowWidth/2);
      ctx.lineTo(arrowLength/2 - arrowLength * 0.3, -arrowWidth/4);
      ctx.lineTo(arrowLength/2 - arrowLength * 0.15, 0);
      ctx.closePath();
      ctx.fill();
      
      ctx.beginPath();
      ctx.moveTo(arrowLength/2, 0);  // Tip of arrow
      ctx.lineTo(arrowLength/2 - arrowLength * 0.3, arrowWidth/2);
      ctx.lineTo(arrowLength/2 - arrowLength * 0.3, arrowWidth/4);
      ctx.lineTo(arrowLength/2 - arrowLength * 0.15, 0);
      ctx.closePath();
      ctx.fill();
      
      // Arrow fletching (now at negative x, at the back)
      ctx.fillStyle = 'red';
      ctx.beginPath();
      ctx.moveTo(-arrowLength/2 + arrowLength * 0.3, 0);
      ctx.lineTo(-arrowLength/2 + arrowLength * 0.15, -arrowWidth/3);
      ctx.lineTo(-arrowLength/2, 0);
      ctx.closePath();
      ctx.fill();
      
      ctx.beginPath();
      ctx.moveTo(-arrowLength/2 + arrowLength * 0.3, 0);
      ctx.lineTo(-arrowLength/2 + arrowLength * 0.15, arrowWidth/3);
      ctx.lineTo(-arrowLength/2, 0);
      ctx.closePath();
      ctx.fill();
    } else {
      // Fallback to emoji rendering
      ctx.font = `${this.size}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emoji, 0, 0);
    }
    
    // Draw impact effect
    if (this.hasImpacted && this.config.impactEffect) {
      const impactProgress = Math.min((this.elapsed - this.impactTime) / 200, 1);
      if (impactProgress < 1) {
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = (1 - impactProgress) * this.alpha;
        ctx.beginPath();
        ctx.arc(0, 0, this.size * impactProgress * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    
    ctx.restore();
  }

  public cleanup(): void {
    this.trail = [];
  }
}