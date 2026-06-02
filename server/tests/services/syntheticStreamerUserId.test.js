const syntheticStreamerUserId = require('../../services/item/syntheticStreamerUserId');

describe('syntheticStreamerUserId', () => {
    it('returns a negative integer for url-stream ids', () => {
        const id = syntheticStreamerUserId('url-stream-1700000000000-3');
        expect(typeof id).toBe('number');
        expect(id).toBeLessThan(0);
        expect(Number.isInteger(id)).toBe(true);
    });

    it('returns a negative integer for viewbot ids', () => {
        expect(syntheticStreamerUserId('viewbot-42')).toBeLessThan(0);
    });

    it('is stable: the same streamer id always maps to the same userId', () => {
        expect(syntheticStreamerUserId('url-stream-abc')).toBe(syntheticStreamerUserId('url-stream-abc'));
    });

    it('distinguishes different relay streams', () => {
        expect(syntheticStreamerUserId('url-stream-a')).not.toBe(syntheticStreamerUserId('url-stream-b'));
    });

    it('returns null for a real socket id (so real streamers resolve a real userId)', () => {
        expect(syntheticStreamerUserId('abcDEF123socket')).toBeNull();
    });

    it('returns null for non-string input', () => {
        expect(syntheticStreamerUserId(null)).toBeNull();
        expect(syntheticStreamerUserId(undefined)).toBeNull();
        expect(syntheticStreamerUserId(123)).toBeNull();
    });

    it('never returns -0 / 0 (AnonymousBuffStore keys off userId < 0)', () => {
        // exercise a spread of ids; all must be strictly < 0
        for (const suffix of ['', '0', 'x', 'url-stream-', 'aaaaaaaa']) {
            const id = syntheticStreamerUserId(`url-stream-${suffix}`);
            expect(id).toBeLessThan(0);
            expect(Object.is(id, -0)).toBe(false);
        }
    });
});
