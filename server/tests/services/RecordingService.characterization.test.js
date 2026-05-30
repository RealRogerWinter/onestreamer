/**
 * Characterization net for RecordingService.
 *
 * RecordingService has no prior test coverage. This suite PINS the current
 * observable behavior before the service is decomposed into collaborators
 * under server/services/recording/ (alongside the existing ContinuousRecording
 * collaborators — distinct filenames). It is written to pass against the
 * CURRENT service and must remain UNCHANGED across the decomposition commit.
 *
 * Strategy:
 *   - The service requires ../bootstrap/logger at require-time; we jest.mock it.
 *   - `fs` is mocked so the constructor's initializeDirectories() does no real
 *     disk I/O and so file-move / stat paths are deterministic.
 *   - `child_process.spawn` is mocked to return a fake ffmpeg process whose
 *     stdin/stdout/stderr are stubbed.
 *   - `database` is a hand-rolled mock exposing runAsync/getAsync/allAsync; the
 *     service destructures these onto itself in the constructor.
 *   - `mediasoupService` is a hand-rolled mock with a router, producers map,
 *     and getCurrentStreamer().
 *   - Lifecycle paths schedule setTimeout-based waits; we drive these with jest
 *     fake timers.
 *
 * Pins: construction state, directory bootstrap, start/stop lifecycle and
 * branching, transport/consumer creation, continuous-recording enable/disable
 * + status, DB persistence call args, and listing/status output shapes.
 */

jest.mock('../../bootstrap/logger', () => {
    const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
    m.child = jest.fn(() => m);
    return m;
});

jest.mock('fs');
jest.mock('child_process', () => ({ spawn: jest.fn() }));

const fs = require('fs');
const { spawn } = require('child_process');
const RecordingService = require('../../services/RecordingService');

function makeDatabase() {
    return {
        db: { _fake: true },
        runAsync: jest.fn(async () => ({ changes: 1 })),
        getAsync: jest.fn(async () => undefined),
        allAsync: jest.fn(async () => []),
    };
}

function makeFakeFfmpegProcess() {
    return {
        stdin: { write: jest.fn() },
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
    };
}

function makeTransport(id) {
    return {
        id,
        closed: false,
        connect: jest.fn(async () => undefined),
        consume: jest.fn(async () => ({
            id: `consumer-${id}`,
            kind: id.includes('video') ? 'video' : 'audio',
            paused: false,
            closed: false,
            resume: jest.fn(async () => undefined),
            close: jest.fn(),
            on: jest.fn(),
            rtpParameters: {
                codecs: [{ mimeType: id.includes('video') ? 'video/VP8' : 'audio/opus', payloadType: 100, clockRate: id.includes('video') ? 90000 : 48000 }],
                encodings: [{ ssrc: 12345 }],
            },
        })),
        close: jest.fn(),
    };
}

function makeMediasoup({ streamer = 'streamerA', withProducers = true } = {}) {
    const producers = new Map();
    if (withProducers) {
        const pmap = new Map([
            ['video', { id: 'prod-video' }],
            ['audio', { id: 'prod-audio' }],
        ]);
        producers.set(streamer, pmap);
    }
    const router = {
        createPlainTransport: jest.fn(async (opts) => makeTransport(`t-${Math.random()}`)),
    };
    return {
        getCurrentStreamer: jest.fn(() => streamer),
        producers,
        router,
    };
}

function makeService(opts = {}) {
    const database = opts.database || makeDatabase();
    const mediasoupService = opts.mediasoupService || makeMediasoup(opts.msOpts || {});
    const storageService = opts.storageService || {};
    const service = new RecordingService(database, mediasoupService, storageService);
    return { service, database, mediasoupService, storageService };
}

beforeEach(() => {
    jest.clearAllMocks();
    // Default fs behavior: directories don't pre-exist (so initializeDirectories
    // calls mkdirSync), file ops succeed.
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.renameSync.mockReturnValue(undefined);
    fs.statSync.mockReturnValue({ size: 4242 });
    fs.readdirSync.mockReturnValue([]);
    fs.unlinkSync.mockReturnValue(undefined);
    spawn.mockReturnValue(makeFakeFfmpegProcess());
});

describe('RecordingService characterization', () => {
    describe('construction', () => {
        it('wires DB helpers, empty active map, and default continuous state', () => {
            const { service, database, mediasoupService } = makeService();
            expect(service.database).toBe(database);
            expect(service.db).toBe(database.db);
            expect(service.runAsync).toBe(database.runAsync);
            expect(service.mediasoupService).toBe(mediasoupService);
            expect(service.activeRecordings instanceof Map).toBe(true);
            expect(service.activeRecordings.size).toBe(0);
            expect(service.continuousRecordingState).toEqual({
                enabled: false,
                quality: '720p',
                sessionId: null,
                currentRecording: null,
                streamSwitches: 0,
            });
        });

        it('exposes the three quality profiles and storage paths, and bootstraps directories', () => {
            const { service } = makeService();
            expect(Object.keys(service.qualityProfiles)).toEqual(['480p', '720p', '1080p']);
            expect(service.qualityProfiles['720p']).toEqual({
                videoBitrate: '1800k',
                audioBitrate: '128k',
                resolution: '1280x720',
                fps: 30,
            });
            // 8 storage path categories, each mkdir'd because existsSync -> false.
            expect(Object.keys(service.storagePaths)).toHaveLength(8);
            expect(fs.mkdirSync).toHaveBeenCalledTimes(8);
        });
    });

    describe('startRecording branching', () => {
        it('rejects when the requested streamer is not the current streamer', async () => {
            const { service } = makeService({ msOpts: { streamer: 'someoneElse' } });
            const res = await service.startRecording('streamerA');
            expect(res).toEqual({ success: false, error: 'Streamer is not currently streaming' });
        });

        it('rejects when there are no producers for the streamer', async () => {
            const { service } = makeService({ msOpts: { streamer: 'streamerA', withProducers: false } });
            const res = await service.startRecording('streamerA');
            expect(res).toEqual({ success: false, error: 'No producers available for recording' });
        });

        it('starts a recording end-to-end: registers active session, persists, returns shape', async () => {
            jest.useFakeTimers();
            try {
                const { service, database } = makeService();
                const promise = service.startRecording('streamerA', '720p', 'manual');
                // startFFmpegRecording awaits a 1s startup delay.
                await jest.advanceTimersByTimeAsync(1000);
                const res = await promise;

                expect(res.success).toBe(true);
                expect(typeof res.recordingId).toBe('string');
                expect(res.quality).toBe('720p');
                expect(res.startTime instanceof Date).toBe(true);
                expect(res.filePath).toContain('recording_streamerA_');
                expect(res.filePath).toContain('_720p.webm');

                // Session is tracked and DB persistence + event log fired.
                expect(service.activeRecordings.has(res.recordingId)).toBe(true);
                expect(spawn).toHaveBeenCalledWith('ffmpeg', expect.any(Array));
                // saveRecordingToDatabase INSERT + logRecordingEvent INSERT.
                const insertCalls = database.runAsync.mock.calls.filter(c => /INSERT INTO/.test(c[0]));
                expect(insertCalls.length).toBeGreaterThanOrEqual(2);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('createPlainTransports', () => {
        it('returns video+audio transports with ffmpegPorts metadata', async () => {
            const { service, mediasoupService } = makeService();
            const res = await service.createPlainTransports();
            expect(res.success).toBe(true);
            expect(res.transports.get('video')).toBeDefined();
            expect(res.transports.get('audio')).toBeDefined();
            expect(res.transports.ffmpegPorts).toEqual({ video: 5004, audio: 5006 });
            expect(mediasoupService.router.createPlainTransport).toHaveBeenCalledTimes(2);
        });

        it('fails when the mediasoup router is unavailable', async () => {
            const ms = makeMediasoup();
            ms.router = null;
            const { service } = makeService({ mediasoupService: ms });
            const res = await service.createPlainTransports();
            expect(res).toEqual({ success: false, error: 'MediaSoup router not available' });
        });
    });

    describe('stopRecording', () => {
        it('returns not-found for an unknown recording id', async () => {
            const { service } = makeService();
            const res = await service.stopRecording('nope');
            expect(res).toEqual({ success: false, error: 'Recording not found' });
        });

        it('stops an active recording: kills ffmpeg, persists update, removes from active', async () => {
            jest.useFakeTimers();
            try {
                const { service, database } = makeService();
                const ffmpegProcess = makeFakeFfmpegProcess();
                const session = {
                    id: 'rec-1',
                    streamerId: 'streamerA',
                    quality: '720p',
                    startTime: new Date('2026-01-01T00:00:00Z'),
                    status: 'recording',
                    transports: new Map(),
                    consumers: new Map(),
                    ffmpegProcess,
                    filePath: '/recordings/active/rec-1.webm',
                };
                service.activeRecordings.set('rec-1', session);
                // File exists so it gets moved to completed.
                fs.existsSync.mockReturnValue(true);

                const promise = service.stopRecording('rec-1', 'user-7');
                await jest.advanceTimersByTimeAsync(2000); // graceful shutdown wait
                const res = await promise;

                expect(res.success).toBe(true);
                expect(res.recordingId).toBe('rec-1');
                expect(ffmpegProcess.kill).toHaveBeenCalledWith('SIGTERM');
                expect(fs.renameSync).toHaveBeenCalled();
                expect(service.activeRecordings.has('rec-1')).toBe(false);
                // updateRecordingInDatabase UPDATE + logRecordingEvent INSERT.
                expect(database.runAsync.mock.calls.some(c => /UPDATE recordings/.test(c[0]))).toBe(true);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('continuous recording', () => {
        it('enableContinuousRecording flips state and returns sessionId + quality', async () => {
            // No current streamer -> no immediate recording start.
            const ms = makeMediasoup();
            ms.getCurrentStreamer = jest.fn(() => null);
            const { service } = makeService({ mediasoupService: ms });

            const res = await service.enableContinuousRecording('1080p');
            expect(res.success).toBe(true);
            expect(res.quality).toBe('1080p');
            expect(typeof res.sessionId).toBe('string');
            expect(service.continuousRecordingState.enabled).toBe(true);
            expect(service.continuousRecordingState.quality).toBe('1080p');
            expect(service.continuousRecordingState.streamSwitches).toBe(0);
        });

        it('disableContinuousRecording resets state and returns success', async () => {
            const { service } = makeService();
            service.continuousRecordingState.enabled = true;
            service.continuousRecordingState.sessionId = 'sess-1';
            // No currentRecording, so stopRecording is not invoked.
            const res = await service.disableContinuousRecording();
            expect(res).toEqual({ success: true });
            expect(service.continuousRecordingState.enabled).toBe(false);
            expect(service.continuousRecordingState.sessionId).toBe(null);
            expect(service.continuousRecordingState.currentRecording).toBe(null);
        });

        it('getContinuousRecordingStatus reports isRecording from state + current streamer', () => {
            const { service } = makeService();
            service.continuousRecordingState.currentRecording = 'rec-9';
            const status = service.getContinuousRecordingStatus();
            expect(status.enabled).toBe(false);
            expect(status.currentRecording).toBe('rec-9');
            expect(status.isRecording).toBe(true);
        });
    });

    describe('database + listing helpers', () => {
        it('saveRecordingToDatabase INSERTs the mapped recording columns', async () => {
            const { service, database } = makeService();
            const session = {
                id: 'rec-2',
                streamerId: 'streamerA',
                quality: '480p',
                startTime: new Date('2026-02-02T00:00:00Z'),
                status: 'recording',
                filePath: '/recordings/active/rec-2.webm',
            };
            await service.saveRecordingToDatabase(session);
            expect(database.runAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = database.runAsync.mock.calls[0];
            expect(sql).toMatch(/INSERT INTO recordings/);
            expect(params).toEqual([
                'rec-2',
                'rec-2',
                'streamerA',
                session.startTime.toISOString(),
                '/recordings/active/rec-2.webm',
                '480p',
                'webm',
                'recording',
                expect.any(String),
            ]);
        });

        it('getRecordingsList passes limit/offset and returns rows from allAsync', async () => {
            const rows = [{ id: 'r1' }, { id: 'r2' }];
            const database = makeDatabase();
            database.allAsync = jest.fn(async () => rows);
            const { service } = makeService({ database });
            const out = await service.getRecordingsList(10, 5);
            expect(out).toBe(rows);
            const [, params] = database.allAsync.mock.calls[0];
            expect(params).toEqual([10, 5]);
        });

        it('getRecordingsList adds the status filter param when status given', async () => {
            const database = makeDatabase();
            database.allAsync = jest.fn(async () => []);
            const { service } = makeService({ database });
            await service.getRecordingsList(20, 0, 'completed');
            const [sql, params] = database.allAsync.mock.calls[0];
            expect(sql).toMatch(/WHERE status = \?/);
            expect(params).toEqual(['completed', 20, 0]);
        });

        it('getActiveRecordings projects tracked sessions to summary shape', async () => {
            const { service } = makeService();
            service.activeRecordings.set('rec-3', {
                streamerId: 'streamerA',
                quality: '720p',
                startTime: new Date('2026-03-03T00:00:00Z'),
                status: 'recording',
                lastProgress: 0.5,
            });
            const out = await service.getActiveRecordings();
            expect(out).toEqual([{
                id: 'rec-3',
                streamerId: 'streamerA',
                quality: '720p',
                startTime: new Date('2026-03-03T00:00:00Z'),
                status: 'recording',
                progress: 0.5,
            }]);
        });

        it('getSystemStatus reports active count, cap, and quality profile keys', async () => {
            const { service } = makeService();
            service.activeRecordings.set('a', {});
            const status = await service.getSystemStatus();
            expect(status).toEqual({
                activeRecordings: 1,
                maxConcurrentRecordings: 5,
                qualityProfiles: ['480p', '720p', '1080p'],
            });
        });
    });
});
