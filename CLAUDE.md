# Notes for Claude (and other agents) working in this repo

This file is for AI/agent collaborators. Humans should start at [`README.md`](README.md).

## Orientation, in this order

1. [`README.md`](README.md) — what OneStreamer is, what it isn't, feature tour, known status.
2. [`docs/README.md`](docs/README.md) — audience-first index of every doc.
3. [`docs/architecture/overview.md`](docs/architecture/overview.md) — system shape, processes, ports.
4. [`docs/architecture/adr/`](docs/architecture/adr/) — design-decision history. **Read the ADR before proposing a structural change that contradicts one.**
5. [`docs/contributing/coding-conventions.md`](docs/contributing/coding-conventions.md) — code style + patterns to match.

## Conventions you must follow

- **Six markdown files belong at the repo root**: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `CLAUDE.md`. Everything else goes in `docs/`. If you're tempted to add another root `.md`, you're wrong — put it under `docs/`.
- **Write an ADR** when you make a non-trivial design decision. Template at [`docs/architecture/adr/README.md`](docs/architecture/adr/README.md). Number sequentially.
- **Write a runbook** when you debug a gnarly incident. Template at [`docs/operations/runbooks/README.md`](docs/operations/runbooks/README.md).
- **Update [`CHANGELOG.md`](CHANGELOG.md)** under "Unreleased" for any PR that ships user-visible change.
- **Tick the doc-update checkbox** in the PR template before merging. If your PR doesn't touch docs, justify in the PR body.
- **Don't commit runtime state.** The `.gitignore` lists what's already ignored; if you're tempted to commit a JSON file the app writes to, that's runtime state — gitignore it and ship a `.example` sibling.
- **Don't commit secrets in any form**, including history. If you accidentally do, escalate immediately — see [`SECURITY.md`](SECURITY.md).

## How to run things locally

- `npm run install-all` — installs root, client, chat-service deps. Run after cloning.
- `npm run dev` — main server (8443), chat service (8444), client dev server (3443). Most development uses this.
- `npm test` — root Jest suite (server-side).
- `cd client && npm test -- --watchAll=false` — client RTL suite.
- `npm run test:all` — both, sequentially.

Smoke-test path (after any change to streaming/takeover/chat/admin): walk through [`docs/getting-started/first-stream.md`](docs/getting-started/first-stream.md) end-to-end (signup → take over → broadcast → watch from a second browser → send chat → buy an item).

## Where things live (mental map)

- **Server core**: [`server/index.js`](server/index.js) — currently a 10K-line orchestrator. Routes mounted from [`server/routes/`](server/routes/), services in [`server/services/`](server/services/), middleware in [`server/middleware/`](server/middleware/). An active refactor is decomposing this; see open PRs for the latest state.
- **Chat microservice**: [`chat-service/`](chat-service/) — separate process, separate port (8444), HTTP callbacks to the main server.
- **Client**: [`client/src/`](client/src/) — React 19 + TypeScript. Components in `components/`, services in `services/`, hooks in `hooks/`, contexts in `contexts/`.
- **DB**: SQLite at `server/data/onestreamer.db`. Schema in [`server/database/`](server/database/). ~30 tables.
- **Real-time media**: MediaSoup SFU (primary), coturn (TURN/STUN), LiveKit (dormant — [ADR-0002](docs/architecture/adr/0002-mediasoup-primary-livekit-dormant.md)).

## What to avoid

- **Don't read `node_modules/`, `whisper.cpp/`, `whisper/`, `audio-buffers/`, `recordings/`, `logs/`, `clips/`** — large, generated, or build artifacts.
- **Don't propose dependency upgrades** unless asked — Dependabot handles those in its own PR stream.
- **Don't refactor adjacent code** while fixing a specific bug — keep PR scope tight. Open a separate PR for cleanup.
- **Don't bypass `authenticateToken` / `authenticateAdmin`** middleware on new admin/auth-gated endpoints. Both live in [`server/middleware/auth.js`](server/middleware/auth.js).
- **Don't add new root-level scripts** — they go in [`scripts/ops/`](scripts/ops/), [`scripts/deploy/`](scripts/deploy/), [`scripts/migrations/`](scripts/migrations/), or [`scripts/setup/`](scripts/setup/) depending on purpose.

## Reporting

When you finish a task, summarize in the PR description: what changed, what's verified, what's deferred. The maintainer reads PR descriptions, not transcripts.
