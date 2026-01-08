import { BaseEffect, EffectConfig } from './BaseEffect';

interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  color: string;
  rotation: number;
  rotationSpeed: number;
  life: number;
  shape: 'rectangle' | 'circle';
}

export class ConfettiEffect extends BaseEffect {
  private particles: ConfettiParticle[];
  private particleCount: number;
  private colors: string[];
  private gravity: number;
  private spread: number;

  constructor(config: EffectConfig) {
    super(config);
    
    this.particleCount = config.particleCount || 50;
    this.colors = config.colors || [
      '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57',
      '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3', '#ff9f43',
      '#10ac84', '#ee5253', '#0abde3', '#5f27cd', '#a55eea'
    ];
    this.gravity = 0.3;
    this.spread = config.spread || 60; // degrees
    
    this.particles = [];
    this.initializeParticles();
  }

  private initializeParticles(): void {
    const spreadRadians = (this.spread * Math.PI) / 180;
    
    for (let i = 0; i < this.particleCount; i++) {
      // Create particles with upward initial velocity and spread
      const angle = -Math.PI / 2 + this.randomInRange(-spreadRadians / 2, spreadRadians / 2);
      const velocity = this.randomInRange(8, 15);
      
      this.particles.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * velocity + this.randomInRange(-2, 2),
        vy: Math.sin(angle) * velocity,
        width: this.randomInRange(4, 12),
        height: this.randomInRange(4, 12),
        color: this.colors[Math.floor(Math.random() * this.colors.length)],
        rotation: this.randomInRange(0, Math.PI * 2),
        rotationSpeed: this.randomInRange(-0.2, 0.2),
        life: 1,
        shape: Math.random() > 0.5 ? 'rectangle' : 'circle'
      });
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    // Update each particle
    this.particles.forEach(particle => {
      // Apply physics
      particle.x += particle.vx * (deltaTime / 16);
      particle.y += particle.vy * (deltaTime / 16);
      particle.vy += this.gravity; // Gravity
      
      // Apply air resistance
      particle.vx *= 0.995;
      particle.vy *= 0.995;
      
      // Update rotation
      particle.rotation += particle.rotationSpeed * (deltaTime / 16);
      
      // Fade out more slowly for longer lasting effect
      particle.life = Math.max(0, 1 - progress * 0.8);
    });
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const pos = this.getAbsolutePosition(width, height);
    // console.log(`🎉 ConfettiEffect: Rendering confetti at position:`, pos, `alpha: ${this.alpha}, particles: ${this.particles.length}`);
    
    ctx.save();
    ctx.globalAlpha = this.alpha;
    
    // Render each particle
    this.particles.forEach((particle, index) => {
      if (particle.life > 0) {
        const particleX = pos.x + particle.x;
        const particleY = pos.y + particle.y;
        
        ctx.save();
        ctx.globalAlpha = particle.life * this.alpha;
        ctx.fillStyle = particle.color;
        
        // Move to particle position and rotate
        ctx.translate(particleX, particleY);
        ctx.rotate(particle.rotation);
        
        if (particle.shape === 'rectangle') {
          // Draw rectangle
          ctx.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
        } else {
          // Draw circle
          ctx.beginPath();
          ctx.arc(0, 0, Math.min(particle.width, particle.height) / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        
        ctx.restore();
        
        if (index === 0) {
          // console.log(`🎉 ConfettiEffect: Drew particle at (${particleX}, ${particleY}) with life ${particle.life}`);
        }
      }
    });
    
    ctx.restore();
    // console.log(`🎉 ConfettiEffect: Render complete`);
  }
}