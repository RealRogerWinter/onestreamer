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
 * (`viewbotService`, `viewBotClientService`, `recordingService`,
 * `visualFxService`, etc.) are passed via
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
 *   1. Run stoppables registry in reverse-construction order (PR 1.2).
 *   2. Disconnect all live sockets BEFORE media-process termination so
 *      the per-disconnect cleanup paths don't race the kill loop.
 *   3. Service-level cleanup (ViewBot/Recording/VisualFx) BEFORE the
 *      `pkill -TERM ffmpeg` safety net — services with stop() get a
 *      clean exit; the safety net catches strays.
 *   4. MediaSoup `cleanupAll()` AFTER stream-level cleanup so the SFU
 *      doesn't tear down transports under live producers.
 *   5. Redis `quit()` LATE in the sequence — services may consult Redis
 *      during their stop() (currently none do, but the ordering keeps
 *      the option open).
 *   6. `server.close()` LAST — once it returns, the process exits.
 *
 * Risk surfaces flagged in the closure audit:
 *   - `simpleMediaStreamService` is referenced via a
 *     `typeof X !== 'undefined'` guard (pre-existing pattern — that
 *     service may or may not exist depending on env / feature flags).
 *     Preserved verbatim here.
 *   - `global.viewBotURLService` / `global.unifiedViewBotRotation` /
 *     `global.viewBotManager` are read from the global namespace
 *     (assigned inside `bootstrap/start-streaming-backend.js`). They
 *     may be unset if shutdown fires before `startServer()` completes.
 */

const logger = require('./logger').child({ svc: 'shutdown' });

function registerShutdownHandlers(deps) {
    const {
        stoppables,
        io,
        server,
        getRedisClient,
        getMediasoupService,
        getViewbotService,
        getViewBotClientService,
        getRecordingService,
        getVisualFxService,
        getTimeTrackingService,
        getResourceMonitor,
        getSessionService,
        getSimpleMediaStreamService,
    } = deps;

    async function shutdown(signal) {
        logger.info(`🛑 Received ${signal}, shutting down server gracefully...`);

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
            // not yet wrapped (ffmpeg children on RecordingService.activeRecordings,
            // etc.). A follow-up PR can prune entries that overlap with stoppables
            // once the iterator is proven.
            logger.info('🎬 Stopping all media streams...');

            const viewBotClientService = getViewBotClientService();
            if (viewBotClientService) {
                logger.info('   Cleaning up ViewBot Client Service...');
                await viewBotClientService.cleanup();
            }

            const viewbotService = getViewbotService();
            if (viewbotService) {
                logger.info('   Stopping main Viewbot service...');
                if (viewbotService.viewbotProcess && !viewbotService.viewbotProcess.killed) {
                    logger.info('   - Killing Viewbot FFmpeg process');
                    viewbotService.viewbotProcess.kill('SIGTERM');
                }
                // Always cleanup to ensure WebRTC service is stopped
                await viewbotService.cleanup();
            }

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

            const recordingService = getRecordingService();
            if (recordingService && recordingService.activeRecordings) {
                logger.info('   Stopping Recording Service FFmpeg processes...');
                for (const [id, recording] of recordingService.activeRecordings) {
                    if (recording.ffmpegProcess && !recording.ffmpegProcess.killed) {
                        logger.info(`   - Stopping recording ${id}`);
                        recording.ffmpegProcess.kill('SIGTERM');
                    }
                }
            }

            const visualFxService = getVisualFxService();
            if (visualFxService && visualFxService.activePipelines) {
                logger.info('   Stopping Visual FX pipelines...');
                for (const [id, pipeline] of visualFxService.activePipelines) {
                    if (pipeline.ffmpegProcess && !pipeline.ffmpegProcess.killed) {
                        logger.info(`   - Stopping visual FX pipeline ${id}`);
                        pipeline.ffmpegProcess.kill('SIGTERM');
                    }
                }
            }

            // Safety-net pkill for any strays
            logger.info('🔍 Checking for any remaining media processes...');
            const { exec } = require('child_process');

            if (process.platform === 'win32') {
                exec('taskkill /F /IM ffmpeg.exe 2>nul', (err) => {
                    if (!err) logger.info('   - Killed remaining FFmpeg processes');
                });
                exec('taskkill /F /IM gst-launch-1.0.exe 2>nul', (err) => {
                    if (!err) logger.info('   - Killed remaining GStreamer (gst-launch-1.0) processes');
                });
                exec('taskkill /F /IM gst-launch.exe 2>nul', (err) => {
                    if (!err) logger.info('   - Killed remaining GStreamer (gst-launch) processes');
                });
                exec('taskkill /F /IM gst-play-1.0.exe 2>nul', () => {});
                exec('taskkill /F /IM gst-inspect-1.0.exe 2>nul', () => {});
                exec('wmic process where "CommandLine like \'%gstreamer%\'" delete 2>nul', (err) => {
                    if (!err) logger.info('   - Killed processes with gstreamer in command line');
                });
                exec('taskkill /F /IM chrome.exe /FI "COMMANDLINE like *puppeteer*" 2>nul', (err) => {
                    if (!err) logger.info('   - Killed Puppeteer Chrome processes');
                });
                exec('taskkill /F /IM chromium.exe /FI "COMMANDLINE like *puppeteer*" 2>nul', () => {});
            } else {
                exec('pkill -TERM ffmpeg 2>/dev/null', (err) => {
                    if (!err) logger.info('   - Killed remaining FFmpeg processes');
                });
                exec('pkill -TERM gst-launch 2>/dev/null', (err) => {
                    if (!err) logger.info('   - Killed remaining GStreamer processes');
                });
                exec('pkill -f "gst-launch-1.0" 2>/dev/null', () => {});
                exec('pkill -f "gstreamer" 2>/dev/null', () => {});
                exec('pkill -f "puppeteer.*chrome" 2>/dev/null', (err) => {
                    if (!err) logger.info('   - Killed Puppeteer Chrome processes');
                });
                exec('pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox" 2>/dev/null', () => {});
            }

            await new Promise((resolve) => setTimeout(resolve, 500));

            // 3. Clean up MediaSoup resources
            logger.info('🧹 Cleaning up MediaSoup resources...');
            const mediasoupService = getMediasoupService();
            if (mediasoupService) {
                mediasoupService.cleanupAll();
            }

            // 3.5. Clean up WebRTC ViewBot systems
            logger.info('🧹 Cleaning up ViewBot systems...');
            if (global.unifiedViewBotRotation) {
                await global.unifiedViewBotRotation.shutdown();
            }
            if (global.viewBotManager) {
                await global.viewBotManager.cleanup();
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

            // 8. Close the HTTP server
            logger.info('🌐 Closing HTTP server...');
            await new Promise((resolve) => {
                server.close(resolve);
            });

            logger.info('✅ Graceful shutdown complete');
            process.exit(0);
        } catch (error) {
            logger.error({ err: error }, '❌ Error during shutdown');
            process.exit(1);
        }
    }

    function cleanupMediaProcesses() {
        const { execSync } = require('child_process');
        try {
            if (process.platform === 'win32') {
                execSync('taskkill /F /IM ffmpeg.exe 2>nul', { stdio: 'ignore' });
                execSync('taskkill /F /IM gst-launch-1.0.exe 2>nul', { stdio: 'ignore' });
                execSync('taskkill /F /IM gst-launch.exe 2>nul', { stdio: 'ignore' });
            } else {
                execSync('pkill -9 ffmpeg 2>/dev/null', { stdio: 'ignore' });
                execSync('pkill -9 gst-launch 2>/dev/null', { stdio: 'ignore' });
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
