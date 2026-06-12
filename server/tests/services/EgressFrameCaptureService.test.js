// Tests for EgressFrameCaptureService — segment-picking by transcription end
// time, partial-write avoidance, cache invalidation on stream takeover, and
// process-cap enforcement. ffmpeg is mocked at the child_process layer so the
// suite doesn't depend on the binary being installed.

const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { spawn } = require('child_process');
const EgressFrameCaptureService = require('../../services/EgressFrameCaptureService');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // valid-looking start byte

function mockFfmpegSuccess(payload = JPEG_MAGIC) {
    spawn.mockImplementationOnce(() => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = jest.fn();
        proc.unref = jest.fn();
        setImmediate(() => {
            proc.stdout.emit('data', payload);
            proc.emit('exit', 0);
        });
        return proc;
    });
}

function mockFfmpegFailure(exitCode = 1) {
    spawn.mockImplementationOnce(() => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = jest.fn();
        proc.unref = jest.fn();
        setImmediate(() => {
            proc.stderr.emit('data', Buffer.from('boom'));
            proc.emit('exit', exitCode);
        });
        return proc;
    });
}

function makeMockEgress({ isRecording = true, sessionId = 'session-1', outputDir, segmentDuration = 4 } = {}) {
    return {
        isRecording,
        currentSessionId: sessionId,
        outputDir,
        segmentDuration,
    };
}

function makeFixtureSession({ playlistTimestamps = [1000], segments }) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-test-'));
    const sessionDir = path.join(tmpRoot, 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Latest playlist holds all the segments; older ones are noise.
    const latestTs = playlistTimestamps[playlistTimestamps.length - 1];
    for (const ts of playlistTimestamps) {
        const playlistName = `playlist_${ts}.m3u8`;
        let content = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
        if (ts === latestTs) {
            for (const seg of segments) {
                content += `#EXTINF:4.0,\n${seg.name}\n`;
            }
        }
        fs.writeFileSync(path.join(sessionDir, playlistName), content);
    }

    // Create segment files with explicit mtimes (the discriminator the
    // service uses to pick the right one for the transcription window).
    for (const seg of segments) {
        const segPath = path.join(sessionDir, seg.name);
        fs.writeFileSync(segPath, 'fake .ts content');
        const mtime = new Date(seg.mtimeMs);
        fs.utimesSync(segPath, mtime, mtime);
    }

    return { tmpRoot, sessionDir };
}

describe('EgressFrameCaptureService', () => {
    let tmpFramesDir;

    beforeEach(() => {
        spawn.mockReset();
        tmpFramesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-archive-'));
    });

    test('returns null when egress is not recording', async () => {
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ isRecording: false }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const r = await svc.captureFrame('streamer-1', new Date(), 1);
        expect(r).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
        await svc.stop();
    });

    test('returns null when sessionDir does not exist', async () => {
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: '/nonexistent/path' }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const r = await svc.captureFrame('streamer-1', new Date(), 1);
        expect(r).toBeNull();
        await svc.stop();
    });

    test('returns null when only one segment exists (would be the in-progress write)', async () => {
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [{ name: 'seg_1000_0.ts', mtimeMs: Date.now() }],
        });
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const r = await svc.captureFrame('streamer-1', new Date(), 1);
        expect(r).toBeNull();
        await svc.stop();
    });

    test('picks the segment whose mtime is the largest ≤ endTime + segmentDuration', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 },
                { name: 'seg_1000_3.ts', mtimeMs: t0 + 12_000 }, // dropped: in-progress
            ],
        });
        mockFfmpegSuccess(JPEG_MAGIC);
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot, segmentDuration: 4 }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });

        // Transcription window ended at t0+5000ms. With 4s segments,
        // candidates allowed up through mtime = t0+9000ms. Among
        // {t0, t0+4000, t0+8000}, the largest ≤ t0+9000 is t0+8000.
        const r = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 1);
        expect(r).not.toBeNull();
        expect(r.sourceSegment).toBe('seg_1000_2.ts');
        expect(r.jpegBase64).toBe(JPEG_MAGIC.toString('base64'));
        expect(spawn).toHaveBeenCalledTimes(1);
        const callArgs = spawn.mock.calls[0];
        expect(callArgs[0]).toBe('ffmpeg');
        // -sseof was removed: ffmpeg 7.x exits non-zero seeking from the end
        // of a short HLS .ts segment with B-frames. We grab the first frame
        // instead, and force -pix_fmt yuvj420p because the egress encoder
        // emits limited-range YUV that ffmpeg 7's mjpeg encoder rejects.
        expect(callArgs[1]).not.toContain('-sseof');
        expect(callArgs[1]).toContain('-pix_fmt');
        expect(callArgs[1]).toContain('-frames:v');
        expect(callArgs[1].some(a => a.endsWith('seg_1000_2.ts'))).toBe(true);
        await svc.stop();
    });

    test('falls back to newest fully-written segment when no segment matches the window', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 }, // dropped: in-progress
            ],
        });
        mockFfmpegSuccess(JPEG_MAGIC);
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot, segmentDuration: 4 }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });

        // endTime far in the past (1e12 ms ago) → no segment has mtime ≤ that;
        // we should still get the newest fully-written one as fallback.
        const r = await svc.captureFrame('streamer-1', new Date(Date.now() - 1_000_000_000_000), 1);
        // Actually: endTime way in the past means target = endTime + 4s, also
        // way in the past, so no candidate qualifies — fallback path picks
        // the newest fully-written segment (seg_1000_1.ts).
        expect(r).not.toBeNull();
        expect(r.sourceSegment).toBe('seg_1000_1.ts');
        await svc.stop();
    });

    test('returns null when ffmpeg exits nonzero', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 },
            ],
        });
        mockFfmpegFailure(1);
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const r = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 1);
        expect(r).toBeNull();
        await svc.stop();
    });

    test('caches result for 10s and serves the cached frame on a repeat call', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 },
            ],
        });
        mockFfmpegSuccess(JPEG_MAGIC);
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const first = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 1);
        expect(first).not.toBeNull();
        // Second call must not spawn ffmpeg again — it should hit the cache.
        const second = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
        await svc.stop();
    });

    test('invalidates cache when streamGeneration changes (takeover)', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 },
            ],
        });
        mockFfmpegSuccess(JPEG_MAGIC);
        mockFfmpegSuccess(Buffer.from([0xff, 0xd8, 0xff, 0xe1])); // distinct payload
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const a = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 1);
        const b = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 2);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(a.jpegBase64).not.toBe(b.jpegBase64);
        await svc.stop();
    });

    test('writes an audit copy under framesArchiveDir/<streamerId>', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 },
            ],
        });
        mockFfmpegSuccess(JPEG_MAGIC);
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        await svc.captureFrame('streamer-with/bad chars', new Date(t0 + 5000), 1);
        // Slashes and spaces in streamerId must be sanitized to keep the path
        // strictly under framesArchiveDir.
        const streamerSubdir = fs.readdirSync(tmpFramesDir);
        expect(streamerSubdir).toHaveLength(1);
        expect(streamerSubdir[0]).not.toMatch(/[/ ]/);
        const auditFiles = fs.readdirSync(path.join(tmpFramesDir, streamerSubdir[0]));
        expect(auditFiles).toHaveLength(1);
        expect(auditFiles[0]).toMatch(/\.jpg$/);
        await svc.stop();
    });

    test('purgeOldFrames deletes files older than frameRetentionHours', async () => {
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ isRecording: false }),
            framesArchiveDir: tmpFramesDir,
            frameRetentionHours: 1,
            cleanupIntervalMs: 999_999_999,
        });
        // Set up a streamer dir with one fresh file and one expired file.
        const streamerDir = path.join(tmpFramesDir, 'streamer-1');
        fs.mkdirSync(streamerDir);
        const freshPath = path.join(streamerDir, 'fresh.jpg');
        const stalePath = path.join(streamerDir, 'stale.jpg');
        fs.writeFileSync(freshPath, 'x');
        fs.writeFileSync(stalePath, 'x');
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

        const { deleted } = await svc.purgeOldFrames();
        expect(deleted).toBe(1);
        expect(fs.existsSync(freshPath)).toBe(true);
        expect(fs.existsSync(stalePath)).toBe(false);
        await svc.stop();
    });

    test('refuses to spawn when ffmpeg concurrency cap is reached', async () => {
        const t0 = Date.now() - 60_000;
        const { tmpRoot } = makeFixtureSession({
            playlistTimestamps: [1000],
            segments: [
                { name: 'seg_1000_0.ts', mtimeMs: t0 },
                { name: 'seg_1000_1.ts', mtimeMs: t0 + 4000 },
                { name: 'seg_1000_2.ts', mtimeMs: t0 + 8000 },
            ],
        });
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ outputDir: tmpRoot }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        // Simulate two ffmpeg processes already in flight.
        svc.activeProcesses.add({ kill: () => {} });
        svc.activeProcesses.add({ kill: () => {} });
        const r = await svc.captureFrame('streamer-1', new Date(t0 + 5000), 99);
        expect(r).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
        await svc.stop();
    });

    test('stop() SIGKILLs tracked children and clears the cleanup timer', async () => {
        const svc = new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ isRecording: false }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
        });
        const killSpy = jest.fn();
        svc.activeProcesses.add({ kill: killSpy });
        svc.activeProcesses.add({ kill: killSpy });
        await svc.stop();
        expect(killSpy).toHaveBeenCalledTimes(2);
        expect(killSpy).toHaveBeenCalledWith('SIGKILL');
        expect(svc.activeProcesses.size).toBe(0);
        expect(svc._cleanupTimer).toBeNull();
    });
});

describe('EgressFrameCaptureService relay-source fallback', () => {
    let tmpFramesDir;

    beforeEach(() => {
        spawn.mockReset();
        tmpFramesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-archive-'));
        delete global.viewBotURLService;
    });

    afterEach(() => {
        delete global.viewBotURLService;
    });

    function makeSvc(relaySourceProvider) {
        return new EgressFrameCaptureService({
            continuousRecordingService: makeMockEgress({ isRecording: false }),
            framesArchiveDir: tmpFramesDir,
            cleanupIntervalMs: 999_999_999,
            relaySourceProvider,
        });
    }

    test('captures from the relay source URL when egress is not recording', async () => {
        mockFfmpegSuccess();
        const svc = makeSvc(() => 'https://example.test/live/variant.m3u8');
        const r = await svc.captureFrame('url-stream-1', new Date(), 3);
        expect(r).not.toBeNull();
        expect(r.sourceSegment).toBe('relay_source');
        expect(r.streamGeneration).toBe(3);
        expect(spawn).toHaveBeenCalledTimes(1);
        const args = spawn.mock.calls[0][1];
        expect(args).toContain('https://example.test/live/variant.m3u8');
        await svc.stop();
    });

    test('returns null (no spawn) when the provider has no source for the streamer', async () => {
        const svc = makeSvc(() => null);
        const r = await svc.captureFrame('not-a-relay', new Date(), 1);
        expect(r).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
        await svc.stop();
    });

    test('returns null when relay ffmpeg fails', async () => {
        mockFfmpegFailure(1);
        const svc = makeSvc(() => 'https://example.test/live/variant.m3u8');
        const r = await svc.captureFrame('url-stream-1', new Date(), 1);
        expect(r).toBeNull();
        await svc.stop();
    });

    test('default provider reads global.viewBotURLService and skips pipe-mode sources', async () => {
        const activeStreams = new Map([
            ['pipe-stream', { status: 'streaming', streamInfo: { pipeMode: true, streamUrl: 'x' } }],
            ['direct-stream', { status: 'streaming', streamInfo: { pipeMode: false, streamUrl: 'https://example.test/d.m3u8' } }],
            ['starting-stream', { status: 'starting', streamInfo: { pipeMode: false, streamUrl: 'https://example.test/s.m3u8' } }],
        ]);
        global.viewBotURLService = { activeStreams };
        const svc = makeSvc(undefined); // default provider

        expect(await svc.captureFrame('pipe-stream', new Date(), 1)).toBeNull();
        expect(await svc.captureFrame('starting-stream', new Date(), 1)).toBeNull();
        expect(spawn).not.toHaveBeenCalled();

        mockFfmpegSuccess();
        const r = await svc.captureFrame('direct-stream', new Date(), 1);
        expect(r).not.toBeNull();
        expect(spawn.mock.calls[0][1]).toContain('https://example.test/d.m3u8');
        await svc.stop();
    });

    test('remote capture uses the longer kill escalation', async () => {
        mockFfmpegSuccess();
        const svc = makeSvc(() => 'https://example.test/live/variant.m3u8');
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        await svc.captureFrame('url-stream-1', new Date(), 1);
        const delays = setTimeoutSpy.mock.calls.map(c => c[1]);
        expect(delays).toContain(12000);
        expect(delays).toContain(15000);
        setTimeoutSpy.mockRestore();
        await svc.stop();
    });
});
