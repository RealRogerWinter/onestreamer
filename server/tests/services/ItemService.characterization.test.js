/**
 * Characterization net for ItemService.
 *
 * ItemService has no prior test coverage. This suite PINS the current
 * observable behavior before the service is decomposed into collaborators
 * under server/services/item/. It is written to pass against the CURRENT
 * service and must remain UNCHANGED across the decomposition commit.
 *
 * Strategy:
 *   - ItemService destructures runAsync/getAsync/allAsync from
 *     ../database/database at require-time, so we jest.mock that module and
 *     capture the mock fns.
 *   - The catalog/CRUD paths go through an injected ItemRepository; we pass a
 *     hand-rolled mock repo with deterministic fixtures.
 *   - initializeDefaultItems() fires (un-awaited) from the constructor. We
 *     stub getAllItems to return a non-empty list so createDefaultItems() is
 *     never invoked, keeping construction side-effect-free for our assertions.
 *
 * Pins: return shapes, repo/DB call args, validation branching, and error
 * paths across the main public methods.
 */

jest.mock('../../bootstrap/logger', () => {
    const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
    m.child = jest.fn(() => m);
    return m;
});

jest.mock('../../database/database', () => ({
    db: null,
    runAsync: jest.fn(),
    getAsync: jest.fn(),
    allAsync: jest.fn(),
}));

const { runAsync, getAsync, allAsync } = require('../../database/database');
const ItemService = require('../../services/ItemService');

function makeRepo(overrides = {}) {
    return {
        create: jest.fn(async () => ({ id: 101, changes: 1 })),
        getById: jest.fn(async () => undefined),
        getByName: jest.fn(async () => undefined),
        listAllActive: jest.fn(async () => []),
        listByType: jest.fn(async () => []),
        listByCategory: jest.fn(async () => []),
        listDistinctCategories: jest.fn(async () => []),
        countByCategory: jest.fn(async () => ({ count: 0 })),
        update: jest.fn(async () => ({ id: 0, changes: 1 })),
        softDelete: jest.fn(async () => ({ id: 0, changes: 1 })),
        ...overrides,
    };
}

/**
 * Build an ItemService whose constructor won't seed default items: stub
 * listAllActive (used by getAllItems within initializeDefaultItems) to a
 * non-empty array. Returns { service, repo }.
 */
function makeService(repoOverrides = {}) {
    const repo = makeRepo({
        listAllActive: jest.fn(async () => [{ id: 1, name: 'existing' }]),
        ...repoOverrides,
    });
    const service = new ItemService({ itemRepository: repo });
    return { service, repo };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('ItemService characterization', () => {
    describe('construction & default-item seeding', () => {
        it('does NOT create default items when the catalog is already populated', async () => {
            const repo = makeRepo({ listAllActive: jest.fn(async () => [{ id: 1 }]) });
            const service = new ItemService({ itemRepository: repo });
            // initializeDefaultItems is fire-and-forget; let the microtask settle.
            await Promise.resolve();
            await Promise.resolve();
            expect(service.itemRepository).toBe(repo);
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('seeds the default catalog via createItem when the catalog is empty', async () => {
            const repo = makeRepo({ listAllActive: jest.fn(async () => []) });
            const service = new ItemService({ itemRepository: repo });
            // Wait for the un-awaited initializeDefaultItems -> createDefaultItems loop.
            await new Promise((r) => setImmediate(r));
            // There are many default items; assert the seeding actually ran and
            // pin the well-known first item (tomato) by name.
            expect(repo.create).toHaveBeenCalled();
            const names = repo.create.mock.calls.map(([arg]) => arg.name);
            expect(names).toContain('tomato');
            expect(names).toContain('megaphone');
            expect(service).toBeInstanceOf(ItemService);
        });
    });

    describe('catalog reads delegate to the repository', () => {
        it('getItemById forwards the id to repo.getById and returns its row', async () => {
            const row = { id: 7, name: 'pizza' };
            const { service, repo } = makeService({ getById: jest.fn(async () => row) });
            await expect(service.getItemById(7)).resolves.toBe(row);
            expect(repo.getById).toHaveBeenCalledWith(7);
        });

        it('getItemByName forwards to repo.getByName', async () => {
            const row = { id: 7, name: 'pizza' };
            const { service, repo } = makeService({ getByName: jest.fn(async () => row) });
            await expect(service.getItemByName('pizza')).resolves.toBe(row);
            expect(repo.getByName).toHaveBeenCalledWith('pizza');
        });

        it('getAllItems delegates to repo.listAllActive', async () => {
            const rows = [{ id: 1 }, { id: 2 }];
            const { service, repo } = makeService({ listAllActive: jest.fn(async () => rows) });
            // Note: the constructor's initializeDefaultItems() also calls
            // getAllItems()->listAllActive once; we only assert delegation here.
            repo.listAllActive.mockClear();
            await expect(service.getAllItems()).resolves.toBe(rows);
            expect(repo.listAllActive).toHaveBeenCalledTimes(1);
        });

        it('getItemsByType delegates to repo.listByType with the type', async () => {
            const { service, repo } = makeService({ listByType: jest.fn(async () => [{ id: 9 }]) });
            await expect(service.getItemsByType('buff')).resolves.toEqual([{ id: 9 }]);
            expect(repo.listByType).toHaveBeenCalledWith('buff');
        });

        it('getItemsByCategory delegates to repo.listByCategory with the category', async () => {
            const { service, repo } = makeService({ listByCategory: jest.fn(async () => [{ id: 3 }]) });
            await expect(service.getItemsByCategory('markers')).resolves.toEqual([{ id: 3 }]);
            expect(repo.listByCategory).toHaveBeenCalledWith('markers');
        });
    });

    describe('getAllCategories reshapes distinct categories with humanized labels + counts', () => {
        it('title-cases underscore-split category values and fills per-category counts', async () => {
            const { service, repo } = makeService({
                listDistinctCategories: jest.fn(async () => [
                    { category: 'stream_effects' },
                    { category: 'markers' },
                ]),
                countByCategory: jest.fn(async (cat) =>
                    cat === 'stream_effects' ? { count: 5 } : { count: 2 }),
            });

            const result = await service.getAllCategories();

            expect(result).toEqual([
                { value: 'stream_effects', label: 'Stream Effects', count: 5 },
                { value: 'markers', label: 'Markers', count: 2 },
            ]);
            expect(repo.countByCategory).toHaveBeenCalledWith('stream_effects');
            expect(repo.countByCategory).toHaveBeenCalledWith('markers');
        });
    });

    describe('createItem', () => {
        it('applies defaults, forwards 15 named fields to repo.create, and returns id + original itemData', async () => {
            const { service, repo } = makeService();
            const input = {
                name: 'widget',
                display_name: 'Widget',
                emoji: '🔧',
                description: 'a widget',
                item_type: 'utility',
                rarity: 'common',
            };

            const result = await service.createItem(input);

            expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
                name: 'widget',
                display_name: 'Widget',
                category: 'misc',         // default
                base_price: 0,            // default
                is_purchasable: true,     // default
                is_active: true,          // default
                cooldown_seconds: 0,      // default
                max_stack: 0,             // default
                duration_seconds: 0,      // default
                effect_data: null,        // default
                stack_behavior: 'replace',// default
            }));
            expect(result).toEqual({ id: 101, ...input });
        });

        it('on UNIQUE constraint failure, swallows and returns the existing item by name', async () => {
            const existing = { id: 55, name: 'widget' };
            const { service, repo } = makeService({
                create: jest.fn(async () => { throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: items.name'); }),
                getByName: jest.fn(async () => existing),
            });

            await expect(service.createItem({ name: 'widget' })).resolves.toBe(existing);
            expect(repo.getByName).toHaveBeenCalledWith('widget');
        });

        it('rethrows non-UNIQUE errors from repo.create', async () => {
            const { service } = makeService({
                create: jest.fn(async () => { throw new Error('disk full'); }),
            });
            await expect(service.createItem({ name: 'widget' })).rejects.toThrow('disk full');
        });
    });

    describe('updateItem', () => {
        it('filters to the allowlist, forwards filtered updates to repo.update, then returns the refreshed item', async () => {
            const refreshed = { id: 7, display_name: 'New Name' };
            const { service, repo } = makeService({
                update: jest.fn(async () => ({ id: 7, changes: 1 })),
                getById: jest.fn(async () => refreshed),
            });

            const result = await service.updateItem(7, {
                display_name: 'New Name',
                bogus_field: 'dropped',   // not in allowlist
                base_price: 250,
            });

            expect(repo.update).toHaveBeenCalledWith(7, { display_name: 'New Name', base_price: 250 });
            expect(repo.getById).toHaveBeenCalledWith(7);
            expect(result).toBe(refreshed);
        });

        it('throws when no allowlisted fields remain after filtering', async () => {
            const { service, repo } = makeService();
            await expect(service.updateItem(7, { bogus: 1, other: 2 }))
                .rejects.toThrow('No valid fields to update');
            expect(repo.update).not.toHaveBeenCalled();
        });
    });

    describe('deleteItem', () => {
        it('delegates to repo.softDelete', async () => {
            const { service, repo } = makeService();
            await service.deleteItem(7);
            expect(repo.softDelete).toHaveBeenCalledWith(7);
        });
    });

    describe('validateItemUsage', () => {
        it('returns {valid:false, error:"Item not found"} when the item is missing', async () => {
            const { service } = makeService({ getById: jest.fn(async () => null) });
            await expect(service.validateItemUsage(1, 99)).resolves.toEqual({
                valid: false, error: 'Item not found',
            });
        });

        it('returns valid:true when the item has no cooldown', async () => {
            const { service } = makeService({
                getById: jest.fn(async () => ({ id: 5, name: 'x', cooldown_seconds: 0 })),
            });
            await expect(service.validateItemUsage(1, 5)).resolves.toEqual({ valid: true });
            expect(getAsync).not.toHaveBeenCalled();
        });

        it('returns valid:true with no prior usage row for a cooldown item', async () => {
            getAsync.mockResolvedValueOnce(undefined);
            const { service } = makeService({
                getById: jest.fn(async () => ({ id: 5, name: 'x', cooldown_seconds: 60 })),
            });
            await expect(service.validateItemUsage(1, 5)).resolves.toEqual({ valid: true });
            expect(getAsync).toHaveBeenCalledWith(
                expect.stringContaining('FROM item_usage_log'),
                [1, 5]
            );
        });

        it('reports cooldown remaining when a recent usage row exists', async () => {
            // used_at one second ago against a 3600s cooldown -> still on cooldown.
            const usedAt = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
            getAsync.mockResolvedValueOnce({ used_at: usedAt });
            const { service } = makeService({
                getById: jest.fn(async () => ({ id: 5, name: 'x', cooldown_seconds: 3600 })),
            });

            const result = await service.validateItemUsage(1, 5);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('Item on cooldown');
            expect(result.cooldownRemaining).toBeGreaterThan(0);
        });
    });

    describe('applyItemCooldown', () => {
        it('inserts a usage-log row with [userId, itemId, streamId]', async () => {
            const { service } = makeService();
            await service.applyItemCooldown(1, 5, 'stream-9');
            expect(runAsync).toHaveBeenCalledWith(
                'INSERT INTO item_usage_log (user_id, item_id, stream_id) VALUES (?, ?, ?)',
                [1, 5, 'stream-9']
            );
        });

        it('defaults streamId to null when omitted', async () => {
            const { service } = makeService();
            await service.applyItemCooldown(1, 5);
            expect(runAsync).toHaveBeenCalledWith(expect.any(String), [1, 5, null]);
        });
    });

    describe('cooldown resets', () => {
        it('resetAllItemCooldowns deletes the log and returns the changed-row count', async () => {
            getAsync.mockResolvedValue({ count: 0 });
            allAsync.mockResolvedValue([]);
            runAsync.mockResolvedValueOnce({ changes: 4 });
            const { service } = makeService();
            await expect(service.resetAllItemCooldowns()).resolves.toBe(4);
            expect(runAsync).toHaveBeenCalledWith('DELETE FROM item_usage_log');
        });

        it('resetUserItemCooldowns scopes the delete to the user and returns count', async () => {
            runAsync.mockResolvedValueOnce({ changes: 2 });
            const { service } = makeService();
            await expect(service.resetUserItemCooldowns(42)).resolves.toBe(2);
            expect(runAsync).toHaveBeenCalledWith('DELETE FROM item_usage_log WHERE user_id = ?', [42]);
        });
    });

    describe('item-type predicates', () => {
        it('isBuffOrDebuffItem is true only for buff/debuff', () => {
            const { service } = makeService();
            expect(service.isBuffOrDebuffItem({ item_type: 'buff' })).toBe(true);
            expect(service.isBuffOrDebuffItem({ item_type: 'debuff' })).toBe(true);
            expect(service.isBuffOrDebuffItem({ item_type: 'weapon' })).toBe(false);
            expect(service.isBuffOrDebuffItem(null)).toBeFalsy();
        });

        it('isCooldownModifierItem is true only for guard/weapon', () => {
            const { service } = makeService();
            expect(service.isCooldownModifierItem({ item_type: 'guard' })).toBe(true);
            expect(service.isCooldownModifierItem({ item_type: 'weapon' })).toBe(true);
            expect(service.isCooldownModifierItem({ item_type: 'buff' })).toBe(false);
            expect(service.isCooldownModifierItem(undefined)).toBeFalsy();
        });
    });

    describe('applyBuffDebuffItem', () => {
        it('validates, applies the buff via the injected service, logs cooldown, and returns the buff result', async () => {
            const item = { id: 5, name: 'spd', display_name: 'Speed', item_type: 'buff', duration_seconds: 300, effect_data: '{"intensity":1.5}' };
            const { service } = makeService({ getById: jest.fn(async () => item) });
            jest.spyOn(service, 'validateItemUsage').mockResolvedValue({ valid: true });
            jest.spyOn(service, 'applyItemCooldown').mockResolvedValue();
            const buffDebuffService = { applyBuff: jest.fn(async () => ({ ok: true })) };

            const result = await service.applyBuffDebuffItem(1, 5, 2, buffDebuffService);

            expect(buffDebuffService.applyBuff).toHaveBeenCalledWith(
                1, 5, 2, 300, { intensity: 1.5 }, false, null
            );
            expect(service.applyItemCooldown).toHaveBeenCalledWith(1, 5);
            expect(result).toEqual({ ok: true });
        });

        it('throws "Item is not a buff or debuff" for a non-buff item', async () => {
            const item = { id: 5, item_type: 'weapon', display_name: 'Sword' };
            const { service } = makeService({ getById: jest.fn(async () => item) });
            jest.spyOn(service, 'validateItemUsage').mockResolvedValue({ valid: true });
            const buffDebuffService = { applyBuff: jest.fn() };

            await expect(service.applyBuffDebuffItem(1, 5, 2, buffDebuffService))
                .rejects.toThrow('Item is not a buff or debuff');
            expect(buffDebuffService.applyBuff).not.toHaveBeenCalled();
        });

        it('propagates the validation error and skips applying when validation fails', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'validateItemUsage').mockResolvedValue({ valid: false, error: 'Item on cooldown' });
            const buffDebuffService = { applyBuff: jest.fn() };

            await expect(service.applyBuffDebuffItem(1, 5, 2, buffDebuffService))
                .rejects.toThrow('Item on cooldown');
            expect(buffDebuffService.applyBuff).not.toHaveBeenCalled();
        });
    });

    describe('applyCooldownModifierItem', () => {
        it('applies global cooldown increase via takeoverService and accumulates an effect', async () => {
            const item = {
                id: 5, name: 'shield', display_name: 'Shield', item_type: 'guard',
                duration_seconds: 0,
                effect_data: JSON.stringify({ global_cooldown_increase: 15 }),
            };
            const { service } = makeService({ getById: jest.fn(async () => item) });
            jest.spyOn(service, 'validateItemUsage').mockResolvedValue({ valid: true });
            jest.spyOn(service, 'applyItemCooldown').mockResolvedValue();
            const takeoverService = { modifyGlobalCooldown: jest.fn(async () => true) };

            const result = await service.applyCooldownModifierItem(1, 5, 2, takeoverService);

            expect(takeoverService.modifyGlobalCooldown).toHaveBeenCalledWith(15, 'shield_guard');
            expect(result.success).toBe(true);
            expect(result.effects).toEqual([
                expect.objectContaining({ type: 'global_cooldown_increase', amount: 15 }),
            ]);
            expect(service.applyItemCooldown).toHaveBeenCalledWith(1, 5);
        });

        it('throws "Item is not a cooldown modifier" for a buff item', async () => {
            const item = { id: 5, item_type: 'buff', display_name: 'Speed', effect_data: '{}' };
            const { service } = makeService({ getById: jest.fn(async () => item) });
            jest.spyOn(service, 'validateItemUsage').mockResolvedValue({ valid: true });
            const takeoverService = { modifyGlobalCooldown: jest.fn() };

            await expect(service.applyCooldownModifierItem(1, 5, 2, takeoverService))
                .rejects.toThrow('Item is not a cooldown modifier');
        });
    });

    describe('getGlobalCooldownInfo', () => {
        it('returns remaining/total/isActive from the takeoverService', async () => {
            const { service } = makeService();
            const takeoverService = {
                lastStreamStartTime: 0,
                globalCooldownSeconds: 30,
                getGlobalCooldownRemaining: jest.fn(async () => 12),
            };
            await expect(service.getGlobalCooldownInfo(takeoverService)).resolves.toEqual({
                remainingSeconds: 12,
                totalSeconds: 30,
                isActive: true,
            });
        });

        it('returns the safe default on error', async () => {
            const { service } = makeService();
            const takeoverService = {
                getGlobalCooldownRemaining: jest.fn(async () => { throw new Error('boom'); }),
            };
            await expect(service.getGlobalCooldownInfo(takeoverService)).resolves.toEqual({
                remainingSeconds: 0, totalSeconds: 30, isActive: false,
            });
        });
    });
});
