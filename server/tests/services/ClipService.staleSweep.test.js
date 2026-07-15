/**
 * Stale-'processing' clip sweep (audit Plan 01 P2.3-residual, flagged in
 * PR #36).
 *
 * A crash between the clips INSERT (status='processing' baked in) and
 * setClipReady/setClipFailed strands the row at 'processing' forever — no
 * code path revisited it. ClipService now sweeps rows older than
 * STALE_PROCESSING_CUTOFF_MS to 'failed' once per boot, deferred behind
 * `database.ready` (DB4-remainder) so the sweep can't race the schema
 * bootstrap's CREATE TABLEs.
 *
 * Real in-memory connection through the REAL production schema
 * (initializeSchema, ADR-0030), both backends.
 */

const ClipRepository = require('../../database/repository/ClipRepository');
const ClipService = require('../../services/ClipService');
const {
    forEachBackend,
    bootstrapProductionSchema,
} = require('../integration/_helpers/db-fixture');

/** Seed a clips row with a controlled age + status. */
async function seedClip(primitives, { clipId, status, ageMinutes }) {
    await primitives.runAsync(`
        INSERT INTO clips (clip_id, title, start_time_ms, end_time_ms, duration_ms, status, created_at)
        VALUES (?, ?, 0, 30000, 30000, ?, datetime('now', ?))
    `, [clipId, `clip ${clipId}`, status, `-${ageMinutes} minutes`]);
}

async function statusOf(primitives, clipId) {
    const row = await primitives.getAsync(
        'SELECT status FROM clips WHERE clip_id = ?', [clipId]);
    return row && row.status;
}

forEachBackend(({ make }) => {
    describe('ClipRepository.failStaleProcessing', () => {
        let primitives;

        beforeEach(async () => {
            primitives = make();
            await bootstrapProductionSchema(primitives);
        });

        afterEach(async () => {
            await primitives.close();
        });

        it('fails old processing rows; leaves fresh/in-flight and non-processing rows alone', async () => {
            await seedClip(primitives, { clipId: 'old-processing', status: 'processing', ageMinutes: 25 });
            await seedClip(primitives, { clipId: 'fresh-processing', status: 'processing', ageMinutes: 2 });
            // A genuinely-in-flight clip that was JUST inserted.
            await seedClip(primitives, { clipId: 'inflight-processing', status: 'processing', ageMinutes: 0 });
            await seedClip(primitives, { clipId: 'old-ready', status: 'ready', ageMinutes: 25 });
            await seedClip(primitives, { clipId: 'old-failed', status: 'failed', ageMinutes: 25 });

            const repo = new ClipRepository({
                getAsync: primitives.getAsync,
                runAsync: primitives.runAsync,
                allAsync: primitives.allAsync,
            });
            const result = await repo.failStaleProcessing(10 * 60 * 1000);

            expect(result.changes).toBe(1);
            expect(await statusOf(primitives, 'old-processing')).toBe('failed');
            expect(await statusOf(primitives, 'fresh-processing')).toBe('processing');
            expect(await statusOf(primitives, 'inflight-processing')).toBe('processing');
            expect(await statusOf(primitives, 'old-ready')).toBe('ready');
            expect(await statusOf(primitives, 'old-failed')).toBe('failed');
        });

        it('is a no-op on an empty clips table', async () => {
            const repo = new ClipRepository({
                getAsync: primitives.getAsync,
                runAsync: primitives.runAsync,
                allAsync: primitives.allAsync,
            });
            const result = await repo.failStaleProcessing(10 * 60 * 1000);
            expect(result.changes).toBe(0);
        });
    });

    describe('ClipService boot sweep wiring', () => {
        let primitives;
        let service;

        beforeEach(async () => {
            primitives = make();
            await bootstrapProductionSchema(primitives);
        });

        afterEach(async () => {
            if (service) service.stopRateLimitCleanup();
            service = null;
            await primitives.close();
        });

        it('runs the sweep only after database.ready resolves, end-to-end against the real schema', async () => {
            await seedClip(primitives, { clipId: 'old-processing', status: 'processing', ageMinutes: 25 });
            await seedClip(primitives, { clipId: 'fresh-processing', status: 'processing', ageMinutes: 2 });

            let resolveReady;
            const database = {
                db: primitives.db,
                runAsync: primitives.runAsync,
                getAsync: primitives.getAsync,
                allAsync: primitives.allAsync,
                withTransaction: async (fn) => fn(primitives),
                ready: new Promise((resolve) => { resolveReady = resolve; }),
            };

            service = new ClipService(database, {}, {}, {});
            expect(service._staleSweepPromise).not.toBeNull();

            // Schema init hasn't "completed" yet — nothing swept.
            await new Promise((r) => setImmediate(r));
            expect(await statusOf(primitives, 'old-processing')).toBe('processing');

            resolveReady();
            await service._staleSweepPromise;

            expect(await statusOf(primitives, 'old-processing')).toBe('failed');
            expect(await statusOf(primitives, 'fresh-processing')).toBe('processing');
        });
    });
});

describe('ClipService boot sweep — test doubles without database.ready', () => {
    it('skips the boot sweep entirely (no deferred DB call scheduled)', async () => {
        const database = {
            db: {},
            runAsync: jest.fn(),
            getAsync: jest.fn(),
            allAsync: jest.fn(),
            withTransaction: jest.fn(),
        };
        const service = new ClipService(database, {}, {}, {});
        expect(service._staleSweepPromise).toBeNull();

        await new Promise((r) => setImmediate(r));
        expect(database.runAsync).not.toHaveBeenCalled();

        service.stopRateLimitCleanup();
    });
});
