# Changelog

All notable changes to OneStreamer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Structured logging (pino).** New `server/bootstrap/logger.js` exports a shared pino instance: JSON-to-stdout in production (consumable by log aggregators) and `pino-pretty` colored output in development. `LOG_LEVEL` env var overrides the level; defaults are `info` in production, `debug` in development. Converted the noisiest startup sites: `server/index.js` env-check banner, `server/database/database.js` connect + PRAGMA logs, `server/database/applyPragmas.js` WAL-fallback warning, `server/routes/bug-reports.js` connection errors. The rest of the codebase still uses `console.*` and migrates opportunistically — this PR establishes the pattern without sweeping every file.
- **Fail-fast env validation at startup.** New `server/bootstrap/env.js` aggregates checks for the four secrets `.env.example` marks REQUIRED (`JWT_SECRET`, `SESSION_SECRET`, `TURN_SECRET`, `TURNSTILE_SECRET_KEY`) — both presence and a minimum-length floor where it applies — and throws a single error listing every missing/malformed var. Wired into `server/index.js` immediately after `dotenv.config()` and before any other `require()` that imports a file calling `requireEnv()`. Operators now see all env problems in one error instead of the previous "fix one, restart, see next miss, repeat" loop with `requireEnv()`. Existing `requireEnv()` callsites stay as a secondary safety net for any required var added to a route file but not yet added to `bootstrap/env.js`'s schema. `ADMIN_KEY` is deliberately not in the schema — it's documented as a legacy key without a length requirement; its existing `requireEnv` enforces presence.

### Removed
- **Legacy `user_stats.points` column dropped.** The migration to `points_balance` as the authoritative column (originally executed by `server/migrations/migrate-points-system.js`) has been complete for some time, and a grep across the codebase confirmed the `points` column was no longer read on any write or read path. Removed from the `CREATE TABLE` definition in `server/database/database.js`; the prior `ALTER TABLE user_stats ADD COLUMN points` migration block was replaced with an idempotent `ALTER TABLE user_stats DROP COLUMN points` (guarded by `"no such column"` for second-run safety). The `/api/auth/me` endpoint that serves `stats.points` to the client already overrode that field with `points_balance` (`routes/auth.js:285–288`), so the API contract is unchanged — `UserProfile.tsx` continues to display the authoritative balance. The standalone `migrate-points-system.js` historical script gained an at-start guard that detects the column-gone state and exits cleanly (preserved for forensic value but no longer re-runnable). `docs/architecture/data-model.md` updated to remove the legacy column from the documented schema.

### Changed
- **SQLite tuned for the 2 GB+ live DB.** New `server/database/applyPragmas.js` helper applies the project-wide PRAGMA set on every handle that opens `onestreamer.db`: `journal_mode=WAL` (with verification — silent fallback no longer leaves `synchronous=NORMAL` on a rollback journal, a power-loss corruption hazard), `synchronous=NORMAL` (conditional on WAL being active), `foreign_keys=ON`, `busy_timeout=5000`, plus large-read tunings (`temp_store=MEMORY`, `mmap_size=256 MB`, `cache_size=64 MB`) on the main handle. Before this change: live DB was on `delete` journal + `synchronous=FULL`, and the two auxiliary handles (`routes/bug-reports.js`, `services/URLStreamDatabaseService.js`) opened with no PRAGMAs at all — so writes from those handles were silently running with `foreign_keys=OFF` and `busy_timeout=0`, a pre-existing correctness regression that WAL would have made more visible (`SQLITE_BUSY` on collision). The pre-existing `sqlite3 ... ".backup"` in `docs/operations/backup-restore.md` is already WAL-safe; the inline comment there explicitly anticipated this. Takes effect on the next `pm2 restart onestreamer-server`.
- **Viewbot URL-stream encoder defaults retuned for lower CPU.** `ViewBotURLService` `adaptiveConfig.mode` default flipped from `'balanced'` to `'performance'` (maps to x264 `ultrafast` + 0.7× bitrate multiplier in `AdaptiveEncodingSettings`). The fixed-fallback path (which fires only on probe failure) was aligned: `superfast`/4000k/4500k/6000k → `ultrafast`/2000k/2500k/4000k. Adaptive remains the hot path. Observed: per-bot ffmpeg CPU dropped from ~90% to ~67% of a single core on a Kick HLS source at 720p30.
- **`onestreamer-client` PM2 entry removed** from `config/ecosystem.config.js`. The entry ran `react-scripts start` (CRA dev server) in "production" and was crash-looping (59 restarts in PM2). nginx already serves the built SPA from `/var/www/html` and never proxied to `127.0.0.1:3443`. Recovers ~1.2 GB RAM. Rollback: restore the entry and `pm2 start config/ecosystem.config.js --only onestreamer-client`.
- **CLAUDE.md** and **docs/architecture/overview.md** inline references to "LiveKit dormant" updated to point at [ADR-0008](docs/architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md). The ADR landed but these inline mentions were missed.

### Added
- **`LIVEKIT_INGRESS_BYPASS_TRANSCODING` env var (default off)** in `ViewBotLiveKitService.createIngress`. When `true`, calls `createIngress` with `bypassTranscoding: true` and no `encodingOptions`, allowing LiveKit ingress to pass upstream H.264/AAC through unchanged (skips ~60% CPU of re-transcoding per active ingress). The team's prior "RTMP requires transcoding for WebRTC conversion, can't bypass" comment is preserved as context; flag exists so the claim can be re-validated on the current `livekit-server-sdk` version. **Requires device-QA (desktop Chrome + mobile Safari) before flipping in production** — mismatched SDP/keyframe interval can cause subscriber-side black streams.
- **`VIEWBOT_STREAM_COPY` env var (default off)** in `ViewBotURLService._createFFmpegRTMPProcess`. When `true` and the input is a direct URL (most IVS/Kick/Twitch HLS sources are H.264 + AAC already), uses `-c:v copy -c:a copy -bsf:v h264_mp4toannexb` instead of x264 re-encoding (~70% CPU off the viewbot ffmpeg). **Same QA requirement**; silent failure modes exist if a platform changes its encoder.

### Fixed
- **Admin Connections tab no longer hangs.** The `/admin/connections` handler in `server/index.js` tried to instantiate `new AccountService()`, but that class is never imported in the file — only the bootstrap-built `accountService` instance (destructured at module scope). The synchronous `ReferenceError` was thrown inside an async handler, which Express 4 leaves un-responded; clients hung until their own timeout. Removed the shadow; the outer-scope `accountService` is reused.
- **Admin Recording Review tab no longer hangs.** The `/admin/review/timeline` handler ran `SELECT * FROM recording_stream_segments` with no time filter (28,931 rows) and then did **one or two follow-up DB queries per segment** for display-name lookups. Response could exceed 20 MB and many seconds. Added a `?days=N` window filter (defaults to 30) and batched the per-segment lookups into a single `WHERE source_url IN (…)` + a single channel-ID `LIKE` per IVS channel + a single `streaming_logs` `WHERE streamer_id IN (…)`. Same data shape returned; timeline at `days=30` now responds in ~0.9 s with 3.3 MB.
- **URL-stream relay (Twitch/Kick) produces video again.** Operational fix; see ADR-0008 below. Verified end-to-end: FFmpeg → RTMP → `livekit-ingress` → LiveKit room → transcription / recording / MovieBot replies.

### Changed
- **LiveKit revived as the active WebRTC backend.** See [ADR-0008](docs/architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md). Supersedes ADR-0002 (LiveKit dormant) and pauses ADR-0007's staged cleanup. URL-stream relay (Twitch/Kick), continuous recording (LiveKit Egress), and MovieBot transcription all depend on LiveKit being live; ADR-0002's "dormant" framing did not match the running system. The shipped LiveKit triad (livekit-server systemd unit + livekit-ingress + livekit-egress containers) is now load-bearing; rollback procedure documented in the ADR.
- **`config/livekit-config.example.yaml`** updated with: mandatory `redis:` section (without which `createIngress` fails), and `bind_addresses` containing both `127.0.0.1` and `::1` (the shipped nginx vhost proxies `/livekit/*` to `[::1]:7882`, so IPv4-only binds return 502). Documentation comment block rewritten to match ADR-0008 instead of ADR-0002.

### Added
- New runbook [`docs/operations/runbooks/livekit-ingress-not-connected.md`](docs/operations/runbooks/livekit-ingress-not-connected.md) covering the most distinctive failure modes encountered during the May 2026 LiveKit revival: missing `redis:` section, IPv4-only bind, stopped ingress/egress containers, stale Redis registry, and downed Redis itself.
- New [ADR-0008](docs/architecture/adr/0008-revive-livekit-for-url-streams-and-recording.md) documenting the LiveKit revival, supersession of ADR-0002/0007, and rollback procedure.

### Removed
- **All references to a phantom "~333 ms A/V sync offset"** across `README.md`, `docs/architecture/streaming-stack.md` (warning banner and limits-table row), `docs/features/streaming-and-takeover.md` (warning banner), `docs/getting-started/first-stream.md` (test step), and `CHANGELOG.md` (Verified entry). The ~333 ms claim was not borne out in practice — viewers don't observe a perceptible offset; the original `AV_SYNC_IMPLEMENTATION_COMPLETE.md` (now in `/docs/archive/av-sync/`) was inherited as documentation without re-verification. The archive directory itself is preserved for forensic value.

## [Documentation overhaul 2026-05-23]

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
- ~~Primary streaming backend: MediaSoup. LiveKit is dormant infrastructure.~~ (Superseded by ADR-0008 — see Unreleased / Changed.)
- Points balance: `user_stats.points_balance` is authoritative (refactor was executed).
- Clips system: substantially implemented; live endpoint returns valid status.
- Account deletion: end-to-end wired with 24h confirm token + 15-day grace + 8-table hard purge.
- Strapi blog: server-side OG-meta injection only; React app oblivious.

## [0.1.0] - YYYY-MM-DD

Initial tagged release marker. Project predates structured versioning — `0.1.0` is a starting point for future release-tagging discipline rather than a complete description of what's in this version. See `git log` for the actual development history.
