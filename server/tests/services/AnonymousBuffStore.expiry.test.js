const EventEmitter = require('events');
const AnonymousBuffStore = require('../../services/buffdebuff/AnonymousBuffStore');

// Minimal BuffDebuffService stand-in: AnonymousBuffStore reads/writes
// owner.anonymousBuffsCache and calls owner.{itemRepository,formatBuffForClient,
// io,emit}.
function makeOwner() {
    const owner = new EventEmitter();
    owner.anonymousBuffsCache = new Map();
    owner.io = { emit: jest.fn() };
    owner.itemRepository = {
        getByIdIncludingInactive: jest.fn(async () => ({
            name: 'upside_down', display_name: 'Upside Down', emoji: '🙃',
            effect_data: JSON.stringify({ effect_type: 'visual_filter', visual_effect: 'flip_vertical' }),
        })),
    };
    owner.formatBuffForClient = (buff) => ({
        id: buff.id,
        remainingSeconds: buff.remaining_seconds,
        durationSeconds: buff.duration_seconds,
        displayName: buff.display_name,
    });
    return owner;
}

function pushBuff(owner, userId, { id = 'anon_x', duration = 20, secondsAgo = 0 }) {
    if (!owner.anonymousBuffsCache.has(userId)) owner.anonymousBuffsCache.set(userId, []);
    owner.anonymousBuffsCache.get(userId).push({
        id, user_id: userId, item_id: 5, applied_by_user_id: 1, buff_type: 'debuff',
        duration_seconds: duration, remaining_seconds: duration,
        applied_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
        is_active: true, metadata: null,
    });
}

describe('AnonymousBuffStore wall-clock expiry/countdown', () => {
    it('reports remaining = duration − elapsed (ticks down) for an in-progress buff', async () => {
        const owner = makeOwner();
        const store = new AnonymousBuffStore(owner);
        pushBuff(owner, -123, { duration: 20, secondsAgo: 5 });

        const buffs = await store.getActiveBuffsForUser(-123);
        expect(buffs).toHaveLength(1);
        expect(buffs[0].remainingSeconds).toBeGreaterThanOrEqual(13);
        expect(buffs[0].remainingSeconds).toBeLessThanOrEqual(15);
    });

    it('expires an elapsed buff: drops it, prunes the cache, and emits buff-expired', async () => {
        const owner = makeOwner();
        const store = new AnonymousBuffStore(owner);
        pushBuff(owner, -123, { id: 'anon_old', duration: 20, secondsAgo: 25 });

        const buffs = await store.getActiveBuffsForUser(-123);
        expect(buffs).toHaveLength(0);
        expect(owner.anonymousBuffsCache.get(-123) || []).toHaveLength(0);
        expect(owner.io.emit).toHaveBeenCalledWith('buff-expired', expect.objectContaining({ buffId: 'anon_old' }));
    });

    it('getActiveBuffByItemForUser ignores an elapsed buff (so re-use starts fresh)', () => {
        const owner = makeOwner();
        const store = new AnonymousBuffStore(owner);
        pushBuff(owner, -123, { id: 'anon_old', duration: 20, secondsAgo: 25 });
        expect(store.getActiveBuffByItemForUser(-123, 5)).toBeNull();
    });

    it('a read for one streamer also expires another (rotated-away) streamer\'s elapsed buffs', async () => {
        const owner = makeOwner();
        const store = new AnonymousBuffStore(owner);
        pushBuff(owner, -123, { id: 'anon_stale', duration: 20, secondsAgo: 30 }); // a previous relay stream
        pushBuff(owner, -456, { id: 'anon_live', duration: 20, secondsAgo: 2 });   // the current relay stream

        const buffs = await store.getActiveBuffsForUser(-456);
        expect(buffs).toHaveLength(1);
        // the orphaned, elapsed buff from the rotated-away stream is cleaned up
        expect(owner.anonymousBuffsCache.has(-123)).toBe(false);
    });
});
