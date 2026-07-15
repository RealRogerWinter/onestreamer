/**
 * Tests for the graceful-shutdown factory (server/bootstrap/shutdown.js)
 * after ADR-0032 (audit items B2 + B4):
 *
 *   B2 — re-entrancy guard (exactly-once), force-exit watchdog
 *        (default 15 s, SHUTDOWN_WATCHDOG_MS override, unref'd),
 *        closeAllConnections() + BOTH httpServer/httpsServer closed,
 *        non-listening servers skipped, legacy `server` dep still accepted,
 *        ERR_SERVER_NOT_RUNNING tolerated.
 *   B4 — kill safety nets scoped to descendants: NO host-wide
 *        `pkill -TERM ffmpeg`, NO Chrome/puppeteer pkills anywhere, and the
 *        crash path (cleanupMediaProcesses) uses the sync scoped variant.
 *
 * The factory registers REAL process.on handlers for SIGINT/SIGTERM/
 * uncaughtException/unhandledRejection — listeners are snapshotted and
 * restored around every test so jest's own handlers survive.
 */

jest.mock('child_process', () => ({
    exec: jest.fn((cmd, cb) => { if (typeof cb === 'function') cb(null, '', ''); }),
    execSync: jest.fn(() => ''),
}));

jest.mock('../../bootstrap/process-tree', () => ({
    killDescendantsByComm: jest.fn(async () => [111, 222]),
    killDescendantsByCommSync: jest.fn(() => [111]),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../bootstrap/logger', () => ({ child: () => mockLog }));

const childProcess = require('child_process');
const processTree = require('../../bootstrap/process-tree');
const registerShutdownHandlers = require('../../bootstrap/shutdown');

const WATCHED_EVENTS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];

function makeServer({ listening = true, closeErr = null, hasCloseAll = true } = {}) {
    const srv = {
        listening,
        close: jest.fn((cb) => { if (typeof cb === 'function') cb(closeErr); }),
    };
    if (hasCloseAll) srv.closeAllConnections = jest.fn();
    return srv;
}

function makeDeps(overrides = {}) {
    return {
        stoppables: [],
        io: { fetchSockets: jest.fn(async () => []) },
        getRedisClient: () => null,
        getWebrtcService: () => null,
        getTimeTrackingService: () => null,
        getResourceMonitor: () => ({ stopMonitoring: jest.fn() }),
        getSessionService: () => null,
        getSimpleMediaStreamService: () => undefined,
        ...overrides,
    };
}

describe('bootstrap/shutdown (ADR-0032)', () => {
    let savedListeners;
    let exitSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        savedListeners = {};
        for (const ev of WATCHED_EVENTS) {
            savedListeners[ev] = process.listeners(ev);
            process.removeAllListeners(ev);
        }
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        for (const ev of WATCHED_EVENTS) {
            process.removeAllListeners(ev);
            for (const l of savedListeners[ev]) process.on(ev, l);
        }
        delete process.env.SHUTDOWN_WATCHDOG_MS;
        jest.useRealTimers();
    });

    // ── B2: re-entrancy ──────────────────────────────────────────────────

    it('runs the drain exactly once when shutdown is invoked twice back-to-back', async () => {
        const stopped = jest.fn(async () => {});
        const httpServer = makeServer();
        const deps = makeDeps({ stoppables: [{ stop: stopped }], httpServer });
        const { shutdown } = registerShutdownHandlers(deps);

        const first = shutdown('SIGTERM');
        const second = shutdown('SIGINT'); // must return immediately, no second drain
        await Promise.all([first, second]);

        expect(stopped).toHaveBeenCalledTimes(1);
        expect(httpServer.close).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
        expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
    }, 15000);

    // ── B2: watchdog ─────────────────────────────────────────────────────

    it('force-exits with code 1 when the drain wedges past the watchdog window, and unrefs the timer', async () => {
        jest.useFakeTimers();

        // Wrap the (fake) setTimeout so we can observe .unref() on the handle.
        const fakeSetTimeout = global.setTimeout;
        const handles = [];
        const stSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
            const handle = fakeSetTimeout(fn, ms, ...rest);
            const origUnref = typeof handle.unref === 'function' ? handle.unref.bind(handle) : () => handle;
            handle.unref = jest.fn(origUnref);
            handles.push({ ms, handle });
            return handle;
        });

        try {
            // Wedge with a never-resolving, timer-free await so ONLY the
            // watchdog can make progress.
            const deps = makeDeps({
                io: { fetchSockets: () => new Promise(() => {}) },
                httpServer: makeServer(),
            });
            const { shutdown } = registerShutdownHandlers(deps);
            shutdown('SIGTERM'); // intentionally not awaited — it never settles

            const watchdogHandle = handles.find((h) => h.ms === 15000);
            expect(watchdogHandle).toBeDefined();
            expect(watchdogHandle.handle.unref).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(14999);
            expect(exitSpy).not.toHaveBeenCalled();

            jest.advanceTimersByTime(2);
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(mockLog.error).toHaveBeenCalledWith(
                expect.objectContaining({ signal: 'SIGTERM' }),
                expect.stringContaining('watchdog'),
            );
        } finally {
            stSpy.mockRestore();
        }
    });

    it('honors the SHUTDOWN_WATCHDOG_MS override', async () => {
        process.env.SHUTDOWN_WATCHDOG_MS = '250';
        jest.useFakeTimers();
        const deps = makeDeps({ io: { fetchSockets: () => new Promise(() => {}) } });
        const { shutdown } = registerShutdownHandlers(deps);
        shutdown('SIGTERM');

        jest.advanceTimersByTime(251);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    // ── B2: server close ─────────────────────────────────────────────────

    it('closes BOTH listening servers and hard-drops connections via closeAllConnections()', async () => {
        const httpServer = makeServer();
        const httpsServer = makeServer();
        const deps = makeDeps({ httpServer, httpsServer });
        const { shutdown } = registerShutdownHandlers(deps);
        await shutdown('SIGTERM');

        for (const srv of [httpServer, httpsServer]) {
            expect(srv.close).toHaveBeenCalledTimes(1);
            expect(srv.closeAllConnections).toHaveBeenCalledTimes(1);
        }
        expect(exitSpy).toHaveBeenCalledWith(0);
    }, 15000);

    it('skips non-listening servers, dedupes the legacy `server` alias, and tolerates missing closeAllConnections', async () => {
        const httpServer = makeServer({ listening: false });
        const httpsServer = makeServer({ hasCloseAll: false });
        const deps = makeDeps({ httpServer, httpsServer, server: httpsServer }); // legacy alias of the same object
        const { shutdown } = registerShutdownHandlers(deps);
        await shutdown('SIGTERM');

        expect(httpServer.close).not.toHaveBeenCalled();
        expect(httpsServer.close).toHaveBeenCalledTimes(1); // deduped: once, not twice
        expect(exitSpy).toHaveBeenCalledWith(0);
    }, 15000);

    it('still accepts the legacy `server` dep alone (backward compatibility)', async () => {
        const server = makeServer();
        const deps = makeDeps({ server });
        const { shutdown } = registerShutdownHandlers(deps);
        await shutdown('SIGTERM');

        expect(server.close).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    }, 15000);

    it('resolves (and exits 0) even when close() reports ERR_SERVER_NOT_RUNNING', async () => {
        const err = Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' });
        const httpServer = makeServer({ closeErr: err });
        const deps = makeDeps({ httpServer });
        const { shutdown } = registerShutdownHandlers(deps);
        await shutdown('SIGTERM');

        expect(httpServer.close).toHaveBeenCalledTimes(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    }, 15000);

    // ── B4: kill scoping ─────────────────────────────────────────────────

    it('graceful path: SIGTERMs only descendant ffmpeg — no host-wide pkill, no Chrome/puppeteer sweep', async () => {
        const deps = makeDeps({ httpServer: makeServer() });
        const { shutdown } = registerShutdownHandlers(deps);
        await shutdown('SIGTERM');

        // The scoped helper is the ONLY kill mechanism on the graceful path.
        expect(processTree.killDescendantsByComm).toHaveBeenCalledTimes(1);
        expect(processTree.killDescendantsByComm).toHaveBeenCalledWith(process.pid, 'ffmpeg', 'SIGTERM');

        // No shell-out kill remains (linux path): in particular no bare
        // `pkill -TERM ffmpeg`, and nothing matching foreign Chrome.
        const commands = childProcess.exec.mock.calls.map((c) => String(c[0]));
        for (const cmd of commands) {
            expect(cmd).not.toMatch(/pkill\s+-TERM\s+ffmpeg/);
            expect(cmd).not.toMatch(/pkill/);
            expect(cmd).not.toContain('puppeteer');
            expect(cmd).not.toContain('no-sandbox');
        }
    }, 15000);

    it('crash path: cleanupMediaProcesses uses only the scoped sync variant (SIGKILL descendants)', () => {
        const { cleanupMediaProcesses } = registerShutdownHandlers(makeDeps());
        cleanupMediaProcesses();

        expect(processTree.killDescendantsByCommSync).toHaveBeenCalledTimes(1);
        expect(processTree.killDescendantsByCommSync).toHaveBeenCalledWith(process.pid, 'ffmpeg', 'SIGKILL');

        const syncCommands = childProcess.execSync.mock.calls.map((c) => String(c[0]));
        for (const cmd of syncCommands) {
            expect(cmd).not.toMatch(/pkill/);
            expect(cmd).not.toContain('puppeteer');
            expect(cmd).not.toContain('no-sandbox');
        }
    });

    // ── wiring ───────────────────────────────────────────────────────────

    it('registers handlers for SIGINT, SIGTERM, uncaughtException and unhandledRejection', () => {
        registerShutdownHandlers(makeDeps());
        for (const ev of WATCHED_EVENTS) {
            expect(process.listeners(ev).length).toBe(1);
        }
    });
});
