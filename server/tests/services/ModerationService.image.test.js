// Tests for ModerationService.handleVisionFrame (OmniImageMod PR 2,
// ADR-0021). The orchestration that VisionBotService._runCycle (PR 3)
// calls per frame: classify via stage3Image, evaluate enabled categories
// + applied_input_types, persist event row, promote audit JPEG, call
// arbiter under enforce, notify admins.

// ModerationService loads a Pino logger via bootstrap/logger. Stub it so
// the tests don't initialize the real one.
jest.mock('../../bootstrap/logger', () => ({
    child: () => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }),
}));

const ModerationService = require('../../services/ModerationService');

function makeStubDb() {
    const inserted = [];
    const updates = [];
    return {
        inserted,
        updates,
        getAsync: jest.fn(async () => null),
        runAsync: jest.fn(async (sql, params) => {
            if (/^\s*INSERT INTO moderation_events/i.test(sql)) {
                inserted.push({ sql, params });
                return { lastID: 999, insertId: 999 };
            }
            if (/^\s*UPDATE moderation_events/i.test(sql)) {
                updates.push({ sql, params });
                return { changes: 1 };
            }
            return { lastID: null, changes: 0 };
        }),
        allAsync: jest.fn(async () => []),
    };
}

function makeService({
    enforce = false,
    imageEnabled = true,
    classifyResult,
    arbResult,
    frameCaptureService = null,
} = {}) {
    const database = makeStubDb();
    const stage3Image = {
        isReady: () => true,
        classify: jest.fn(async () => classifyResult),
    };
    const streamService = {
        getStreamGeneration: () => 5,
    };
    const moderationNotifier = {
        eventCreated: jest.fn(),
        actionTaken: jest.fn(),
        streamerBanner: jest.fn(),
        botOutputDropped: jest.fn(),
    };
    const transcriptionService = {
        on: jest.fn(), off: jest.fn(), removeListener: jest.fn(),
    };
    const actionArbiter = {
        setEnforce: jest.fn(),
        arbitrate: jest.fn(async () => arbResult || {
            final_decision: enforce ? 'auto_ban' : 'admin_review',
            action_taken: enforce ? 'banned:42;rotation=ok' : null,
        }),
    };
    const fcs = frameCaptureService || {
        setBannedRetentionDays: jest.fn(),
        promoteFrameForEvent: jest.fn(async ({ eventId }) => `/tmp/banned/${eventId}.jpg`),
    };
    const svc = new ModerationService({
        database,
        transcriptionService,
        moderationNotifier,
        streamService,
        stage2: null,
        stage3: null,
        stage3Image,
        frameCaptureService: fcs,
        actionArbiter,
        failClosed: false,
    });
    // Bypass real initialize() (schema apply, seed verify, etc.).
    svc._enforce = enforce;
    svc._imageModerationEnabled = imageEnabled;
    svc._imageCategoriesEnabled = new Set([
        'sexual', 'violence', 'violence/graphic',
        'self-harm', 'self-harm/intent', 'self-harm/instructions',
    ]);
    svc._imageFrameRetentionDays = 30;
    svc._resolveStreamType = jest.fn(() => 'webcam');
    return { svc, database, stage3Image, moderationNotifier, actionArbiter, fcs };
}

function makeFrame(overrides = {}) {
    return {
        streamerId: 'streamer-1',
        streamGeneration: 5,
        jpegBase64: '/9j/4AAQfake',
        capturedAt: Date.now(),
        sourceSegment: 'seg.ts',
        sizeBytes: 1024,
        auditPath: '/tmp/audit/streamer-1/2026-01-01T00-00-00-000Z.jpg',
        ...overrides,
    };
}

describe('ModerationService.handleVisionFrame', () => {
    test('returns null when image moderation is disabled', async () => {
        const { svc, stage3Image, database } = makeService({ imageEnabled: false, classifyResult: { flagged: true } });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).toBeNull();
        expect(stage3Image.classify).not.toHaveBeenCalled();
        expect(database.inserted).toHaveLength(0);
    });

    test('returns null when stage3Image is not ready', async () => {
        const { svc } = makeService({ classifyResult: { flagged: true } });
        svc.stage3Image.isReady = () => false;
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).toBeNull();
    });

    test('sends both image AND transcription when transcription is provided', async () => {
        const { svc, stage3Image } = makeService({
            classifyResult: { flagged: false, categories: {}, scores: {}, applied_input_types: {} },
        });
        await svc.handleVisionFrame({
            streamerId: 's',
            frame: makeFrame(),
            transcription: 'spoken words',
        });
        const call = stage3Image.classify.mock.calls[0][0];
        expect(call.imageBase64).toBe('/9j/4AAQfake');
        expect(call.text).toBe('spoken words');
        expect(call.imageMime).toBe('image/jpeg');
    });

    test('clean frame → no row written, no notifier emit', async () => {
        const { svc, database, moderationNotifier } = makeService({
            classifyResult: {
                flagged: false,
                categories: { sexual: false, violence: false },
                scores: { sexual: 0.05, violence: 0.1 },
                applied_input_types: {},
            },
        });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).toBeNull();
        expect(database.inserted).toHaveLength(0);
        expect(moderationNotifier.eventCreated).not.toHaveBeenCalled();
    });

    test('flagged frame with image-source trigger → writes event row with source=image', async () => {
        const { svc, database } = makeService({
            classifyResult: {
                flagged: true,
                categories: { violence: true, sexual: false },
                scores: { violence: 0.92 },
                applied_input_types: { violence: ['image'] },
                model: 'omni-moderation-latest',
                latency_ms: 410,
            },
        });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).not.toBeNull();
        expect(database.inserted).toHaveLength(1);
        const inserted = database.inserted[0];
        expect(inserted.sql).toMatch(/INSERT INTO moderation_events/);
        // Stream type discriminator is webcam (stubbed); source column is 'image' literal.
        expect(inserted.sql).toMatch(/'image'/);
        // The params order matches the INSERT — verdict_json is param 6.
        const verdictJson = inserted.params[5];
        expect(JSON.parse(verdictJson).model).toBe('omni-moderation-latest');
    });

    test('skips a category whose only applied_input_type is text', async () => {
        // omni's `sexual/minors` is text-only. In a text+image call where
        // text is sketchy and image is clean, applied_input_types might be
        // { 'sexual/minors': ['text'] }. The image path must ignore that.
        const { svc, database } = makeService({
            classifyResult: {
                flagged: true,
                categories: { 'sexual/minors': true },
                scores: { 'sexual/minors': 0.85 },
                applied_input_types: { 'sexual/minors': ['text'] },
            },
        });
        // Make sure sexual/minors isn't in our enabled set (it isn't by
        // default, but be explicit).
        svc._imageCategoriesEnabled.delete('sexual/minors');
        const r = await svc.handleVisionFrame({
            streamerId: 's',
            frame: makeFrame(),
            transcription: 'whatever',
        });
        expect(r).toBeNull();
        expect(database.inserted).toHaveLength(0);
    });

    test('skips a category not in the enabled set', async () => {
        const { svc, database } = makeService({
            classifyResult: {
                flagged: true,
                categories: { sexual: true },
                scores: { sexual: 0.9 },
                applied_input_types: { sexual: ['image'] },
            },
        });
        // Operator disabled `sexual` (kept only violence + self-harm).
        svc._imageCategoriesEnabled = new Set(['violence', 'violence/graphic', 'self-harm']);
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).toBeNull();
        expect(database.inserted).toHaveLength(0);
    });

    test('promotes audit JPEG to banned/ on flag and updates image_path', async () => {
        const promoteFrame = jest.fn(async ({ eventId }) => `/tmp/banned/${eventId}.jpg`);
        const fcs = {
            setBannedRetentionDays: jest.fn(),
            promoteFrameForEvent: promoteFrame,
        };
        const { svc, database } = makeService({
            classifyResult: {
                flagged: true,
                categories: { violence: true },
                scores: { violence: 0.95 },
                applied_input_types: { violence: ['image'] },
            },
            frameCaptureService: fcs,
        });
        await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(promoteFrame).toHaveBeenCalledWith({
            originalPath: '/tmp/audit/streamer-1/2026-01-01T00-00-00-000Z.jpg',
            eventId: 999,
        });
        // The path-update UPDATE happens before the arbiter result UPDATE.
        const pathUpdate = database.updates.find(u => /image_path/.test(u.sql));
        expect(pathUpdate).toBeTruthy();
        expect(pathUpdate.params[0]).toBe('/tmp/banned/999.jpg');
    });

    test('with enforce=true, arbiter is called and final_decision is updated to auto_ban', async () => {
        const { svc, database, actionArbiter } = makeService({
            enforce: true,
            classifyResult: {
                flagged: true,
                categories: { violence: true },
                scores: { violence: 0.95 },
                applied_input_types: { violence: ['image'] },
            },
            arbResult: { final_decision: 'auto_ban', action_taken: 'banned:42;rotation=ok' },
        });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(actionArbiter.arbitrate).toHaveBeenCalledTimes(1);
        const arbEvent = actionArbiter.arbitrate.mock.calls[0][0];
        expect(arbEvent.source).toBe('image');
        expect(arbEvent.stream_type).toBe('webcam');
        expect(r.final_decision).toBe('auto_ban');
        expect(r.action_taken).toBe('banned:42;rotation=ok');
        // The final_decision UPDATE writes both columns.
        const decisionUpdate = database.updates.find(u => /final_decision/.test(u.sql));
        expect(decisionUpdate).toBeTruthy();
        expect(decisionUpdate.params[0]).toBe('auto_ban');
    });

    test('with enforce=false, arbiter downgrades to admin_review and no decision update is written', async () => {
        const { svc, database } = makeService({
            enforce: false,
            classifyResult: {
                flagged: true,
                categories: { violence: true },
                scores: { violence: 0.9 },
                applied_input_types: { violence: ['image'] },
            },
            arbResult: { final_decision: 'admin_review', action_taken: null },
        });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r.final_decision).toBe('admin_review');
        // No decision-update should happen (since result === initial).
        const decisionUpdate = database.updates.find(u => /final_decision/.test(u.sql));
        expect(decisionUpdate).toBeUndefined();
    });

    test('notifier.eventCreated fires after a flag', async () => {
        const { svc, moderationNotifier } = makeService({
            classifyResult: {
                flagged: true,
                categories: { violence: true },
                scores: { violence: 0.91 },
                applied_input_types: { violence: ['image'] },
            },
        });
        await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(moderationNotifier.eventCreated).toHaveBeenCalledTimes(1);
    });

    test('stage3Image degraded → null, no row', async () => {
        const { svc, database } = makeService({
            classifyResult: { degraded: true, reason: 'breaker_open' },
        });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).toBeNull();
        expect(database.inserted).toHaveLength(0);
    });

    test('stage3Image error → null, no row (fail-open)', async () => {
        const { svc, database } = makeService({
            classifyResult: { error: 'openai_500', raw_status: 500 },
        });
        const r = await svc.handleVisionFrame({ streamerId: 's', frame: makeFrame() });
        expect(r).toBeNull();
        expect(database.inserted).toHaveLength(0);
    });

    test('setImageModerationConfig filters categories to image-supported subset', async () => {
        const { svc, database } = makeService();
        await svc.setImageModerationConfig({
            enabled: true,
            categories: ['sexual', 'sexual/minors', 'hate', 'violence'],
            frame_retention_days: 60,
        }, 'admin-1');
        // sexual/minors and hate are TEXT-ONLY in omni and must be dropped.
        expect(Array.from(svc._imageCategoriesEnabled).sort()).toEqual(['sexual', 'violence']);
        expect(svc._imageFrameRetentionDays).toBe(60);
        expect(database.runAsync).toHaveBeenCalled();
    });

    test('setImageModerationConfig clamps retention days to [1, 365]', async () => {
        const { svc } = makeService();
        await svc.setImageModerationConfig({ frame_retention_days: 9999 });
        expect(svc._imageFrameRetentionDays).toBe(365);
        await svc.setImageModerationConfig({ frame_retention_days: 0 });
        expect(svc._imageFrameRetentionDays).toBe(1);
    });
});
