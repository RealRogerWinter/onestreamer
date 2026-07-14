# ADR-0032: Descendant-scoped shutdown kill, Chrome-pkill deletion, and a shutdown watchdog

_Status: accepted_
_Date: 2026-07-14_

## Context

The 2026-07 audit (items B2 + B4, Plan 07) flagged the graceful-shutdown path
(`server/bootstrap/shutdown.js`) on two fronts:

**B4 — the kill safety nets were host/namespace-wide.** The normal shutdown
path ran `pkill -TERM ffmpeg`, `pkill -f "puppeteer.*chrome"` and
`pkill -f "chrome.*--no-sandbox.*--disable-setuid-sandbox"`; the crash path
(`cleanupMediaProcesses`, run from `uncaughtException`) ran `pkill -9 ffmpeg`.
On any shared PID namespace these SIGTERM/SIGKILL **every** matching process —
most damagingly the LiveKit egress recorder (headless Chrome + ffmpeg),
corrupting an in-progress recording on every restart/deploy.

Deployment-topology reality check (the audit demanded this verification):
since ADR-0025 the app runs as a Docker container with a **private PID
namespace** (`compose.yaml` explicitly forbids `pid: host`; `deploy.sh`
refuses `PidMode=host`), so in the deployed topology the pkills **cannot**
reach egress — the headline corruption is already mitigated by topology. But
they remain a live hazard for any bare-host run (`npm run dev` on a box also
running egress, or future `PidMode` drift), and in-container they still
indiscriminately killed every ffmpeg from all ~8 spawn sites at once.

A second reality check: this codebase spawns **no Chrome at all** — there is
no `puppeteer` dependency and no Chrome launch site anywhere in the tree. The
two Chrome pkills could only ever match *foreign* processes; they were pure
friendly-fire surface.

**B2 — shutdown could hang forever.** No watchdog, no re-entrancy guard
(SIGINT+SIGTERM back-to-back ran two overlapping drains), and on Node 18
`server.close()` never closes idle keep-alive connections (that is Node 19+
behavior) and never closes active ones — an nginx upstream keep-alive socket
could hold `close()` open indefinitely. In prod, docker then SIGKILLs at
`stop_grace_period: 20s` with a dirty exit; in dev it hangs forever.

## Decision

All in `server/bootstrap/shutdown.js` plus a small new helper:

1. **Delete the Chrome kills outright** — the two Linux pkills and the two
   win32 `taskkill … chrome/chromium` variants. No marker-scoped replacement:
   there is nothing of ours those lines could ever legitimately kill. (The
   audit doc's own alternative: "or drop the pkills entirely".)
   **Maintainer check requested:** confirm no *out-of-tree* operator tooling
   relied on the server sweeping stray Chrome on shutdown.
2. **Scope the ffmpeg kills to descendants.** New helper
   `server/bootstrap/process-tree.js`: parse `ps -eo pid=,ppid=,comm=`, BFS
   the child tree from `process.pid`, signal entries whose comm matches
   `ffmpeg` (tolerating the kernel's 15-char comm truncation; malformed `ps`
   output or a vanished PID produces no signals and no throw). The graceful
   path uses the async variant with SIGTERM; the crash path uses a sync
   (`execSync`) variant with SIGKILL. This catches direct children (all
   spawn sites) *and* grandchildren (e.g. an ffmpeg forked by streamlink),
   and never touches an unrelated ffmpeg.
3. **Watchdog**: an `unref()`'d `setTimeout` at the top of `shutdown()`
   force-exits with code 1 (and an error log) if the drain wedges. Default
   **15 s**, overridable via `SHUTDOWN_WATCHDOG_MS`. Sized deliberately
   *below* `compose.yaml`'s `stop_grace_period: 20s` — the audit's suggested
   30 s would be dead code in prod (docker SIGKILLs first). `compose.yaml`
   itself is untouched; whether to instead raise `stop_grace_period` and the
   watchdog together is left as a maintainer call.
4. **Re-entrancy guard**: a closure-scoped flag makes `shutdown()` run
   exactly once; later signals log and return.
5. **Connection teardown**: shutdown now accepts BOTH `httpServer` and
   `httpsServer` (the legacy `server` dep still works, deduped), closes each
   server with `.listening === true`, calls `closeAllConnections?.()` right
   after initiating `close()` (available since Node 18.2; optional-chained so
   older dev installs degrade to today's behavior), and resolves even on
   `ERR_SERVER_NOT_RUNNING`.

## Consequences

- A restart/deploy can no longer SIGTERM a co-located egress recorder's
  ffmpeg/Chrome on a bare-host run, and never nukes unrelated in-container
  ffmpeg mid-flight beyond the server's own children.
- **No stray-reaping is lost in prod**: in the container, node is **PID 1**
  (`Dockerfile` CMD runs `node server/index.js` directly), so an orphaned
  ffmpeg reparents to node itself and *remains a descendant* — the scoped
  sweep still catches it. A hard crash tears down the whole container and its
  PID namespace anyway.
- **Accepted dev-only leak**: on a bare host, ffmpeg orphaned by a *previous*
  crashed run reparents to init and is no longer reachable by the scoped
  sweep. Partially covered at runtime by `IngressJanitor`'s narrow
  pattern-scoped sweeps. Do **not** "re-fix" this with a host-wide pkill.
- Shutdown now always terminates: cleanly, or via watchdog exit-1 within
  ~15 s (visible in logs), rather than hanging or being SIGKILLed dirty at
  the docker grace boundary.
- `closeAllConnections()` hard-destroys in-flight HTTP responses — acceptable
  at shutdown, and only after `close()` has been initiated so graceful
  completion is attempted first.

## Alternatives considered

- **ProcessManager-registry teardown** (the audit's first suggestion):
  rejected for now — `registerProcess` has **zero callers** (the registry is
  always empty; the comment in `bootstrap/services.js` claiming ViewBot
  services register is stale), so building on it would silently do nothing.
  **Follow-up**: either wire registration into the ffmpeg spawn sites or
  remove the dead registry.
- **`-metadata` marker on every ffmpeg spawn + pattern pkill**: rejected —
  requires every one of ~8 spawn sites to add the marker forever (one miss
  trades the massacre for a leak), and cannot work for Chrome at all.
- **`pkill -TERM -P $PID ffmpeg`** (direct children only, zero new code):
  rejected — misses grandchildren (streamlink-forked ffmpeg); the tree helper
  is ~100 lines and unit-tested.
