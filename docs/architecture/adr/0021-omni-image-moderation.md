# ADR-0021: OmniImageMod — image moderation via OpenAI omni-moderation

* **Status:** Accepted (locked by product owner)
* **Date:** 2026-05-27
* **Builds on:** [ADR-0013](0013-ai-moderation-pipeline.md) (AI moderation pipeline), [ADR-0018](0018-visionbot-screenshot-comments.md) (VisionBot screenshot infrastructure)
* **Related**: [csam-incident runbook](../../operations/runbooks/csam-incident.md)

## Context

ADR-0013 shipped a three-stage moderation pipeline for streamer audio: Stage 1 word filter, Stage 2 Groq LLM verdict, Stage 3 OpenAI `omni-moderation-latest` cross-check. ADR-0018 shipped VisionBot, which already captures a JPEG of the active stream every 120 s via `EgressFrameCaptureService` and pairs it with the transcription window for a vision LLM commentary call.

OpenAI's omni-moderation endpoint is **multi-modal** — the same `/v1/moderations` call that classifies text accepts an `image_url` content part with a base64 data URI. It's free and rate-limited to ~250 RPM on the lowest tier. Wiring image moderation onto VisionBot's frame captures is incremental:

- the endpoint is already called for text (Stage 3 for transcripts);
- the captures already happen for VisionBot;
- the ActionArbiter / `moderation_events` table / admin UI already handle ban-and-log decisions.

The new work is feeding the JPEG to Stage 3 and routing the verdict through the same arbiter.

## Decision

Extend the AI-moderation pipeline with an image-source path. Frames captured by VisionBot are screened for sexual / violence / self-harm content; flagged frames are routed through the same `ModerationActionArbiter` that handles text-source events. Defaults to disabled; admin enables via a new `moderation_global_config.image_moderation_enabled` flag.

### Locked architectural choices (from clarifying interview)

1. **Trigger**: piggyback VisionBot only — image moderation fires inside `VisionBotService._runCycle`. Moderation is dormant whenever VisionBot is off. One frame capture, two consumers (the bot + the moderation gate).
2. **Threshold**: hybrid — `sexual/minors` would use a hair-trigger score threshold for text-source CSAM (existing Stage 3 text path already handles this); image-source categories use OpenAI's `flagged` boolean per category. Per-category enable list lets ops drop a category to admin-review-only via the moderation_config table.
3. **Ban policy**: shared `moderation_global_config.enforce` toggle with text moderation. `enforce=true` → ActionArbiter auto-bans on webcam, blocks on URL-relay. `enforce=false` → all flags downgrade to `admin_review` (existing arbiter behavior).
4. **CSAM-image scope**: ship with text-only CSAM detection only; CSAM-image detection via PhotoDNA / Thorn Safer is a deferred follow-up.
5. **Audit retention**: flagged JPEGs are promoted to a `banned/` subdirectory and kept 30 days (configurable up to 365). Clean frames purge at 1 h. Survives ban appeals filed within a month.

## Critical caveat: omni image-CSAM gap

Per OpenAI's docs and the September 2024 multimodal announcement, image inputs only trigger 6 of 13 categories:

| Image-supported | Text-only |
|---|---|
| `sexual` | **`sexual/minors`** (CSAM) |
| `violence` | `hate` |
| `violence/graphic` | `hate/threatening` |
| `self-harm` | `harassment` |
| `self-harm/intent` | `harassment/threatening` |
| `self-harm/instructions` | `illicit` |
| | `illicit/violent` |

**Image-CSAM screening is NOT covered by this PR series.** A screenshot containing CSAM returns `flagged: false` from omni unless it coincidentally trips the adult `sexual` category. Operators must not interpret "image moderation: ON" as "CSAM protection."

Mitigations:
- Admin UI tile carries an explicit label: `Image moderation: detects sexual / violence / self-harm content. Does NOT detect CSAM from images — see csam-incident runbook.`
- New runbook `docs/operations/runbooks/csam-incident.md` documents the manual reporting workflow when CSAM is reported by viewers, including NCMEC CyberTipline submission per 18 U.S.C. § 2258A.
- Image-CSAM detection via PhotoDNA / Thorn Safer is tracked as a deferred follow-up.

## Critical fixes from red-team review

Eight concrete fixes are baked into the implementation:

| # | Problem | Fix |
|---|---------|-----|
| F1 | Single `flagged: true` → instant ban risks false positives on gaming / cosplay / medical / horror content. | Default `image_moderation_enabled=0`. When enabled, `enforce=false` is the operationally safe rollout (log-only to admin_review queue). Per-category enable list lives in `moderation_global_config.image_categories_enabled_json`. |
| F2 | Audit JPEG purged in 1 h breaks ban appeals filed later. | On flag, JPEG is promoted from `logs/visionbot/frames/<streamerId>/<iso>.jpg` to `logs/visionbot/frames/banned/<event_id>.jpg`. `EgressFrameCaptureService.purgeOldFrames` uses a separate `bannedRetentionDays` cutoff (default 30, configurable up to 365). |
| F3 | Shared Stage 3 circuit breaker between text + image — image timeouts blind text moderation. | A **second** `ModerationStage3` instance (`moderationStage3Image`) is constructed in `server/index.js` for image classification. Same API key + endpoint; distinct breaker state. |
| F4 | Bot dispatch race — VisionBot's `setTimeout` dispatch chain fires bots before moderation completes. | `_runCycle` **awaits** `moderationService.handleVisionFrame()` BEFORE scheduling the `setTimeout` dispatches. On `auto_ban` / `auto_skip`: halt cycle (no chat post). On `clean` / `admin_review`: continue with dispatch. Bot reaction latency grows by ~0.5–2 s; acceptable. |
| F5 | Operator misunderstanding of CSAM coverage | Admin UI label + runbook (see "Critical caveat" above). |
| F6 | Discoverability gap — image mod silently dormant when VisionBot off | Admin UI tile renders the VisionBot status inline. (Wired in PR 3.) |
| F7 | Stale-session race — frame from streamer A could ban streamer B | Existing `ModerationActionArbiter.arbitrate` stale-session check at `ModerationActionArbiter.js:99–105` rejects mismatches with `admin_review` downgrade. `streamGeneration` snapshotted at frame-capture time inside `EgressFrameCaptureService`. |
| F8 | NCMEC actual-knowledge trap — flagging `sexual` on content that is actually CSAM | New runbook `csam-incident.md`. Automated NCMEC reporting deferred; manual workflow is the v1 answer. |

## Three-PR ship

PR 1 — `ModerationStage3` accepts image input. Backward-compat. Tests + error codes.

PR 2 — `ModerationService.handleVisionFrame` + schema + evidence preservation. `moderation_events.{source, image_path, applied_input_types_json}` columns. `moderation_global_config.{image_moderation_enabled, image_categories_enabled_json, image_frame_retention_days}` columns. `EgressFrameCaptureService.promoteFrameForEvent` method + `banned/` subdir retention separation. Second `ModerationStage3` instance for breaker isolation.

PR 3 (this) — VisionBot integration + admin endpoints + ADR-0021 + CSAM runbook + CHANGELOG. `VisionBotService._runCycle` awaits the moderation gate before dispatching bots; halts on `auto_ban`/`auto_skip`. Admin endpoints `GET /api/moderation-ai/image-config`, `POST /api/moderation-ai/image-config`, `GET /api/moderation-ai/events/:id/frame`. ADR + runbook + CHANGELOG.

## Consequences

- New schema columns on `moderation_events` and `moderation_global_config`. Idempotent inline ALTERs in `ai-moderation-schema.sql` rely on `ModerationService._applySchema` swallowing "duplicate column" errors on reboot.
- New service constructor deps on `ModerationService`: `stage3Image` (optional) and `frameCaptureService` (optional). Tests that don't pass them get a no-op moderation gate.
- New process activity: one extra HTTPS call to `api.openai.com` per 120 s cycle (free); zero extra ffmpeg work (same frame consumed twice).
- New disk usage: flagged frames in `logs/visionbot/frames/banned/` for 30 days default. Worst-case at 1 frame / 120s with a sustained banning operator: ~720 frames / day × 30 KB ≈ 21 MB / day, 630 MB at 30 days.
- New admin UI surface: a config tile in the existing AI Moderation tab (toggle, category checkboxes, retention slider, VisionBot status indicator).
- New external dependency: OpenAI API key (`OPENAI_API_KEY` env or via the existing Stage 3 config path). Same key already required by Stage 3 text — no new vendor onboarding.

## Deferred (NOT in this PR series)

- **PhotoDNA / Thorn Safer** for image-CSAM hash matching. Separate vendor onboarding + hash DB sync + NCMEC compliance.
- **Automated NCMEC CyberTipline reporting**. Manual runbook only in this PR.
- **Per-category score-threshold admin UI**. Default uses OpenAI's `flagged` boolean (one knob per category: on/off).
- **N-of-M consecutive-frame requirement** before auto-ban. User picked single-frame ban under `enforce=true` (with `enforce=false` as the safe rollout path).
- **Separate `image_enforce` toggle**. Shared with text per user choice.
- **TOS / privacy policy update** reflecting OpenAI data flow. Out of code-PR scope.
- **Static-frame evasion detection** (adversary spoofs a still). Worth a follow-up.

## Top-3 ship blockers (red-team-derived, all addressed in PR 3)

1. **CSAM coverage misadvertisement** — admin UI label + runbook (above).
2. **Evidence purged before appeals** — `banned/` subdir + 30-day retention (PR 2, wired here).
3. **Bot dispatch race** — `_runCycle` awaits moderation before dispatch (this PR).
