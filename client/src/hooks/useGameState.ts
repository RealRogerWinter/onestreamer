import { useState } from 'react';

/**
 * Encapsulates the game-mode active flag for the app shell.
 *
 * Owns:
 *   - `isGameActive`: whether a game session is currently in progress.
 *
 * Does NOT own:
 *   - The `game:started` / `game:ended` socket listeners themselves —
 *     those still live in App.tsx alongside the rest of the stream-socket
 *     handlers (which mutate many other pieces of state). The hook
 *     exposes `setIsGameActive` so the App.tsx listeners can flip the
 *     flag without owning the listener wiring here.
 *   - The `stream-status.isGameMode` field that also flips this flag —
 *     same reason as above (listener lives in App.tsx).
 *
 * Behavior is preserved verbatim from the original inline state in
 * App.tsx: same initial `false` value, same setter semantics.
 */
export interface GameState {
  /** True when a game session is currently active. */
  isGameActive: boolean;
  /**
   * Setter exposed for socket listeners that still live in App.tsx
   * (`game:started`, `game:ended`, and `stream-status.isGameMode`).
   */
  setIsGameActive: (active: boolean) => void;
}

export function useGameState(): GameState {
  const [isGameActive, setIsGameActive] = useState(false);

  return {
    isGameActive,
    setIsGameActive,
  };
}

export default useGameState;
