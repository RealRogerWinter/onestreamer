import { BaseEffect, EffectConfig } from './BaseEffect';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rotation: number;
  rotationSpeed: number;
  life: number;
  type: 'square' | 'circle' | 'star' | 'line';
}

export class ParticleEffect extends BaseEffect {
  private particles: Particle[];
  private colors: string[];
  private particleCount: number;
  private spread: number;
  private startVelocity: number;
  private gravity: number;
  private animation: string;

  constructor(config: EffectConfig) {
    super(config);
    
    this.colors = config.colors || ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    this.particleCount = config.particleCount || 30;
    this.spread = config.spread || 360;
    this.startVelocity = config.startVelocity || 20;
    this.gravity = config.gravity || 0.3;
    this.animation = config.animation || 'confetti';
    
    this.particles = [];
    this.initializeParticles();
  }

  private initializeParticles(): void {
    const spreadRad = (this.spread * Math.PI) / 180;
    const baseAngle = -Math.PI / 2; // Start from top
    
    for (let i = 0; i < this.particleCount; i++) {
      let angle: number;
      let velocity: number;
      let particleType: 'square' | 'circle' | 'star' | 'line';
      
      if (this.animation === 'speedLines') {
        // Speed lines effect - horizontal lines
        angle = Math.random() > 0.5 ? 0 : Math.PI; // Left or right
        velocity = this.startVelocity * this.randomInRange(1, 3);
        particleType = 'line';
      } else if (this.animation === 'confetti') {
        // Confetti effect - upward burst
        angle = baseAngle - spreadRad / 2 + Math.random() * spreadRad;
        velocity = this.startVelocity * this.randomInRange(0.5, 1.5);
        particleType = Math.random() > 0.5 ? 'square' : 'circle';
      } else if (this.animation === 'disco') {
        // Disco ball effect - sparkles radiating outward
        angle = Math.random() * Math.PI * 2;
        velocity = this.startVelocity * this.randomInRange(0.3, 1.2);
        particleType = Math.random() > 0.7 ? 'star' : 'circle';
      } else if (this.animation === 'smoke-puff') {
        // Smoke puff effect - expanding outward and upward with drift
        angle = baseAngle + this.randomInRange(-Math.PI/3, Math.PI/3); // Mostly upward with some spread
        velocity = this.startVelocity * this.randomInRange(0.3, 0.8); // Slower than confetti
        particleType = 'circle';
      } else {
        // Default particle burst
        angle = Math.random() * Math.PI * 2;
        velocity = this.startVelocity * this.randomInRange(0.5, 1.5);
        particleType = 'circle';
      }
      
      this.particles.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        size: this.animation === 'disco' ? this.randomInRange(4, 12) : this.randomInRange(3, 8),
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: this.animation === 'disco' ? this.randomInRange(-0.3, 0.3) : this.randomInRange(-0.2, 0.2),
        life: 1,
        type: particleType
      });
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    this.particles.forEach(particle => {
      // Update position
      particle.x += particle.vx * (deltaTime / 16);
      particle.y += particle.vy * (deltaTime / 16);
      
      // Apply gravity (except for speed lines and disco)
      if (this.animation !== 'speedLines' && this.animation !== 'disco') {
        particle.vy += this.gravity;
      }
      
      // Update rotation
      particle.rotation += particle.rotationSpeed;
      
      // Apply drag
      if (this.animation === 'disco') {
        particle.vx *= 0.97; // More drag for disco effect
        particle.vy *= 0.97;
      } else {
        particle.vx *= 0.99;
        if (this.animation !== 'speedLines') {
          particle.vy *= 0.99;
        }
      }
      
      // Fade out
      if (this.animation === 'speedLines') {
        particle.life = Math.max(0, 1 - progress * 2); // Fade faster for speed lines
      } else if (this.animation === 'disco') {
        particle.life = Math.max(0, 1 - progress * 0.8); // Slower fade for disco
      } else {
        particle.life = Math.max(0, 1 - progress);
      }
    });
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    
    ctx.save();
    
    this.particles.forEach(particle => {
      if (particle.life <= 0) return;
      
      ctx.save();
      ctx.globalAlpha = particle.life * this.alpha;
      ctx.fillStyle = particle.color;
      ctx.strokeStyle = particle.color;
      
      const x = pos.x + particle.x;
      const y = pos.y + particle.y;
      
      ctx.translate(x, y);
      ctx.rotate(particle.rotation);
      
      switch (particle.type) {
        case 'square':
          ctx.fillRect(
            -particle.size / 2,
            -particle.size / 2,
            particle.size,
            particle.size
          );
          break;
          
        case 'circle':
          ctx.beginPath();
          ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
          ctx.fill();
          
          // Add extra glow for disco circles
          if (this.animation === 'disco') {
            ctx.shadowColor = particle.color;
            ctx.shadowBlur = particle.size;
            ctx.globalAlpha = particle.life * this.alpha * 0.5;
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(0, 0, particle.size / 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
          break;
          
        case 'star':
          this.drawStar(ctx, 0, 0, particle.size / 2);
          
          // Add sparkle effect for disco stars
          if (this.animation === 'disco') {
            ctx.shadowColor = particle.color;
            ctx.shadowBlur = particle.size * 2;
            ctx.fillStyle = 'white';
            ctx.beginPath();
            ctx.arc(0, 0, particle.size / 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
          break;
          
        case 'line':
          ctx.lineWidth = particle.size / 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-particle.size * 2, 0);
          ctx.lineTo(particle.size * 2, 0);
          ctx.stroke();
          
          // Add motion blur effect for speed lines
          if (this.animation === 'speedLines') {
            ctx.globalAlpha = particle.life * this.alpha * 0.3;
            ctx.lineWidth = particle.size;
            ctx.beginPath();
            ctx.moveTo(-particle.size * 4, 0);
            ctx.lineTo(particle.size * 4, 0);
            ctx.stroke();
          }
          break;
      }
      
      ctx.restore();
    });
    
    ctx.restore();
  }

  private drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
    const spikes = 5;
    const outerRadius = radius;
    const innerRadius = radius * 0.5;
    
    ctx.beginPath();
    
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (i * Math.PI) / spikes - Math.PI / 2;
      const r = i % 2 === 0 ? outerRadius : innerRadius;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    
    ctx.closePath();
    ctx.fill();
  }
}