# `console.*` callsite inventory — pre-Phase-12 snapshot

> Companion to [ADR-0020](../adr/0020-namespaced-logging-with-pino.md). Sets the target list for the PR 12.2 / PR 12.3 sweep. Captured at PR 12.1 (commit on `main` immediately after merging PR 11.2 — `3f597b1`).

## Headline numbers

| Scope | `console.*` calls | Files |
| --- | --- | --- |
| `server/services/` | 3256 | 96 |
| `server/routes/` | 409 | 25 |
| `server/database/` | 44 | 2 |
| `server/bootstrap/` | 23 | 3 |
| `server/middleware/` | 18 | 2 |
| **Total (in-scope for sweep)** | **3750** | **128** |
| `scripts/` (out-of-scope per ADR-0020 §3) | 526 | n/a |

## PR 12.2 target — top 20 services (57% of all in-scope calls)

| Rank | File | Calls |
| --- | --- | --- |
| 1 | `server/services/viewbot/ViewBotInstance.js` | 369 |
| 2 | `server/services/ViewBotClientService.js` | 197 |
| 3 | `server/services/VisualFxService.js` | 163 |
| 4 | `server/services/ViewBotURLService.js` | 134 |
| 5 | `server/services/RandomStreamRotationService.js` | 108 |
| 6 | `server/services/ChatBotService.js` | 108 |
| 7 | `server/services/TranscriptionService.js` | 107 |
| 8 | `server/services/MediasoupService.js` | 107 |
| 9 | `server/services/CanvasFxService.js` | 89 |
| 10 | `server/services/ContinuousRecordingService.js` | 82 |
| 11 | `server/services/ViewBotLiveKitService.js` | 81 |
| 12 | `server/services/TakeoverService.js` | 74 |
| 13 | `server/services/RecordingService.js` | 72 |
| 14 | `server/services/ViewBotSocketClient.js` | 64 |
| 15 | `server/services/ItemUseService.js` | 62 |
| 16 | `server/services/TranscriptionAudioAdapter.js` | 61 |
| 17 | `server/services/BuffDebuffService.js` | 58 |
| 18 | `server/services/ViewbotService.js` | 54 |
| 19 | `server/services/ViewBotRotationService.js` | 49 |
| 20 | `server/services/AudioBufferService.js` | 47 |
| | **Subtotal (top 20)** | **2127** |

## PR 12.3 target — tail (~1623 calls across ~108 files)

Everything else under `server/{services,routes,bootstrap,middleware,database}` not listed above. Average density ~15 calls/file; long tail. The runner-up files (`server/routes/items.js` 51, `server/services/ChatBotLLMService.js` 43, `server/database/database.js` 43, `server/services/StreamInterceptorService.js` 42, `server/services/SoundFxService.js` 40, etc.) bucket here.

Also lands in PR 12.3:

* The `_traceId` propagation helper (`server/bootstrap/trace-context.js`, ~80 LoC).
* The chokepoint-notifier integration so every socket emit carries `_traceId`.
* The CI regression check (the `console.*`-grep invariant from ADR-0020 §"How to verify").

## Existing pino consumers (baseline for sweep)

Six server files import `bootstrap/logger.js`. Hybrid usage is mostly `console.*` even when the logger is in scope:

| File | `logger.*` calls | `console.*` calls |
| --- | --- | --- |
| `server/index.js` | 1 | 368 |
| `server/database/database-better.js` | 1 | 0 |
| `server/database/applyPragmas.js` | 1 | 0 |
| `server/database/transaction.js` | 0 | 0 |
| `server/database/database.js` | 6 | 43 |
| `server/routes/bug-reports.js` | 2 | 10 |

`database-better.js`, `applyPragmas.js`, `transaction.js` are clean adopters. `server/index.js`'s 1 vs 368 split is the canonical "logger imported but unused" pattern the sweep retires.

## Methodology

```bash
# In-scope total
grep -rE "console\.(log|info|warn|error|debug)" \
    server/services server/routes server/bootstrap server/middleware server/database \
    --include="*.js" | wc -l

# Top-N by density
grep -crE "console\.(log|info|warn|error|debug)" \
    server/services server/routes server/bootstrap server/middleware server/database \
    --include="*.js" | grep -v ":0$" | sort -t: -k2 -rn | head -20
```

Counted: `console.log`, `console.info`, `console.warn`, `console.error`, `console.debug`. Excluded: `console.group`, `console.time`, `console.table` (zero hits at snapshot time — re-grep before assuming the sweep covers them).

The numbers shift slightly as PR 12.2 / PR 12.3 progress — the inventory is a planning artifact, not a contract. Re-run the methodology block at the start of PR 12.2 against the merge-tip-of-main for a fresh snapshot before scoping the touch list.
