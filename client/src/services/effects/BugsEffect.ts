import { BaseEffect, EffectConfig } from './BaseEffect';

interface BugsConfig extends EffectConfig {
  config: {
    bugType?: string;
    bugCount?: number;
    bugTypes?: string[];
    minSpeed?: number;
    maxSpeed?: number;
    wiggleAmount?: number;
    turnSpeed?: number;
    sizeVariation?: number;
    opacity?: number;
    shadowEffect?: boolean;
    scatterOnClick?: boolean;
    fadeOut?: boolean;
    fadeStartTime?: number;
  };
}

interface Bug {
  id: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  angle: number;
  speed: number;
  size: number;
  emoji: string;
  wigglePhase: number;
  turnDirection: number;
  opacity: number;
  isScattering: boolean;
  legPhase: number;
  antennaePhase: number;
}

export class BugsEffect extends BaseEffect {
  private config: BugsConfig['config'];
  private bugs: Bug[] = [];
  private bugCount: number;
  private bugTypes: string[];
  private fadeStartTime: number;
  private time: number = 0;

  constructor(config: BugsConfig) {
    super(config);
    this.config = config.config;
    this.bugCount = this.config.bugCount || 15;
    this.bugTypes = this.config.bugTypes || ['🐛', '🐜', '🕷️', '🦗', '🪲', '🪳', '🦟', '🐞'];
    this.fadeStartTime = this.config.fadeStartTime || 13000;
    
    // Initialize bugs
    this.initializeBugs();
  }

  private initializeBugs(): void {
    for (let i = 0; i < this.bugCount; i++) {
      const startFromEdge = Math.random() > 0.5;
      let x, y;
      
      if (startFromEdge) {
        // Start from edges of screen
        const edge = Math.floor(Math.random() * 4);
        switch(edge) {
          case 0: // Top
            x = Math.random();
            y = 0;
            break;
          case 1: // Right
            x = 1;
            y = Math.random();
            break;
          case 2: // Bottom
            x = Math.random();
            y = 1;
            break;
          case 3: // Left
          default:
            x = 0;
            y = Math.random();
            break;
        }
      } else {
        // Start randomly on screen
        x = Math.random();
        y = Math.random();
      }
      
      this.bugs.push({
        id: i,
        x: x,
        y: y,
        targetX: Math.random(),
        targetY: Math.random(),
        angle: Math.random() * Math.PI * 2,
        speed: this.randomInRange(this.config.minSpeed || 0.5, this.config.maxSpeed || 2),
        size: 1 + (Math.random() - 0.5) * (this.config.sizeVariation || 0.5),
        emoji: this.bugTypes[Math.floor(Math.random() * this.bugTypes.length)],
        wigglePhase: Math.random() * Math.PI * 2,
        turnDirection: Math.random() > 0.5 ? 1 : -1,
        opacity: this.config.opacity || 0.9,
        isScattering: false,
        legPhase: Math.random() * Math.PI * 2,
        antennaePhase: Math.random() * Math.PI * 2
      });
    }
  }

  protected updateEffect(deltaTime: number, progress: number): void {
    this.time += deltaTime;
    
    // Update fade out
    if (this.config.fadeOut && this.elapsed > this.fadeStartTime) {
      const fadeProgress = (this.elapsed - this.fadeStartTime) / (this.duration - this.fadeStartTime);
      this.alpha = Math.max(0, 1 - fadeProgress);
    }
    
    // Update each bug
    this.bugs.forEach(bug => {
      // Update wiggle phase for organic movement
      bug.wigglePhase += deltaTime * 0.005;
      bug.legPhase += deltaTime * 0.01;
      bug.antennaePhase += deltaTime * 0.008;
      
      // Check if bug reached its target
      const dx = bug.targetX - bug.x;
      const dy = bug.targetY - bug.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < 0.02 || Math.random() < 0.001) {
        // Pick new random target
        bug.targetX = Math.random();
        bug.targetY = Math.random();
        bug.turnDirection = Math.random() > 0.5 ? 1 : -1;
        
        // Occasionally change speed
        if (Math.random() < 0.3) {
          bug.speed = this.randomInRange(this.config.minSpeed || 0.5, this.config.maxSpeed || 2);
        }
      }
      
      // Calculate desired angle to target
      const targetAngle = Math.atan2(dy, dx);
      
      // Smoothly turn towards target
      let angleDiff = targetAngle - bug.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      
      bug.angle += angleDiff * (this.config.turnSpeed || 0.02);
      
      // Add wiggle to movement
      const wiggle = Math.sin(bug.wigglePhase) * (this.config.wiggleAmount || 5) * 0.0001;
      const perpAngle = bug.angle + Math.PI / 2;
      
      // Move bug
      const moveSpeed = bug.speed * deltaTime * 0.00005;
      bug.x += Math.cos(bug.angle) * moveSpeed + Math.cos(perpAngle) * wiggle;
      bug.y += Math.sin(bug.angle) * moveSpeed + Math.sin(perpAngle) * wiggle;
      
      // Keep bugs on screen with wrapping
      if (bug.x < -0.05) bug.x = 1.05;
      if (bug.x > 1.05) bug.x = -0.05;
      if (bug.y < -0.05) bug.y = 1.05;
      if (bug.y > 1.05) bug.y = -0.05;
      
      // Random direction changes for more organic movement
      if (Math.random() < 0.002) {
        bug.angle += (Math.random() - 0.5) * Math.PI * 0.5;
      }
      
      // Update opacity based on fade
      bug.opacity = (this.config.opacity || 0.9) * this.alpha;
    });
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    ctx.save();
    
    this.bugs.forEach(bug => {
      const x = bug.x * width;
      const y = bug.y * height;
      const size = 30 * bug.size;
      
      ctx.globalAlpha = bug.opacity;
      
      // Draw shadow if enabled
      if (this.config.shadowEffect) {
        ctx.save();
        ctx.globalAlpha = bug.opacity * 0.3;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.translate(x + 3, y + 3);
        ctx.rotate(bug.angle);
        ctx.scale(1.2, 0.6);
        ctx.beginPath();
        ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      
      // Draw bug body (before emoji for additional details)
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(bug.angle);
      
      // Draw legs (animated)
      if (bug.emoji === '🕷️' || bug.emoji === '🐜') {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 1;
        
        // Draw multiple legs
        for (let i = 0; i < 6; i++) {
          const legAngle = (i - 2.5) * 0.3;
          const legMovement = Math.sin(bug.legPhase + i) * 0.2;
          
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(
            Math.cos(legAngle + legMovement) * size * 0.7,
            Math.sin(legAngle + legMovement) * size * 0.7
          );
          ctx.stroke();
        }
      }
      
      // Draw antennae for certain bugs
      if (bug.emoji === '🐜' || bug.emoji === '🦗') {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.lineWidth = 1;
        
        const antennaeWave = Math.sin(bug.antennaePhase) * 0.1;
        
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(
          size * 0.3,
          -size * 0.3,
          size * 0.5 + Math.cos(bug.antennaePhase) * size * 0.1,
          -size * 0.5
        );
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(
          -size * 0.3,
          -size * 0.3,
          -size * 0.5 - Math.cos(bug.antennaePhase) * size * 0.1,
          -size * 0.5
        );
        ctx.stroke();
      }
      
      ctx.restore();
      
      // Draw bug emoji
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(bug.angle - Math.PI / 2); // Adjust rotation so bugs face forward
      ctx.font = `${size}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(bug.emoji, 0, 0);
      ctx.restore();
      
      // Draw creepy eyes for spiders
      if (bug.emoji === '🕷️') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(bug.angle);
        
        // Multiple spider eyes
        ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
        for (let i = 0; i < 4; i++) {
          const eyeX = (i - 1.5) * size * 0.15;
          const eyeY = -size * 0.2;
          ctx.beginPath();
          ctx.arc(eyeX, eyeY, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        
        ctx.restore();
      }
    });
    
    ctx.restore();
  }

  public cleanup(): void {
    this.bugs = [];
  }
}