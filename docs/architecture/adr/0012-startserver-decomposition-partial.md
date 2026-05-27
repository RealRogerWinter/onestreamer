# ADR-0012: Partial decomposition of `startServer()` in `server/index.js`

**Date**: 2026-05-27
**Status**: Accepted
**Phase**: 4 (`server/index.js` decomposition)
**PR**: 4.3 — third and last PR of Phase 4.

## Context

The orchestrator file `server/index.js` started Phase 4 at ~6.2K lines.
Phase 4's stated goal was to shrink it "small enough that the next refactor
phase (Phase 5 — better-sqlite3 adapter, atomic points updates) can start
without the surrounding orchestration noise."

PR 4.1 extracted the last 6 inline socket listeners (~196 lines).
PR 4.2 introduced `LifecycleManager` and relocated 7 `setTimeout` callsites
(net wash on line count — adds the manager, deletes 2 dev-debug timers).

That left `startServer()` as the biggest remaining concentration of mixed
concerns:

- ~500 lines of MediaSoup-vs-LiveKit branch orchestration (URL relay,
  whitelist enforcer, random rotation routes, viewbot rotation init).
- ~290 lines of Open Graph / Twitter Card / JSON-LD route handlers for
  `/blog/:slug` and `/clips/:clipId`. Pure Express middleware; no service
  touch except `clipService`.
- ~20 lines of HTTP / HTTPS `<server>.listen(port, host, cb)` boilerplate.
- A miscellany of express middleware (catch-all, auth-API skip rules) +
  cleanup intervals + ChatBot init.

A maximalist Phase 4 closeout would have decomposed every section into
its own module/phase. That is the right end-state but it's also a
multi-week refactor with high risk of byte-equivalence drift in the
MediaSoup/LiveKit branch — the duplicated-but-not-identical control flow
across the two backends has historically been a source of subtle bugs
(see PR 3.1's MediaSoup-suppression footnote).

## Decision

Pragmatic, narrow PR 4.3: extract the two highest-ROI, lowest-risk
sections and **explicitly defer** the biggest remaining chunk
(MediaSoup-vs-LiveKit branch) to a future PR with its own ADR. The
reviewer of the first PR draft pushed back that this is "scope reduction
dressed as pragmatism" — fair, and the framing is now explicit: Phase 4
closes with a known follow-up, not with the orchestrator at its
end-state size.

### Extracted

**`server/routes/social-embed.js`** — both Open Graph rewrite handlers.
- `/blog/:slug` (~145 lines): Strapi fetch → meta-tag rewrite → return.
- `/clips/:clipId` (~135 lines): clipService fetch → Open Graph + Twitter
  Card injection → return.
- Net 291 lines extracted from startServer().
- Module-scope helpers (`escapeHtml`, `fetchArticle`, `buildArticleImageUrl`,
  `renderBlogHtml`, `renderClipHtml`) dedupe the two **byte-identical**
  inline copies of `escapeHtml` (verified by diff against pre-PR
  `server/index.js:5379` and `:5523`) into one module function.
- Extraction is **behaviour-equivalent**, not byte-equivalent (review
  fix). Three concrete textual differences: (a) JSON-LD object literal
  rewritten from double-quoted-key to ES shorthand (wire output
  identical); (b) `imageUrl` selection restructured from
  `if/else if/else` mutation to an early-return helper; (c) an unused
  `const https = require('https')` at pre-PR `:5353` silently dropped.
- No tests in this PR. The inline originals had zero coverage; extracting
  doesn't add tests but the new module-scope helpers (`renderBlogHtml`,
  `renderClipHtml`) are now unit-testable in isolation. Adding tests is
  a clean follow-up and called out in the CHANGELOG.

**`server/bootstrap/start-listeners.js`** — HTTP + HTTPS `.listen()` block.
- ~20 lines extracted.
- The `httpServer.on('error', ...)` handler from the same neighbourhood is
  **deliberately left inline** in `server/index.js`: it's a long-lived
  runtime concern, not a startup concern. Moving it into the listener
  helper would imply ownership of the lifecycle.

### Deleted

The 5000-ms `setInterval(() => { /* commented log */ }, 5000)` "keep-alive"
timer at the bottom of startServer(). The body was a commented-out
`console.log`; the timer was no-op work that contributed to the
leaked-handle tally in `background-work.md`. Node doesn't need a
setInterval to stay alive — the listening sockets already keep the
process up. Same criteria as PR 4.2's two dev-debug `setTimeout`
deletions (no production value, ungated debug code).

### NOT extracted (deliberately deferred)

The MediaSoup-vs-LiveKit branch (~500 lines of mostly-but-not-quite-
identical orchestration) is the biggest remaining target. Decomposing it
correctly requires aligning the two branches against each other first
(deduping the diverged paths in `URL relay`, `WhitelistEnforcer` wiring,
`SimpleViewBotRotation.setLiveKitService`, etc.). That's a behaviour-
sensitive refactor that warrants its own ADR + reviewer. Phase 4 closes
without doing it.

`startServer()` after this PR is ~700 lines of its own function body
(measured by counting between the `async function startServer() {` line
and the closing `}`; the full `server/index.js` is 5703 lines because it
also has module-scope requires, helper functions, route mounts, and
event-loop handlers that aren't inside startServer). Down from ~960
lines at start of Phase 4. The two metrics are different and the ADR
should not have conflated them — review feedback fixed the wording.

The remaining content inside startServer() is reasonably topical: redis
bootstrap, the MediaSoup/LiveKit branch, ChatBot init, the social-embed
mount call, catch-all middleware, the LifecycleManager-driven
account-deletion scheduler, the listener helper call, and the error
handler. Each block is small enough that adding a Phase 5 DB migration
call into this file doesn't require navigating around hundreds of lines
of orchestration to find a spot.

## Consequences

### Positive

- **`server/index.js` is ~311 lines shorter**: 6014 → 5703. With PR 4.1's
  cut, total Phase 4 shrinkage is ~507 lines.
- **`/blog/:slug` and `/clips/:clipId` are testable in isolation**. The
  extracted module's `escapeHtml` / `fetchArticle` / `renderBlogHtml` /
  `renderClipHtml` helpers can be unit-tested without booting the full
  server. No tests are included in this PR (the inline originals had
  none and we're not introducing new behaviour), but the structural
  affordance is now there.
- **The `escapeHtml` duplicate is gone**. Two near-identical inline
  copies are now one module-level function.
- **Phase 5 setup work is unblocked.** The DB-internal code Phase 5 will
  touch (`AccountService.addPoints` race, better-sqlite3 adapter wiring)
  lives in `server/services/` and `server/database/`, not here — Phase 4
  was never about making Phase 5's DB diffs land cleanly (those weren't
  blocked by orchestrator size). What Phase 4 unblocks is the *bootstrap*
  side of Phase 5: if Phase 5 needs to add a new init call, register a
  new stoppable, or thread a new dep through service construction, it
  now lands in a less-crowded `server/index.js` next to topically-grouped
  blocks rather than buried inside an undifferentiated mass of
  setTimeouts and inline socket listeners. The brief's stated goal —
  "small enough that Phase 5 can start without the orchestration noise"
  — is satisfied for the *Phase 5 bootstrap work specifically*. The
  remaining 500-line MediaSoup/LiveKit branch is still noisy and is the
  honest scope-deferral acknowledged in the "NOT extracted" section.

### Negative / Trade-offs

- **The MediaSoup/LiveKit branch is still huge.** That work is real and
  unavoidable. Tagged as the headline target of a future "Phase 4
  follow-up" PR (probably worth its own short-lived plan doc rather than
  reopening Phase 4).
- **No tests for social-embed.js.** The two route handlers had zero
  test coverage inline; extracting them doesn't add tests, but it does
  make adding tests easy in a follow-up. Honest about this in the
  CHANGELOG entry.
- **`mountSocialEmbedRoutes(app, deps)` signature is different from
  the existing route modules**: most under `server/routes/` are
  `module.exports = function(serviceInstance) -> router`. This one
  takes the app directly because the blog/clip handlers register two
  GET handlers on specific paths rather than mounting a sub-router.
  Both shapes are valid Express patterns; the new one matches the
  blog/clip handlers' "intercept GET on this path, fall through to
  static otherwise" semantic better than a sub-router would.

## Alternatives considered

### A. Full startServer() decomposition into 8+ phase modules

`createInfra()` / `setupMediaSoup()` / `setupLiveKit()` /
`mountRoutes()` / `startBots()` / `startListeners()` etc. with an
orchestrator at the top that just sequences them.

Rejected for this PR because the MediaSoup-vs-LiveKit branch requires
aligning the two paths first (currently they diverge in 6+ places that
look identical but aren't). That alignment is its own multi-PR effort.
Forcing it into Phase 4 risks behaviour drift on a hot path (URL relay)
that already has subtle suppression footnotes (see PR 3.1's MediaSoup
branch comment).

### B. Extract the MediaSoup/LiveKit branch as-is into two helper modules

Without first aligning the branches, the result is two ~250-line modules
that are 90% identical but diverge in non-obvious ways. The structural
duplication moves to a new file rather than being fixed. Rejected.

### C. Stop at social-embed extraction, skip the listener helper

The listener helper is small (~20 lines extracted). It's a real but
modest win. Including it keeps PR 4.3 cohesive ("decompose startup
concerns out of startServer()") rather than scoped to just the
biggest extraction.

## Phase 4 close-out status

After this PR:
- PR 4.1 ✓ — listeners extracted
- PR 4.2 ✓ — LifecycleManager + 7 setTimeouts relocated + 2 dev-debug
  deleted
- PR 4.3 ✓ — social-embed + listener helper extracted + 1 dead setInterval
  deleted

`server/index.js`: 6014 → 5703 lines net across Phase 4 (~5% shrinkage
plus structural cleanups).

Outstanding Phase 4 follow-ups (not blocking Phase 5):
1. **MediaSoup-vs-LiveKit branch alignment + extraction** — the biggest
   remaining concentration.
2. **`notifyViewersStreamStarted` / `notifyViewersStreamEnded` closures
   relocation** — these two closures (currently `server/index.js:4038`
   and `:4068`; line numbers will drift as the file evolves) are used by
   both the extracted handlers (DisconnectHandler.js, StreamHandler.js,
   MediaSoupHandler.js) — threaded through deps — and the inline emit
   site for stream-ended-for-viewing. Now that the handler consumers
   are external, the closures could move to a module — but the threading
   pattern still works as-is.
3. **`enrichStreamStatus` / `getStreamerDisplayName` / `broadcastGlobalCooldown`**
   are similar closures that could move out.

These are nice-to-haves, not Phase-4 blockers.

## References

- [`docs/architecture/background-work.md`](../background-work.md) — the
  lifecycle hazard catalog Phase 4 was named after.
- ADR-0011 — LifecycleManager (PR 4.2).
- PR 4.1 in CHANGELOG.md — listener sweep that opened the path for this
  pragmatic close-out.
