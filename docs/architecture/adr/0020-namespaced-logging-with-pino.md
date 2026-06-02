# ADR-0020: Namespaced logging with pino

* **Status:** Accepted
* **Date:** 2026-05-27
* **Phase:** 12 (observability sweep)
* **PR:** 12.1 (`logging-convention-and-inventory`) — codification only; sweeps land in PR 12.2 / 12.3
* **Related:** [`server/bootstrap/logger.js`](../../../server/bootstrap/logger.js), [`docs/architecture/plans/console-callsite-inventory.md`](../../archive/plans/console-callsite-inventory.md)

## Context

At the close of Phase 11 the codebase has **3750 `console.*` callsites across 128 server-side files** (verified by `grep -rE "console\.(log|info|warn|error|debug)" server/{services,routes,bootstrap,middleware,database} --include="*.js"`), against a [`server/bootstrap/logger.js`](../../../server/bootstrap/logger.js) module that exposes a single shared [pino](https://github.com/pinojs/pino) logger but is imported by only **six** server files. Three of those six (`database-better.js`, `applyPragmas.js`, `transaction.js`) use the logger cleanly; the other three (`server/index.js`, `server/database/database.js`, `server/routes/bug-reports.js`) are hybrid — they imported the module at some point but >95 % of their log output still goes through `console.*`. The existing module's docstring acknowledges the state explicitly: *"The bulk of the codebase still uses `console.*` and migrates opportunistically — this module exists so new code (and any of the noisiest existing sites a refactor touches) has a structured target."*

Two consequences in production:

1. **No filterable structure.** Each log line is `process.stdout.write(util.format(...) + '\n')` — no level, no service tag, no timestamp shape we can index against. A "what did `ChatBotService` say in the last hour at warn-or-above" query is a `grep` against an unstructured stream that mixes 96 services' output.
2. **No correlation across layers.** When a socket emit goes wrong, the HTTP route that originated the work and the chokepoint notifier (Phase 3 — `StreamNotifier`, `ViewerCountNotifier`, `BuffNotifier`) that emitted it have no shared identifier. "What happened to this user's request?" requires reading the timestamps and guessing.

Phase 12 closes both. This ADR codifies the convention; PR 12.2 sweeps the top 20 services; PR 12.3 sweeps the tail and adds the trace-ID propagation.

## Decision

### 1. One pino child logger per service / route file, namespaced by `svc`

Every server-side module that emits log output owns a module-scoped child logger:

```js
const logger = require('../bootstrap/logger').child({ svc: 'ChatBotService' });
// then: logger.info(...), logger.warn(...), logger.error(...), etc.
```

The `svc` field is the **class name** for service modules and the **route family** for route modules (`auth`, `clips`, `admin-recordings`, etc.). The child name lives in the bindings so every line that logger emits carries `"svc":"ChatBotService"` in the JSON payload — Loki / ELK / Datadog can filter on it natively.

Child loggers are cheap (pino caches the bindings). Construct one at module scope per file; don't construct per-request unless the request has its own bindings to add (see §4 on `_traceId`).

### 2. Level conventions

| Level | Use for |
| --- | --- |
| `fatal` | Process is about to die. Bootstrap failures, unrecoverable schema mismatches. Rare. |
| `error` | A handled error: request/operation failed, but the service continues. Always include the `err` (use `logger.error({ err }, '...')` so pino serializes the stack). |
| `warn` | Suspicious state, degraded operation, retries succeeded after first-try failures, rate-limit hits. |
| `info` | Noteworthy lifecycle: service started, scheduled task ran, user-visible state transition (stream started/ended, takeover completed). |
| `debug` | Per-request / per-event details useful for production troubleshooting. Default-on in development, default-off in production. |
| `trace` | Reserved for very-noisy interior loops (per-frame, per-packet). Production-off. |

The level boundary that matters most operationally is **info ↔ debug**: info lines should be readable as a story of what the system did at a high level. If `tail -f` of production-info would dump tens of lines per second, the per-event ones belong at `debug`.

### 3. What stays on `console.*`

- **Migration scripts** under `scripts/migrations/` — CLI tools run with `node scripts/migrations/X.js`, not part of the long-running server, no shared logger context. The success criterion explicitly excludes them.
- **Other scripts** under `scripts/ops/`, `scripts/deploy/`, `scripts/setup/` — same rationale.
- **`server/bootstrap/logger.js` itself** — circular if the logger module logs through itself.
- **Nothing else.** Even early-boot files in `server/bootstrap/` can `require('./logger')` after the module loads.

### 4. `_traceId` propagation (target shape; lands in PR 12.3)

Every chokepoint notifier emit (StreamNotifier, ViewerCountNotifier, BuffNotifier, plus the ad-hoc emits that have not been routed through chokepoints yet) carries a `_traceId` field on the payload. The trace ID is generated at the **HTTP route entry** (express middleware) and propagated through the service call chain via async context (`AsyncLocalStorage`) so every `logger.X(...)` call inside that request scope picks up `traceId` as a binding automatically.

A production debugging session collapses to:

```bash
journalctl -u onestreamer --since '15 min ago' | grep '"traceId":"abc123"'
```

…and gets every line from the HTTP route through the service through the socket emit.

The propagation helper lands in PR 12.3 as `server/bootstrap/trace-context.js` (~80 LoC). PR 12.2 prepares the way by sweeping services to use the namespaced logger — once those services are calling `logger.X(...)` instead of `console.X(...)`, the AsyncLocalStorage layer can inject `traceId` into the bindings transparently and every existing log line gets the field for free.

## Consequences

* PR 12.2 has a concrete target list — the top 20 service files by `console.*` density (see [console-callsite-inventory.md](../../archive/plans/console-callsite-inventory.md)) cover ~57 % of all server-side callsites. Estimated touch: ~500 lines edited, ~2100 `console.*` calls converted.
* PR 12.3 sweeps the remaining ~1650 callsites across ~108 files (mostly low-density tail; average 15 calls/file) and adds the trace-ID helper + the chokepoint integration.
* No log-output schema change for now: production already gets raw JSON to stdout from anything that calls the pino logger. The fields gain `svc` (per child) and `traceId` (per scope) — both are additive.
* **What this ADR doesn't change**: log destination (still stdout), log format (still pino-JSON), log aggregator (operator's choice — Loki / ELK / Datadog all consume pino JSON natively), the `LOG_LEVEL` env-var override (still works as documented in [`server/bootstrap/logger.js`](../../../server/bootstrap/logger.js)).
* **What's deliberately deferred to a later phase**: log sampling (pino-supported but not needed at current volume), per-route timing middleware (a separate Phase 12.5 or Phase 13 candidate — it touches every route mounting and is its own design conversation), shipping logs to a vendor (operator's deployment decision, out of scope for this codebase).

## How to verify (post-PR-12.2 + 12.3)

Success criterion from the Phase 12 brief, restated as testable:

1. `grep -rE "console\.(log|info|warn|error|debug)" server/{services,routes,bootstrap,middleware,database} --include="*.js" | wc -l` → **0**, except (a) `server/bootstrap/logger.js` itself and (b) any deliberate retention documented in PR 12.3's CHANGELOG entry.
2. Every chokepoint notifier emit carries `_traceId` in the payload (asserted in the notifier tests post-PR-12.3).
3. A single grep against the pino output for a `traceId` returns every line from the originating HTTP route through the socket emit.

Inverse (regression-style) check, useful as a long-running CI invariant once Phase 12 closes: a `console.*` grep over server-side files with the two allowed exceptions whitelisted. If a future PR adds a stray `console.log`, CI catches it. The check itself doesn't land in PR 12.1 — it belongs in PR 12.3 once the sweep is complete.
