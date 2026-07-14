# Plan 03 — Data durability & disaster recovery

_Part of the [2026-07 codebase audit](README.md). Owner area: git/deploy topology, `docs/operations/backup-restore.md`, `.gitignore`, the SQLite DB at `server/data/onestreamer.db`._

> Status: **proposed**. This plan holds the two findings the audit rates **highest overall risk**: a single disk event on the production host currently loses **both** the only copy of the deployed source **and** up to three weeks of the money-flow database. Everything else in the audit is recoverable; this is not.

## The core exposure

The production host is a single point of failure with no off-host copy of either artifact:

- **Code exists only on this host.** `git remote` push is disabled (`.git/config:10` → `pushurl = DISABLED://do-not-push-dirty-history-use-a-fresh-clone`), and local `main` has diverged **473 commits ahead / 487 behind** `origin/main`. The deployed code is 6 weeks of history that lives nowhere else.
- **Backups are documentation-only.** `docs/operations/backup-restore.md` prescribes a script + cron, but neither is installed: `/usr/local/bin/onestreamer-backup.sh` does not exist, no crontab/`cron.d`/systemd-timer runs it, and the newest file in the backups dir is **3 weeks old** for a **2.4 GB** DB holding user accounts, points balances, and purchases.

Combined, one disk failure is an extinction event for the project.

## Confirmed findings

| # | Sev | Finding | Anchor |
|---|-----|---------|--------|
| D1 | **critical** | Deployed code exists only on this host; push disabled; local `main` diverged 473/487 from origin | `.git/config:10` |
| D2 | **critical** | Backup system is documentation-only — script + cron not installed; newest DB backup 3 weeks old (2.4 GB money DB) | `docs/operations/backup-restore.md:82` |
| D3 | high | Live LiveKit secret is an uncommitted edit to tracked config files; secret-bearing `.bak-*-rotate` files evade `.gitignore` — one `git commit -a` re-dirties history | `egress-config.yaml:4` |
| D4 | medium | `node_modules` + `chat-service/node_modules` committed as absolute-path symlinks (mode 120000) into `/root/onestreamer` — the tree goes dirty the moment `npm install` materializes a real dir, and a blanket `git add -A` then silently stages the *symlink deletion* into a commit (`.gitignore` prevents staging the contents) | `node_modules:1` |

## Remediation plan

### P0 — get a second copy of everything (hours, do first)

- **D1.a — Archive the repo off-host now.** `git bundle create onestreamer-full.bundle --all` and copy it off the box (and to durable object storage). One-command insurance against total loss while the reconciliation below is planned. Note the bundle captures **committed refs only** — the two uncommitted config edits (live secrets) and the node_modules symlink deletions are excluded (fine — no uncommitted source exists here; the DB is covered by D2.a).
- **D2.a — Install the nightly backup the doc already contains** (`sqlite3 .backup` + rsync/scp off-host + the `monitoring.md` "newest file in `/backups` older than 25h" alert). Add a **free-space precondition**: the local `.backup` needs ~2.4 GB free on the *same* disk before the off-host copy, and this host has the active recording disk-leak ([Plan 01](01-recording-and-clips-pipeline.md)) — a near-full disk would silently fail the backup exactly when durability matters. Fail loudly / alert if free space < DB size + margin. (Reliable backups therefore depend on the [Plan 01](01-recording-and-clips-pipeline.md) P0 disk reclaim.) _Continuous replication (Litestream) is an RPO upgrade — deferred to P2 with its own validation gate, not a same-day task._
- **D3 — Neutralize the leak-on-commit** (shared with [Plan 02](02-security-and-access-control.md) S4): `git rm --cached` the two config files, `.gitignore` them and `*.bak-*`/`*rotate*`, ship `.example` siblings, move rotation backups out of the tree, and **rotate the exposed LiveKit keys**.
- **D4.a — Defuse the node_modules symlinks now** (pulled forward from P1): `git rm --cached node_modules chat-service/node_modules` (a throwaway commit on the doomed local line is fine). Leaving them tracked keeps the `git add -A` accidental-commit footgun live for the entire D1.b deferral window, right next to the still-present secret-bearing config edits — the same class of accident D3 is being rushed to close.

### P1 — reconcile the two histories (days, careful)

- **D1.b — Deferred history reconciliation (bidirectional, not a one-way replay).** Local `main` is **both** 473 ahead **and** 487 behind `origin/main` — and origin is a *live PR-merge line* (HEAD references #321), not a scratch target. So this is a conflict-heavy **two-way merge**, not a clean cherry-pick, and "re-enable push" presupposes someone deliberately **rewrites and force-pushes `origin/main`** — an external step whose blast radius (breaks every existing clone, open PRs, and CI) must be owned and planned separately. **Prerequisite step: decide the canonical line** (prod-HEAD vs origin). Then, in a fresh clone of the agreed history, integrate the divergence, **scanning each commit for secrets that must not ride along** (the reason push was disabled), verify build + tests, swap prod to the fresh clone, and re-enable push. This is genuinely hard and risky — do it deliberately, never under time pressure; D1.a makes "lose everything" impossible first so this can proceed calmly.

### P2 — make DR routine (weeks)

- Document and **test a restore** from the off-host backup into a scratch environment (an untested backup is a hope, not a plan). Add it to the runbook set and schedule a periodic restore drill.
- Add a lightweight `git fsck` + "commits-ahead-of-origin" check to monitoring so history divergence can never silently grow to 473 again.

## Risks & red-team notes

- **The history rewrite is genuinely hard and risky** — that is why it was deferred. Do **not** attempt it under time pressure or as a side effect of another PR. D1.a (off-host bundle) de-risks the whole thing by making "lose everything" impossible first; the reconciliation can then proceed deliberately.
- **Litestream (P2) — the real risk is checkpoint contention, not WAL being disabled.** WAL is already force-enabled by the adapter (`database-better.js:54`) and active in prod (`.db-wal`/`.db-shm` present), so "validate WAL isn't disabled" chases a non-risk. The genuine hazard is that the ADR-0014 multi-handle topology + SQLite autocheckpoint can race Litestream's WAL-frame capture — a data-completeness risk. Test replication **and** restore under load before relying on it.
- **Do not delete the `.bak-*-rotate` files before confirming the current secrets are the live ones** — they are the rollback for the last rotation.

## Success criteria

Two independently-declarable milestones (so the durability win is not held hostage to the risky migration):

**Milestone A — durability achieved (P0/P2, the extinction-risk retirement):**
- An off-host `--all` bundle and a nightly DB backup both exist and are < 25h old, with a monitoring alert if they age out and a free-space precondition on the backup.
- A restore has been performed end-to-end into a scratch env and verified.
- `git status` is clean of secret-bearing files and the node_modules symlinks are untracked (D3 + D4.a).

**Milestone B — history reconciled (P1, tracked separately):**
- The canonical line is agreed, the two histories are integrated, and push is re-enabled against a reconciled `origin/main`.
