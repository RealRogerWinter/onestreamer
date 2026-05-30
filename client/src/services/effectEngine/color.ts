/**
 * Pure color parsing helpers for the EffectEngine.
 *
 * Extracted verbatim from EffectEngine.parseColor — no `this`, no canvas, no
 * side effects. Behavior is preserved exactly, including the gray-smoke default.
 */

import { RgbColor } from './types';

/**
 * Parse a color string into an {r, g, b} triple.
 *
 * Supports `rgb()`/`rgba()` and 6-digit `#hex`. Anything unrecognized falls
 * back to a neutral gray (matching the original smoke default).
 */
export function parseColor(colorStr: string): RgbColor | undefined {
  // Parse rgba(r, g, b, a) format
  const rgbaMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1]),
      g: parseInt(rgbaMatch[2]),
      b: parseInt(rgbaMatch[3]),
    };
  }

  // Parse hex format
  const hexMatch = colorStr.match(/^#([a-f\d]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    return {
      r: parseInt(hex.substr(0, 2), 16),
      g: parseInt(hex.substr(2, 2), 16),
      b: parseInt(hex.substr(4, 2), 16),
    };
  }

  // Default to gray smoke
  return { r: 120, g: 120, b: 120 };
}
