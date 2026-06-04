# ADR-0026: CircleCI build → test → approval → deploy pipeline

_Status: accepted_
_Date: 2026-06-04_

## Context

CI had never actually run on this repository — `.github/workflows/ci.yml`
existed but Actions was never wired up, so its suites and docs/secret guards had
never executed (standing this up surfaced 11 pre-existing failures, fixed in
PR #1). Deploys were manual (`scripts/deploy/start-production.sh` + PM2). With
the app now containerized (ADR-0025) we want one pipeline that builds, tests,
produces an immutable image, gates on a human, and deploys to the VPS.

## Decision

A CircleCI pipeline (`.circleci/config.yml`) replaces GitHub Actions:

```
build ─┬─ lint
       ├─ test-server-unit
       ├─ test-server-bettersqlite   (isolated process — see below)
       ├─ test-server-integration
       ├─ test-chat
       └─ test-client
                └─ docker-build (main) ─ hold (manual approval) ─ deploy (main)
```

- **build** installs root + chat + client deps (full native build scripts — the
  old `--ignore-scripts` is gone; it silently disabled the node-sqlite3 prod
  driver) and builds the client bundle with `CI=false` (CRA treats warnings as
  errors under `CI=true`); persists `node_modules` + `client/build` to the
  workspace.
- **lint** = client `tsc --noEmit` + `scripts/ci/docs-lint.sh`, the latter
  ported verbatim from the retired Actions job (6-root-md hygiene, no-stub docs,
  SendGrid-secret scan) so those invariants keep running.
- **tests** run as parallel jobs. `test-server-bettersqlite` is a **separate
  job (= separate process)** so node-sqlite3 is never loaded alongside
  better-sqlite3 — the two native SQLite bindings corrupt each other's error
  handling in one process (ADR-0014; jest.bettersqlite.config.js).
- **docker-build** (main only) builds the image, fails on CRITICAL CVEs (trivy),
  pushes to GHCR tagged by commit SHA, and captures the **immutable digest** as
  the deploy/rollback target. Building before the gate is deliberate — the
  approver signs off on the exact scanned artifact.
- **hold** is a `type: approval` job — the mandatory human gate before any VPS
  change.
- **deploy** (main, after approval) SSHes as a **least-privilege `deploy` user**
  (not root) and runs `scripts/deploy/deploy.sh`: `flock` (serialize against the
  single-writer WAL DB) → WAL-consistent `sqlite3 .backup` (disk preflight +
  retention) → ensure PM2 is gone → `docker pull` by digest → rsync client
  bundle + nginx reload → stop-old/start-new (private PID ns guard) → **verify
  dependency-touching signals** (LiveKit/Redis init log lines, not just the
  static `/health`) → rollback by previous digest on failure.

**"Smarter testing":** `jest-junit` + `store_test_results` feed CircleCI Test
Insights / flaky-test detection now (requires the org to use OAuth/`gh` slug).
Timings-based **test splitting** (`circleci tests split --split-by=timings`,
`parallelism > 1`) on the large server-unit suite is staged groundwork — it is a
follow-up gated on confirming a paid plan; v1 ships `parallelism: 1`, unsplit.

## Consequences

- Every change is built + tested + scanned; deploys are one-click-after-approval
  and roll back to an immutable digest.
- The pipeline is the first real execution of these suites and guards, so it is
  also the regression gate that PR #1 made green.
- Secrets stay out of CI: only a deploy SSH key + a push-only GHCR token live in
  the `onestreamer-deploy` context; app secrets never enter CI (tests use dummy
  values).
- Schema-changing releases cannot be image-rolled-back cleanly (ADR-0025); the
  approval step surfaces them and the runbook documents the snapshot-restore path.

## Alternatives considered

- **Keep GitHub Actions / run both** — rejected: Actions was never wired up here
  and CircleCI is the team's chosen system; the docs/secret guards were ported so
  nothing is lost.
- **Build on the VPS (no registry)** — rejected: couples build to prod and loses
  the immutable-digest rollback story. GHCR pull-by-digest is cleaner.
- **Deploy as root over SSH** — rejected: a leaked key would be full host root; a
  scoped `deploy` user (docker group + a small sudoers allowlist) bounds it.
- **Enable test splitting in v1** — deferred: it needs jest-junit timings history
  and a paid plan with parallelism; shipping unsplit first is correct and simpler.
