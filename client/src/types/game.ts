/**
 * Game System TypeScript Types
 */

// ============================================
// Player Types
// ============================================

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface MovementVector {
  x: number; // -1 to 1
  y: number; // -1 to 1
}

export interface PlayerState {
  id: string;
  username: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  direction: Direction;
  spriteId: string;
  color: string;
  inventory?: InventoryItem[];
  lastInputSequence?: number;
}

export interface PlayerInput {
  type: 'movement' | 'action';
  direction?: MovementVector;
  action?: PlayerAction;
  sequence?: number;
  timestamp?: number;
}

export interface PlayerAction {
  type: 'interact' | 'use-item' | 'primary';
  itemId?: string;
  targetPosition?: { x: number; y: number };
}

// ============================================
// World Types
// ============================================

export interface TileData {
  type: string; // 'grass', 'path', 'water', 'tree', etc.
  walkable: boolean;
  variant?: number;
}

export interface Building {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  walkable?: boolean;
  interactable?: boolean;
  ownerId?: number;
  data?: Record<string, unknown>;
}

export interface SpawnPoint {
  x: number;
  y: number;
  name?: string;
}

export interface WorldBounds {
  width: number;
  height: number;
}

export interface WorldState {
  tiles: TileData[][];
  buildings: Building[];
  spawnPoints: SpawnPoint[];
  bounds: WorldBounds;
  tileSize: number;
}

// ============================================
// Item Types
// ============================================

export interface WorldItem {
  id: string;
  type: string;
  x: number;
  y: number;
  data?: ItemData;
  spawnedAt?: number;
}

export interface ItemData {
  value?: number;
  effect?: string;
  duration?: number;
  sprite?: string;
}

export interface InventoryItem {
  id: string;
  type: string;
  data?: ItemData;
}

// ============================================
// Game State Types
// ============================================

export interface GameFullState {
  players: Record<string, PlayerState>;
  world: WorldState;
  items: WorldItem[];
  sessionId?: number;
  startedAt?: number;
  timestamp?: number;
}

export interface GameStateDelta {
  playerUpdates: Record<string, Partial<PlayerState>>;
  itemUpdates: ItemUpdate[];
  worldChanges: WorldChange[];
  timestamp: number;
}

export interface ItemUpdate {
  type: 'spawned' | 'removed' | 'pickup';
  itemId: string;
  item?: WorldItem;
  playerId?: string;
}

export interface WorldChange {
  type: 'building-added' | 'building-removed' | 'tile-changed';
  data: Building | { id: string } | { x: number; y: number; tile: TileData };
}

// ============================================
// Socket Event Types
// ============================================

export interface GameStartedEvent {
  startedBy: number | null;
  timestamp: number;
}

export interface GameEndedEvent {
  endedBy: number | null;
  timestamp: number;
}

export interface PlayerJoinedEvent extends PlayerState {
  timestamp: number;
}

export interface PlayerLeftEvent {
  id: string;
  timestamp: number;
}

export interface ItemPickupEvent {
  playerId: string;
  itemId: string;
  item: WorldItem;
  timestamp: number;
}

export interface ItemSpawnedEvent extends WorldItem {
  timestamp: number;
}

export interface GameErrorEvent {
  message: string;
  code: string;
  timestamp?: number;
}

// ============================================
// Game Status Types
// ============================================

export interface GameStatus {
  isActive: boolean;
  sessionId: number | null;
  playerCount: number;
  peakPlayers: number;
  totalPlayers: number;
  startedAt: number | null;
  startedBy: number | null;
  uptime: number;
  itemCount: number;
  loopStats?: {
    avg: number;
    max: number;
    min: number;
    tickCount: number;
    isRunning: boolean;
  };
}

export interface GameStreamStatus {
  isActive: boolean;
  streamId: string | null;
  gameStatus: GameStatus | null;
}

// ============================================
// Rendering Types
// ============================================

export interface Camera {
  x: number;
  y: number;
  width: number;
  height: number;
  targetPlayerId: string;
  zoom: number;
}

export interface CameraTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface VisibleBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SpriteFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteSheet {
  image: HTMLImageElement;
  frames: Record<string, SpriteFrame[]>;
  frameWidth: number;
  frameHeight: number;
}

// ============================================
// Input Types
// ============================================

export interface GameInputState {
  keysPressed: Set<string>;
  touchActive: boolean;
  touchPosition: { x: number; y: number } | null;
  joystickVector: MovementVector;
}

// ============================================
// Component Props Types
// ============================================

export interface GameOverlayProps {
  isActive: boolean;
  userId: string | number;
  containerRef: React.RefObject<HTMLDivElement>;
  onClose?: () => void;
}

export interface GameCanvasProps {
  playerState: PlayerState | null;
  worldState: WorldState | null;
  allPlayers: Record<string, PlayerState>;
  items: WorldItem[];
  containerRef: React.RefObject<HTMLDivElement>;
  localPlayerId: string;
}

export interface GameControlsProps {
  onMove: (direction: MovementVector) => void;
  onAction: (action: PlayerAction) => void;
  enabled: boolean;
}

export interface GameHUDProps {
  playerState: PlayerState | null;
  gameStatus: GameStatus | null;
  playerCount: number;
}
