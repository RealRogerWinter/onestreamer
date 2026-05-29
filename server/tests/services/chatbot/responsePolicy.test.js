const { isBotExpired, computeResponseInterval, buildResponsePersonality } = require('../../../services/chatbot/responsePolicy');

describe('isBotExpired', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  test('non-temporary bot is never expired', () => {
    expect(isBotExpired({ is_temporary: 0, expires_at: new Date(0).toISOString() }, now)).toBe(false);
  });
  test('temporary bot without expires_at is not expired', () => {
    expect(isBotExpired({ is_temporary: 1, expires_at: null }, now)).toBe(false);
  });
  test('temporary bot past expiry is expired', () => {
    expect(isBotExpired({ is_temporary: 1, expires_at: new Date(now.getTime() - 1).toISOString() }, now)).toBe(true);
  });
  test('temporary bot before expiry is not expired', () => {
    expect(isBotExpired({ is_temporary: 1, expires_at: new Date(now.getTime() + 1000).toISOString() }, now)).toBe(false);
  });
});

describe('computeResponseInterval', () => {
  test('maps [min,max] seconds to ms using rng across the range', () => {
    const data = { response_interval_min: 10, response_interval_max: 20 }; // 10000..20000ms
    expect(computeResponseInterval(data, () => 0)).toBe(10000);
    expect(computeResponseInterval(data, () => 0.5)).toBe(15000);
    expect(computeResponseInterval(data, () => 1)).toBe(20000);
  });
});

describe('buildResponsePersonality', () => {
  test('empty traits -> just temperature', () => {
    expect(buildResponsePersonality({ personality_traits: null, response_creativity_temperature: 0.8 }))
      .toEqual({ temperature: 0.8 });
  });
  test('parses traits JSON and layers temperature', () => {
    expect(buildResponsePersonality({ personality_traits: JSON.stringify({ tone: 'snarky' }), response_creativity_temperature: 0.3 }))
      .toEqual({ tone: 'snarky', temperature: 0.3 });
  });
  test('omits temperature when null/undefined', () => {
    expect(buildResponsePersonality({ personality_traits: JSON.stringify({ tone: 'x' }), response_creativity_temperature: null }))
      .toEqual({ tone: 'x' });
    expect(buildResponsePersonality({ personality_traits: null }))
      .toEqual({});
  });
});
