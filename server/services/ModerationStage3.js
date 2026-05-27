// server/services/ModerationStage3.js
//
// Stage 3 of the AI moderation pipeline (PR-M3 of [ADR-0013]).
//
// Cross-checks a Stage 2 risk_level=3 verdict against OpenAI's free
// `omni-moderation-latest` endpoint. Auto-action (PR-M3 ActionArbiter)
// fires ONLY on two-of-two HIGH agreement — partial protection against
// the Stage 2 model having a particular bias (especially AAVE / reclaimed
// terms, the load-bearing residual risk documented in ADR-0013). The two
// LLMs train on overlapping corpora so this is "partial" not "full"
// independence.
//
// Cost: omni-moderation is free. Rate limit is ~1000 req/min on Tier 1.
// Per-streamer quota (`per-streamer max 20 calls/hr`) is enforced in
// ModerationService once we have the streamer context — it's not Stage 3's
// concern here.
//
// IMAGE INPUT (ADR-0021, OmniImageMod PR 1):
// classify() now accepts an optional `imageBase64` alongside `text`. Sent as
// an OpenAI multi-modal `input` array with an `image_url` content part using
// a base64 data URI. Used by ModerationService.handleVisionFrame to screen
// VisionBot screenshots. Only the 6 image-supported categories trigger from
// image input: sexual, violence, violence/graphic, self-harm,
// self-harm/intent, self-harm/instructions. `sexual/minors` (CSAM), hate,
// hate/threatening, harassment, harassment/threatening, illicit, illicit/violent
// remain TEXT-ONLY in omni-moderation per OpenAI's docs.
//
// Returns:
//   { flagged: boolean, categories: {...}, scores: {...},
//     applied_input_types: {...}, model, latency_ms, raw }
//   { degraded: true, reason: 'no_api_key' | 'breaker_open' }
//   { error, raw_status, raw_body }
//
// Mirrors ModerationStage2's circuit-breaker shape so ModerationService
// can treat the two interchangeably.

const DEFAULT_API_URL = 'https://api.openai.com/v1/moderations';
const DEFAULT_MODEL = 'omni-moderation-latest';
const DEFAULT_TIMEOUT_MS = 5000;
const CB_THRESHOLD = 5;
const CB_OPEN_MS = 60_000;

// We care about these categories for the 2-of-2 HIGH agreement gate.
// Stage 3 only confirms (or contradicts) Stage 2's verdict — it doesn't
// need to produce its own risk_level.
const RELEVANT_CATEGORIES = ['hate', 'hate/threatening', 'sexual', 'sexual/minors', 'violence', 'violence/graphic', 'harassment', 'harassment/threatening'];

class ModerationStage3 {
  /**
   * @param {object} options
   * @param {string} [options.apiKey]      OpenAI API key. Defaults to OPENAI_API_KEY env.
   * @param {string} [options.model]       Override model. Defaults to omni-moderation-latest.
   * @param {string} [options.apiUrl]      Override endpoint (testing).
   * @param {number} [options.timeoutMs]   Per-call timeout. Defaults to 5000.
   * @param {Function} [options.fetchImpl] Fetch impl (testing). Defaults to globalThis.fetch.
   * @param {number} [options.cbThreshold] Consecutive failures before opening.
   * @param {number} [options.cbOpenMs]    How long the breaker stays open.
   * @param {object} [options.clock]       { now: () => ms } injection.
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? null;
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cbThreshold = options.cbThreshold ?? CB_THRESHOLD;
    this.cbOpenMs = options.cbOpenMs ?? CB_OPEN_MS;
    this.clock = options.clock ?? { now: () => Date.now() };

    this._consecutiveFailures = 0;
    this._cbOpenUntil = 0;
  }

  isDegraded() {
    return this.clock.now() < this._cbOpenUntil;
  }

  isReady() {
    return !!this.apiKey && !this.isDegraded();
  }

  /**
   * Call OpenAI omni-moderation. Accepts text, image, or both.
   *
   * @param {object} input
   * @param {string} [input.text]         Transcript text to check. We
   *   deliberately do NOT add the anti-injection wrapper here — omni-
   *   moderation is a classifier, not a chat completion, so injection is
   *   structurally impossible. The model sees only the raw text and returns
   *   score-per-category.
   * @param {string} [input.imageBase64]  Base64-encoded image (no data URI
   *   prefix). When present, sent as an `image_url` content part using a
   *   `data:<mime>;base64,...` URI. Caller supplies imageMime.
   * @param {string} [input.imageMime]    MIME type for the imageBase64.
   *   Defaults to image/jpeg. omni-moderation supports image/jpeg,
   *   image/png, image/gif, image/webp per docs.
   * @returns {Promise<object>}
   */
  async classify({ text, imageBase64, imageMime = 'image/jpeg' } = {}) {
    if (!this.apiKey) return { degraded: true, reason: 'no_api_key' };
    if (this.isDegraded()) return { degraded: true, reason: 'breaker_open' };
    const hasText = typeof text === 'string' && text.length > 0;
    const hasImage = typeof imageBase64 === 'string' && imageBase64.length > 0;
    if (!hasText && !hasImage) {
      return { error: 'empty_input', raw_status: null, raw_body: null };
    }
    // 4 MB base64 ≈ 3 MB binary. Catches misconfig before we burn a fetch
    // round-trip. omni's documented hard limit is 20 MB; our captures from
    // EgressFrameCaptureService are ~30 KB, so anything large is bogus.
    if (hasImage && imageBase64.length > 4 * 1024 * 1024) {
      return { error: 'image_too_large', raw_status: null, raw_body: null };
    }
    // JPEG magic-byte sanity — base64('FF D8 FF') starts with '/9j/'. Catches
    // upstream ffmpeg corruption before it burns a breaker count. Only
    // applies to JPEG; other MIMEs pass through unchecked (caller's
    // responsibility).
    if (hasImage && imageMime === 'image/jpeg' && !imageBase64.startsWith('/9j/')) {
      return { error: 'invalid_jpeg', raw_status: null, raw_body: null };
    }
    if (typeof this.fetchImpl !== 'function') {
      this._recordFailure();
      return { error: 'no_fetch_impl', raw_status: null, raw_body: null };
    }

    // Build the request body. Text-only callers keep the original
    // `input: text` (string) shape — backward-compat. As soon as an image is
    // present, switch to the OpenAI multi-modal content-part array.
    let inputField;
    if (hasImage) {
      inputField = [];
      if (hasText) inputField.push({ type: 'text', text });
      inputField.push({
        type: 'image_url',
        image_url: { url: `data:${imageMime};base64,${imageBase64}` },
      });
    } else {
      inputField = text;
    }

    const startTime = this.clock.now();
    let resp;
    let bodyText;

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        resp = await this.fetchImpl(this.apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: this.model, input: inputField }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(tid);
      }
    } catch (err) {
      this._recordFailure();
      return {
        error: err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'network_error',
        raw_status: null,
        raw_body: null,
      };
    }

    try {
      bodyText = await resp.text();
    } catch (err) {
      this._recordFailure();
      return { error: 'body_read_error', raw_status: resp.status, raw_body: null };
    }

    if (!resp.ok) {
      this._recordFailure();
      return {
        error: `openai_${resp.status}`,
        raw_status: resp.status,
        raw_body: bodyText.slice(0, 500),
      };
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (err) {
      this._recordFailure();
      return { error: 'envelope_parse_failed', raw_status: resp.status, raw_body: bodyText.slice(0, 500) };
    }

    const result = payload && payload.results && payload.results[0];
    if (!result || typeof result.flagged !== 'boolean') {
      this._recordFailure();
      return { error: 'result_shape_invalid', raw_status: resp.status, raw_body: bodyText.slice(0, 500) };
    }

    // Success — reset breaker.
    this._consecutiveFailures = 0;
    this._cbOpenUntil = 0;

    return {
      flagged: result.flagged,
      categories: result.categories || {},
      scores: result.category_scores || {},
      // omni-moderation tells the caller whether each category was tripped
      // by text, image, or both. Surface it so ModerationService can drop
      // false hits where, e.g., `sexual/minors` (text-only) appears in a
      // text+image call but only the text branch fired. {} for legacy
      // text-only responses that don't include the field.
      applied_input_types: result.category_applied_input_types || {},
      model: this.model,
      latency_ms: this.clock.now() - startTime,
      raw: bodyText,
    };
  }

  _recordFailure() {
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= this.cbThreshold && this._cbOpenUntil <= this.clock.now()) {
      this._cbOpenUntil = this.clock.now() + this.cbOpenMs;
    }
  }
}

module.exports = ModerationStage3;
module.exports.RELEVANT_CATEGORIES = RELEVANT_CATEGORIES;
