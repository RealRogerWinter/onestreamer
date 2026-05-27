const { execSync } = require('child_process');
const fs = require('fs');

const logger = require('../bootstrap/logger').child({ svc: 'ProcessManager' });
/**
 * Centralized Process Manager for ViewBot GStreamer processes
 *
 * Tracks PIDs spawned by ViewBot services and provides:
 *   - per-bot kill paths (`killBotProcesses`, `prepareForStreaming`,
 *     `onBotStopped`) for steady-state lifecycle, AND
 *   - PR 8.3 (Phase 8): a shutdown-time `reapAll()` / `stop()` path that
 *     sends SIGTERM, waits a grace period, then SIGKILL to anything still
 *     alive. Registered as a stoppable in `server/bootstrap/services.js`
 *     so the shutdown loop reaps any straggler PIDs after the per-service
 *     `stop()` calls have run their own cleanup. See ADR-0011 for the
 *     lifecycle contract and the PID-reuse / mid-write trade-offs.
 */
class ProcessManager {
  constructor() {
    // Map of botId -> { [type]: { pid, comm } }
    // comm is captured at register time so reapAll can refuse to SIGKILL
    // a PID that has been recycled by the kernel for an unrelated process.
    this.activeProcesses = new Map();

    // Single streaming bot tracking
    this.currentStreamingBot = null;

    // Lock to prevent concurrent operations
    this.operationLock = false;

    logger.debug('🔧 ProcessManager: Initialized centralized process management');
  }

  /**
   * Register a process for a bot. Captures the current /proc/<pid>/comm
   * snapshot so reapAll can detect PID reuse before SIGKILLing.
   */
  registerProcess(botId, type, pid) {
    if (!this.activeProcesses.has(botId)) {
      this.activeProcesses.set(botId, {});
    }

    const processes = this.activeProcesses.get(botId);
    processes[type] = { pid, comm: this._readComm(pid) };

    logger.debug(`📝 ProcessManager: Registered ${type} process ${pid} for bot ${botId}`);
  }


  /**
   * Kill ALL processes for a specific bot (steady-state per-bot cleanup,
   * not shutdown). Uses process-group kill via SIGKILL to bring down
   * gst-launch + any of its children together.
   */
  async killBotProcesses(botId) {
    const processes = this.activeProcesses.get(botId);
    if (!processes) {
      logger.debug(`⚠️ ProcessManager: No processes registered for bot ${botId}`);
      return;
    }

    logger.debug(`🔫 ProcessManager: Killing all processes for bot ${botId}`);

    for (const [type, entry] of Object.entries(processes)) {
      // entry may be the legacy bare-number shape OR the new { pid, comm }
      // shape — tolerate both so a stale serialization or an old caller
      // doesn't blow up.
      const pid = (entry && typeof entry === 'object') ? entry.pid : entry;
      if (pid) {
        try {
          // Use process group kill on Linux
          logger.debug(`   Killing ${type} process group -${pid}`);
          execSync(`kill -9 -${pid}`, { stdio: 'ignore' });
        } catch (error) {
          // Process might already be dead
          logger.debug(`   Process ${pid} already terminated`);
        }
      }
    }

    // Remove from tracking
    this.activeProcesses.delete(botId);
  }

  /**
   * Kill ALL GStreamer processes system-wide (nuclear option)
   */
  async killAllGStreamerProcesses() {
    logger.debug('☢️ ProcessManager: NUCLEAR CLEANUP - Killing ALL GStreamer processes');

    try {
      // Kill all gst-launch processes
      execSync("pkill -9 -f gst-launch", { stdio: 'ignore' });
    } catch (error) {
      // No processes to kill
    }

    // Clear all tracking
    this.activeProcesses.clear();
    this.currentStreamingBot = null;
  }

  /**
   * Ensure only one bot can stream at a time
   */
  async prepareForStreaming(botId) {
    // Wait if another operation is in progress
    while (this.operationLock) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.operationLock = true;

    try {
      logger.debug(`🎬 ProcessManager: Preparing for bot ${botId} to stream`);

      // If another bot is streaming, kill it first
      if (this.currentStreamingBot && this.currentStreamingBot !== botId) {
        logger.debug(`⚠️ ProcessManager: Bot ${this.currentStreamingBot} is currently streaming, killing it first`);
        await this.killBotProcesses(this.currentStreamingBot);
      }

      // Kill any existing processes for this bot (in case of duplicates)
      await this.killBotProcesses(botId);

      // Nuclear option: Kill ALL GStreamer processes to ensure clean state
      await this.killAllGStreamerProcesses();

      // Set as current streaming bot
      this.currentStreamingBot = botId;

      logger.debug(`✅ ProcessManager: Bot ${botId} is now clear to stream`);
    } finally {
      this.operationLock = false;
    }
  }

  /**
   * Clean up after a bot stops streaming
   */
  async onBotStopped(botId) {
    logger.debug(`🛑 ProcessManager: Bot ${botId} stopped streaming`);

    // Kill any remaining processes
    await this.killBotProcesses(botId);

    // Clear current if it matches
    if (this.currentStreamingBot === botId) {
      this.currentStreamingBot = null;
    }
  }

  /**
   * Get current process count for monitoring
   */
  getProcessCount() {
    let count = 0;
    for (const processes of this.activeProcesses.values()) {
      count += Object.keys(processes).length;
    }
    return count;
  }

  /**
   * Get detailed process info
   */
  getProcessInfo() {
    const info = {
      currentStreamingBot: this.currentStreamingBot,
      totalProcesses: this.getProcessCount(),
      bots: {}
    };

    for (const [botId, processes] of this.activeProcesses.entries()) {
      info.bots[botId] = processes;
    }

    return info;
  }

  // ====================================================================
  // PR 8.3 (Phase 8) — shutdown-time force-reap
  // ====================================================================

  /**
   * Read /proc/<pid>/comm so the reaper can refuse to SIGKILL a PID
   * that has been reused by the kernel for an unrelated process.
   * Linux-only; returns null on read failure (including non-Linux hosts
   * where /proc doesn't exist, in which case the reaper falls back to
   * "send SIGKILL anyway, the trade-off is documented in ADR-0011").
   */
  _readComm(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch (_err) {
      return null;
    }
  }

  /**
   * Best-effort PID-alive probe via `kill(pid, 0)` — signal 0 doesn't
   * actually signal but throws ESRCH if the PID doesn't exist or EPERM
   * if it exists but we can't signal it (treated as alive for safety).
   */
  _isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = no such process; EPERM = exists but not signallable.
      // Treat EPERM as alive so we don't accidentally orphan it.
      return err && err.code === 'EPERM';
    }
  }

  /**
   * Send `signal` to `pid` via process-group kill (negative PID). Falls
   * back to direct PID kill if the group kill fails (process may not
   * have been a session/process-group leader). Errors are swallowed —
   * a "kill what we can" semantics is what the reaper wants.
   */
  _sendSignal(pid, signal) {
    try {
      execSync(`kill -${signal} -${pid}`, { stdio: 'ignore' });
      return;
    } catch (_groupErr) {
      // Fall through to direct PID kill.
    }
    try {
      execSync(`kill -${signal} ${pid}`, { stdio: 'ignore' });
    } catch (_pidErr) {
      // Already dead, or PID reused into a process we can't signal.
    }
  }

  /**
   * PR 8.3 — shutdown force-reap.
   *
   * For each tracked PID:
   *   1. Skip if already dead at entry.
   *   2. Send SIGTERM (via process-group kill) and wait up to graceMs
   *      for natural exit (polled every 100 ms via kill(pid, 0)).
   *   3. If still alive, verify /proc/<pid>/comm still matches the
   *      snapshot taken at register time — refuse to SIGKILL if it
   *      drifted (PID was recycled into something unrelated).
   *   4. Send SIGKILL.
   *
   * The registry is cleared at the end so subsequent calls are no-ops.
   * Returns a summary suitable for the shutdown log.
   *
   * The `deps` parameter exists for testability — production calls
   * `reapAll()` with no args. Tests inject a fake `now`, `sleep`,
   * `isAlive`, `sendSignal`, and `readComm`.
   */
  async reapAll({ graceMs = 2000, ...deps } = {}) {
    // PR 8.3 (review fix): idempotency guard. If SIGTERM + SIGINT arrive
    // back-to-back, `shutdown()` can re-enter; without this guard, two
    // overlapping reapAlls race against the activeProcesses map and the
    // signals are sent twice. Node is single-threaded so this is more of
    // a correctness clarification than a real race — but the guard makes
    // the invariant explicit.
    if (this._reaping) {
      logger.debug('🧹 ProcessManager.reapAll: already in progress, skipping concurrent call');
      return { tracked: 0, alreadyDead: 0, gracefullyExited: 0, sigKilled: 0, pidReuseSkipped: 0, skipped: 'concurrent' };
    }
    this._reaping = true;
    try {
      return await this._reapAllImpl({ graceMs, ...deps });
    } finally {
      this._reaping = false;
    }
  }

  async _reapAllImpl({ graceMs, ...deps }) {
    const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const isAlive = deps.isAlive || ((pid) => this._isAlive(pid));
    const sendSignal = deps.sendSignal || ((pid, sig) => this._sendSignal(pid, sig));
    const readComm = deps.readComm || ((pid) => this._readComm(pid));
    const now = deps.now || (() => Date.now());

    const summary = { tracked: 0, alreadyDead: 0, gracefullyExited: 0, sigKilled: 0, pidReuseSkipped: 0 };

    const targets = [];
    for (const [botId, processes] of this.activeProcesses.entries()) {
      for (const [type, entry] of Object.entries(processes)) {
        const pid = (entry && typeof entry === 'object') ? entry.pid : entry;
        const comm = (entry && typeof entry === 'object') ? entry.comm : null;
        if (pid) {
          targets.push({ botId, type, pid, comm });
        }
      }
    }
    summary.tracked = targets.length;

    if (targets.length === 0) {
      logger.debug('🧹 ProcessManager.reapAll: nothing to reap');
      return summary;
    }

    logger.debug(`🧹 ProcessManager.reapAll: reaping ${targets.length} tracked PIDs (graceMs=${graceMs})`);

    // Phase 1: SIGTERM the live ones — with the same comm-snapshot
    // PID-reuse defense applied to BOTH signals (review feedback on PR 8.3).
    // A ghost entry (registered, exited naturally, PID recycled) would
    // otherwise eat an unconditional SIGTERM to an unrelated process; many
    // daemons treat SIGTERM as a clean-exit signal and would terminate.
    const stillAlive = [];
    for (const t of targets) {
      if (!isAlive(t.pid)) {
        summary.alreadyDead++;
        continue;
      }
      if (t.comm !== null) {
        const currentComm = readComm(t.pid);
        if (currentComm !== null && currentComm !== t.comm) {
          logger.warn(
            `🛡️ ProcessManager.reapAll: skipping SIGTERM of PID ${t.pid} (bot=${t.botId}, type=${t.type}) — comm drifted from '${t.comm}' to '${currentComm}', PID likely reused`
          );
          summary.pidReuseSkipped++;
          continue;
        }
      }
      sendSignal(t.pid, 'TERM');
      stillAlive.push(t);
    }

    // Phase 2: poll until grace expires or all dead.
    const deadline = now() + graceMs;
    while (stillAlive.length > 0 && now() < deadline) {
      await sleep(100);
      for (let i = stillAlive.length - 1; i >= 0; i--) {
        if (!isAlive(stillAlive[i].pid)) {
          summary.gracefullyExited++;
          stillAlive.splice(i, 1);
        }
      }
    }

    // Phase 3: SIGKILL anything still alive, with PID-reuse defense.
    for (const t of stillAlive) {
      if (!isAlive(t.pid)) {
        // Raced — exited between the last poll and now.
        summary.gracefullyExited++;
        continue;
      }
      // PID-reuse defense: if /proc/<pid>/comm no longer matches what we
      // captured at register time, the PID was recycled into an unrelated
      // process. Skip SIGKILL — better to leak a real orphan than to
      // SIGKILL an unrelated process.
      if (t.comm !== null) {
        const currentComm = readComm(t.pid);
        if (currentComm !== null && currentComm !== t.comm) {
          logger.warn(
            `🛡️ ProcessManager.reapAll: skipping SIGKILL of PID ${t.pid} (bot=${t.botId}, type=${t.type}) — comm drifted from '${t.comm}' to '${currentComm}', PID likely reused`
          );
          summary.pidReuseSkipped++;
          continue;
        }
      }
      sendSignal(t.pid, 'KILL');
      summary.sigKilled++;
    }

    // Clear the registry; further shutdown work shouldn't find ghosts.
    this.activeProcesses.clear();
    this.currentStreamingBot = null;

    logger.debug(
      `🧹 ProcessManager.reapAll: done — ${summary.gracefullyExited} graceful, ${summary.sigKilled} SIGKILLed, ${summary.alreadyDead} already-dead, ${summary.pidReuseSkipped} PID-reuse-skipped (of ${summary.tracked} tracked)`
    );
    return summary;
  }

  /**
   * PR 8.3 — stoppable contract entry point.
   *
   * Called by the shutdown loop in `server/index.js` via the stoppables
   * array (`server/bootstrap/services.js`). Per-bot stop() paths on the
   * ViewBot services run FIRST (because they appear LATER in the
   * stoppables array, which is iterated in reverse); by the time this
   * runs, the registry should be near-empty in the steady-state happy
   * path. The reaper exists to catch the case where a service died with
   * a registered PID still in the map — orphan-prevention.
   */
  async stop() {
    await this.reapAll();
  }
}

// Export singleton instance
module.exports = new ProcessManager();
