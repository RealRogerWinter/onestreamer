# Testing

_Last verified: 2026-05-23 after the PR-A→PR-R refactor series._

OneStreamer ships with growing test coverage — Phase 1-5 of the open-source refactor added Jest + Supertest tests alongside each new module. This page covers how to run what exists, what's gated by CI, and how to add new tests.

## What exists today

- **Server unit + integration tests** in [`server/tests/`](../../server/tests/), organized to mirror the source tree:
  - [`routes/`](../../server/tests/routes/) — Supertest against extracted route modules (tutorial, audio, …)
  - [`sockets/`](../../server/tests/sockets/) — socket-handler tests (AdminHandler, …)
  - [`services/`](../../server/tests/services/) — service-class tests (DrawingService, …)
  - [`bootstrap/`](../../server/tests/bootstrap/) — service-factory tests
  - [`database/repository/`](../../server/tests/database/repository/) — repository-class tests (UserRepository, …)
  - Top-level files (`StreamService.test.js`, etc.) for the pre-refactor services
- **Chat-service tests** at [`chat-service/tests/`](../../chat-service/tests/) — added in PR-K (claims/claimEventService).
- **Client component + hook tests** at:
  - `client/src/hooks/__tests__/*.test.tsx` — extracted hooks (useResponsiveLayout, useChatMessages, …)
  - `client/src/components/video/__tests__/*.test.tsx` — sub-components (VideoControls, …)
  - `client/src/components/*.test.tsx` — legacy colocated tests
- **Manual test notes** archived in [`/docs/archive/test-notes/`](../archive/test-notes/) — these are scratch procedures, not automated.

> [!NOTE]
> The README historically claimed "96.7% statement coverage across services." That figure is **no longer accurate** at the current code volume. Treat it as a goal, not a baseline.

## Running tests

### Server (jest)

```bash
cd /root/onestreamer
npm test                  # run server tests
npm run test:watch        # watch mode
```

The server's `package.json` defines `test: jest` against the project root.

### Client (react-scripts test)

```bash
cd /root/onestreamer/client
npm test                  # interactive watch mode
npm test -- --watchAll=false   # single run (useful in CI)
```

### Both at once

```bash
cd /root/onestreamer
npm run test:all          # runs server + client in sequence
```

### Smoke / integration

Smoke tests live in `scripts/ops/` (run against a live instance) and `scripts/setup/` (verify a fresh setup works). The historical ad-hoc `test-*.js`/`fix-*.js`/`check-*.js` collection at the repo root has been removed — it was hundreds of one-off scripts that predated this docs tree and had no CI integration.

If you write a new operator-invoked check, drop it under `scripts/ops/` and follow the conventions in [`scripts/README.md`](../../scripts/README.md).

## What CI runs

CI runs on **CircleCI** ([`.circleci/config.yml`](../../.circleci/config.yml), [ADR-0026](../architecture/adr/0026-circleci-pipeline.md)): `build → lint → test → docker-build → manual approval → deploy`. The test stage is parallel jobs:

- **lint** — client `tsc --noEmit` + `scripts/ci/docs-lint.sh` (root-md hygiene, no-stub docs, SendGrid-secret scan). There is no server ESLint config.
- **test-server-unit** — root jest (`config/jest/jest.config.js`).
- **test-server-bettersqlite** — the better-sqlite3 contract tests in their own process (`config/jest/jest.bettersqlite.config.js`) so node-sqlite3 never co-loads with better-sqlite3 (they corrupt each other in one process; ADR-0014 — better-sqlite3 is the production default since the Phase-C flip, and this job also boot-smokes the flag-unset default), plus jest.setup.js pins the ambient test driver to sqlite3 so the main config never loads the adapter.
- **test-server-integration** — `config/jest/jest.integration.config.js`.
- **test-chat** — `chat-service` jest.
- **test-client** — `tsc --noEmit` + react-scripts tests.

`jest-junit` + `store_test_results` feed CircleCI Test Insights / flaky-test detection. Timings-based test splitting (parallelism) on the server-unit suite is staged groundwork, gated on a paid plan (ADR-0026). The deploy job is gated by a manual approval. Failing CI blocks merges if branch protection is enabled (see [`branching-and-releases.md`](branching-and-releases.md)).

## How tests are organized

### Server

```
server/
└── tests/
    ├── bootstrap/
    │   └── services.test.js
    ├── database/
    │   └── repository/
    │       └── UserRepository.test.js
    ├── routes/
    │   ├── audio.test.js
    │   └── tutorial.test.js
    ├── sockets/
    │   └── AdminHandler.test.js
    ├── services/
    │   └── DrawingService.test.js
    ├── StreamService.test.js
    ├── TakeoverService.test.js
    └── TestStreamService.test.js
```

Convention: one test file per source module, mirroring the source path under `server/tests/`. Named `<ModuleName>.test.js`. Test files `require()` the source module directly and mock the database / external services at the boundary (see `UserRepository.test.js` for the `{ getAsync, runAsync, allAsync }` mock pattern established by PR-Q).

The pre-refactor top-level tests will gradually migrate under the new mirroring convention as their modules are touched.

### Client

```
client/src/
└── components/
    ├── StreamerSettings.tsx
    ├── StreamerSettings.test.tsx        ← colocated
    └── ...
```

Convention: colocated `*.test.tsx` files use `@testing-library/react`. Shared test utilities in [`client/src/test-utils/`](../../client/src/test-utils/).

## What to test

**Always test:**

- New service methods that handle money / points / privileges (auth, inventory mutations, admin actions). Subtle bugs here cause real user harm.
- Migration scripts before running them against production.
- Anything you debugged in a runbook — the test is the regression guard.

**Test if convenient:**

- New REST endpoints — happy path + one error path is usually enough.
- New socket event handlers — at least the "wrong payload shape" rejection.
- Pure utility functions — easy to test, high signal.

**Don't bother testing:**

- React component visual rendering. Snapshot tests in particular have low signal and rot fast.
- Third-party library wrappers (the library has its own tests).
- Throwaway scripts.

## Coverage philosophy

No coverage threshold is enforced. Adding coverage to a previously-untested area is a worthy PR on its own; adding tests alongside a feature is encouraged but not required.

What matters more than coverage percentage:

- **Critical-path tests exist** — auth, payments-shaped (point movements), admin actions, data migrations
- **Bug-fix PRs add a regression test** when the bug was non-trivial
- **CI catches obvious breakage** before merge

## Testing tools available

| Tool | Where | Use for |
|------|-------|---------|
| `jest` | server + client | Unit + integration tests |
| `@testing-library/react` | client | Component behavior tests |
| `@testing-library/user-event` | client | Simulating user input |
| `supertest` | server (in `devDependencies`) | HTTP route testing |
| Manual probes via `curl` | runbooks | Operational smoke-testing |

No `cypress` / `playwright` for end-to-end browser tests today. Could be a follow-up — would catch a class of regression that unit tests miss.

## Test the docs

Documentation has its own form of testing:

- **Verify Mermaid renders** on github.com (eye-check after a PR is open).
- **Verify internal links resolve** — `grep -rE '\]\([^)]+\)' docs/` plus mental check, or a markdown link-checker.
- **Re-run the [`first-stream.md`](../getting-started/first-stream.md) walkthrough quarterly** on a clean checkout — confirms `local-dev.md` is still accurate.

These aren't automated yet. Adding a doc-link-check to CI would be a cheap, useful follow-up.

## Pitfalls

- **Tests that hit the real database** — use a sandbox SQLite per test run, or mock at the service boundary. Tests that read/write `server/data/onestreamer.db` corrupt your dev state.
- **Tests that spawn real subprocesses** (ffmpeg, whisper.cpp, streamlink) — slow and flaky in CI. Mock the spawn or skip in CI.
- **Tests that depend on external services** (B2, SendGrid, Twitch) — mock the SDK boundary. Real network calls in tests are flaky.
- **Tests that depend on time** — use Jest's fake timers, never `await sleep(...)` for synchronization.

## See also

- [`coding-conventions.md`](coding-conventions.md) — style + file layout
- [`branching-and-releases.md`](branching-and-releases.md) — what CI blocks
- [`/.circleci/config.yml`](../../.circleci/config.yml) — current CI pipeline ([ADR-0026](../architecture/adr/0026-circleci-pipeline.md))
- [`/docs/getting-started/first-stream.md`](../getting-started/first-stream.md) — manual smoke test of the happy path
