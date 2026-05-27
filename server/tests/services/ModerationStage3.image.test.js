// Tests for ModerationStage3's image-input extension (OmniImageMod PR 1,
// ADR-0021). The image path is used by ModerationService.handleVisionFrame
// (PR 2) to screen VisionBot screenshots. Text-only callers are unaffected
// — backward-compat is covered in ModerationStage3.test.js.

const ModerationStage3 = require('../../services/ModerationStage3');

// Base64 of [0xFF, 0xD8, 0xFF, 0xE0] — the JPEG magic-byte prefix plus one
// extra byte. Long enough to pass the prefix check; short enough that the
// tests aren't carrying weight.
const VALID_JPEG_B64 = '/9j/4AAQ';

// Base64 of [0x00, 0x00, 0x00, 0x00] — does NOT start with /9j/, so the
// JPEG magic-byte check should reject it.
const NOT_A_JPEG_B64 = 'AAAAAAAA';

function ok(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function flaggedImageResponse({ category = 'violence', score = 0.9 } = {}) {
    return ok({
        results: [{
            flagged: true,
            categories: { [category]: true },
            category_scores: { [category]: score },
            category_applied_input_types: { [category]: ['image'] },
        }],
    });
}

describe('ModerationStage3 image input — request shape', () => {
    test('image-only call sends a single image_url content part with data URI', async () => {
        const fetchImpl = jest.fn(async () => flaggedImageResponse());
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        await s3.classify({ imageBase64: VALID_JPEG_B64 });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(Array.isArray(body.input)).toBe(true);
        expect(body.input).toHaveLength(1);
        expect(body.input[0]).toEqual({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${VALID_JPEG_B64}` },
        });
        expect(body.model).toBe('omni-moderation-latest');
    });

    test('text + image call sends a two-item input array, text first', async () => {
        const fetchImpl = jest.fn(async () => flaggedImageResponse());
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        await s3.classify({ text: 'spoken transcript', imageBase64: VALID_JPEG_B64 });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.input).toEqual([
            { type: 'text', text: 'spoken transcript' },
            {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${VALID_JPEG_B64}` },
            },
        ]);
    });

    test('honors imageMime override (e.g., image/png)', async () => {
        const fetchImpl = jest.fn(async () => flaggedImageResponse());
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        // Note: the JPEG magic-byte check only applies when mime is JPEG, so
        // a non-JPEG mime + a base64 string that doesn't look like JPEG is
        // accepted.
        await s3.classify({ imageBase64: 'iVBORw0KGgo=', imageMime: 'image/png' });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.input[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    });

    test('text-only call preserves the legacy `input: "<string>"` shape (backward-compat)', async () => {
        const fetchImpl = jest.fn(async () => ok({
            results: [{ flagged: false, categories: {}, category_scores: {} }],
        }));
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        await s3.classify({ text: 'plain text' });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.input).toBe('plain text');
    });
});

describe('ModerationStage3 image input — validation', () => {
    test('empty inputs (no text, no image) → empty_input', async () => {
        const s3 = new ModerationStage3({ apiKey: 'k' });
        const r = await s3.classify({});
        expect(r.error).toBe('empty_input');
    });

    test('image larger than 4 MB base64 → image_too_large (no fetch)', async () => {
        const fetchImpl = jest.fn();
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        const huge = '/9j/' + 'A'.repeat(5 * 1024 * 1024);
        const r = await s3.classify({ imageBase64: huge });
        expect(r.error).toBe('image_too_large');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('non-JPEG base64 with mime=image/jpeg → invalid_jpeg (no fetch)', async () => {
        const fetchImpl = jest.fn();
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        const r = await s3.classify({ imageBase64: NOT_A_JPEG_B64 });
        expect(r.error).toBe('invalid_jpeg');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('validation does NOT consume a breaker count', async () => {
        const fetchImpl = jest.fn();
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl, cbThreshold: 2 });
        await s3.classify({ imageBase64: NOT_A_JPEG_B64 });
        await s3.classify({ imageBase64: NOT_A_JPEG_B64 });
        await s3.classify({ imageBase64: NOT_A_JPEG_B64 });
        expect(s3._consecutiveFailures).toBe(0);
        expect(s3.isDegraded()).toBe(false);
    });
});

describe('ModerationStage3 image input — response shape', () => {
    test('returns applied_input_types from category_applied_input_types', async () => {
        const fetchImpl = jest.fn(async () => ok({
            results: [{
                flagged: true,
                categories: { violence: true, 'violence/graphic': false },
                category_scores: { violence: 0.91, 'violence/graphic': 0.42 },
                category_applied_input_types: {
                    violence: ['image'],
                    'violence/graphic': ['image', 'text'],
                },
            }],
        }));
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        const r = await s3.classify({ imageBase64: VALID_JPEG_B64 });
        expect(r.flagged).toBe(true);
        expect(r.applied_input_types).toEqual({
            violence: ['image'],
            'violence/graphic': ['image', 'text'],
        });
    });

    test('empty applied_input_types object when omni omits the field (legacy text-only response)', async () => {
        const fetchImpl = jest.fn(async () => ok({
            results: [{ flagged: false, categories: {}, category_scores: {} }],
        }));
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        const r = await s3.classify({ text: 'plain' });
        expect(r.applied_input_types).toEqual({});
    });
});

describe('ModerationStage3 image input — error propagation', () => {
    test('429 increments breaker (image path uses the same failure tracking)', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, text: async () => 'rate' }));
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl, cbThreshold: 3 });
        await s3.classify({ imageBase64: VALID_JPEG_B64 });
        expect(s3._consecutiveFailures).toBe(1);
    });

    test('5xx propagates as openai_<status> error', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }));
        const s3 = new ModerationStage3({ apiKey: 'k', fetchImpl });
        const r = await s3.classify({ imageBase64: VALID_JPEG_B64 });
        expect(r.error).toBe('openai_503');
        expect(r.raw_status).toBe(503);
    });
});
