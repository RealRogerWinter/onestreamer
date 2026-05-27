// Tests for server/services/ModerationStage3 — OpenAI omni-moderation
// cross-check (PR-M3 of ADR-0013).
//
// Coverage:
//   - Constructor reads OPENAI_API_KEY from env.
//   - isReady / isDegraded toggle correctly with circuit-breaker state.
//   - classify() returns shaped result on a well-formed OpenAI response.
//   - Degraded paths (no API key, empty text).
//   - Error paths (non-2xx, malformed envelope, malformed result).
//   - Circuit breaker opens after threshold and stays open for cbOpenMs.

const ModerationStage3 = require('../../services/ModerationStage3');

function ok(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function err(status, body = '{"error":"x"}') {
  return { ok: false, status, text: async () => body };
}
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('ModerationStage3 contract', () => {
  test('isReady=false when no API key', () => {
    const s3 = new ModerationStage3({ apiKey: null });
    expect(s3.isReady()).toBe(false);
  });

  test('classify returns degraded when no API key', async () => {
    const s3 = new ModerationStage3({ apiKey: null });
    const r = await s3.classify({ text: 'foo' });
    expect(r).toEqual({ degraded: true, reason: 'no_api_key' });
  });

  test('classify returns error on empty text', async () => {
    const s3 = new ModerationStage3({ apiKey: 'k' });
    const r = await s3.classify({ text: '' });
    expect(r.error).toBe('empty_text');
  });
});

describe('ModerationStage3.classify happy path', () => {
  test('returns shaped result on flagged response', async () => {
    const fetchImpl = jest.fn(async () => ok({
      results: [{
        flagged: true,
        categories: { hate: true, 'hate/threatening': false },
        category_scores: { hate: 0.92, 'hate/threatening': 0.31 },
      }],
    }));
    const clock = fakeClock();
    const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl, clock });
    clock.advance(70);
    const r = await s3.classify({ text: 'a clearly hateful sentence' });
    expect(r.flagged).toBe(true);
    expect(r.categories).toEqual({ hate: true, 'hate/threatening': false });
    expect(r.scores).toEqual({ hate: 0.92, 'hate/threatening': 0.31 });
    expect(r.model).toBeDefined();
    expect(typeof r.latency_ms).toBe('number');
  });

  test('passes raw text without anti-injection wrapping (classifier endpoint)', async () => {
    // omni-moderation is a classifier, not a chat completion — there is no
    // attack surface for prompt injection because the model doesn't follow
    // instructions inside the input. We deliberately do NOT wrap the text.
    const fetchImpl = jest.fn(async () => ok({
      results: [{ flagged: false, categories: {}, category_scores: {} }],
    }));
    const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
    await s3.classify({ text: 'plain text here' });
    const reqBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(reqBody.input).toBe('plain text here');
    expect(reqBody.input).not.toMatch(/<transcript untrusted/);
  });
});

describe('ModerationStage3.classify error paths', () => {
  test('non-2xx → openai_<status>', async () => {
    const fetchImpl = jest.fn(async () => err(429, 'rate'));
    const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
    const r = await s3.classify({ text: 'x' });
    expect(r.error).toBe('openai_429');
    expect(r.raw_status).toBe(429);
  });

  test('malformed envelope → envelope_parse_failed', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'not json' }));
    const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
    const r = await s3.classify({ text: 'x' });
    expect(r.error).toBe('envelope_parse_failed');
  });

  test('missing results → result_shape_invalid', async () => {
    const fetchImpl = jest.fn(async () => ok({ results: [{ /* no flagged */ }] }));
    const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
    const r = await s3.classify({ text: 'x' });
    expect(r.error).toBe('result_shape_invalid');
  });
});

describe('ModerationStage3 circuit breaker', () => {
  test('opens after threshold and refuses calls during open window', async () => {
    const clock = fakeClock();
    const fetchImpl = jest.fn(async () => err(500));
    const s3 = new ModerationStage3({
      apiKey: 'k', fetchImpl, clock,
      cbThreshold: 3, cbOpenMs: 10_000,
    });
    for (let i = 0; i < 3; i++) await s3.classify({ text: 'x' });
    expect(s3.isDegraded()).toBe(true);
    const callsBefore = fetchImpl.mock.calls.length;
    const r = await s3.classify({ text: 'x' });
    expect(r).toEqual({ degraded: true, reason: 'breaker_open' });
    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
  });

  test('success resets the failure counter', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = jest.fn(async () => {
      n += 1;
      if (n === 1) return err(500);
      return ok({ results: [{ flagged: false, categories: {}, category_scores: {} }] });
    });
    const s3 = new ModerationStage3({
      apiKey: 'k', fetchImpl, clock,
      cbThreshold: 3, cbOpenMs: 10_000,
    });
    await s3.classify({ text: 'x' });
    expect(s3._consecutiveFailures).toBe(1);
    const r = await s3.classify({ text: 'x' });
    expect(r.flagged).toBe(false);
    expect(s3._consecutiveFailures).toBe(0);
  });
});
