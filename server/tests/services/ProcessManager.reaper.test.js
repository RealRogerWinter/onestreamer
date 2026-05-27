/**
 * PR 8.3 (Phase 8) — shutdown-time force-reap of tracked viewbot PIDs.
 *
 * Tests the `reapAll()` / `stop()` methods added to ProcessManager. The
 * reaper sends SIGTERM, polls for natural exit during a grace period,
 * then SIGKILLs anything still alive — with a PID-reuse defense via
 * /proc/<pid>/comm snapshot comparison. See ADR-0011 (lifecycle
 * contract) for the design and rejected alternatives.
 *
 * Tests use `reapAll`'s deps-injection seam to avoid actually spawning
 * processes — `isAlive`, `sendSignal`, `readComm`, `sleep`, and `now`
 * are all stubbable. The production code path remains untested here on
 * purpose; the integration with real `process.kill(pid, 0)` is documented
 * and a smoke test in the PR description covers it manually.
 */

const path = require('path');

// Reset the require cache between tests so the singleton starts fresh.
function freshProcessManager() {
    jest.resetModules();
    return require('../../services/ProcessManager');
}

// Build a fake-process-table for the deps-injection seam.
function buildFakeWorld({ initiallyAlive, sigtermAfter = {}, commByPid = {} } = {}) {
    const aliveSet = new Set(initiallyAlive || []);
    const signalsSent = [];
    const sleepCalls = [];

    return {
        aliveSet,
        signalsSent,
        sleepCalls,

        // For now() — start at a fixed epoch so deadline math is readable.
        nowValue: 1_000_000,

        isAlive: (pid) => aliveSet.has(pid),

        sendSignal: (pid, signal) => {
            signalsSent.push({ pid, signal });
            if (signal === 'TERM') {
                // If a per-PID exit-after-N-ms is configured, schedule it.
                if (Object.prototype.hasOwnProperty.call(sigtermAfter, pid)) {
                    const after = sigtermAfter[pid];
                    if (after === 0) {
                        aliveSet.delete(pid);
                    } else {
                        // Mark it to die after a number of polls; the sleep
                        // hook below decrements this. We use a separate map.
                        sigtermAfter[pid] = after;
                    }
                }
            }
            if (signal === 'KILL') {
                aliveSet.delete(pid);
            }
        },

        readComm: (pid) => commByPid[pid] || null,

        // Sleep doesn't actually sleep — it advances the clock and runs
        // any "die-after-N-ms-of-sleep" hooks attached via sigtermAfter.
        sleep: (ms) => {
            sleepCalls.push(ms);
            // Decrement remaining time for each scheduled SIGTERM exit.
            for (const [pidStr, remaining] of Object.entries(sigtermAfter)) {
                const pid = Number(pidStr);
                const next = remaining - ms;
                if (next <= 0) {
                    aliveSet.delete(pid);
                    delete sigtermAfter[pidStr];
                } else {
                    sigtermAfter[pidStr] = next;
                }
            }
            return Promise.resolve();
        },
    };
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
});

describe('ProcessManager.reapAll — PR 8.3 (Phase 8, ADR-0011)', () => {
    it('returns early with empty registry when nothing is tracked', async () => {
        const pm = freshProcessManager();
        const world = buildFakeWorld({ initiallyAlive: [] });
        let elapsed = 0;
        const now = () => world.nowValue + elapsed;

        const summary = await pm.reapAll({
            graceMs: 2000,
            now,
            sleep: world.sleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
        });

        expect(summary).toEqual({
            tracked: 0,
            alreadyDead: 0,
            gracefullyExited: 0,
            sigKilled: 0,
            pidReuseSkipped: 0,
        });
        expect(world.signalsSent).toEqual([]);
    });

    it('skips PIDs that are already dead at entry (no SIGTERM, no SIGKILL)', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 9001);
        pm.registerProcess('bot-2', 'gstreamer', 9002);
        // Pretend 9001 already exited (dead) before reapAll starts.
        // 9002 dies immediately on SIGTERM (sigtermAfter: 0) so the
        // polling loop has no survivor to wait for.
        const world = buildFakeWorld({ initiallyAlive: [9002], sigtermAfter: { 9002: 0 } });
        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 500,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });

        // 9001 never got a signal (already dead at entry).
        expect(world.signalsSent.find((s) => s.pid === 9001)).toBeUndefined();
        // 9002 got SIGTERM; KILL is conditional on still-alive after grace.
        expect(world.signalsSent.find((s) => s.pid === 9002 && s.signal === 'TERM')).toBeDefined();
        expect(world.signalsSent.find((s) => s.pid === 9002 && s.signal === 'KILL')).toBeUndefined();
        expect(summary.alreadyDead).toBe(1);
    });

    it('SIGTERM followed by graceful exit within grace → no SIGKILL', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 12001);
        const world = buildFakeWorld({
            initiallyAlive: [12001],
            sigtermAfter: { 12001: 100 }, // dies after 100ms of polling
        });
        // Advance clock by ms accumulated in sleep calls so the polling
        // loop can drain naturally.
        let clock = 0;
        const now = () => clock;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 2000,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now,
        });

        expect(world.signalsSent).toContainEqual({ pid: 12001, signal: 'TERM' });
        expect(world.signalsSent.find((s) => s.pid === 12001 && s.signal === 'KILL')).toBeUndefined();
        expect(summary).toMatchObject({ tracked: 1, gracefullyExited: 1, sigKilled: 0 });
    });

    it('SIGKILLs PIDs still alive after grace period elapses', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 13001);
        // Process refuses to die on SIGTERM.
        const world = buildFakeWorld({ initiallyAlive: [13001] });
        let clock = 0;
        const now = () => clock;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 500,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now,
        });

        expect(world.signalsSent).toContainEqual({ pid: 13001, signal: 'TERM' });
        expect(world.signalsSent).toContainEqual({ pid: 13001, signal: 'KILL' });
        expect(summary).toMatchObject({ tracked: 1, sigKilled: 1, gracefullyExited: 0 });
    });

    it('PID-reuse defense: refuses BOTH SIGTERM and SIGKILL when /proc/<pid>/comm drifted (review fix)', async () => {
        // Review fix: SIGTERM is also gated by the comm check, because
        // many daemons treat SIGTERM as a clean-exit signal. An unconditional
        // SIGTERM to a recycled PID is just as harmful as SIGKILL.
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 14001);
        const entry = pm.activeProcesses.get('bot-1').gstreamer;
        entry.comm = 'gst-launch-1.0';

        const world = buildFakeWorld({ initiallyAlive: [14001] });
        // readComm at reap-time returns 'sshd' — drifted from 'gst-launch-1.0'.
        world.readComm = (_pid) => 'sshd';

        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 500,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });

        // NEITHER signal should reach the recycled PID.
        expect(world.signalsSent.find((s) => s.pid === 14001)).toBeUndefined();
        expect(summary).toMatchObject({ tracked: 1, sigKilled: 0, pidReuseSkipped: 1 });
    });

    it('PID-reuse defense: does NOT trip when comm matches', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 15001);
        const entry = pm.activeProcesses.get('bot-1').gstreamer;
        entry.comm = 'gst-launch-1.0';

        const world = buildFakeWorld({ initiallyAlive: [15001] });
        world.readComm = (_pid) => 'gst-launch-1.0';

        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 500,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });

        expect(world.signalsSent).toContainEqual({ pid: 15001, signal: 'KILL' });
        expect(summary.sigKilled).toBe(1);
        expect(summary.pidReuseSkipped).toBe(0);
    });

    it('clears the registry after reaping (subsequent reapAll is a no-op)', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 16001);
        const world = buildFakeWorld({ initiallyAlive: [16001] });
        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        await pm.reapAll({
            graceMs: 200,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });

        expect(pm.getProcessCount()).toBe(0);

        const secondSummary = await pm.reapAll({
            graceMs: 200,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });
        expect(secondSummary.tracked).toBe(0);
    });

    it('stop() delegates to reapAll() with default grace (2000 ms)', async () => {
        const pm = freshProcessManager();
        // Spy on _reapAllImpl (the inner impl) so we can read the resolved
        // graceMs that reapAll passes through after applying the default —
        // not just the public call shape. This catches "someone changed the
        // default in the signature" regressions.
        const spy = jest.spyOn(pm, '_reapAllImpl').mockResolvedValue({ tracked: 0 });
        await pm.stop();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].graceMs).toBe(2000);
        spy.mockRestore();
    });

    it('reapAll is idempotent under concurrent invocation (PR 8.3 review fix)', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'gstreamer', 20001);
        const world = buildFakeWorld({ initiallyAlive: [20001], sigtermAfter: { 20001: 200 } });
        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        // Fire two concurrent reapAlls. The second should detect the
        // in-flight first and bail out without sending duplicate signals.
        const [first, second] = await Promise.all([
            pm.reapAll({
                graceMs: 1000,
                sleep: wrappedSleep,
                isAlive: world.isAlive,
                sendSignal: world.sendSignal,
                readComm: world.readComm,
                now: () => clock,
            }),
            pm.reapAll({
                graceMs: 1000,
                sleep: wrappedSleep,
                isAlive: world.isAlive,
                sendSignal: world.sendSignal,
                readComm: world.readComm,
                now: () => clock,
            }),
        ]);

        const concurrent = [first, second].find((r) => r.skipped === 'concurrent');
        const main = [first, second].find((r) => r.skipped !== 'concurrent');
        expect(concurrent).toBeDefined();
        expect(main.tracked).toBe(1);
        // Exactly one SIGTERM emitted, not two.
        const termCount = world.signalsSent.filter((s) => s.signal === 'TERM').length;
        expect(termCount).toBe(1);
    });

    it('handles multiple PIDs per bot independently (video + audio)', async () => {
        const pm = freshProcessManager();
        pm.registerProcess('bot-A', 'video', 17001);
        pm.registerProcess('bot-A', 'audio', 17002);
        pm.registerProcess('bot-B', 'gstreamer', 17003);

        const world = buildFakeWorld({
            initiallyAlive: [17001, 17002, 17003],
            sigtermAfter: { 17001: 100, 17002: 100 }, // bot-A dies on SIGTERM
            // bot-B survives → SIGKILL.
        });
        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 500,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });

        expect(summary).toMatchObject({ tracked: 3, gracefullyExited: 2, sigKilled: 1 });
        expect(world.signalsSent).toContainEqual({ pid: 17001, signal: 'TERM' });
        expect(world.signalsSent).toContainEqual({ pid: 17002, signal: 'TERM' });
        expect(world.signalsSent).toContainEqual({ pid: 17003, signal: 'KILL' });
    });

    it('does not corrupt the registry mid-iteration if a target dies during the SIGTERM phase', async () => {
        // Synthetic: 18001 dies on SIGTERM immediately, 18002 dies during polling.
        const pm = freshProcessManager();
        pm.registerProcess('bot-1', 'video', 18001);
        pm.registerProcess('bot-1', 'audio', 18002);

        const world = buildFakeWorld({
            initiallyAlive: [18001, 18002],
            sigtermAfter: { 18001: 0, 18002: 200 },
        });
        let clock = 0;
        const wrappedSleep = (ms) => {
            clock += ms;
            return world.sleep(ms);
        };

        const summary = await pm.reapAll({
            graceMs: 1000,
            sleep: wrappedSleep,
            isAlive: world.isAlive,
            sendSignal: world.sendSignal,
            readComm: world.readComm,
            now: () => clock,
        });

        expect(summary.tracked).toBe(2);
        expect(summary.gracefullyExited).toBe(2);
        expect(summary.sigKilled).toBe(0);
    });
});

describe('ProcessManager.registerProcess — comm snapshot (PR 8.3)', () => {
    it('stores the PID + a /proc/<pid>/comm snapshot (null if read fails)', () => {
        const pm = freshProcessManager();
        // process.pid is the test runner itself — /proc/<self>/comm should
        // be readable on Linux. On non-Linux this returns null.
        pm.registerProcess('bot-self', 'test', process.pid);
        const entry = pm.activeProcesses.get('bot-self').test;
        expect(entry).toHaveProperty('pid', process.pid);
        expect(entry).toHaveProperty('comm');
        // On Linux: 'node' or 'jest'. On non-Linux: null. Both are
        // acceptable; we only assert the field exists.
        expect(entry.comm === null || typeof entry.comm === 'string').toBe(true);
    });
});

// PR 8.3 (review fix C3): exercise the PRODUCTION code path — no deps
// injection — against a real spawned child. This catches the class of
// bug the deps-injected tests miss: process-group kill failing because
// the child wasn't spawned detached; `_isAlive` misinterpreting signal
// errors; comm-read assumptions on this host.
describe('ProcessManager.reapAll — production code path integration (PR 8.3)', () => {
    const { spawn } = require('child_process');

    it('SIGKILLs a real spawned child that ignores SIGTERM', async () => {
        const pm = freshProcessManager();
        // node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
        // → ignores SIGTERM, forces the reaper into the SIGKILL branch.
        // detached:true so the child becomes its own process-group leader;
        // the reaper's negative-PID group kill needs this.
        const child = spawn(process.execPath, [
            '-e',
            'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
        ], {
            stdio: 'ignore',
            detached: true,
        });
        // Give Node a tick to actually start and register the SIGTERM handler.
        await new Promise((r) => setTimeout(r, 200));

        // Wait-for-exit promise BEFORE we reap; the assertion is "the child
        // actually exits", which is the only reliable signal that the
        // production code path (group kill via execSync) worked. Polling
        // `kill(pid, 0)` against a zombie returns alive=true until the
        // parent reaps it; the ChildProcess 'exit' event is the
        // authoritative shutdown signal.
        const exited = new Promise((resolve) => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
        });

        pm.registerProcess('integration-bot', 'sleeper', child.pid);
        const summary = await pm.reapAll({ graceMs: 300 });

        // Wait up to 2s for the child to actually exit (it should already
        // be SIGKILLed by the time reapAll returns).
        const exitInfo = await Promise.race([
            exited,
            new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit')), 2000)),
        ]);

        expect(summary.tracked).toBe(1);
        // Either SIGKILL fired (the expected branch) or the child
        // gracefully-exited (some hosts deliver SIGTERM before the
        // handler is registered). Both prove the reaper actually killed it.
        expect(summary.sigKilled + summary.gracefullyExited).toBe(1);
        // The child exited via signal (SIGTERM or SIGKILL), not natural exit.
        expect(exitInfo.signal === 'SIGKILL' || exitInfo.signal === 'SIGTERM').toBe(true);
    }, 8000);

    it('returns gracefully when registry contains an already-dead PID', async () => {
        // Pick a definitely-dead PID by spawning + waiting for exit.
        const pm = freshProcessManager();
        const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
        await new Promise((r) => child.on('exit', r));

        pm.registerProcess('dead-bot', 'noop', child.pid);

        const summary = await pm.reapAll({ graceMs: 50 });

        expect(summary.tracked).toBe(1);
        expect(summary.alreadyDead).toBe(1);
        expect(summary.sigKilled).toBe(0);
    }, 8000);
});

// PR 8.3 (review fix B3): scope invariant — ProcessManager.registerProcess
// is for ViewBot child processes ONLY. Recording-service ffmpeg PIDs must
// NEVER be registered (the shutdown reaper would SIGKILL them mid-write).
// This isn't a runtime check; it's a static safeguard against a future
// contributor copy-pasting the pattern into the wrong file.
describe('ProcessManager scope invariant (PR 8.3)', () => {
    const path = require('path');
    const { execSync } = require('child_process');

    it('no recording-service file calls processManager.registerProcess', () => {
        const repoRoot = path.resolve(__dirname, '../../..');
        // Grep across server/services/ for registerProcess calls. Filter to
        // anything matching /Recording|Clip/ in the path — those are
        // disk-write paths whose ffmpeg PIDs must stay out of the registry.
        let lines = '';
        try {
            lines = execSync(
                `grep -rn 'processManager\\.registerProcess\\|processManager.trackProcess' "${repoRoot}/server/services/" --include='*.js' || true`,
                { encoding: 'utf8' }
            );
        } catch (_err) {
            lines = '';
        }
        const offenders = lines
            .split('\n')
            .filter(Boolean)
            .filter((l) => /Recording|ClipProcessor|ClipService|Transcription/.test(l));
        expect(offenders).toEqual([]);
    });

    it('only ViewBot services register PIDs with the reaper', () => {
        const repoRoot = path.resolve(__dirname, '../../..');
        let lines = '';
        try {
            lines = execSync(
                `grep -rln 'processManager\\.registerProcess' "${repoRoot}/server/services/" --include='*.js' || true`,
                { encoding: 'utf8' }
            );
        } catch (_err) {
            lines = '';
        }
        const files = lines.split('\n').filter(Boolean);
        // Every caller's file name must contain 'ViewBot' (or the
        // ProcessManager itself, which doesn't actually call it).
        const offenders = files.filter((f) => !/ViewBot|ProcessManager\.js$/.test(f));
        expect(offenders).toEqual([]);
    });
});
