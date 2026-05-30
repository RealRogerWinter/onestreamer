// Pure effect-definition helpers for CanvasEffectOverlay's debug-mode test
// effects. Extracted verbatim from three duplicated inline copies inside the
// parent component (debug click handler + the two debug-panel buttons). No
// behavior change — the returned objects are byte-for-byte identical to the
// originals.

/**
 * Build the config payload for a debug/test effect of the given type.
 * Mirrors the original inline `getEffectConfig` switch.
 */
export function getEffectConfig(effectType: string): Record<string, any> {
  switch (effectType) {
    case 'confetti':
      return {
        particleCount: 50,
        colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57'],
        spread: 60,
      };
    case 'particles':
      return {
        particleCount: 30,
        colors: ['#ff4444', '#44ff44', '#4444ff'],
        animation: 'sparkle',
      };
    case 'splat':
    default:
      return {
        color: '#ff4444',
        splashColor: '#cc0000',
        particles: 12,
        size: 'large',
        animation: 'splat',
        drip: true,
      };
  }
}

/**
 * Pick the emoji for a debug/test effect of the given type.
 * Mirrors the original inline `getEffectEmoji` switch.
 */
export function getEffectEmoji(effectType: string): string {
  switch (effectType) {
    case 'confetti':
      return '🎉';
    case 'particles':
      return '✨';
    case 'splat':
    default:
      return '🍅';
  }
}
