/**
 * GameRenderer - Handles canvas rendering for the game
 */

import {
  PlayerState,
  WorldState,
  WorldItem,
  Camera,
  CameraTransform,
  VisibleBounds
} from '../../types/game';

interface RenderConfig {
  tileSize: number;
  spriteSize: number;
  showDebug: boolean;
}

export class GameRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private camera: Camera;
  private config: RenderConfig;
  private animationFrame: number = 0;
  private lastFrameTime: number = 0;
  private frameCount: number = 0;
  private fps: number = 0;
  private lastFpsUpdate: number = 0;

  // Sprite animation state
  private animationTime: number = 0;
  private readonly ANIMATION_FRAME_DURATION = 150; // ms per frame

  // Colors for tiles
  private readonly TILE_COLORS: Record<string, string> = {
    grass: '#4a7c23',
    path: '#8b7355',
    water: '#2d5a87',
    tree: '#2d5a2d',
    default: '#666666'
  };

  // Player colors for variety
  private readonly SPRITE_COLORS: Record<string, string> = {
    player_default: '#4ecdc4',
    player_blue: '#45b7d1',
    player_green: '#96ceb4',
    player_red: '#ff6b6b'
  };

  constructor(canvas: HTMLCanvasElement, localPlayerId: string, config?: Partial<RenderConfig>) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D context');
    }
    this.ctx = ctx;

    this.config = {
      tileSize: 32,
      spriteSize: 32,
      showDebug: false,
      ...config
    };

    this.camera = {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      targetPlayerId: localPlayerId,
      zoom: 1
    };
  }

  /**
   * Update camera to follow a player
   */
  updateCamera(player: PlayerState | null, worldBounds?: { width: number; height: number }): void {
    if (!player) return;

    // Center camera on player
    const targetX = player.x - this.canvas.width / 2;
    const targetY = player.y - this.canvas.height / 2;

    // Smooth camera movement
    this.camera.x += (targetX - this.camera.x) * 0.1;
    this.camera.y += (targetY - this.camera.y) * 0.1;

    // Clamp to world bounds
    if (worldBounds) {
      this.camera.x = Math.max(0, Math.min(worldBounds.width - this.canvas.width, this.camera.x));
      this.camera.y = Math.max(0, Math.min(worldBounds.height - this.canvas.height, this.camera.y));
    }
  }

  /**
   * Resize canvas to fit container
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.camera.width = width;
    this.camera.height = height;
  }

  /**
   * Get visible bounds based on camera position
   */
  getVisibleBounds(): VisibleBounds {
    return {
      left: this.camera.x,
      right: this.camera.x + this.canvas.width,
      top: this.camera.y,
      bottom: this.camera.y + this.canvas.height
    };
  }

  /**
   * Main render function
   */
  render(
    worldState: WorldState | null,
    players: Record<string, PlayerState>,
    items: WorldItem[],
    localPlayer: PlayerState | null,
    deltaTime: number
  ): void {
    // Update animation time
    this.animationTime += deltaTime * 1000;

    // Update camera
    this.updateCamera(localPlayer, worldState?.bounds);

    // Clear canvas
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Save context state
    this.ctx.save();

    // Apply camera transform
    this.ctx.translate(-this.camera.x, -this.camera.y);

    // Render layers
    if (worldState) {
      this.renderTiles(worldState);
      this.renderBuildings(worldState);
    }

    this.renderItems(items);
    this.renderPlayers(players, localPlayer?.id);

    // Restore context
    this.ctx.restore();

    // Render UI overlay (not affected by camera)
    this.renderUI(localPlayer, Object.keys(players).length);

    // Update FPS counter
    this.updateFps();
  }

  /**
   * Render tile layer
   */
  private renderTiles(worldState: WorldState): void {
    const bounds = this.getVisibleBounds();
    const tileSize = worldState.tileSize || this.config.tileSize;

    const startTileX = Math.max(0, Math.floor(bounds.left / tileSize));
    const endTileX = Math.min(worldState.tiles[0]?.length || 0, Math.ceil(bounds.right / tileSize));
    const startTileY = Math.max(0, Math.floor(bounds.top / tileSize));
    const endTileY = Math.min(worldState.tiles.length, Math.ceil(bounds.bottom / tileSize));

    for (let y = startTileY; y < endTileY; y++) {
      for (let x = startTileX; x < endTileX; x++) {
        const tile = worldState.tiles[y]?.[x];
        if (tile) {
          this.renderTile(tile.type, x * tileSize, y * tileSize, tileSize, tile.variant);
        }
      }
    }
  }

  /**
   * Render a single tile
   */
  private renderTile(type: string, x: number, y: number, size: number, variant?: number): void {
    const baseColor = this.TILE_COLORS[type] || this.TILE_COLORS.default;

    // Add slight variation based on variant
    this.ctx.fillStyle = this.adjustColor(baseColor, variant || 0);
    this.ctx.fillRect(x, y, size, size);

    // Add subtle grid lines
    this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(x, y, size, size);

    // Add decorations for specific tile types
    if (type === 'tree') {
      this.renderTree(x, y, size);
    } else if (type === 'water') {
      this.renderWaterEffect(x, y, size);
    }
  }

  /**
   * Render tree decoration
   */
  private renderTree(x: number, y: number, size: number): void {
    const centerX = x + size / 2;
    const centerY = y + size / 2;

    // Tree trunk
    this.ctx.fillStyle = '#5d4037';
    this.ctx.fillRect(centerX - 4, centerY, 8, size / 2);

    // Tree foliage
    this.ctx.fillStyle = '#2e7d32';
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY - 4, size / 3, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /**
   * Render water animation effect
   */
  private renderWaterEffect(x: number, y: number, size: number): void {
    const wave = Math.sin(this.animationTime / 500 + x / 50) * 2;
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    this.ctx.fillRect(x, y + size / 2 + wave, size, 2);
  }

  /**
   * Render buildings
   */
  private renderBuildings(worldState: WorldState): void {
    const bounds = this.getVisibleBounds();

    worldState.buildings.forEach(building => {
      // Skip if not in view
      if (building.x + building.width < bounds.left ||
          building.x > bounds.right ||
          building.y + building.height < bounds.top ||
          building.y > bounds.bottom) {
        return;
      }

      this.renderBuilding(building);
    });
  }

  /**
   * Render a single building
   */
  private renderBuilding(building: { type: string; x: number; y: number; width: number; height: number }): void {
    // Building base
    this.ctx.fillStyle = building.type === 'fountain' ? '#607d8b' : '#795548';
    this.ctx.fillRect(building.x, building.y, building.width, building.height);

    // Building outline
    this.ctx.strokeStyle = '#3e2723';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(building.x, building.y, building.width, building.height);

    // Fountain water animation
    if (building.type === 'fountain') {
      const centerX = building.x + building.width / 2;
      const centerY = building.y + building.height / 2;
      const pulse = Math.sin(this.animationTime / 300) * 5 + 15;

      this.ctx.fillStyle = 'rgba(100, 181, 246, 0.6)';
      this.ctx.beginPath();
      this.ctx.arc(centerX, centerY, pulse, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  /**
   * Render items
   */
  private renderItems(items: WorldItem[]): void {
    const bounds = this.getVisibleBounds();

    items.forEach(item => {
      // Skip if not in view
      if (item.x < bounds.left - 20 || item.x > bounds.right + 20 ||
          item.y < bounds.top - 20 || item.y > bounds.bottom + 20) {
        return;
      }

      this.renderItem(item);
    });
  }

  /**
   * Render a single item
   */
  private renderItem(item: WorldItem): void {
    const size = 16;
    const bounce = Math.sin(this.animationTime / 200 + item.x) * 3;

    // Item glow
    this.ctx.fillStyle = this.getItemColor(item.type, 0.3);
    this.ctx.beginPath();
    this.ctx.arc(item.x, item.y + bounce, size + 4, 0, Math.PI * 2);
    this.ctx.fill();

    // Item body
    this.ctx.fillStyle = this.getItemColor(item.type, 1);
    this.ctx.beginPath();
    this.ctx.arc(item.x, item.y + bounce, size / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /**
   * Get color for item type
   */
  private getItemColor(type: string, alpha: number): string {
    const colors: Record<string, string> = {
      coin: `rgba(255, 215, 0, ${alpha})`,
      gem: `rgba(138, 43, 226, ${alpha})`,
      powerup: `rgba(0, 255, 127, ${alpha})`
    };
    return colors[type] || `rgba(255, 255, 255, ${alpha})`;
  }

  /**
   * Render all players
   */
  private renderPlayers(players: Record<string, PlayerState>, localPlayerId?: string): void {
    // Sort players by Y position for depth sorting
    const sortedPlayers = Object.values(players).sort((a, b) => a.y - b.y);

    sortedPlayers.forEach(player => {
      const isLocal = player.id === localPlayerId;
      this.renderPlayer(player, isLocal);
    });
  }

  /**
   * Render a single player
   */
  private renderPlayer(player: PlayerState, isLocal: boolean): void {
    const size = this.config.spriteSize;
    const x = player.x;
    const y = player.y;

    // Player shadow
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    this.ctx.beginPath();
    this.ctx.ellipse(x, y + size / 4, size / 3, size / 6, 0, 0, Math.PI * 2);
    this.ctx.fill();

    // Player body
    const color = player.color || this.SPRITE_COLORS[player.spriteId] || '#4ecdc4';
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y - size / 4, size / 2.5, 0, Math.PI * 2);
    this.ctx.fill();

    // Player outline (highlight for local player)
    if (isLocal) {
      this.ctx.strokeStyle = '#ffffff';
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.arc(x, y - size / 4, size / 2.5 + 2, 0, Math.PI * 2);
      this.ctx.stroke();
    }

    // Direction indicator (eyes)
    this.renderPlayerDirection(x, y - size / 4, size / 2.5, player.direction);

    // Player name
    this.ctx.fillStyle = player.color || '#ffffff';
    this.ctx.font = 'bold 12px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(player.username, x, y - size - 5);

    // Walking animation (bobbing)
    if (player.velocityX !== 0 || player.velocityY !== 0) {
      const bobOffset = Math.sin(this.animationTime / 100) * 2;
      // Already applied in position calculations above
    }
  }

  /**
   * Render player direction indicator
   */
  private renderPlayerDirection(x: number, y: number, radius: number, direction: string): void {
    const eyeOffset = radius * 0.4;
    const eyeSize = radius * 0.2;

    let eyeX1 = x - eyeOffset * 0.5;
    let eyeX2 = x + eyeOffset * 0.5;
    let eyeY = y;

    switch (direction) {
      case 'up':
        eyeY = y - eyeOffset * 0.3;
        break;
      case 'down':
        eyeY = y + eyeOffset * 0.3;
        break;
      case 'left':
        eyeX1 -= eyeOffset * 0.3;
        eyeX2 -= eyeOffset * 0.3;
        break;
      case 'right':
        eyeX1 += eyeOffset * 0.3;
        eyeX2 += eyeOffset * 0.3;
        break;
    }

    this.ctx.fillStyle = '#ffffff';
    this.ctx.beginPath();
    this.ctx.arc(eyeX1, eyeY, eyeSize, 0, Math.PI * 2);
    this.ctx.arc(eyeX2, eyeY, eyeSize, 0, Math.PI * 2);
    this.ctx.fill();

    // Pupils
    this.ctx.fillStyle = '#000000';
    this.ctx.beginPath();
    this.ctx.arc(eyeX1, eyeY, eyeSize * 0.5, 0, Math.PI * 2);
    this.ctx.arc(eyeX2, eyeY, eyeSize * 0.5, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /**
   * Render UI overlay
   */
  private renderUI(localPlayer: PlayerState | null, playerCount: number): void {
    // FPS counter (top right)
    if (this.config.showDebug) {
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      this.ctx.fillRect(this.canvas.width - 80, 10, 70, 25);
      this.ctx.fillStyle = '#00ff00';
      this.ctx.font = '14px monospace';
      this.ctx.textAlign = 'right';
      this.ctx.fillText(`${this.fps} FPS`, this.canvas.width - 15, 28);
    }

    // Player count (top left)
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    this.ctx.fillRect(10, 10, 100, 25);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '14px Arial';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(`Players: ${playerCount}`, 20, 28);

    // Minimap (bottom right)
    this.renderMinimap(localPlayer);
  }

  /**
   * Render minimap
   */
  private renderMinimap(localPlayer: PlayerState | null): void {
    const mapSize = 100;
    const mapX = this.canvas.width - mapSize - 10;
    const mapY = this.canvas.height - mapSize - 10;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    this.ctx.fillRect(mapX, mapY, mapSize, mapSize);

    // Border
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(mapX, mapY, mapSize, mapSize);

    // Local player position (if we have world bounds)
    if (localPlayer) {
      const dotX = mapX + (localPlayer.x / 1600) * mapSize;
      const dotY = mapY + (localPlayer.y / 1200) * mapSize;

      this.ctx.fillStyle = '#00ff00';
      this.ctx.beginPath();
      this.ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  /**
   * Update FPS counter
   */
  private updateFps(): void {
    this.frameCount++;
    const now = performance.now();

    if (now - this.lastFpsUpdate >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }

  /**
   * Adjust color brightness based on variant
   */
  private adjustColor(color: string, variant: number): string {
    // Simple brightness adjustment based on variant
    const adjustment = (variant % 3 - 1) * 10;
    return color; // TODO: Implement actual color adjustment
  }

  /**
   * Enable/disable debug mode
   */
  setDebugMode(enabled: boolean): void {
    this.config.showDebug = enabled;
  }

  /**
   * Get canvas element
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Get current FPS
   */
  getFps(): number {
    return this.fps;
  }
}
