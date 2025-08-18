import { BaseEffect, EffectConfig } from './BaseEffect';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  color: string;
}

interface DripParticle {
  x: number;
  y: number;
  vy: number;
  size: number;
  length: number;
  alpha: number;
}

export class SplatEffect extends BaseEffect {
  private color: string;
  private splashColor: string;
  private particleCount: number;
  private size: string;
  private particles: Particle[];
  private drips: DripParticle[];
  private splatRadius: number;
  private maxSplatRadius: number;
  private splatGrowthRate: number;
  private enableDrip: boolean;
  private centerAlpha: number;

  constructor(config: EffectConfig) {
    super(config);
    
    this.color = config.color || '#ff4444';
    this.splashColor = config.splashColor || '#cc0000';
    this.particleCount = config.particles || 12;
    this.size = config.size || 'large';
    this.enableDrip = config.drip !== false;
    
    // Calculate splat size based on config
    this.maxSplatRadius = this.size === 'small' ? 30 : this.size === 'large' ? 80 : 50;
    this.splatRadius = 0;
    this.splatGrowthRate = this.maxSplatRadius / 150; // Reach max size in 150ms
    this.centerAlpha = 1;
    
    // Initialize particles
    this.particles = [];
    this.drips = [];
    this.initializeParticles();
  }

  private initializeParticles(): void {
    // Create splash particles
    for (let i = 0; i < this.particleCount; i++) {
      const angle = (Math.PI * 2 * i) / this.particleCount + this.randomInRange(-0.2, 0.2);
      const velocity = this.randomInRange(2, 5);
      
      this.particles.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - this.randomInRange(1, 3), // Upward bias
        size: this.randomInRange(3, 8),
        life: 1,
        color: Math.random() > 0.5 ? this.color : this.splashColor
      });
    }
    
    // Create drip particles if enabled
    if (this.enableDrip) {
      const dripCount = Math.floor(this.randomInRange(2, 5));
      for (let i = 0; i < dripCount; i++) {
        this.drips.push({
          x: this.randomInRange(-20, 20),
          y: 0,
          vy: 0,
          size: this.randomInRange(4, 8),
          length: 0,
          alpha: 1
        });
      }
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    // Update splat growth
    if (this.splatRadius < this.maxSplatRadius) {
      this.splatRadius += this.splatGrowthRate * deltaTime;
    }
    
    // Fade center splat after initial impact
    if (progress > 0.1) {
      this.centerAlpha = Math.max(0, 1 - (progress - 0.1) * 1.2);
    }
    
    // Update particles
    this.particles.forEach(particle => {
      // Apply physics
      particle.x += particle.vx * (deltaTime / 16);
      particle.y += particle.vy * (deltaTime / 16);
      particle.vy += 0.3; // Gravity
      
      // Reduce velocity over time (air resistance)
      particle.vx *= 0.98;
      particle.vy *= 0.98;
      
      // Fade out
      particle.life = Math.max(0, 1 - progress * 1.5);
    });
    
    // Update drips
    if (this.enableDrip && progress > 0.2) {
      this.drips.forEach(drip => {
        // Start dripping after splat
        drip.vy += 0.2; // Gravity for drips
        drip.y += drip.vy * (deltaTime / 16);
        drip.length = Math.min(30, drip.length + drip.vy * 0.5);
        
        // Fade drips
        drip.alpha = Math.max(0, 1 - (progress - 0.2) * 1.5);
      });
    }
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    // console.log(`🍅 SplatEffect: Rendering splat at position:`, pos, `alpha: ${this.alpha}, radius: ${this.splatRadius}, canvas: ${width}x${height}`);
    
    ctx.save();
    ctx.globalAlpha = this.alpha;
    
    // Draw simple test circle first to verify rendering
    ctx.fillStyle = '#ff0000'; // Bright red for visibility
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 20, 0, Math.PI * 2);
    ctx.fill();
    
    // console.log(`🍅 SplatEffect: Drew test circle at (${pos.x}, ${pos.y})`);
    
    // Draw main splat (circular gradient)
    if (this.centerAlpha > 0 && this.splatRadius > 0) {
      try {
        const gradient = ctx.createRadialGradient(
          pos.x, pos.y, 0,
          pos.x, pos.y, this.splatRadius
        );
        
        gradient.addColorStop(0, this.color + 'ff');
        gradient.addColorStop(0.6, this.splashColor + 'cc');
        gradient.addColorStop(1, this.splashColor + '00');
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, this.splatRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // console.log(`🍅 SplatEffect: Drew gradient splat with radius ${this.splatRadius}`);
      } catch (error) {
        console.error('🍅 SplatEffect: Error drawing gradient:', error);
      }
    }
    
    // Draw particles
    this.particles.forEach((particle, index) => {
      if (particle.life > 0) {
        try {
          ctx.save();
          ctx.globalAlpha = particle.life * this.alpha;
          ctx.fillStyle = particle.color;
          ctx.beginPath();
          ctx.arc(
            pos.x + particle.x,
            pos.y + particle.y,
            particle.size,
            0,
            Math.PI * 2
          );
          ctx.fill();
          ctx.restore();
          
          if (index === 0) {
            // console.log(`🍅 SplatEffect: Drew particle at (${pos.x + particle.x}, ${pos.y + particle.y})`);
          }
        } catch (error) {
          console.error('🍅 SplatEffect: Error drawing particle:', error);
        }
      }
    });
    
    // Draw drips (simplified)
    if (this.enableDrip) {
      this.drips.forEach((drip, index) => {
        if (drip.alpha > 0 && drip.length > 0) {
          try {
            ctx.save();
            ctx.globalAlpha = drip.alpha * this.alpha * 0.7;
            ctx.strokeStyle = this.splashColor;
            ctx.lineWidth = drip.size;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(pos.x + drip.x, pos.y);
            ctx.lineTo(pos.x + drip.x, pos.y + drip.y);
            ctx.stroke();
            ctx.restore();
            
            if (index === 0) {
              // console.log(`🍅 SplatEffect: Drew drip from (${pos.x + drip.x}, ${pos.y}) to (${pos.x + drip.x}, ${pos.y + drip.y})`);
            }
          } catch (error) {
            console.error('🍅 SplatEffect: Error drawing drip:', error);
          }
        }
      });
    }
    
    ctx.restore();
    // console.log(`🍅 SplatEffect: Render complete`);
  }
}