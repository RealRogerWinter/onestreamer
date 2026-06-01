/**
 * Characterization net for ItemUseService.
 *
 * ItemUseService has no prior test coverage. This suite PINS the current
 * observable behavior before the service is decomposed into collaborators
 * under server/services/itemUse/. It is written to pass against the CURRENT
 * service and must remain UNCHANGED across the decomposition commit.
 *
 * Strategy:
 *   - The single public entry is useItem(); it dispatches by item-type to a
 *     family of private sub-methods. We drive each branch through useItem with
 *     hand-rolled mock services and assert the discriminated-result shape.
 *   - Sub-methods read collaborators off opts.services, so the mocks only need
 *     the methods each branch touches.
 *
 * buffNotifier is destructured in useItem() AND carried on ctx, so the
 * inventory-update forEach in the sub-methods resolves it correctly and the
 * notifier is invoked (io AND sessionService both present). The buff/debuff
 * and regular-path tests below assert that fixed behavior.
 */

jest.mock('../../bootstrap/logger', () => {
    const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
    m.child = jest.fn(() => m);
    return m;
});

const ItemUseService = require('../../services/ItemUseService');

const noop = async () => {};

/** A default item row; override per-branch. */
function makeItem(overrides = {}) {
    return {
        id: 5, name: 'x', display_name: 'X', emoji: '⚡', item_type: 'utility',
        ...overrides,
    };
}

/** Base inventoryService mock; consumption + lookup both succeed. */
function makeInventory(overrides = {}) {
    return {
        useItem: jest.fn(async () => ({ item: { id: 5, displayName: 'X', name: 'x' }, remainingQuantity: 2 })),
        getInventoryItem: jest.fn(async () => ({ quantity: 3 })),
        ...overrides,
    };
}

/** Base itemService mock; predicates default to false. */
function makeItemService(item, overrides = {}) {
    return {
        getItemById: jest.fn(async () => item),
        isBuffOrDebuffItem: jest.fn(() => false),
        isCooldownModifierItem: jest.fn(() => false),
        validateItemUsage: jest.fn(async () => ({ valid: true })),
        applyBuffDebuffItem: jest.fn(async () => ({ ok: true })),
        applyCooldownModifierItem: jest.fn(async () => ({ effects: [] })),
        getGlobalCooldownInfo: jest.fn(async () => ({})),
        ...overrides,
    };
}

function activeStream(streamerId = 's1') {
    return { getStreamStatus: jest.fn(() => ({ hasActiveStream: true, streamerId })), getCurrentStreamer: jest.fn(() => 'sock1') };
}

function call(svc, services, extra = {}) {
    return svc.useItem({
        user: { id: 1, username: 'u' },
        itemId: 5,
        body: {},
        services,
        io: undefined,
        sessionService: undefined,
        sendSystemMessage: noop,
        ...extra,
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('ItemUseService characterization', () => {
    describe('top-level gating', () => {
        it('returns {ok:false, kind:"item-not-found"} when the item does not exist', async () => {
            const services = {
                inventoryService: makeInventory(),
                itemService: makeItemService(null, { getItemById: jest.fn(async () => null) }),
                streamService: activeStream(),
            };
            await expect(call(svc(), services)).resolves.toEqual({ ok: false, kind: 'item-not-found' });
        });

        it('maps a thrown "cooldown" error to {ok:false, kind:"cooldown"}', async () => {
            const services = {
                inventoryService: makeInventory(),
                itemService: makeItemService(null, { getItemById: jest.fn(async () => { throw new Error('item on cooldown'); }) }),
                streamService: activeStream(),
            };
            await expect(call(svc(), services)).resolves.toEqual({ ok: false, kind: 'cooldown', message: 'item on cooldown' });
        });

        it('maps any other thrown error to {ok:false, kind:"error"} carrying the cause', async () => {
            const boom = new Error('disk full');
            const services = {
                inventoryService: makeInventory(),
                itemService: makeItemService(null, { getItemById: jest.fn(async () => { throw boom; }) }),
                streamService: activeStream(),
            };
            const res = await call(svc(), services);
            expect(res).toMatchObject({ ok: false, kind: 'error', message: 'disk full' });
            expect(res.cause).toBe(boom);
        });
    });

    describe('auto-trigger items (fart / thunderstorm)', () => {
        it('consumes immediately and returns interactionMode:"auto-trigger" for fart', async () => {
            const item = makeItem({ name: 'fart', display_name: 'Fart', emoji: '💨' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item);
            const canvasFxService = {
                isInteractiveItem: jest.fn(() => false),
                getInteractionConfig: jest.fn(() => ({ mode: 'auto-trigger' })),
                triggerItemEffect: jest.fn(async () => ({})),
            };
            const soundFxService = { queue101Soundboard: jest.fn(async () => {}) };
            const sent = [];
            const res = await call(svc(), { inventoryService, itemService, streamService: activeStream(), canvasFxService, soundFxService },
                { sendSystemMessage: async (m) => sent.push(m) });

            expect(res).toEqual({
                ok: true,
                body: {
                    success: true,
                    item: { id: 5, displayName: 'X', name: 'x' },
                    remainingQuantity: 2,
                    interactionMode: 'auto-trigger',
                    interactionConfig: { mode: 'auto-trigger' },
                    message: 'Auto-trigger item activated',
                },
            });
            expect(inventoryService.useItem).toHaveBeenCalledWith(1, 5, 's1');
            expect(sent).toContain('💨 u let one rip!');
        });
    });

    describe('interactive items (validate-only)', () => {
        it('returns the click-to-throw success body with an interactionId for an interactive item', async () => {
            const item = makeItem({ name: 'paint', item_type: 'marker' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item);
            const canvasFxService = {
                isInteractiveItem: jest.fn(() => true),
                getInteractionConfig: jest.fn(() => ({ autoTrigger: false, mode: 'click-to-throw' })),
            };
            const res = await call(svc(), { inventoryService, itemService, streamService: activeStream(), canvasFxService });

            expect(res.ok).toBe(true);
            expect(res.body).toMatchObject({
                success: true,
                item: { id: 5, name: 'paint', displayName: 'X', emoji: '⚡', type: 'marker' },
                remainingQuantity: 3,
                interactionMode: 'click-to-throw',
                message: 'Interaction mode activated',
            });
            expect(res.body.interactionId).toMatch(/^interact_1_5_\d+$/);
            // Validate-only: the item is NOT consumed here.
            expect(inventoryService.useItem).not.toHaveBeenCalled();
        });

        it('returns {ok:false, kind:"no-active-stream"} for an interactive item with no stream/MediaSoup', async () => {
            const item = makeItem({ name: 'paint' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item);
            const canvasFxService = {
                isInteractiveItem: jest.fn(() => true),
                getInteractionConfig: jest.fn(() => ({ autoTrigger: false, mode: 'click-to-throw' })),
            };
            const streamService = { getStreamStatus: jest.fn(() => ({ hasActiveStream: false, streamerId: null })) };
            await expect(call(svc(), { inventoryService, itemService, streamService, canvasFxService }))
                .resolves.toEqual({ ok: false, kind: 'no-active-stream' });
        });
    });

    describe('utility validate-only items (TTS / summon-bot / soundboard)', () => {
        it('TTS items return ttsMode:true and "TTS input required" WITHOUT cooldownRemaining', async () => {
            const item = makeItem({ name: 'megaphone' });
            const services = { inventoryService: makeInventory(), itemService: makeItemService(item), streamService: activeStream() };
            const res = await call(svc(), services);
            expect(res).toEqual({
                ok: true,
                body: {
                    success: true,
                    item: { id: 5, name: 'megaphone', displayName: 'X', emoji: '⚡', type: 'utility' },
                    remainingQuantity: 3,
                    ttsMode: true,
                    message: 'TTS input required',
                },
            });
        });

        it('summon-bot validation failure INCLUDES cooldownRemaining in the 429 result', async () => {
            const item = makeItem({ name: 'summon_bot' });
            const itemService = makeItemService(item, {
                validateItemUsage: jest.fn(async () => ({ valid: false, error: 'on cd', cooldownRemaining: 42 })),
            });
            const res = await call(svc(), { inventoryService: makeInventory(), itemService, streamService: activeStream() });
            expect(res).toEqual({ ok: false, kind: 'validation-failed', error: 'on cd', cooldownRemaining: 42 });
        });

        it('soundboard validation failure EXCLUDES cooldownRemaining (parity with original handler)', async () => {
            const item = makeItem({ name: '101soundboards' });
            const itemService = makeItemService(item, {
                validateItemUsage: jest.fn(async () => ({ valid: false, error: 'on cd', cooldownRemaining: 42 })),
            });
            const res = await call(svc(), { inventoryService: makeInventory(), itemService, streamService: activeStream() });
            expect(res).toEqual({ ok: false, kind: 'validation-failed', error: 'on cd' });
            expect(res.cooldownRemaining).toBeUndefined();
        });

        it('returns {ok:false, kind:"not-in-inventory"} when quantity < 1', async () => {
            const item = makeItem({ name: 'megaphone' });
            const inventoryService = makeInventory({ getInventoryItem: jest.fn(async () => ({ quantity: 0 })) });
            await expect(call(svc(), { inventoryService, itemService: makeItemService(item), streamService: activeStream() }))
                .resolves.toEqual({ ok: false, kind: 'not-in-inventory' });
        });
    });

    describe('buff/debuff items', () => {
        it('returns service-unavailable when buffDebuffService is missing', async () => {
            const item = makeItem({ name: 'spd', item_type: 'buff' });
            const itemService = makeItemService(item, { isBuffOrDebuffItem: jest.fn(() => true) });
            await expect(call(svc(), { inventoryService: makeInventory(), itemService, streamService: activeStream() }))
                .resolves.toEqual({ ok: false, kind: 'service-unavailable', service: 'buffDebuffService' });
        });

        it('returns no-streamer-target when no current streamer can be resolved', async () => {
            const item = makeItem({ name: 'spd', item_type: 'buff' });
            const itemService = makeItemService(item, { isBuffOrDebuffItem: jest.fn(() => true) });
            const streamService = { getStreamStatus: jest.fn(() => ({ hasActiveStream: true, streamerId: 's1' })), getCurrentStreamer: jest.fn(() => null) };
            await expect(call(svc(), { inventoryService: makeInventory(), itemService, streamService, buffDebuffService: {} }, { sessionService: {} }))
                .resolves.toEqual({ ok: false, kind: 'no-streamer-target' });
        });

        it('consumes, applies the buff, and returns ok:true WITHOUT io (socket-emit block skipped)', async () => {
            const item = makeItem({ name: 'spd', item_type: 'buff' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item, { isBuffOrDebuffItem: jest.fn(() => true) });
            const sessionService = { getSessionBySocketId: jest.fn(() => ({ userId: 9 })) };
            const res = await call(svc(), { inventoryService, itemService, streamService: activeStream(), buffDebuffService: {} },
                { io: undefined, sessionService });

            expect(res.ok).toBe(true);
            expect(res.body.targetUserId).toBe(9);
            expect(res.body.buffResult).toEqual({ ok: true });
            expect(itemService.applyBuffDebuffItem).toHaveBeenCalled();
        });

        it('with io AND sessionService present, notifies via buffNotifier.inventoryUpdated and returns ok:true', async () => {
            const item = makeItem({ name: 'spd', item_type: 'buff' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item, { isBuffOrDebuffItem: jest.fn(() => true) });
            const sessionService = { getSessionBySocketId: jest.fn(() => ({ userId: 9 })), getSocketsByUserId: jest.fn(() => ['sa']) };
            const io = { emit: jest.fn(), to: jest.fn(() => ({ emit: jest.fn() })) };
            const buffNotifier = { inventoryUpdated: jest.fn() };
            const res = await call(svc(), { inventoryService, itemService, streamService: activeStream(), buffDebuffService: {} },
                { io, sessionService, buffNotifier });
            expect(res.ok).toBe(true);
            expect(buffNotifier.inventoryUpdated).toHaveBeenCalledWith(expect.objectContaining({
                toSocketId: 'sa', action: 'use', itemId: 5, remainingQuantity: 2,
            }));
        });
    });

    describe('regular consumed items', () => {
        it('consumes and returns the raw inventory result when io is absent', async () => {
            const item = makeItem({ name: 'pizza' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item);
            const canvasFxService = { isInteractiveItem: jest.fn(() => false), triggerItemEffect: jest.fn(async () => ({})) };
            const res = await call(svc(), { inventoryService, itemService, streamService: activeStream(), canvasFxService });
            expect(res).toEqual({ ok: true, body: { item: { id: 5, displayName: 'X', name: 'x' }, remainingQuantity: 2 } });
            expect(inventoryService.useItem).toHaveBeenCalledWith(1, 5, 's1');
        });

        it('regular path with io AND sessionService notifies via buffNotifier.inventoryUpdated and returns ok:true', async () => {
            const item = makeItem({ name: 'pizza' });
            const inventoryService = makeInventory();
            const itemService = makeItemService(item);
            const canvasFxService = { isInteractiveItem: jest.fn(() => false), triggerItemEffect: jest.fn(async () => ({})) };
            const io = { emit: jest.fn() };
            const sessionService = { getSocketsByUserId: jest.fn(() => ['sa']) };
            const buffNotifier = { inventoryUpdated: jest.fn() };
            const res = await call(svc(), { inventoryService, itemService, streamService: activeStream(), canvasFxService },
                { io, sessionService, buffNotifier });
            expect(res.ok).toBe(true);
            expect(buffNotifier.inventoryUpdated).toHaveBeenCalledWith(expect.objectContaining({
                toSocketId: 'sa', action: 'use', itemId: 5, remainingQuantity: 2,
            }));
        });
    });

    describe('constructor', () => {
        it('defaults the reserved drawingService / throwingService fields to null', () => {
            const s = new ItemUseService();
            expect(s.drawingService).toBeNull();
            expect(s.throwingService).toBeNull();
        });
    });
});

// Fresh instance per call — ItemUseService is a stateless orchestrator.
function svc() {
    return new ItemUseService();
}
