# `scripts/`

Operational tooling for OneStreamer. **Run all scripts from the repo root** (e.g. `node scripts/ops/make-admin.js alice`) — they resolve relative paths against the repo root.

## Layout

| Directory | Purpose | When to use |
|-----------|---------|-------------|
| [`setup/`](setup/) | One-time setup for a fresh checkout — bootstrapping the SQLite schema, downloading the Whisper model, seeding emojis. | First time you clone the repo or stand up a new instance. |
| [`ops/`](ops/) | Day-to-day operational tools against a running instance — promote an admin, recompute points, reset cooldowns. | Live ops on a deployed box. |
| [`deploy/`](deploy/) | Deployment helpers — production startup with PM2 + nginx + cert checks. | When deploying or recovering a production node. |
| [`migrations/`](migrations/) | Idempotent schema-evolution scripts (the historical `add-*.js` set). Safe to re-run; check for existing columns/tables before adding. | When bringing an older DB up to current schema on a fork. |

## Conventions

- **Database path.** SQLite scripts resolve `path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db')`. Run from the repo root or from any subdirectory — `__dirname` anchors them correctly.
- **No fallbacks for secrets.** Scripts use `process.env.*` directly. If a required env var is missing, they should fail-fast rather than fall back to a default.

## Adding a new script

1. Pick the directory by intent (`setup/`, `ops/`, `deploy/`, `migrations/`).
2. Anchor any filesystem paths to `__dirname` (not `process.cwd()`).
3. Add a header comment explaining the script's purpose, when to run it, and any prerequisites.
4. If it touches the database, make it idempotent.

See [`docs/contributing/coding-conventions.md`](../docs/contributing/coding-conventions.md) for the broader project conventions.
