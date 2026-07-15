/**
 * Graceful-shutdown registration.
 *
 * Extracted from `server/index.js` as part of Phase 15B.4. The pre-PR
 * shape had a 277-LoC inline block (lines 5255–5531 at the 15B.5 close)
 * containing:
 *   - `async function shutdown(signal)`              — the orderly drain
 *   - `process.on('SIGINT', ...)` / `('SIGTERM', ...)`  — signal binding
 *   - `process.on('uncaughtException', ...)`         — fatal-error fallback
 *   - `process.on('unhandledRejection', ...)`        — log-only fallback
 *   - `function cleanupMediaProcesses()`             — emergency pkill loop
 *
 * The post-PR shape is `registerShutdownHandlers(deps)` — a single factory
 * that wires all four `process.on(...)` handlers and contains
 * byte-equivalent shutdown + cleanup bodies. Lazy-init services
 * (`webrtcService`, `viewbotService`, etc.) are passed via
 * getter functions so the lookup happens at signal-time (always after
 * `startServer()` has wired them — or `undefined` if the signal arrives
 * during startup, in which case the relevant cleanup steps no-op).
 *
 * The two `// console-allowed: uncaughtException fallback` markers
 * (introduced by PR 15A.2 in the uncaughtException + unhandledRejection
 * handlers) are preserved inline here. Per ADR-0020's escape-hatch rule,
 * the markers must sit on the immediately-preceding line of each raw
 * stderr call — the expanded `no-console.test.js` enforces.
 *
 * Shutdown ordering invariants (load-bearing — do not reorder without
 * consulting the relevant ADRs and re-running the SIGTERM smoke):
 *   0. Re-entrancy guard + force-exit watchdog FIRST (ADR-0032): a second
 *      signal is ignored while a shutdown is in flight, and an unref'd
 *      watchdog timer (default 15 s, `SHUTDOWN_WATCHDOG_MS` override —
 *      sized BELOW compose.yaml's `stop_grace_period: 20s`) force-exits
 *      with code 1 if the drain wedges.
 *   1. Run stoppables registry in reverse-construction order (PR 1.2).
 *   2. Disconnect all live sockets BEFORE media-process termination so
 *      the per-disconnect cleanup paths don't race the kill loop.
 *   3. Service-level cleanup (ViewBot/Recording) BEFORE the
 *      descendant-scoped ffmpeg SIGTERM safety net (ADR-0032 — replaces
 *      the old host-wide `pkill -TERM ffmpeg`; the Chrome pkills were
 *      deleted outright, this codebase never spawns Chrome) — services
 *      with stop() get a clean exit; the safety net catches strays
 *      among OUR descendants only.
 *   4. LiveKit `cleanupAll()` AFTER stream-level cleanup so the backend
 *      doesn't tear down transports under live producers.
 *   5. Redis `quit()` LATE in the sequence — services may consult Redis
 *      during their stop() (currently none do, but the ordering keeps
 *      the option open).
 *   6. HTTP(S) server close LAST — BOTH `httpServer` and `httpsServer`
 *      (whichever are listening) are closed, `closeAllConnections()` is
 *      invoked after close() is initiated so keep-alive sockets can't
 *      hold the drain open forever, and once done the process exits.
 *
 * Risk surfaces flagged in the closure audit:
 *   - `simpleMediaStreamService` is referenced via a
 *     `typeof X !== 'undefined'` guard (pre-existing pattern — that
 *     service may or may not exist depending on env / feature flags).
 *     Preserved verbatim here.
 *   - `global.viewBotURLService` is read from the global namespace
 *     (assigned inside `bootstrap/start-streaming-backend.js`). It
 *     may be unset if shutdown fires before `startServer()` completes.
 */

const logger = require('./logger').child({ svc: 'shutdown' });
const { killDescendantsByComm, killDescendantsByCommSync } = require('./process-tree');

// Default watchdog. MUST stay below compose.yaml's `stop_grace_period: 20s`,
// or docker SIGKILLs the container before the watchdog can fire (ADR-0032).
const DEFAULT_WATCHDOG_MS = 15_000;

function watchdogMs() {
    const override = Number(process.env.SHUTDOWN_WATCHDOG_MS);
    return Number.isFinite(override) && override > 0 ? override : DEFAULT_WATCHDOG_MS;
}

/**
 * Close one HTTP(S) server: initiate close(), then hard-drop any remaining
 * (keep-alive / in-flight) connections so close() can actually complete on
 * Node 18 — `server.close()` alone waits on open sockets forever there.
 * Resolves even if the server was already closed (ERR_SERVER_NOT_RUNNING).
 */
function closeListeningServer(srv) {
    return new Promise((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
    });
}

function registerShutdownHandlers(deps) {
    const {
        stoppables,
        io,
        server,
        httpServer,
        httpsServer,
        getRedisClient,
        getWebrtcService,
        getTimeTrackingService,
        getResourceMonitor,
        getSessionService,
        getSimpleMediaStreamService,
    } = deps;

    // ADR-0032 (B2): re-entrancy guard — SIGINT+SIGTERM back-to-back (or a
    // repeated Ctrl-C) must not run two overlapping drains.
    let shuttingDown = false;

    async function shutdown(signal) {
        if (shuttingDown) {
            logger.warn(`🛑 Received ${signal} but a shutdown is already in progress — ignoring`);
            return;
        }
        shuttingDown = true;

        logger.info(`🛑 Received ${signal}, shutting down server gracefully...`);

        // ADR-0032 (B2): force-exit watchdog. unref'd so it never keeps the
        // process alive; if the drain wedges (stuck redis quit(), wedged
        // socket fetch, …) we exit dirty-but-promptly instead of hanging
        // until docker's stop_grace_period SIGKILL.
        const watchdog = setTimeout(() => {
            logger.error({ signal, watchdogMs: watchdogMs() }, '⏰ shutdown watchdog fired — force exit');
            process.exit(1);
        }, watchdogMs());
        watchdog.unref();

        try {
            // PR 1.2: iterate the stoppables registry in reverse-construction
            // order. Each service.stop() races against a 5 s timeout so a single
            // wedged teardown can't hold up the whole shutdown. The timer is
            // cleared on each iteration to avoid leaking a pending rejection that
            // would surface as an unhandled rejection after Promise.race resolves.
            // svc.stop?.() is wrapped in an async IIFE so a synchronous throw
            // inside stop() lands in the per-iteration catch rather than escaping.
            logger.info(`🛑 Stopping ${stoppables.length} registered service(s)...`);
            for (const svc of [...stoppables].reverse()) {
                const name = svc?.constructor?.name || 'anonymous';
                let timer;
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('stop() timed out after 5s')), 5000);
                });
                try {
                    await Promise.race([(async () => svc.stop?.())(), timeout]);
                } catch (e) {
                    logger.error({ err: e, name }, '   ⚠️  service stop() failed');
                } finally {
                    clearTimeout(timer);
                }
            }

            // 1. Disconnect all socket connections
            logger.info('🔌 Disconnecting all socket connections...');
            const sockets = await io.fetchSockets();
            for (const socket of sockets) {
                socket.disconnect(true);
            }

            // 2. Stop all media streams (FFmpeg)
            // NOTE: services with stop() are already drained above via stoppables —
            // this block intentionally remains as belt-and-braces for processes
            // not yet wrapped. A follow-up PR can prune entries that overlap with
            // stoppables once the iterator is proven.
            logger.info('🎬 Stopping all media streams...');

            // NOTE: the ViewbotService FFmpeg-process / cleanup() teardown was
            // removed here along with the ViewbotService creation half — the
            // service is now stateless (only isViewbotStream) and owns no
            // process or background work to drain.

            if (global.viewBotURLService) {
                logger.info('   Stopping URL Stream ViewBot service...');
                await global.viewBotURLService.stopAllURLStreams();
            }

            const simpleMediaStreamService = getSimpleMediaStreamService ? getSimpleMediaStreamService() : undefined;
            if (simpleMediaStreamService && simpleMediaStreamService.ffmpegProcess) {
                logger.info('   Stopping Simple Media Stream FFmpeg...');
                if (!simpleMediaStreamService.ffmpegProcess.killed) {
                    simpleMediaStreamService.ffmpegProcess.kill('SIGTERM');
                }
            }

            // (The MediaSoup-era RecordingService ffmpeg-drain was removed with
            // ADR-0024. LiveKit egress recordings are server-side jobs stopped
            // via continuousRecordingService.stop() in the stoppables registry,
            // not local ffmpeg children — so there's nothing to SIGTERM here.)

            // Safety-net kill for any strays — scoped to OUR descendants
            // (ADR-0032). The pre-0032 shape was a host/namespace-wide
            // `pkill -TERM ffmpeg` plus two Chrome pkills; the ffmpeg kill
            // could SIGTERM a co-located LiveKit egress recorder on any
            // bare-host run, and the Chrome pkills matched ONLY foreign
            // processes (this codebase spawns no Chrome), so they were
            // deleted outright. In the containerized prod, node is PID 1,
            // so even orphaned ffmpeg reparents to us and stays a
            // descendant — nothing legitimate is missed by the scoping.
            logger.info('🔍 Checking for any remaining media processes...');

            if (process.platform === 'win32') {
                // Dev-only platform; taskkill has no cheap descendant filter.
                const { exec } = require('child_process');
                exec('taskkill /F /IM ffmpeg.exe 2>nul', (err) => {
                    if (!err) logger.info('   - Killed remaining FFmpeg processes');
                });
            } else {
                const killed = await killDescendantsByComm(process.pid, 'ffmpeg', 'SIGTERM');
                if (killed.length > 0) {
                    logger.info({ pids: killed }, `   - SIGTERMed ${killed.length} remaining descendant FFmpeg process(es)`);
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 500));

            // 3. Clean up LiveKit resources
            logger.info('🧹 Cleaning up LiveKit resources...');
            const webrtcService = getWebrtcService();
            if (webrtcService) {
                webrtcService.cleanupAll();
            }

            // 4. Clear all sessions
            logger.info('📊 Clearing session data...');
            const sessionService = getSessionService();
            if (sessionService) {
                sessionService.clearAllSessions();
            }

            // 5. Stop resource monitoring
            logger.info('📈 Stopping resource monitor...');
            getResourceMonitor().stopMonitoring();

            // 6. Stop time tracking
            logger.info('⏱️ Stopping time tracking...');
            const timeTrackingService = getTimeTrackingService();
            if (timeTrackingService) {
                timeTrackingService.stopPeriodicCleanup();
            }

            // 7. Close Redis connection
            const redisClient = getRedisClient();
            if (redisClient) {
                logger.info('🔴 Closing Redis connection...');
                await redisClient.quit();
            }

            // 8. Close the HTTP(S) servers (ADR-0032). Accept both the new
            // httpServer/httpsServer deps and the legacy `server` dep
            // (deduped — index.js's `server` aliases one of the other two).
            // Only servers actually listening are closed; today exactly one
            // listens (start-listeners.js), but this stays correct if a
            // second listener ever returns.
            logger.info('🌐 Closing HTTP server(s)...');
            const servers = [...new Set([httpServer, httpsServer, server])]
                .filter((srv) => srv && srv.listening === true);
            await Promise.all(servers.map(closeListeningServer));

            logger.info('✅ Graceful shutdown complete');
            clearTimeout(watchdog);
            process.exit(0);
        } catch (error) {
            logger.error({ err: error }, '❌ Error during shutdown');
            clearTimeout(watchdog);
            process.exit(1);
        }
    }

    function cleanupMediaProcesses() {
        // Crash-path (uncaughtException) emergency sweep. Scoped to OUR
        // descendant ffmpeg only (ADR-0032) — the pre-0032 `pkill -9 ffmpeg`
        // was namespace-wide. Sync variant: the process exits immediately
        // after this, so async work would never run.
        try {
            if (process.platform === 'win32') {
                const { execSync } = require('child_process');
                execSync('taskkill /F /IM ffmpeg.exe 2>nul', { stdio: 'ignore' });
            } else {
                killDescendantsByCommSync(process.pid, 'ffmpeg', 'SIGKILL');
            }
        } catch (e) {
            // Ignore errors in emergency cleanup
        }
    }

    // PR 1.2: both signals route through the same shutdown function so SIGTERM
    // (the systemd / Docker production path) actually awaits the work instead
    // of fire-and-forgetting via process.emit('SIGINT').
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (error) => {
        // console-allowed: uncaughtException fallback
        console.error('💥 Uncaught Exception:', error);
        // Attempt cleanup before exit
        cleanupMediaProcesses();
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        // console-allowed: uncaughtException fallback
        console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
        // Don't exit on unhandled rejection, but log it
    });

    return { shutdown, cleanupMediaProcesses };
}

module.exports = registerShutdownHandlers;
