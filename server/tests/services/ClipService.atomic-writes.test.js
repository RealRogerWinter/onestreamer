/**
 * ClipService — atomic-write regression gate (PR 10.2, ADR-0015).
 *
 * Pre-PR-10.2, the two multi-statement write paths in ClipService
 * (`recordView` and `deleteClip`) ran as back-to-back un-wrapped
 * `runAsync` calls. A crash between the statements (or any
 * unrelated tx claim) left the DB in an inconsistent state:
 *
 *   recordView: clip_views row exists but `clips.view_count` did
 *               not get bumped (or vice-versa).
 *   deleteClip: clip_views rows orphan against a deleted clip
 *               row (or vice-versa).
 *
 * PR 10.2 wraps both paths in `withTransaction(async (tx) => …)`
 * per ADR-0015. The tests below pin the wrap shape — failing if
 * a future refactor accidentally moves a statement outside the
 * tx scope.
 *
 * The DB layer is dependency-injected; the test counts callbacks
 * and asserts which primitive (the module-level `runAsync` or the
 * tx-scoped one passed into the body fn) ran each statement.
 */

const ClipService = require('../../services/ClipService');

// ClipService's constructor schedules a 15-min setInterval for rate-limit
// cache cleanup; fake timers keep the test runner from hanging on the
// real timer reference.
beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

function makeDeps() {
    const baseRunAsync = jest.fn().mockResolvedValue({ id: 0, changes: 1 });
    const baseGetAsync = jest.fn();
    const baseAllAsync = jest.fn().mockResolvedValue([]);
    const txRunAsync = jest.fn().mockResolvedValue({ id: 0, changes: 1 });
    const txGetAsync = jest.fn();
    const txAllAsync = jest.fn().mockResolvedValue([]);
    const withTransaction = jest.fn(async (fn, opts) => {
        // Match the production helper's contract: pass tx primitives
        // into the body; do NOT call commit / rollback ourselves (the
        // body's failures bubble; success returns the body result).
        return await fn({
            runAsync: txRunAsync,
            getAsync: txGetAsync,
            allAsync: txAllAsync,
        });
    });

    const database = {
        db: {},
        runAsync: baseRunAsync,
        getAsync: baseGetAsync,
        allAsync: baseAllAsync,
        withTransaction,
    };

    const storageService = { deleteClip: jest.fn(), getStorageStats: jest.fn() };
    const processorService = null;
    const continuousRecordingService = null;

    const service = new ClipService(database, storageService, processorService, continuousRecordingService);
    return {
        service,
        database,
        storageService,
        withTransaction,
        baseRunAsync,
        baseGetAsync,
        baseAllAsync,
        txRunAsync,
        txGetAsync,
        txAllAsync,
    };
}

describe('ClipService — atomic-write wrap (PR 10.2 / ADR-0015)', () => {
    describe('recordView', () => {
        it('runs INSERT clip_views + UPDATE clips.view_count INSIDE one withTransaction scope', async () => {
            const { service, withTransaction, baseGetAsync, baseRunAsync, txRunAsync } = makeDeps();
            // No recent view → the wrapped INSERT+UPDATE path fires.
            baseGetAsync.mockResolvedValueOnce(undefined);

            await service.recordView('clip_abc', 7, '1.2.3.4');

            // Exactly one tx scope opened.
            expect(withTransaction).toHaveBeenCalledTimes(1);
            // The findRecentView SELECT runs on the BASE getAsync (outside the tx).
            expect(baseGetAsync).toHaveBeenCalledTimes(1);
            expect(baseGetAsync.mock.calls[0][0]).toContain('SELECT id FROM clip_views');
            // The two writes both ran on the TX primitives.
            expect(txRunAsync).toHaveBeenCalledTimes(2);
            expect(txRunAsync.mock.calls[0][0]).toContain('INSERT INTO clip_views');
            expect(txRunAsync.mock.calls[1][0]).toContain('UPDATE clips SET view_count = view_count + 1');
            // Crucially, the base runAsync was NEVER called — every write went through the tx scope.
            expect(baseRunAsync).not.toHaveBeenCalled();
        });

        it('opens NO tx scope when a recent view already exists (short-circuit path)', async () => {
            const { service, withTransaction, baseGetAsync, baseRunAsync, txRunAsync } = makeDeps();
            baseGetAsync.mockResolvedValueOnce({ id: 42 });

            await service.recordView('clip_abc', 7, '1.2.3.4');

            expect(withTransaction).not.toHaveBeenCalled();
            expect(baseRunAsync).not.toHaveBeenCalled();
            expect(txRunAsync).not.toHaveBeenCalled();
        });

        it('INSERT runs BEFORE UPDATE inside the tx (causal ordering pinned)', async () => {
            // If a future refactor swaps the order to UPDATE-then-INSERT,
            // the failure mode changes: a crash between would leak a
            // counter bump for a view that doesn't exist. Pin the order.
            const { service, baseGetAsync, txRunAsync } = makeDeps();
            baseGetAsync.mockResolvedValueOnce(undefined);
            await service.recordView('clip_abc', 7, '1.2.3.4');
            const firstSql = txRunAsync.mock.calls[0][0];
            const secondSql = txRunAsync.mock.calls[1][0];
            expect(firstSql).toContain('INSERT INTO clip_views');
            expect(secondSql).toContain('UPDATE clips');
        });
    });

    describe('deleteClip', () => {
        it('runs DELETE clip_views + DELETE clips INSIDE one withTransaction scope', async () => {
            const { service, storageService, withTransaction, baseGetAsync, baseRunAsync, txRunAsync } = makeDeps();
            // getClip path returns a clip row owned by userId=7.
            baseGetAsync.mockResolvedValueOnce({ clip_id: 'clip_abc', user_id: 7 });

            await service.deleteClip('clip_abc', 7);

            expect(storageService.deleteClip).toHaveBeenCalledWith('clip_abc');
            // Exactly one tx scope opened.
            expect(withTransaction).toHaveBeenCalledTimes(1);
            // Both DELETEs ran on the TX primitives, in clip_views-then-clips order.
            expect(txRunAsync).toHaveBeenCalledTimes(2);
            expect(txRunAsync.mock.calls[0][0]).toContain('DELETE FROM clip_views');
            expect(txRunAsync.mock.calls[1][0]).toContain('DELETE FROM clips');
            // No write touched the base runAsync.
            expect(baseRunAsync).not.toHaveBeenCalled();
        });

        it('does NOT wrap when the auth check fails (no tx scope opened)', async () => {
            const { service, withTransaction, baseGetAsync, txRunAsync } = makeDeps();
            // Clip exists but is owned by a DIFFERENT user → auth throws before any DB write.
            baseGetAsync.mockResolvedValueOnce({ clip_id: 'clip_abc', user_id: 99 });

            await expect(service.deleteClip('clip_abc', 7)).rejects.toThrow('Not authorized');
            expect(withTransaction).not.toHaveBeenCalled();
            expect(txRunAsync).not.toHaveBeenCalled();
        });

        it('clip_views DELETE precedes clips DELETE (FK-safe ordering pinned)', async () => {
            // SQLite doesn't enforce FK constraints unless `PRAGMA foreign_keys = ON`.
            // The order is moot today, but a future schema change that turns FKs on
            // would make clip_views-first the only safe order. Pin it.
            const { service, baseGetAsync, txRunAsync } = makeDeps();
            baseGetAsync.mockResolvedValueOnce({ clip_id: 'clip_abc', user_id: 7 });
            await service.deleteClip('clip_abc', 7);
            const firstSql = txRunAsync.mock.calls[0][0];
            const secondSql = txRunAsync.mock.calls[1][0];
            expect(firstSql).toContain('DELETE FROM clip_views');
            expect(secondSql).toContain('DELETE FROM clips');
        });

        it('admin bypass: isAdmin=true allows deletion of another user\'s clip', async () => {
            const { service, baseGetAsync, withTransaction } = makeDeps();
            baseGetAsync.mockResolvedValueOnce({ clip_id: 'clip_abc', user_id: 99 });
            await service.deleteClip('clip_abc', 7, true);
            // Auth bypass → the wrap STILL happens.
            expect(withTransaction).toHaveBeenCalledTimes(1);
        });
    });
});
