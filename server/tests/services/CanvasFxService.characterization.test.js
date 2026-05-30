/**
 * Characterization net for CanvasFxService.
 *
 * CanvasFxService has no prior test coverage. This suite PINS the current
 * observable behavior before the service is decomposed into collaborators
 * under server/services/canvasfx/ (alongside the existing effectDefinitions.js
 * data module). It is written to pass against the CURRENT service and must
 * remain UNCHANGED across the decomposition commit.
 *
 * Strategy:
 *   - The service requires ../bootstrap/logger at require-time; we jest.mock it.
 *   - Deps (io, itemService, buffDebuffService, streamService, sessionService)
 *     are hand-rolled mocks. `io` records emit/to() calls so we can assert the
 *     socket fan-out shapes.
 *   - Effect application schedules setTimeout-based auto-cleanup and the
 *     streamer monitor uses setInterval; we drive these with jest fake timers.
 *
 * Pins: emit fan-out shapes + payloads, registry/config lookups, the
 * concurrent-effect cap + dropped-effect accounting, predicate tables,
 * cleanup/cancel side effects, getStats output shape, and shutdown teardown.
 */

jest.mock('../../bootstrap/logger', () => {
    const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
    m.child = jest.fn(() => m);
    return m;
});

const CanvasFxService = require('../../services/CanvasFxService');

function makeIo() {
    const room = { emit: jest.fn() };
    const io = {
        emit: jest.fn(),
        to: jest.fn(() => room),
        _room: room,
    };
    return io;
}

function makeItemService(item) {
    return {
        getItemById: jest.fn(async () => item),
    };
}

const TOMATO = { id: 1, name: 'tomato', display_name: 'Tomato', emoji: '🍅' };

function makeService({ io = makeIo(), itemService = makeItemService(TOMATO), buffDebuffService = null } = {}) {
    const service = new CanvasFxService(io, itemService, buffDebuffService);
    return { service, io, itemService, buffDebuffService };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('CanvasFxService characterization', () => {
    describe('construction', () => {
        it('initializes empty state, default config, and zeroed stats', () => {
            const { service } = makeService();
            expect(service.activeEffects.size).toBe(0);
            expect(service.buffSyncedEffects.size).toBe(0);
            expect(service.config).toEqual({
                maxConcurrentEffects: 10,
                effectQueueSize: 20,
                defaultDuration: 2000,
            });
            expect(service.effectStats).toEqual({
                totalTriggered: 0,
                activeCount: 0,
                droppedEffects: 0,
            });
        });
    });

    describe('predicate tables', () => {
        it('hasVisualEffect is true for known visual items and false otherwise', () => {
            const { service } = makeService();
            expect(service.hasVisualEffect({ name: 'tomato' })).toBe(true);
            expect(service.hasVisualEffect({ name: 'smoke_bomb' })).toBe(true);
            expect(service.hasVisualEffect({ name: 'not_a_real_item' })).toBe(false);
        });

        it('isBuffSyncedEffect is true only for smoke_bomb', () => {
            const { service } = makeService();
            expect(service.isBuffSyncedEffect({ name: 'smoke_bomb' })).toBe(true);
            expect(service.isBuffSyncedEffect({ name: 'tomato' })).toBe(false);
        });

        it('isInteractiveItem is true for click-to-throw items and false otherwise', () => {
            const { service } = makeService();
            expect(service.isInteractiveItem({ name: 'tomato' })).toBe(true);
            expect(service.isInteractiveItem({ name: 'snowball' })).toBe(true);
            expect(service.isInteractiveItem({ name: 'megaphone' })).toBe(false);
        });
    });

    describe('getEffectConfig registry lookup', () => {
        it('returns the registered mapping for a known item', () => {
            const { service } = makeService();
            const cfg = service.getEffectConfig({ name: 'tomato' });
            expect(cfg.type).toBe('splat');
            expect(cfg.duration).toBe(3000);
        });

        it('falls back to the default config (using this.config.defaultDuration) for unknown items', () => {
            const { service } = makeService();
            const cfg = service.getEffectConfig({ name: 'mystery' });
            expect(cfg).toEqual({
                type: 'default',
                duration: 2000,
                config: { color: '#ffffff', animation: 'fade' },
            });
        });
    });

    describe('getInteractionConfig', () => {
        it('returns null for an item with no interaction config', () => {
            const { service } = makeService();
            expect(service.getInteractionConfig({ name: 'mystery' })).toBeNull();
        });

        it('substitutes the item display name into the indicator placeholder', () => {
            const { service } = makeService();
            const cfg = service.getInteractionConfig({ name: 'tomato', display_name: 'Tomato' });
            expect(cfg).not.toBeNull();
            expect(cfg.indicator).not.toContain('{itemName}');
            expect(cfg.indicator).toContain('Tomato');
        });
    });

    describe('getRandomPosition', () => {
        it('returns x/y clamped to the 0.1..0.9 band', () => {
            const { service } = makeService();
            for (let i = 0; i < 25; i++) {
                const { x, y } = service.getRandomPosition();
                expect(x).toBeGreaterThanOrEqual(0.1);
                expect(x).toBeLessThanOrEqual(0.9);
                expect(y).toBeGreaterThanOrEqual(0.1);
                expect(y).toBeLessThanOrEqual(0.9);
            }
        });
    });

    describe('triggerItemEffect (single-phase)', () => {
        it('stores the effect, bumps stats, broadcasts canvas-effect-trigger, and emits effect-triggered', async () => {
            const { service, io } = makeService();
            const local = jest.fn();
            service.on('effect-triggered', local);

            const effect = await service.triggerItemEffect(7, 1, 'stream-9');

            expect(effect).not.toBeNull();
            expect(effect.userId).toBe(7);
            expect(effect.itemId).toBe(1);
            expect(effect.itemName).toBe('tomato');
            expect(effect.type).toBe('splat');
            expect(service.activeEffects.has(effect.id)).toBe(true);
            expect(service.effectStats.totalTriggered).toBe(1);
            expect(service.effectStats.activeCount).toBe(1);
            expect(io.emit).toHaveBeenCalledWith('canvas-effect-trigger', effect);
            expect(local).toHaveBeenCalledWith(effect);
        });

        it('returns null and increments droppedEffects when the concurrent cap is reached', async () => {
            const { service, itemService } = makeService();
            // Saturate the active map past maxConcurrentEffects.
            for (let i = 0; i < service.config.maxConcurrentEffects; i++) {
                service.activeEffects.set(`pad_${i}`, { id: `pad_${i}` });
            }
            itemService.getItemById.mockClear();

            const result = await service.triggerItemEffect(7, 1, 'stream-9');

            expect(result).toBeNull();
            expect(service.effectStats.droppedEffects).toBe(1);
            // Cap check short-circuits BEFORE the item lookup.
            expect(itemService.getItemById).not.toHaveBeenCalled();
        });

        it('returns null when the item is not found', async () => {
            const { service } = makeService({ itemService: makeItemService(null) });
            const result = await service.triggerItemEffect(7, 99, 'stream-9');
            expect(result).toBeNull();
            expect(service.activeEffects.size).toBe(0);
        });

        it('auto-cleans up a non-buff-synced effect after its duration elapses', async () => {
            jest.useFakeTimers();
            try {
                const { service, io } = makeService();
                const effect = await service.triggerItemEffect(7, 1, 'stream-9');
                expect(service.activeEffects.has(effect.id)).toBe(true);

                jest.advanceTimersByTime(3000); // tomato duration

                expect(service.activeEffects.has(effect.id)).toBe(false);
                expect(io.emit).toHaveBeenCalledWith('canvas-effect-complete', { effectId: effect.id });
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('triggerItemEffectAtPosition', () => {
        it('clamps the requested position into 0..1 on both axes', async () => {
            const { service } = makeService();
            const effect = await service.triggerItemEffectAtPosition(7, 1, 'stream-9', { x: 1.7, y: -0.4 });
            expect(effect.position).toEqual({ x: 1, y: 0 });
        });
    });

    describe('cleanupEffect', () => {
        it('removes the effect, syncs activeCount, emits complete + completed, and drops buff-sync tracking', async () => {
            const { service, io } = makeService();
            const effect = await service.triggerItemEffect(7, 1, 'stream-9');
            service.buffSyncedEffects.set(effect.id, 'buff-123');
            const completed = jest.fn();
            service.on('effect-completed', completed);
            io.emit.mockClear();

            service.cleanupEffect(effect.id);

            expect(service.activeEffects.has(effect.id)).toBe(false);
            expect(service.buffSyncedEffects.has(effect.id)).toBe(false);
            expect(service.effectStats.activeCount).toBe(0);
            expect(io.emit).toHaveBeenCalledWith('canvas-effect-complete', { effectId: effect.id });
            expect(completed).toHaveBeenCalledWith(effect);
        });

        it('is a no-op for an unknown effect id', () => {
            const { service, io } = makeService();
            service.cleanupEffect('does-not-exist');
            expect(io.emit).not.toHaveBeenCalled();
        });
    });

    describe('cancelEffect', () => {
        it('removes the effect, emits canvas-effect-cancelled with reason, and returns true', async () => {
            const { service, io } = makeService();
            const effect = await service.triggerItemEffect(7, 1, 'stream-9');
            io.emit.mockClear();

            const result = await service.cancelEffect(effect.id, 'buff-expired');

            expect(result).toBe(true);
            expect(service.activeEffects.has(effect.id)).toBe(false);
            expect(io.emit).toHaveBeenCalledWith('canvas-effect-cancelled', {
                effectId: effect.id,
                reason: 'buff-expired',
                itemName: 'tomato',
            });
        });

        it('sends an extra force-clear for smoke_bomb effects', async () => {
            const { service, io } = makeService();
            service.activeEffects.set('sb1', { id: 'sb1', itemName: 'smoke_bomb' });
            io.emit.mockClear();

            await service.cancelEffect('sb1', 'streamer-switched');

            expect(io.emit).toHaveBeenCalledWith('canvas-effect-force-clear-item', {
                itemName: 'smoke_bomb',
                reason: 'streamer-switched',
                effectId: 'sb1',
            });
        });

        it('returns false for an unknown effect id', async () => {
            const { service } = makeService();
            await expect(service.cancelEffect('nope')).resolves.toBe(false);
        });
    });

    describe('clearAllEffects', () => {
        it('cleans every active effect and broadcasts canvas-effects-clear', async () => {
            const { service, io } = makeService();
            await service.triggerItemEffect(7, 1, 'stream-9');
            await service.triggerItemEffect(8, 1, 'stream-9');
            expect(service.activeEffects.size).toBe(2);
            io.emit.mockClear();

            service.clearAllEffects();

            expect(service.activeEffects.size).toBe(0);
            expect(io.emit).toHaveBeenCalledWith('canvas-effects-clear');
        });
    });

    describe('forceCleanupForSocket', () => {
        it('fans out three cleanup events to the targeted socket room', () => {
            const { service, io } = makeService();
            service.forceCleanupForSocket('sock-1', 'streamer-switched');
            expect(io.to).toHaveBeenCalledWith('sock-1');
            expect(io._room.emit).toHaveBeenCalledWith('canvas-effects-clear');
            expect(io._room.emit).toHaveBeenCalledWith('canvas-effects-clear-buff-synced');
            expect(io._room.emit).toHaveBeenCalledWith('canvas-effect-force-clear', {
                reason: 'streamer-switched',
                effects: ['smoke_bomb'],
                forceComplete: true,
            });
        });
    });

    describe('active-effect queries + getStats', () => {
        it('getActiveEffectsForUser filters by userId; getAllActiveEffects returns all', async () => {
            const { service } = makeService();
            const a = await service.triggerItemEffect(7, 1, 'stream-9');
            const b = await service.triggerItemEffect(8, 1, 'stream-9');
            expect(service.getActiveEffectsForUser(7)).toEqual([a]);
            expect(service.getAllActiveEffects()).toEqual(expect.arrayContaining([a, b]));
            expect(service.getAllActiveEffects()).toHaveLength(2);
        });

        it('getStats returns the stats spread plus the active effect-id list', async () => {
            const { service } = makeService();
            const effect = await service.triggerItemEffect(7, 1, 'stream-9');
            const stats = service.getStats();
            expect(stats).toEqual({
                totalTriggered: 1,
                activeCount: 1,
                droppedEffects: 0,
                activeEffects: [effect.id],
            });
        });
    });

    describe('handleClientConnection', () => {
        it('syncs current active effects to the connecting socket and wires request-effect-sync', async () => {
            const { service } = makeService();
            const effect = await service.triggerItemEffect(7, 1, 'stream-9');
            const socket = { emit: jest.fn(), on: jest.fn() };

            service.handleClientConnection(socket);

            expect(socket.emit).toHaveBeenCalledWith('canvas-effects-sync', { effects: [effect] });
            expect(socket.on).toHaveBeenCalledWith('request-effect-sync', expect.any(Function));
        });
    });

    describe('setDependencies', () => {
        it('subscribes to buff-applied / buff-expired on the buff service', () => {
            const buffDebuffService = { on: jest.fn() };
            const { service } = makeService();
            service.setDependencies(makeIo(), makeItemService(TOMATO), buffDebuffService);
            const events = buffDebuffService.on.mock.calls.map(([evt]) => evt);
            expect(events).toContain('buff-applied');
            expect(events).toContain('buff-expired');
        });
    });

    describe('shutdown', () => {
        it('clears the monitor interval and empties both effect maps', async () => {
            jest.useFakeTimers();
            try {
                const buffDebuffService = { on: jest.fn() };
                const streamService = { getCurrentStreamer: jest.fn(() => null) };
                const { service } = makeService({ buffDebuffService });
                service.setDependencies(makeIo(), makeItemService(TOMATO), buffDebuffService, streamService);
                expect(service.streamerCheckInterval).not.toBeNull();
                service.activeEffects.set('x', { id: 'x' });
                service.buffSyncedEffects.set('x', 'buff-1');

                service.shutdown();

                expect(service.streamerCheckInterval).toBeNull();
                expect(service.activeEffects.size).toBe(0);
                expect(service.buffSyncedEffects.size).toBe(0);
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
