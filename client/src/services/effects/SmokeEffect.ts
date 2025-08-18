import { BaseEffect, EffectConfig } from './BaseEffect';

interface SmokeParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  life: number;
  maxLife: number;
  color: { r: number; g: number; b: number };
  turbulencePhase: number;
  swirl: number;
  growthRate: number;
}

interface SmokeCloud {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  maxSize: number;
  opacity: number;
  life: number;
  maxLife: number;
  rotation: number;
  rotationSpeed: number;
  turbulence: number;
  pulsePhase: number;
  color: { r: number; g: number; b: number };
}

export class SmokeEffect extends BaseEffect {
  private particles: SmokeParticle[];
  private clouds: SmokeCloud[];
  private effectType: 'puff' | 'persistent';
  private turbulenceStrength: number;
  private windDirection: { x: number; y: number };
  private time: number;
  private noiseGrid: number[][] = [];
  private gridSize: number;

  constructor(config: EffectConfig & {
    effectType?: 'puff' | 'persistent';
    particleCount?: number;
    cloudCount?: number;
    turbulenceStrength?: number;
    windDirection?: { x: number; y: number };
    color?: { r: number; g: number; b: number };
  }) {
    super(config);
    
    console.log(`🔥 SMOKE: Starting constructor for ${config.effectType || 'puff'} smoke effect`);
    
    this.effectType = config.effectType || 'puff';
    this.turbulenceStrength = config.turbulenceStrength || 0.3;
    this.windDirection = config.windDirection || { x: 0.2, y: -0.1 };
    this.time = 0;
    this.gridSize = 20;
    
    this.particles = [];
    this.clouds = [];
    
    console.log(`🔥 SMOKE: Creating ${this.effectType} smoke effect with config:`, config);
    
    try {
      // Initialize noise grid for turbulence
      this.initializeNoiseGrid();
      
      if (this.effectType === 'puff') {
        this.initializeSmokeParticles(config.particleCount || 40);
        console.log(`🔥 SMOKE: Created ${this.particles.length} puff particles`);
      } else {
        this.initializeSmokeClouds(config.cloudCount || 12);
        console.log(`🔥 SMOKE: Created ${this.clouds.length} persistent clouds`);
      }
      
      console.log(`🔥 SMOKE: Constructor completed successfully for ${this.effectType}`);
    } catch (error) {
      console.error('🔥 SMOKE: ERROR in constructor initialization:', error);
      // Initialize with empty arrays to prevent crashes
      this.particles = [];
      this.clouds = [];
      this.noiseGrid = [];
    }
  }

  private initializeNoiseGrid(): void {
    this.noiseGrid = [];
    for (let x = 0; x < this.gridSize; x++) {
      this.noiseGrid[x] = [];
      for (let y = 0; y < this.gridSize; y++) {
        this.noiseGrid[x][y] = Math.random() * 2 - 1; // -1 to 1
      }
    }
  }

  private sampleNoise(x: number, y: number): number {
    const gx = Math.floor(x * this.gridSize) % this.gridSize;
    const gy = Math.floor(y * this.gridSize) % this.gridSize;
    const gx2 = (gx + 1) % this.gridSize;
    const gy2 = (gy + 1) % this.gridSize;
    
    const fx = (x * this.gridSize) % 1;
    const fy = (y * this.gridSize) % 1;
    
    // Bilinear interpolation
    const n00 = this.noiseGrid[gx][gy];
    const n10 = this.noiseGrid[gx2][gy];
    const n01 = this.noiseGrid[gx][gy2];
    const n11 = this.noiseGrid[gx2][gy2];
    
    const nx0 = n00 * (1 - fx) + n10 * fx;
    const nx1 = n01 * (1 - fx) + n11 * fx;
    
    return nx0 * (1 - fy) + nx1 * fy;
  }

  private initializeSmokeParticles(count: number): void {
    const baseColor = { r: 120, g: 120, b: 120 }; // Lighter gray smoke
    
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 1.5; // Even wider spread for dramatic puffs
      const speed = this.randomInRange(12, 35); // Very fast initial explosion
      
      this.particles.push({
        x: this.randomInRange(-100, 100), // Huge spread for dramatic puffs
        y: this.randomInRange(-50, 50),
        vx: Math.cos(angle) * speed * radius,
        vy: Math.sin(angle) * speed * radius - 8, // Strong upward burst
        size: this.randomInRange(80, 150), // Even larger particles
        opacity: this.randomInRange(0.6, 0.9), // Good visibility but not too opaque
        life: 1,
        maxLife: this.randomInRange(2000, 3500), // Shorter life for quick dissipation
        color: {
          r: baseColor.r + this.randomInRange(-30, 30),
          g: baseColor.g + this.randomInRange(-30, 30),
          b: baseColor.b + this.randomInRange(-30, 30)
        },
        turbulencePhase: Math.random() * Math.PI * 2,
        swirl: this.randomInRange(-0.5, 0.5), // Much more dramatic swirling
        growthRate: this.randomInRange(0.12, 0.25) // Rapid expansion and dissipation
      });
    }
  }

  private initializeSmokeClouds(count: number): void {
    const baseColor = { r: 60, g: 60, b: 60 }; // Darker for better visibility
    
    for (let i = 0; i < count; i++) {
      // Spread clouds across the entire screen area
      const x = this.randomInRange(-0.6, 0.6); // Screen relative coordinates
      const y = this.randomInRange(-0.4, 0.4);
      
      this.clouds.push({
        x: x,
        y: y,
        vx: this.randomInRange(-1, 1), // More movement
        vy: this.randomInRange(-0.8, 0.2), // Generally upward but some variation
        size: this.randomInRange(80, 150), // Start larger
        maxSize: this.randomInRange(200, 400), // Grow much larger
        opacity: this.randomInRange(0.6, 0.9), // More opaque
        life: this.duration, // Live for full duration
        maxLife: this.duration,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: this.randomInRange(-0.02, 0.02), // More rotation
        turbulence: this.randomInRange(1.0, 2.0), // More turbulence
        pulsePhase: Math.random() * Math.PI * 2,
        color: {
          r: baseColor.r + this.randomInRange(-40, 20),
          g: baseColor.g + this.randomInRange(-40, 20),
          b: baseColor.b + this.randomInRange(-40, 20)
        }
      });
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    try {
      this.time += deltaTime;
      
      if (this.effectType === 'puff') {
        this.updateSmokeParticles(deltaTime, progress);
      } else {
        this.updateSmokeClouds(deltaTime, progress);
      }
    } catch (error) {
      console.error('🔥 SMOKE: ERROR in updateEffect:', error);
    }
  }

  private updateSmokeParticles(deltaTime: number, progress: number): void {
    this.particles.forEach(particle => {
      // Much stronger turbulence for animated puffs
      const turbulenceX = this.sampleNoise(
        particle.x * 0.008 + this.time * 0.003,
        particle.y * 0.008 + this.time * 0.002
      ) * this.turbulenceStrength * 2;
      
      const turbulenceY = this.sampleNoise(
        particle.x * 0.008 + this.time * 0.002,
        particle.y * 0.008 + this.time * 0.003
      ) * this.turbulenceStrength * 2;
      
      // Apply enhanced wind and turbulence
      particle.vx += (this.windDirection.x * 2 + turbulenceX) * (deltaTime / 16);
      particle.vy += (this.windDirection.y * 2 + turbulenceY) * (deltaTime / 16);
      
      // Much more dynamic swirling motion
      const swirlForce = particle.swirl * Math.sin(this.time * 0.015 + particle.turbulencePhase);
      const crossSwirl = particle.swirl * Math.cos(this.time * 0.012 + particle.turbulencePhase + Math.PI/2);
      particle.vx += swirlForce * (deltaTime / 16);
      particle.vy += crossSwirl * (deltaTime / 16);
      
      // Add pulsing motion for more animation
      const pulse = Math.sin(this.time * 0.02 + particle.turbulencePhase) * 0.5;
      particle.vx += pulse * (deltaTime / 16);
      particle.vy += pulse * 0.5 * (deltaTime / 16);
      
      // Update position with enhanced movement
      particle.x += particle.vx * (deltaTime / 16);
      particle.y += particle.vy * (deltaTime / 16);
      
      // Less drag for more movement
      particle.vx *= 0.98;
      particle.vy *= 0.985;
      
      // Rapid growth and then shrinkage for puff effect
      const lifeProgress = 1 - particle.life;
      if (lifeProgress < 0.3) {
        // Growing phase
        particle.size += particle.growthRate * (deltaTime / 16) * 2;
      } else {
        // Shrinking/dissipating phase
        particle.size += particle.growthRate * (deltaTime / 16) * 0.3;
      }
      
      // Update life and opacity with more dramatic fading
      particle.life = Math.max(0, particle.life - (deltaTime / particle.maxLife));
      
      // More dramatic opacity curve for puff effect
      if (particle.life > 0.7) {
        particle.opacity = particle.life * 0.9; // Quick fade in
      } else if (particle.life > 0.3) {
        particle.opacity = particle.life * 0.8; // Stable visibility
      } else {
        particle.opacity = particle.life * particle.life * 0.6; // Rapid fade out
      }
    });
    
    // Remove dead particles
    this.particles = this.particles.filter(p => p.life > 0);
  }

  private updateSmokeClouds(deltaTime: number, progress: number): void {
    this.clouds.forEach(cloud => {
      // Apply complex turbulence
      const turbulenceX = this.sampleNoise(
        cloud.x * 0.005 + this.time * 0.0005,
        cloud.y * 0.005
      ) * cloud.turbulence;
      
      const turbulenceY = this.sampleNoise(
        cloud.x * 0.005,
        cloud.y * 0.005 + this.time * 0.0005
      ) * cloud.turbulence;
      
      // Apply wind and turbulence
      cloud.vx += (this.windDirection.x * 0.5 + turbulenceX) * (deltaTime / 16);
      cloud.vy += (this.windDirection.y * 0.5 + turbulenceY) * (deltaTime / 16);
      
      // Add organic swirling motion
      const swirl = Math.sin(this.time * 0.003 + cloud.pulsePhase) * 0.2;
      cloud.vx += swirl * (deltaTime / 16);
      
      // Update position
      cloud.x += cloud.vx * (deltaTime / 16);
      cloud.y += cloud.vy * (deltaTime / 16);
      
      // Apply drag
      cloud.vx *= 0.98;
      cloud.vy *= 0.98;
      
      // Grow and pulse
      const growthProgress = Math.min(1, (this.duration - cloud.life) / (this.duration * 0.3));
      const targetSize = cloud.maxSize * growthProgress;
      const pulse = Math.sin(this.time * 0.005 + cloud.pulsePhase) * 0.1 + 1;
      cloud.size = targetSize * pulse;
      
      // Update rotation
      cloud.rotation += cloud.rotationSpeed * (deltaTime / 16);
      
      // Update opacity with complex fading
      const fadeIn = Math.min(1, (this.duration - cloud.life) / (this.duration * 0.2));
      const fadeOut = progress > 0.8 ? Math.max(0, (1 - progress) / 0.2) : 1;
      cloud.opacity = fadeIn * fadeOut * 0.6;
      
      // Update life
      cloud.life = Math.max(0, cloud.life - deltaTime);
    });
    
    // Remove dead clouds
    this.clouds = this.clouds.filter(c => c.life > 0);
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    try {
      const pos = this.getAbsolutePosition(width, height);
      
      ctx.save();
      
      if (this.effectType === 'puff') {
        this.renderSmokeParticles(ctx, pos, width, height);
      } else {
        this.renderSmokeClouds(ctx, pos, width, height);
      }
      
      ctx.restore();
    } catch (error) {
      console.error('🔥 SMOKE: ERROR in render:', error);
      ctx.restore(); // Make sure we restore context even on error
    }
  }

  private renderSmokeParticles(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, width: number, height: number): void {
    // Use additive blending for more dramatic smoke buildup
    ctx.globalCompositeOperation = 'multiply';
    
    this.particles.forEach(particle => {
      if (particle.life <= 0) return;
      
      const x = pos.x + particle.x;
      const y = pos.y + particle.y;
      
      ctx.save();
      ctx.globalAlpha = particle.opacity * this.alpha;
      
      // Create many more overlapping circles for ultra-dense smoke
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const offsetRadius = particle.size * 0.4;
        const offsetX = Math.cos(angle) * offsetRadius;
        const offsetY = Math.sin(angle) * offsetRadius;
        const currentSize = particle.size * (1.2 + i * 0.1);
        
        // Create radial gradient for soft smoke effect
        const gradient = ctx.createRadialGradient(
          x + offsetX, y + offsetY, 0, 
          x + offsetX, y + offsetY, currentSize
        );
        gradient.addColorStop(0, `rgba(${particle.color.r}, ${particle.color.g}, ${particle.color.b}, ${1.0 - i * 0.1})`);
        gradient.addColorStop(0.3, `rgba(${particle.color.r}, ${particle.color.g}, ${particle.color.b}, ${0.7 - i * 0.1})`);
        gradient.addColorStop(0.7, `rgba(${particle.color.r}, ${particle.color.g}, ${particle.color.b}, ${0.3 - i * 0.05})`);
        gradient.addColorStop(1, `rgba(${particle.color.r}, ${particle.color.g}, ${particle.color.b}, 0)`);
        
        ctx.fillStyle = gradient;
        
        ctx.beginPath();
        ctx.arc(x + offsetX, y + offsetY, currentSize, 0, Math.PI * 2);
        ctx.fill();
      }
      
      ctx.restore();
    });
    
    ctx.globalCompositeOperation = 'source-over'; // Reset blend mode
    
    if (this.particles.length > 0 && Math.random() < 0.1) {
      console.log(`🔥 SMOKE: Rendered ${this.particles.length} puff particles`);
    }
  }

  private renderSmokeClouds(ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, width: number, height: number): void {
    this.clouds.forEach((cloud, index) => {
      if (cloud.life <= 0) return;
      
      // Position clouds across the screen
      const x = width * 0.5 + cloud.x * width;
      const y = height * 0.5 + cloud.y * height;
      
      ctx.save();
      ctx.globalAlpha = cloud.opacity * this.alpha;
      ctx.translate(x, y);
      ctx.rotate(cloud.rotation);
      
      // Create multiple layers for thick smoke
      for (let layer = 0; layer < 4; layer++) {
        const layerSize = cloud.size * (1 + layer * 0.3);
        const layerOpacity = (0.8 - layer * 0.15);
        
        // Create complex smoke cloud shape
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, layerSize);
        gradient.addColorStop(0, `rgba(${cloud.color.r}, ${cloud.color.g}, ${cloud.color.b}, ${layerOpacity})`);
        gradient.addColorStop(0.3, `rgba(${cloud.color.r}, ${cloud.color.g}, ${cloud.color.b}, ${layerOpacity * 0.7})`);
        gradient.addColorStop(0.6, `rgba(${cloud.color.r}, ${cloud.color.g}, ${cloud.color.b}, ${layerOpacity * 0.3})`);
        gradient.addColorStop(1, `rgba(${cloud.color.r}, ${cloud.color.g}, ${cloud.color.b}, 0)`);
        
        ctx.fillStyle = gradient;
        
        // Draw organic cloud shape with multiple overlapping circles
        this.drawOrganicCloud(ctx, layer * 10, layer * 5, layerSize);
      }
      
      ctx.restore();
    });
    
    if (this.clouds.length > 0 && Math.random() < 0.1) { // Only log 10% of the time
      console.log(`🔥 SMOKE: Rendered ${this.clouds.length} persistent clouds`);
    }
  }

  private drawOrganicCloud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    const numCircles = 12; // More circles for better shape
    const baseRadius = size * 0.5;
    
    for (let i = 0; i < numCircles; i++) {
      const angle = (i / numCircles) * Math.PI * 2;
      const radius = baseRadius + Math.sin(this.time * 0.001 + i * 0.5) * baseRadius * 0.4;
      const distance = size * (0.3 + Math.sin(this.time * 0.0015 + i) * 0.2);
      const offsetX = Math.cos(angle) * distance;
      const offsetY = Math.sin(angle) * distance;
      
      ctx.beginPath();
      ctx.arc(x + offsetX, y + offsetY, radius * (0.8 + Math.sin(this.time * 0.002 + i) * 0.2), 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Add central core
    ctx.beginPath();
    ctx.arc(x, y, baseRadius * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }

  public isComplete(): boolean {
    if (this.effectType === 'puff') {
      return this.particles.length === 0;
    } else {
      return this.clouds.length === 0 || this.elapsed >= this.duration;
    }
  }
}