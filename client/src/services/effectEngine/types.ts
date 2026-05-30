/**
 * Shared types for the EffectEngine and its collaborators.
 *
 * Extracted verbatim from EffectEngine.ts to give effectEngine/* modules a
 * dependency-free place to import from. EffectEngine re-exports EffectData so
 * its public API is unchanged.
 */

export interface EffectData {
  id: string;
  userId: string;
  itemId: string;
  itemName: string;
  displayName: string;
  emoji: string;
  type: string;
  duration: number;
  config: any;
  startTime: number;
  position: { x: number; y: number };
  mainEffectId?: string; // For multi-phase effects to share data
}

/** RGB color triple used by smoke/particle effect parameter builders. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}
