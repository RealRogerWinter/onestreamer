const { defaultPropsForPlatform, capSourceQuality } = require('../../../services/viewbot/streamDefaults');

describe('capSourceQuality', () => {
  test("'best' and 'source' collapse to 720p", () => {
    expect(capSourceQuality('best')).toBe('720p');
    expect(capSourceQuality('source')).toBe('720p');
  });

  test('resolutions above the cap collapse to 720p', () => {
    expect(capSourceQuality('1080p')).toBe('720p');
    expect(capSourceQuality('1080p60')).toBe('720p');
    expect(capSourceQuality('1440p')).toBe('720p');
  });

  test('720p and below pass through unchanged', () => {
    expect(capSourceQuality('720p')).toBe('720p');
    expect(capSourceQuality('720p60')).toBe('720p60');
    expect(capSourceQuality('480p')).toBe('480p');
    expect(capSourceQuality('worst')).toBe('worst');
    expect(capSourceQuality('audio_only')).toBe('audio_only');
  });

  test('missing quality defaults to 720p', () => {
    expect(capSourceQuality(undefined)).toBe('720p');
    expect(capSourceQuality('')).toBe('720p');
  });
});

describe('defaultPropsForPlatform', () => {
  test('known platform + quality returns that tier merged with audio + probeNote', () => {
    expect(defaultPropsForPlatform('twitch', '720p')).toEqual({
      width: 1280, height: 720, fps: 60, videoBitrate: 3000000,
      hasAudio: true, audioBitrate: 128000, probeNote: 'platform_default_twitch',
    });
  });

  test('unknown platform falls back to the default table', () => {
    const props = defaultPropsForPlatform('vimeo', 'best');
    expect(props).toMatchObject({ width: 1280, height: 720, fps: 30, videoBitrate: 3000000 });
    expect(props.probeNote).toBe('platform_default_vimeo'); // note keeps the requested platform name
  });

  test('unknown quality falls back to the platform best tier', () => {
    expect(defaultPropsForPlatform('youtube', '1440p')).toMatchObject({
      width: 1920, height: 1080, fps: 60, videoBitrate: 8000000, // youtube best
    });
  });

  test('baseDefaults are merged underneath and overridden by quality settings', () => {
    const props = defaultPropsForPlatform('twitch', 'best', { foo: 'bar', width: 1, audioBitrate: 999 });
    expect(props.foo).toBe('bar');           // base-only key survives
    expect(props.width).toBe(1920);          // quality tier overrides base
    expect(props.audioBitrate).toBe(128000); // explicit audio default overrides base
    expect(props.hasAudio).toBe(true);
  });
});
