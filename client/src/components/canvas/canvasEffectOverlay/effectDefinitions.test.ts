import { getEffectConfig, getEffectEmoji } from './effectDefinitions';

// Unit tests for the pure helpers extracted from CanvasEffectOverlay. These
// pin the exact config/emoji payloads the parent previously built inline so a
// future change to a value is caught.

describe('getEffectConfig', () => {
  it('returns the confetti config', () => {
    expect(getEffectConfig('confetti')).toEqual({
      particleCount: 50,
      colors: ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57'],
      spread: 60,
    });
  });

  it('returns the particles config', () => {
    expect(getEffectConfig('particles')).toEqual({
      particleCount: 30,
      colors: ['#ff4444', '#44ff44', '#4444ff'],
      animation: 'sparkle',
    });
  });

  it('returns the splat config explicitly', () => {
    expect(getEffectConfig('splat')).toEqual({
      color: '#ff4444',
      splashColor: '#cc0000',
      particles: 12,
      size: 'large',
      animation: 'splat',
      drip: true,
    });
  });

  it('falls back to the splat config for unknown types', () => {
    expect(getEffectConfig('something-else')).toEqual(getEffectConfig('splat'));
  });
});

describe('getEffectEmoji', () => {
  it('maps known types to their emoji', () => {
    expect(getEffectEmoji('confetti')).toBe('🎉');
    expect(getEffectEmoji('particles')).toBe('✨');
    expect(getEffectEmoji('splat')).toBe('🍅');
  });

  it('falls back to the splat emoji for unknown types', () => {
    expect(getEffectEmoji('unknown')).toBe('🍅');
  });
});
