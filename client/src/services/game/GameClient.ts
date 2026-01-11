/**
 * GameClient - Main client-side game orchestrator
 */

import { Socket } from 'socket.io-client';
import { GameStateManager } from './GameStateManager';
import { GameInputHandler } from './GameInputHandler';
import { GameRenderer } from './GameRenderer';
import {
  PlayerState,
  WorldState,
  WorldItem,
  MovementVector,
  PlayerAction,
  GameFullState,
  GameStateDelta,
  GameStatus,
  EnemyState
} from '../../types/game';

type GameEventCallback = (...args: any[]) => void;

export class GameClient {
  private socket: Socket;
  private userId: string;
  private stateManager: GameStateManager;
  private inputHandler: GameInputHandler;
  private renderer: GameRenderer | null = null;

  private lastInputSequence: number = 0;
  private isConnected: boolean = false;
  private renderLoop: number = 0;
  private lastRenderTime: number = 0;

  private eventCallbacks: Map<string, GameEventCallback[]> = new Map();

  constructor(socket: Socket, userId: string | number) {
    this.socket = socket;
    this.userId = String(userId);
    this.stateManager = new GameStateManager(this.userId);
    this.inputHandler = new GameInputHandler();

    this.setupSocketHandlers();
    this.setupInputHandlers();
  }

  /**
   * Set up socket event handlers
   */
  private setupSocketHandlers(): void {
    // Full state sync (on join or reconnect)
    this.socket.on('game:full-state', (state: GameFullState) => {
      console.log('[GameClient] Received full state');
      this.stateManager.setFullState(state);
      this.emit('state-update', this.getGameState());
    });

    // Delta state update (tick updates)
    this.socket.on('game:state-update', (delta: GameStateDelta) => {
      this.stateManager.applyDelta(delta);
      this.emit('state-update', this.getGameState());
    });

    // Player-specific updates (for reconciliation)
    this.socket.on('game:player-state', (playerState: PlayerState & { lastInputSequence: number }) => {
      this.stateManager.reconcilePlayerState(playerState);
      this.emit('player-update', this.stateManager.getLocalPlayer());
    });

    // Player joined
    this.socket.on('game:player-joined', (player: PlayerState) => {
      console.log('[GameClient] Player joined:', player.username);
      this.stateManager.addPlayer(player);
      this.emit('player-joined', player);
      this.emit('state-update', this.getGameState());
    });

    // Player left
    this.socket.on('game:player-left', (data: { id: string }) => {
      console.log('[GameClient] Player left:', data.id);
      this.stateManager.removePlayer(data.id);
      this.emit('player-left', data.id);
      this.emit('state-update', this.getGameState());
    });

    // Item pickup
    this.socket.on('game:item-pickup', (data: { playerId: string; itemId: string; item: WorldItem }) => {
      this.stateManager.handleItemPickup(data);
      this.emit('item-pickup', data);
      this.emit('state-update', this.getGameState());
    });

    // Item spawned
    this.socket.on('game:item-spawned', (item: WorldItem) => {
      this.stateManager.applyDelta({
        playerUpdates: {},
        itemUpdates: [{ type: 'spawned', itemId: item.id, item }],
        enemyUpdates: [],
        worldChanges: [],
        timestamp: Date.now()
      });
      this.emit('item-spawned', item);
    });

    // Item removed
    this.socket.on('game:item-removed', (data: { id: string }) => {
      this.stateManager.applyDelta({
        playerUpdates: {},
        itemUpdates: [{ type: 'removed', itemId: data.id }],
        enemyUpdates: [],
        worldChanges: [],
        timestamp: Date.now()
      });
    });

    // Enemy spawned
    this.socket.on('game:enemy-spawned', (data: { enemy: EnemyState }) => {
      console.log('[GameClient] Enemy spawned:', data.enemy.id);
      this.stateManager.addEnemy(data.enemy);
      this.emit('enemy-spawned', data.enemy);
      this.emit('state-update', this.getGameState());
    });

    // Enemy killed
    this.socket.on('game:enemy-killed', (data: { enemyId: string }) => {
      console.log('[GameClient] Enemy killed:', data.enemyId);
      this.stateManager.removeEnemy(data.enemyId);
      this.emit('enemy-killed', data.enemyId);
      this.emit('state-update', this.getGameState());
    });

    // Player damaged
    this.socket.on('game:player-damaged', (data: { playerId: string; damage: number; health: number }) => {
      console.log('[GameClient] Player damaged:', data.playerId, 'health:', data.health);
      this.emit('player-damaged', data);
    });

    // Player respawned
    this.socket.on('game:player-respawned', (data: { playerId: string; x: number; y: number }) => {
      console.log('[GameClient] Player respawned:', data.playerId);
      this.emit('player-respawned', data);
    });

    // Error handling
    this.socket.on('game:error', (error: { message: string; code: string }) => {
      console.error('[GameClient] Error:', error);
      this.emit('error', error);
    });

    // Join confirmation
    this.socket.on('game:joined', (data: { playerId: string; player: PlayerState }) => {
      console.log('[GameClient] Successfully joined game');
      this.isConnected = true;
      this.emit('joined', data);
    });
  }

  /**
   * Set up input handlers
   */
  private setupInputHandlers(): void {
    this.inputHandler.setCallbacks(
      (direction: MovementVector) => this.handleMovement(direction),
      (action: PlayerAction) => this.handleAction(action)
    );
  }

  /**
   * Handle movement input
   */
  private handleMovement(direction: MovementVector): void {
    if (!this.isConnected) return;

    const sequence = ++this.lastInputSequence;

    // Apply locally for prediction
    this.stateManager.applyLocalInput(direction, sequence);
    this.emit('player-update', this.stateManager.getLocalPlayer());

    // Send to server
    this.socket.emit('game:input', {
      type: 'movement',
      direction,
      sequence,
      timestamp: Date.now()
    });
  }

  /**
   * Handle action input
   */
  private handleAction(action: PlayerAction): void {
    if (!this.isConnected) return;

    // Trigger attack animation for primary action
    if (action.type === 'primary' && this.renderer) {
      this.renderer.triggerAttack();
    }

    this.socket.emit('game:input', {
      type: 'action',
      action,
      timestamp: Date.now()
    });
  }

  /**
   * Initialize renderer with canvas
   */
  initRenderer(canvas: HTMLCanvasElement): void {
    this.renderer = new GameRenderer(canvas, this.userId);
    this.startRenderLoop();
  }

  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    const render = (timestamp: number) => {
      const deltaTime = (timestamp - this.lastRenderTime) / 1000;
      this.lastRenderTime = timestamp;

      // Update local player position for smooth rendering
      this.stateManager.updateLocalPlayerPosition(deltaTime);

      // Render frame
      if (this.renderer) {
        const state = this.getGameState();
        this.renderer.render(
          state.world,
          state.players,
          state.items,
          state.enemies,
          state.localPlayer,
          deltaTime
        );
      }

      this.renderLoop = requestAnimationFrame(render);
    };

    this.lastRenderTime = performance.now();
    this.renderLoop = requestAnimationFrame(render);
  }

  /**
   * Stop the render loop
   */
  private stopRenderLoop(): void {
    if (this.renderLoop) {
      cancelAnimationFrame(this.renderLoop);
      this.renderLoop = 0;
    }
  }

  /**
   * Join the game
   */
  joinGame(): void {
    console.log('[GameClient] Joining game...');
    this.socket.emit('game:join', { userId: this.userId });
    this.inputHandler.enable();
  }

  /**
   * Leave the game
   */
  leaveGame(): void {
    console.log('[GameClient] Leaving game...');
    this.socket.emit('game:leave', { userId: this.userId });
    this.inputHandler.disable();
    this.isConnected = false;
  }

  /**
   * Use an item
   */
  useItem(itemId: string, targetPosition?: { x: number; y: number }): void {
    this.socket.emit('game:use-item', { itemId, targetPosition });
  }

  /**
   * Interact with nearby objects
   */
  interact(): void {
    this.socket.emit('game:interact');
  }

  /**
   * Get current game state
   */
  getGameState(): {
    localPlayer: PlayerState | null;
    players: Record<string, PlayerState>;
    world: WorldState | null;
    items: WorldItem[];
    enemies: EnemyState[];
    playerCount: number;
  } {
    return {
      localPlayer: this.stateManager.getLocalPlayer(),
      players: this.stateManager.getPlayersRecord(),
      world: this.stateManager.getWorldState(),
      items: this.stateManager.getItems(),
      enemies: this.stateManager.getEnemies(),
      playerCount: this.stateManager.getPlayerCount()
    };
  }

  /**
   * Check if connected to game
   */
  isInGame(): boolean {
    return this.isConnected;
  }

  /**
   * Get renderer (for external access to FPS etc.)
   */
  getRenderer(): GameRenderer | null {
    return this.renderer;
  }

  /**
   * Resize renderer
   */
  resizeRenderer(width: number, height: number): void {
    if (this.renderer) {
      this.renderer.resize(width, height);
    }
  }

  /**
   * Subscribe to events
   */
  on(event: string, callback: GameEventCallback): void {
    if (!this.eventCallbacks.has(event)) {
      this.eventCallbacks.set(event, []);
    }
    this.eventCallbacks.get(event)!.push(callback);
  }

  /**
   * Unsubscribe from events
   */
  off(event: string, callback: GameEventCallback): void {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index !== -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Emit event to subscribers
   */
  private emit(event: string, ...args: any[]): void {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(...args);
        } catch (error) {
          console.error(`[GameClient] Error in ${event} callback:`, error);
        }
      });
    }
  }

  /**
   * Clean up and destroy
   */
  destroy(): void {
    this.stopRenderLoop();
    this.inputHandler.destroy();
    this.stateManager.clear();

    // Remove socket listeners
    this.socket.off('game:full-state');
    this.socket.off('game:state-update');
    this.socket.off('game:player-state');
    this.socket.off('game:player-joined');
    this.socket.off('game:player-left');
    this.socket.off('game:item-pickup');
    this.socket.off('game:item-spawned');
    this.socket.off('game:item-removed');
    this.socket.off('game:enemy-spawned');
    this.socket.off('game:enemy-killed');
    this.socket.off('game:player-damaged');
    this.socket.off('game:player-respawned');
    this.socket.off('game:error');
    this.socket.off('game:joined');

    this.eventCallbacks.clear();
    this.renderer = null;
    this.isConnected = false;

    console.log('[GameClient] Destroyed');
  }
}

// Export all game services
export { GameStateManager } from './GameStateManager';
export { GameInputHandler } from './GameInputHandler';
export { GameRenderer } from './GameRenderer';
