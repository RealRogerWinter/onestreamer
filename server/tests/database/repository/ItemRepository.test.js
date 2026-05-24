const ItemRepository = require('../../../database/repository/ItemRepository');

// Helper: build a repo with jest.fn() mocks for the three DB primitives.
function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ItemRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

// Collapse all internal whitespace so we can assert on the SQL "shape"
// without being sensitive to formatting.
const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe('ItemRepository', () => {
    describe('getById', () => {
        it('selects by id with the is_active=1 filter', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 7, name: 'tomato' });

            const result = await repo.getById(7);

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE id = ? AND is_active = 1');
            expect(params).toEqual([7]);
            expect(result).toEqual({ id: 7, name: 'tomato' });
        });
    });

    describe('getByName', () => {
        it('selects by name with the is_active=1 filter', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, name: 'speed_boost' });

            await repo.getByName('speed_boost');

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE name = ? AND is_active = 1');
            expect(params).toEqual(['speed_boost']);
        });
    });

    describe('getByIdIncludingInactive', () => {
        it('selects by id WITHOUT the is_active filter', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 99, is_active: 0 });

            await repo.getByIdIncludingInactive(99);

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE id = ?');
            expect(sql).not.toMatch(/is_active/i);
            expect(params).toEqual([99]);
        });
    });

    describe('listAllActive', () => {
        it('lists active items ordered by rarity then name', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1 }, { id: 2 }]);

            const result = await repo.listAllActive();

            expect(allAsync).toHaveBeenCalledTimes(1);
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE is_active = 1 ORDER BY rarity, name');
            expect(result).toEqual([{ id: 1 }, { id: 2 }]);
        });
    });

    describe('listByType', () => {
        it('lists active items filtered by item_type, no ORDER BY', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);

            await repo.listByType('buff');

            expect(allAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE item_type = ? AND is_active = 1');
            // Legacy SQL had no ORDER BY for type-list; preserve.
            expect(sql).not.toMatch(/ORDER\s+BY/i);
            expect(params).toEqual(['buff']);
        });
    });

    describe('listByCategory', () => {
        it('lists active items filtered by category, ordered by display_name', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);

            await repo.listByCategory('cosmetic');

            expect(allAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE category = ? AND is_active = 1 ORDER BY display_name');
            expect(params).toEqual(['cosmetic']);
        });
    });

    describe('listDistinctCategories', () => {
        it('selects DISTINCT non-null categories of active items', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ category: 'a' }, { category: 'b' }]);

            const result = await repo.listDistinctCategories();

            expect(allAsync).toHaveBeenCalledTimes(1);
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT DISTINCT category FROM items WHERE is_active = 1 AND category IS NOT NULL ORDER BY category'
            );
            expect(result).toEqual([{ category: 'a' }, { category: 'b' }]);
        });
    });

    describe('countByCategory', () => {
        it('returns the COUNT(*) row for a given category', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ count: 4 });

            const result = await repo.countByCategory('combat');

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT COUNT(*) as count FROM items WHERE category = ? AND is_active = 1');
            expect(params).toEqual(['combat']);
            expect(result).toEqual({ count: 4 });
        });
    });

    describe('listByRarity', () => {
        it('lists active items filtered by rarity, no ORDER BY', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);

            await repo.listByRarity('legendary');

            expect(allAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM items WHERE rarity = ? AND is_active = 1');
            expect(sql).not.toMatch(/ORDER\s+BY/i);
            expect(params).toEqual(['legendary']);
        });
    });

    describe('create', () => {
        it('issues an INSERT with all 15 columns and 15 placeholders', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 123, changes: 1 });

            const fields = {
                name: 'banana',
                display_name: 'Banana',
                emoji: '🍌',
                description: 'a banana',
                item_type: 'utility',
                category: 'misc',
                rarity: 'common',
                base_price: 10,
                is_purchasable: true,
                is_active: true,
                cooldown_seconds: 5,
                max_stack: 0,
                duration_seconds: 0,
                effect_data: null,
                stack_behavior: 'replace'
            };

            const result = await repo.create(fields);

            expect(runAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = runAsync.mock.calls[0];

            // INSERT must list these 15 columns in this order.
            expect(sql).toMatch(/INSERT\s+INTO\s+items\s*\(/i);
            const expectedCols = [
                'name', 'display_name', 'emoji', 'description', 'item_type', 'category',
                'rarity', 'base_price', 'is_purchasable', 'is_active',
                'cooldown_seconds', 'max_stack', 'duration_seconds', 'effect_data', 'stack_behavior'
            ];
            for (const col of expectedCols) {
                expect(sql).toContain(col);
            }
            // 15 placeholders for 15 columns.
            const placeholderCount = (sql.match(/\?/g) || []).length;
            expect(placeholderCount).toBe(15);
            // Params in the SAME order as the column list.
            expect(params).toEqual(expectedCols.map((c) => fields[c]));
            expect(result).toEqual({ id: 123, changes: 1 });
        });
    });

    describe('update', () => {
        it('builds the SET clause and always appends updated_at = CURRENT_TIMESTAMP', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.update(5, { display_name: 'New Name', base_price: 50 });

            expect(runAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE items SET display_name = ?, base_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(params).toEqual(['New Name', 50, 5]);
        });

        it('returns { id:0, changes:0 } and does NOT call DB when no fields', async () => {
            const { repo, runAsync } = makeRepo();

            const result = await repo.update(5, {});

            expect(runAsync).not.toHaveBeenCalled();
            expect(result).toEqual({ id: 0, changes: 0 });
        });

        it('rejects column names that do not look like plain SQL identifiers', async () => {
            const { repo, runAsync } = makeRepo();

            await expect(repo.update(5, { 'name; DROP TABLE items--': 'evil' })).rejects.toThrow(
                /invalid column name/i
            );
            expect(runAsync).not.toHaveBeenCalled();
        });
    });

    describe('softDelete', () => {
        it('flips is_active=0 and stamps updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.softDelete(42);

            expect(runAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE items SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(params).toEqual([42]);
        });
    });

    describe('constructor defaults', () => {
        it('a default-constructed instance exposes the public methods', () => {
            // We don't actually call any method here — that would touch the
            // real DB primitives. We only verify the method surface exists,
            // which is what backwards compatibility requires.
            const repo = new ItemRepository();
            expect(typeof repo.getById).toBe('function');
            expect(typeof repo.getByName).toBe('function');
            expect(typeof repo.getByIdIncludingInactive).toBe('function');
            expect(typeof repo.listAllActive).toBe('function');
            expect(typeof repo.listByType).toBe('function');
            expect(typeof repo.listByCategory).toBe('function');
            expect(typeof repo.listDistinctCategories).toBe('function');
            expect(typeof repo.countByCategory).toBe('function');
            expect(typeof repo.listByRarity).toBe('function');
            expect(typeof repo.create).toBe('function');
            expect(typeof repo.update).toBe('function');
            expect(typeof repo.softDelete).toBe('function');
        });
    });
});
