# Changelog

All notable changes to OneStreamer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Documentation overhaul.** Comprehensive `/docs/` tree organized by audience (getting-started, operations, features, architecture, integrations, api, contributing, security, archive). 70 markdown files covering the full system: feature flows, architecture, ADRs, runbooks, integration references, API endpoints, socket events, contributing conventions, and security policies.
- New root README — feature tour, quick-start, Mermaid system diagram, documentation map, tech stack, honest status notes.
- 6 Architecture Decision Records (ADRs) documenting major design choices: ADRs for the use of ADRs, MediaSoup-as-primary / LiveKit-dormant rationale, the Sept-2025 LiveKit dual-stack rollback, chat-as-separate-microservice rationale, Backblaze B2 over direct AWS S3, and whisper.cpp over cloud STT.
- 7 Mermaid diagrams: system architecture, streaming-stack data flow (×3), data-model ER, deployment topology, stream-takeover sequence, plus 7 auth-flow sequence diagrams in `/docs/security/auth-flows.md`.
- Five operations runbooks: stream-stuck, livekit-disconnect, recording-upload-failed, viewbot-fleet-misbehaving, secret-rotation.
- `CONTRIBUTING.md`, `SECURITY.md`, this changelog, `CODEOWNERS`.
- `.github/` templates: issue templates (bug, feature), pull request template (with doc-update checkbox), CI workflow, Dependabot config.

### Changed
- 22 evergreen `.md` files migrated from repo root into `/docs/` (e.g. `ADMIN_PANEL.md` → `docs/features/admin-panel.md`).
- Repo root cleaned up: only `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `CLAUDE.md` allowed going forward.

### Archived (not removed — preserved for forensic value)
- 44 historical `.md` files moved to `/docs/archive/` under topical subdirectories (livekit, transcription, viewbot-fixes, av-sync, audio, points, soundboards, plans, browser, optimization, rollbacks, investigations, test-notes). Each carries a redirect banner pointing at the current state.

### Removed
- `client/README.md` (CRA boilerplate; superseded by the dev guide).
- Empty `server/docs/` directory.

### Verified (not changed, but ground-truthed)
- Transcription pipeline: `whisper.cpp` native binary is live. `openai-whisper` is a phantom dependency.
- Primary streaming backend: MediaSoup. LiveKit is dormant infrastructure.
- Points balance: `user_stats.points_balance` is authoritative (refactor was executed).
- Clips system: substantially implemented; live endpoint returns valid status.
- A/V sync: still has the ~333 ms architectural offset documented as a `> [!WARNING]`.
- Account deletion: end-to-end wired with 24h confirm token + 15-day grace + 8-table hard purge.
- Strapi blog: server-side OG-meta injection only; React app oblivious.

## [0.1.0] - YYYY-MM-DD

Initial tagged release marker. Project predates structured versioning — `0.1.0` is a starting point for future release-tagging discipline rather than a complete description of what's in this version. See `git log` for the actual development history.
