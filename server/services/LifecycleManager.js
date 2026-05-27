/**
 * LifecycleManager
 *
 * Centralised registry for deferred (one-shot) `setTimeout`-style work. Closes
 * the hazard documented in [`docs/architecture/background-work.md`][1] under
 * "Notable hazards / `setTimeout` chains in `server/index.js` startup": prior
 * to PR 4.2 the orchestrator scheduled autostart + grace-period work without
 * any per-handle reference, so a SIGTERM landing during the delay window
 * fired the deferred callback against torn-down service state.
 *
 * Scope is deliberately narrow:
 *   - Owns ONE-SHOT timers only. Recurring work (`setInterval`) is owned by
 *     each service via its own `stop()` method (Phase 1's lifecycle work).
 *   - Does NOT replace promise-based sleeps or `Promise.race` deadlines —
 *     those have their own teardown shape and weren't part of the hazard.
 *
 * Wired into `server/bootstrap/services.js` as a stoppable (no deps); SIGTERM
 * drains it through the existing `stoppables` reverse-iteration loop in
 * `server/index.js`'s shutdown handler.
 *
 * Each `schedule(name, fn, delayMs)` call:
 *   - Tags the work with a `name` for log/observability — every error from
 *     `fn()` lands with a `[Lifecycle] <name> threw after <delayMs>ms` line so
 *     production telemetry can attribute the failure.
 *   - Returns the underlying timer handle so a caller that wants to cancel
 *     proactively (e.g. a service that knows the work is now irrelevant) can,
 *     by calling `manager.cancel(handle)`. Callers that don't care can
 *     discard the return value — shutdown-time cleanup runs anyway.
 *   - Drops the call entirely if `stop()` has already run (returns `null`).
 *     Without that guard a service that schedules deferred work inside its
 *     own shutdown path would re-arm timers against a manager whose
 *     pending-set is being walked.
 *
 * The handler body wraps `fn()` in a try/catch so a single throw doesn't
 * leak into the runtime's unhandled-rejection path. The catch logs but
 * doesn't re-throw — symmetry with the existing inline pattern, where
 * every `setTimeout(async () => {...})` site already absorbed its own
 * exceptions in nested try/catch blocks.
 *
 * **Two windows, not one** (review feedback on PR 4.2):
 *   1. PRE-FIRE: `stop()` calls `clearTimeout` on every pending handle.
 *      A SIGTERM landing inside the delay window cancels the work — the
 *      headline hazard `background-work.md` named.
 *   2. POST-FIRE / MID-EXECUTION: once the timer has fired, `clearTimeout`
 *      is a no-op (Node can't unwind an in-flight callback). The wrapper
 *      tracks each running promise in `this.inFlight` and `stop()`
 *      `Promise.allSettled`s them before resolving, so the shutdown loop's
 *      5-second-per-service deadline bounds how long we wait for an
 *      in-flight fn to finish. Without this the original `async stop()`
 *      qualifier was misleading: it returned a resolved promise on the
 *      next microtask and the in-flight fn ran free against torn-down
 *      services. Now `stop()` actually waits.
 *
 * [1]: ../../docs/architecture/background-work.md
 */
class LifecycleManager {
  constructor() {
    this.pending = new Set();
    this.inFlight = new Set();
    this.stopped = false;
  }

  schedule(name, fn, delayMs) {
    if (typeof name !== 'string' || name.length === 0) {
      console.warn('[Lifecycle] schedule() called without a name; dropping');
      return null;
    }
    if (typeof fn !== 'function') {
      console.warn(`[Lifecycle] schedule(${name}) called without a function; dropping`);
      return null;
    }
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
      console.warn(`[Lifecycle] schedule(${name}) called with non-numeric / negative delayMs (${delayMs}); dropping`);
      return null;
    }
    if (this.stopped) {
      console.log(`[Lifecycle] ${name}: dropped (manager stopped)`);
      return null;
    }
    const handle = setTimeout(() => {
      this.pending.delete(handle);
      // Wrap the fn call in an IIFE so a synchronous throw or async
      // rejection both land in the same catch. The resulting promise is
      // tracked so `stop()` can await in-flight work.
      const promise = (async () => {
        try {
          await fn();
        } catch (e) {
          console.error(`[Lifecycle] ${name} threw after ${delayMs}ms:`, e);
        }
      })();
      this.inFlight.add(promise);
      promise.finally(() => this.inFlight.delete(promise));
    }, delayMs);
    this.pending.add(handle);
    return handle;
  }

  cancel(handle) {
    if (!handle) return false;
    if (!this.pending.has(handle)) return false;
    clearTimeout(handle);
    this.pending.delete(handle);
    return true;
  }

  async stop() {
    this.stopped = true;
    const cleared = this.pending.size;
    for (const handle of this.pending) {
      clearTimeout(handle);
    }
    this.pending.clear();
    if (cleared > 0) {
      console.log(`[Lifecycle] cleared ${cleared} pending task(s) on shutdown`);
    }
    // Wait for in-flight fn promises to settle before resolving. The
    // shutdown loop's 5-second `Promise.race` deadline bounds the total
    // wait; anything slower hits that ceiling and gets logged as a
    // stop() timeout, which is the right signal for a wedged background
    // task. allSettled (not all) because a throw inside a tracked fn
    // already lands in our own catch — we just need to wait for the
    // promise to resolve, not propagate.
    const inFlightCount = this.inFlight.size;
    if (inFlightCount > 0) {
      console.log(`[Lifecycle] awaiting ${inFlightCount} in-flight task(s) on shutdown`);
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

module.exports = LifecycleManager;
