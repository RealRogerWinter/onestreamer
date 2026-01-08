/**
 * GameStateManager - Manages game state with client-side prediction
 */

import {
  PlayerState,
  WorldState,
  WorldItem,
  MovementVector,
  GameFullState,
  GameStateDelta,
  WorldChange,
  InventoryItem
} from '../../types/game';

interface PendingInput {
  sequence: number;
  direction: MovementVector;
  timestamp: number;
}

export class GameStateManager {
  private localPlayerId: string;
  private players: Map<string, PlayerState> = new Map();
  private worldState: WorldState | null = null;
  private items: Map<string, WorldItem> = new Map();
  private pendingInputs: PendingInput[] = [];

  // Physics constants (should match server)
  private readonly PLAYER_SPEED = 150;

  constructor(localPlayerId: string) {
    this.localPlayerId = localPlayerId;
  }

  /**
   * Set full game state (on join/reconnect)
   */
  setFullState(state: GameFullState): void {
    // Set players
    this.players.clear();
    if (state.players) {
      Object.entries(state.players).forEach(([id, player]) => {
        this.players.set(id, player);
      });
    }

    // Set world
    this.worldState = state.world;

    // Set items
    this.items.clear();
    if (state.items) {
      state.items.forEach(item => {
        this.items.set(item.id, item);
      });
    }

    // Clear pending inputs since we have fresh state
    this.pendingInputs = [];
  }

  /**
   * Apply delta update from server
   */
  applyDelta(delta: GameStateDelta): void {
    // Apply player updates
    if (delta.playerUpdates) {
      Object.entries(delta.playerUpdates).forEach(([id, update]) => {
        const player = this.players.get(id);
        if (player) {
          Object.assign(player, update);
        }
      });
    }

    // Apply item updates
    if (delta.itemUpdates) {
      delta.itemUpdates.forEach(update => {
        switch (update.type) {
          case 'spawned':
            if (update.item) {
              this.items.set(update.itemId, update.item);
            }
            break;
          case 'removed':
          case 'pickup':
            this.items.delete(update.itemId);
            break;
        }
      });
    }

    // Apply world changes
    if (delta.worldChanges) {
      delta.worldChanges.forEach(change => {
        this.applyWorldChange(change);
      });
    }
  }

  /**
   * Reconcile local player state with server state
   */
  reconcilePlayerState(serverState: PlayerState & { lastInputSequence: number }): void {
    if (serverState.id !== this.localPlayerId) return;

    const localPlayer = this.players.get(this.localPlayerId);
    if (!localPlayer) return;

    // Remove inputs that have been processed by server
    this.pendingInputs = this.pendingInputs.filter(
      input => input.sequence > serverState.lastInputSequence
    );

    // Start from server position
    localPlayer.x = serverState.x;
    localPlayer.y = serverState.y;
    localPlayer.velocityX = serverState.velocityX;
    localPlayer.velocityY = serverState.velocityY;

    // Re-apply pending inputs
    this.pendingInputs.forEach(input => {
      this.applyInputToPlayer(localPlayer, input.direction);
    });
  }

  /**
   * Apply local input for prediction
   */
  applyLocalInput(direction: MovementVector, sequence: number): void {
    const player = this.players.get(this.localPlayerId);
    if (!player) return;

    // Store pending input for reconciliation
    this.pendingInputs.push({
      sequence,
      direction,
      timestamp: Date.now()
    });

    // Keep only recent inputs
    if (this.pendingInputs.length > 100) {
      this.pendingInputs = this.pendingInputs.slice(-50);
    }

    // Apply input immediately for prediction
    this.applyInputToPlayer(player, direction);
  }

  /**
   * Apply input to player (for prediction)
   */
  private applyInputToPlayer(player: PlayerState, direction: MovementVector): void {
    player.velocityX = direction.x * this.PLAYER_SPEED;
    player.velocityY = direction.y * this.PLAYER_SPEED;

    // Update direction for animation
    if (Math.abs(direction.y) > 0.5 || Math.abs(direction.x) > 0.5) {
      if (Math.abs(direction.y) > Math.abs(direction.x)) {
        player.direction = direction.y < 0 ? 'up' : 'down';
      } else {
        player.direction = direction.x < 0 ? 'left' : 'right';
      }
    }
  }

  /**
   * Update local player position (for smooth rendering between ticks)
   */
  updateLocalPlayerPosition(deltaTime: number): void {
    const player = this.players.get(this.localPlayerId);
    if (!player) return;

    if (player.velocityX !== 0 || player.velocityY !== 0) {
      player.x += player.velocityX * deltaTime;
      player.y += player.velocityY * deltaTime;

      // Clamp to world bounds
      if (this.worldState) {
        const halfSize = 16;
        player.x = Math.max(halfSize, Math.min(this.worldState.bounds.width - halfSize, player.x));
        player.y = Math.max(halfSize, Math.min(this.worldState.bounds.height - halfSize, player.y));
      }
    }
  }

  /**
   * Add a player to the game
   */
  addPlayer(player: PlayerState): void {
    this.players.set(player.id, player);
  }

  /**
   * Remove a player from the game
   */
  removePlayer(playerId: string): void {
    this.players.delete(playerId);
  }

  /**
   * Handle item pickup
   */
  handleItemPickup(data: { playerId: string; itemId: string; item: WorldItem }): void {
    // Remove item from world
    this.items.delete(data.itemId);

    // Add to player inventory if it's the local player
    if (data.playerId === this.localPlayerId) {
      const player = this.players.get(this.localPlayerId);
      if (player) {
        if (!player.inventory) {
          player.inventory = [];
        }
        player.inventory.push({
          id: data.item.id,
          type: data.item.type,
          data: data.item.data
        });
      }
    }
  }

  /**
   * Apply world change
   */
  applyWorldChange(change: WorldChange): void {
    if (!this.worldState) return;

    switch (change.type) {
      case 'building-added':
        this.worldState.buildings.push(change.data as any);
        break;
      case 'building-removed':
        const removeId = (change.data as { id: string }).id;
        this.worldState.buildings = this.worldState.buildings.filter(b => b.id !== removeId);
        break;
      case 'tile-changed':
        const tileChange = change.data as { x: number; y: number; tile: any };
        if (this.worldState.tiles[tileChange.y]) {
          this.worldState.tiles[tileChange.y][tileChange.x] = tileChange.tile;
        }
        break;
    }
  }

  /**
   * Get local player state
   */
  getLocalPlayer(): PlayerState | null {
    return this.players.get(this.localPlayerId) || null;
  }

  /**
   * Get all players
   */
  getAllPlayers(): Map<string, PlayerState> {
    return this.players;
  }

  /**
   * Get players as record (for rendering)
   */
  getPlayersRecord(): Record<string, PlayerState> {
    const record: Record<string, PlayerState> = {};
    this.players.forEach((player, id) => {
      record[id] = player;
    });
    return record;
  }

  /**
   * Get world state
   */
  getWorldState(): WorldState | null {
    return this.worldState;
  }

  /**
   * Get all items
   */
  getItems(): WorldItem[] {
    return Array.from(this.items.values());
  }

  /**
   * Get player count
   */
  getPlayerCount(): number {
    return this.players.size;
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.players.clear();
    this.worldState = null;
    this.items.clear();
    this.pendingInputs = [];
  }
}
