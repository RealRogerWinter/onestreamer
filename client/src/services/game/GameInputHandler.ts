/**
 * GameInputHandler - Handles keyboard and touch input for the game
 */

import { MovementVector, PlayerAction } from '../../types/game';

type MovementCallback = (direction: MovementVector) => void;
type ActionCallback = (action: PlayerAction) => void;

export class GameInputHandler {
  private enabled: boolean = false;
  private keysPressed: Set<string> = new Set();
  private touchJoystickActive: boolean = false;
  private touchStartPos: { x: number; y: number } | null = null;
  private currentTouchVector: MovementVector = { x: 0, y: 0 };
  private inputInterval: ReturnType<typeof setInterval> | null = null;

  private movementCallback: MovementCallback | null = null;
  private actionCallback: ActionCallback | null = null;

  // Input rate limiting (20 updates per second matches server tick rate)
  private readonly INPUT_RATE_MS = 50;
  private readonly JOYSTICK_MAX_DISTANCE = 50;

  constructor() {
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
  }

  /**
   * Set callbacks for input events
   */
  setCallbacks(movement: MovementCallback, action: ActionCallback): void {
    this.movementCallback = movement;
    this.actionCallback = action;
  }

  /**
   * Enable input handling
   */
  enable(): void {
    if (this.enabled) return;

    this.enabled = true;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    window.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    window.addEventListener('touchend', this.handleTouchEnd);
    window.addEventListener('blur', this.handleBlur);

    // Start input polling
    this.inputInterval = setInterval(() => {
      this.emitMovement();
    }, this.INPUT_RATE_MS);
  }

  /**
   * Disable input handling
   */
  disable(): void {
    if (!this.enabled) return;

    this.enabled = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('touchstart', this.handleTouchStart);
    window.removeEventListener('touchmove', this.handleTouchMove);
    window.removeEventListener('touchend', this.handleTouchEnd);
    window.removeEventListener('blur', this.handleBlur);

    if (this.inputInterval) {
      clearInterval(this.inputInterval);
      this.inputInterval = null;
    }

    this.keysPressed.clear();
    this.touchJoystickActive = false;
    this.currentTouchVector = { x: 0, y: 0 };
  }

  /**
   * Handle key down event
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.enabled) return;

    // Ignore if typing in an input field
    if (this.isTypingInInput()) return;

    const key = e.key.toLowerCase();

    // Movement keys
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      e.preventDefault();
      this.keysPressed.add(key);
    }

    // Action keys
    if (key === ' ' || key === 'e') {
      e.preventDefault();
      if (this.actionCallback) {
        this.actionCallback({ type: key === ' ' ? 'primary' : 'interact' });
      }
    }

    // Inventory slot keys (1-9)
    if (/^[1-9]$/.test(key)) {
      if (this.actionCallback) {
        this.actionCallback({ type: 'use-item', itemId: `slot_${parseInt(key) - 1}` });
      }
    }
  }

  /**
   * Handle key up event
   */
  private handleKeyUp(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    this.keysPressed.delete(key);
  }

  /**
   * Handle touch start event
   */
  private handleTouchStart(e: TouchEvent): void {
    if (!this.enabled) return;

    // Check if touch is in joystick area (left third of screen)
    const touch = e.touches[0];
    if (touch.clientX < window.innerWidth / 3) {
      e.preventDefault();
      this.touchJoystickActive = true;
      this.touchStartPos = { x: touch.clientX, y: touch.clientY };
    }
  }

  /**
   * Handle touch move event
   */
  private handleTouchMove(e: TouchEvent): void {
    if (!this.touchJoystickActive || !this.touchStartPos) return;

    e.preventDefault();
    const touch = e.touches[0];
    const deltaX = touch.clientX - this.touchStartPos.x;
    const deltaY = touch.clientY - this.touchStartPos.y;

    // Normalize to -1 to 1 range
    this.currentTouchVector = {
      x: Math.max(-1, Math.min(1, deltaX / this.JOYSTICK_MAX_DISTANCE)),
      y: Math.max(-1, Math.min(1, deltaY / this.JOYSTICK_MAX_DISTANCE))
    };
  }

  /**
   * Handle touch end event
   */
  private handleTouchEnd(e: TouchEvent): void {
    // Only reset if all touches are gone or if this was the joystick touch
    if (e.touches.length === 0 || this.touchJoystickActive) {
      this.touchJoystickActive = false;
      this.touchStartPos = null;
      this.currentTouchVector = { x: 0, y: 0 };

      // Emit stop movement
      if (this.movementCallback) {
        this.movementCallback({ x: 0, y: 0 });
      }
    }
  }

  /**
   * Handle window blur (stop all movement)
   */
  private handleBlur(): void {
    this.keysPressed.clear();
    this.touchJoystickActive = false;
    this.currentTouchVector = { x: 0, y: 0 };
  }

  /**
   * Emit movement based on current input state
   */
  private emitMovement(): void {
    if (!this.enabled || !this.movementCallback) return;

    // Use touch joystick if active
    if (this.touchJoystickActive) {
      this.movementCallback(this.currentTouchVector);
      return;
    }

    // Calculate keyboard movement
    const vector: MovementVector = { x: 0, y: 0 };

    if (this.keysPressed.has('w') || this.keysPressed.has('arrowup')) vector.y = -1;
    if (this.keysPressed.has('s') || this.keysPressed.has('arrowdown')) vector.y = 1;
    if (this.keysPressed.has('a') || this.keysPressed.has('arrowleft')) vector.x = -1;
    if (this.keysPressed.has('d') || this.keysPressed.has('arrowright')) vector.x = 1;

    // Normalize diagonal movement
    if (vector.x !== 0 && vector.y !== 0) {
      const magnitude = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
      vector.x /= magnitude;
      vector.y /= magnitude;
    }

    // Always emit movement state (including {0, 0} when no keys pressed)
    this.movementCallback(vector);
  }

  /**
   * Check if user is typing in an input field
   */
  private isTypingInInput(): boolean {
    const activeElement = document.activeElement;
    if (!activeElement) return false;

    const tagName = activeElement.tagName.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' ||
           activeElement.getAttribute('contenteditable') === 'true';
  }

  /**
   * Get current input state
   */
  getInputState(): { keysPressed: string[]; touchActive: boolean; touchVector: MovementVector } {
    return {
      keysPressed: Array.from(this.keysPressed),
      touchActive: this.touchJoystickActive,
      touchVector: this.currentTouchVector
    };
  }

  /**
   * Check if any movement input is active
   */
  hasMovementInput(): boolean {
    return this.keysPressed.size > 0 || this.touchJoystickActive;
  }

  /**
   * Trigger an action programmatically
   */
  triggerAction(action: PlayerAction): void {
    if (this.actionCallback) {
      this.actionCallback(action);
    }
  }

  /**
   * Destroy the input handler
   */
  destroy(): void {
    this.disable();
    this.movementCallback = null;
    this.actionCallback = null;
  }
}
