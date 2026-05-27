# ADR-0013: AI moderation pipeline for streamer audio

_Status: accepted_
_Date: 2026-05-27_

## Context

OneStreamer transcribes streamer audio with whisper.cpp in 5-second rolling
windows ([`TranscriptionService.js:340`](../../../server/services/TranscriptionService.js)).
Transcripts flow to `MovieBotService`, which sends them to Groq LLMs to
generate chat-bot commentary ([`MovieBotService.js:354`](../../../server/services/MovieBotService.js)).
At no point between Whisper and the LLM call is the transcript inspected
for content policy. Streamers can say anything on-stream and the only
enforcement is reactive — a human admin sees a report, manually visits the
admin panel, and toggles `users.streaming_banned`.

The product mandate now is: live audio that is **clearly hateful, threatening,
or sexual** (especially CSAM-adjacent) should not stay on-air, and the
platform should not need a human in the loop to make that ruling for the
hardest categories. The relay and webcam stream surfaces are 24/7; we cannot
keep an admin staring at every transcript.

Two ancillary realities shape the design:

1. **URL-relay streams have no `user_id`** to ban. They originate from a
   Twitch or Kick channel that's being passed through onestreamer's LiveKit
   ingress; the right action is to stop relaying that channel and add it to
   the existing `url_relay_filter_entries` block list ([ADR-0010](0010-url-relay-whitelist-mode.md)).
2. **MovieBot's LLM output is itself a moderation surface.** A streamer can
   prompt-inject the bot into producing offensive content that then appears
   in chat over MovieBot's identity. Output gating is non-optional.

Research the design absorbed before locking:

- OpenAI omni-moderation API is free, low-latency, multilingual, and broadly
  competent — but has a higher false-positive rate than the legacy model on
  English text, particularly on AAVE and reclaimed slurs.
- Perspective API is being sunset on **2026-12-31**; not a path forward.
- Whisper has documented hallucination rates of ~38% on long-segment chunks,
  and Whisper redacts profanity to `***` by default — a moderator built on
  raw Whisper output will both miss real slurs and act on hallucinated ones.
- Twitch AutoMod, audited at ACL 2025, misses 94% of context-dependent hate
  speech and over-blocks 89.5% of benign reclaimed/quotational use. A pure
  keyword filter is not a moderator.
- The AAVE-bias problem is real and well-documented (Sap et al. 2019; ACL
  2025). LLM moderators trained on overlapping corpora exhibit correlated
  bias, so a "two LLMs agree" gate provides partial — not complete —
  independence.
- DSA Article 17 requires a statement of reasons for every moderation action;
  GDPR Article 22 gives EU users the right to object to solely-automated
  decisions producing significant effects.

The user accepts the residual AAVE-bias risk in exchange for first-strike
permaban speed, with mitigation via curated word lists, AAVE-aware Stage 2
prompts, two-of-two Stage 3 cross-check on the hardest categories, and a
prominent admin appeals UI for fast reversal.

## Decision

Add a three-stage moderation gate that subscribes to the existing
`transcription-chunk` event, classifies each transcript, and on confirmed
high-risk content takes an automated, role-appropriate action.

### The three stages

1. **Stage 1 — word filter (cheap, local, recall-only).** Normalize
   incoming text (NFKC, lowercase, homoglyph fold, leetspeak fold, repeat
   collapse, strip non-alphanumeric) and match against a hand-curated
   embedded core list (~120 terms, shipped in this PR as
   `server/data/seeds/moderation-core-list.json` with a SHA-256 integrity
   check) **plus** an admin-editable `moderation_terms` DB table. Stage 1
   **only flags**; it never auto-bans.

2. **Stage 2 — Groq classifier (LLM, structured output).** When Stage 1
   flags, call Groq via the existing `ChatBotLLMService` client with a
   structured system prompt that returns
   `{risk_level: 0..3, categories, explanation}`. Pass 60 seconds of
   surrounding transcript as context so the LLM can disambiguate
   use/mention, quotation, AAVE/reclamation, song lyrics, and educational
   framing. Wrap the untrusted transcript in
   `<transcript untrusted="true">…</transcript>` and instruct the model
   explicitly that content inside is data, never instructions, to defeat
   prompt-injection attempts.

3. **Stage 3 — OpenAI omni-moderation cross-check (only on `risk_level=3`).**
   When Stage 2 returns the top risk level, call the free OpenAI
   omni-moderation endpoint as a second opinion. Automated action proceeds
   only on **two-of-two HIGH agreement**. Disagreement routes to the admin
   review queue. Per-streamer Stage-3 quota (20 calls/hour) prevents an
   attacker from intentionally burning OpenAI throughput.

### Actions

- **Real streamers (`streamType === 'webcam'`):** First-strike permanent
  streaming ban. Set `users.streaming_banned = 1`, force-end the stream via
  the existing `RandomStreamRotationService` rotation lock, log a full
  statement of reasons (transcript excerpt, all three stages' verdicts,
  matched terms, model identifiers, DSA-required `automated_decision=1`,
  legal basis, redress URL), notify the streamer via an in-stream banner +
  email + dashboard. Manual unban via admin appeals UI.
- **URL-relay streams:** Skip immediately to the next stream and insert a
  permanent `url_relay_filter_entries` row keyed on the platform's
  immutable numeric `external_user_id` (not display name — display names
  are mutable and spoofable). This requires schema-bumping the existing
  table to add an `external_user_id` column and propagating numeric IDs
  through `TwitchRandomService`, `KickRandomService`, and `ViewBotURLService`.
- **ViewBot streams:** Log only. Synthetic prerecorded media shouldn't
  trip this, but if it does, we record it for QA.

### MovieBot output gating

Every MovieBot reply runs through Stages 1 and 2 (no Stage 3, no
auto-action) before `MovieBotService` emits `moviebot-comment` and the
chat-service relays it. Flagged outputs are dropped silently and logged.
This protects users from prompt-injection-induced offensive output without
banning the bot persona.

### Whisper hardening (mandatory companion)

Whisper.cpp arguments change to emit JSON with word-level confidence and
no-speech probability (`-oj --word-thold 0.6 --no-speech-thold 0.6
--temperature 0.0`), with an `--initial-prompt` instructing verbatim
transcription. Chunks failing the confidence threshold are dropped from
the moderation pipeline (still saved for transcript display, just not
acted on). A "two confirming chunks within 30s" rule for the slur category
further reduces hallucination-driven false bans.

### Where the data lives

Two new tables (DDL in `server/database/ai-moderation-schema.sql`):

- `moderation_terms(id, term, normalized_form, category, severity, source,
  enabled, created_by, created_at, notes)` — embedded + admin-editable
  word list. `source = 'embedded'` rows come from the signed seed file and
  cannot be deleted by admins.
- `moderation_events(...)` — one row per decision. Includes transcript
  excerpt, surrounding context, all three stages' verdicts, final
  decision, action taken, reversal fields, whisper confidence values, model
  identifiers, DSA-shaped statement-of-reasons columns, and the
  `stream_session_id` used to detect stale verdicts.
- `moderation_config(category, enabled, action_mode, stage2_threshold,
  stage3_required, updated_at, updated_by)` — per-category dial; lets ops
  drop a category to `admin_review` mode without a deploy.
- `moderation_terms_audit(...)` — append-only audit log with hash-chained
  rows for tamper evidence.

Plus a schema bump on `url_relay_filter_entries` to carry numeric
`external_user_id` for the URL-relay blocklist key.

### Service shape

A new stateful `ModerationService`, instantiated once in `server/index.js`
and exposed as `app.locals.moderationService` per coding conventions, owns
the pipeline. It subscribes to `TranscriptionService` `transcription-chunk`
and exposes `checkBotOutput(text, ctx)` for `MovieBotService` to call
before emitting. A new `ModerationNotifier` chokepoint (parallel to
`BuffNotifier`, `ViewerCountNotifier`, `StreamNotifier`) owns all
moderation-related socket emits.

A new `ModerationActionArbiter` makes the webcam/URL-relay/viewbot
decision after the pipeline returns a high-confidence verdict, acquiring
the existing `RandomStreamRotationService` rotation lock before any
ban/skip mutation so it can't race against the existing rotation logic.

### Retention

- `moderation_events` rows with non-clean `final_decision`: **90 days**.
- Clean transcript chunks: **30 days** (unchanged from existing transcript
  retention).
- A nightly cron purges aged rows.
- A `GET /api/user/me/moderation-export` endpoint serves GDPR Article 15
  data-portability requests.

### Phased rollout

Eight PRs, each independently mergeable. M0 is this ADR + schema + seed
(no wire-up). M1 ships Stage 1 in log-only mode. M2 adds Stage 2 still
log-only. M3 adds Stage 3 + the ActionArbiter behind an
`AI_MODERATION_ENFORCE=false` env flag. M4 hardens Whisper and adds the
MovieBot output gate. M5 ships the admin UI. M6 turns enforcement on and
adds the retention/audit hardening. M7 propagates `external_user_id`
through the URL-relay subsystem so the blocklist is keyed on the immutable
ID.

## Consequences

**Positive.**

- Live audio that crosses the hate/threat/sexual line is taken off-air
  within ~10 seconds without a human in the loop, for both webcam and
  URL-relay surfaces.
- The chat-service stops accidentally publishing MovieBot output that
  contains offensive content the LLM was tricked into producing.
- Whisper's known hallucination behavior is taken seriously rather than
  ignored — the moderation pipeline is the right place to make the
  word-level-confidence investment that the rest of the transcription
  pipeline has been able to skip.
- The admin gets a single tab in `AdminPanelV3` that surfaces every
  moderation decision the system makes with the full context (transcript
  excerpt, model verdicts, action taken) and a one-click reversal.
- The system writes DSA Article 17-shaped statements of reasons by
  default, removing a compliance task that would otherwise grow with
  every action.

**Negative.**

- **AAVE / dialect bias on the permaban path** is the load-bearing
  residual risk. Both Stage 2 (Groq) and Stage 3 (OpenAI) train on
  overlapping corpora and exhibit correlated false-positive bias on AAVE
  and reclaimed terms. The two-of-two cross-check is partial — not full —
  independence. Mitigations: a hand-curated hard-tier embedded list that
  excludes terms with strong reclamation context; Stage 2 prompt
  explicitly instructs the model on AAVE/quotation/song-lyric handling;
  the admin appeals UI is treated as a first-class feature, not an
  afterthought. We accept this risk in exchange for first-strike speed.
- **Audio-injection framing** (an attacker plays slur audio in a Discord
  call the streamer is on, or via OBS overlay) can cause an innocent
  streamer to be banned. v1 adds a partial mitigation by refusing
  takeover when the input device label matches virtual-cable patterns
  (`VB-Audio`, `BlackHole`, `VAC`, `Voicemeeter`). Full mitigation
  (voiceprint enrollment + pyannote diarization) is deferred to v1.5.
- **Whisper hallucination** can fire false positives. Mitigation: the
  word-level confidence floor + "two confirming chunks" rule for slurs.
  This still leaves a non-zero false-positive rate, which is why appeals
  matter.
- **Vendor footprint expands** to include OpenAI for Stage 3 and a small
  `openai` npm dependency. The free omni-moderation tier covers expected
  volume, but the dependency is real. If `OPENAI_API_KEY` is unset, the
  system runs without Stage 3 and the threshold to act on Stage 2 alone
  is configurable upward; defaulting to "Stage 2-only auto-action is
  disabled" preserves safety at the cost of an admin queue for those
  events.
- **Maintenance burden** on the admin-editable `moderation_terms` table.
  False positives identified through appeals should feed back into the
  list (term disabled or moved to soft severity). The audit log tracks
  who changed what.
- **A bug or runaway in `ModerationService` is an availability incident**
  for streaming. If the service is wedged, real streamers can be
  spuriously banned. Mitigations: circuit breaker on Stage 2 latency,
  `AI_MODERATION_ENFORCE` kill switch via env, `moderation_config` per-
  category mode that ops can flip to `admin_review` without a deploy.
- **First-strike permaban with first-strike permanent URL-relay blocklist
  is unforgiving.** Reversals require admin action; there's no
  time-based auto-expiry. We accept this and will iterate if data shows
  the appeals queue is overwhelming.

## Alternatives considered

- **Word filter only, no LLM stages.** Cheap, fast, vendor-free. Rejected:
  the ACL 2025 audit of Twitch AutoMod's slur-matcher approach
  showed 94% miss rate on context-dependent hate. A word-filter-only
  moderator would be performative.
- **Piggyback on the existing MovieBot Groq call** by asking it to also
  return a moderation verdict. One LLM call per cycle. Rejected: MovieBot's
  cycle is 45–120s, which is too slow for mid-stream ban-on-slur; and
  conflates "is this entertaining" with "is this offensive" in one prompt
  surface.
- **OpenAI omni-moderation primary, no Groq classifier.** Vendor lock and
  no AAVE-aware structured prompt. Rejected.
- **Llama Guard 4 via Groq as Stage 2.** Reasonable; the taxonomy is good.
  Rejected for v1 to keep the prompt under our control and the JSON
  schema explicit. Documented as a v1.5 candidate for adding a third
  independent classifier without a third vendor.
- **Human-in-loop for all categories before any ban.** Maximum
  false-positive protection. Rejected per user preference: the speed of
  first-strike permaban for clear violations is the product property the
  feature is paying for; appeals carry the reversal weight.
- **Progressive enforcement (warn → mute → 24h ban → 7d → permanent).**
  Industry norm at Twitch since 2025. Rejected per user preference:
  onestreamer's scale and per-streamer concurrency don't justify the
  state machine.
- **Auto-expire URL-relay blocklist entries after N days.** Rejected per
  user preference: the blocklist is permanent; reversals are admin-driven.

## References

- [ADR-0006: whisper.cpp over cloud STT](0006-whisper-cpp-over-cloud-stt.md) — why we own the transcription stack.
- [ADR-0008: Revive LiveKit for URL streams, recording, and transcription](0008-revive-livekit-for-url-streams-and-recording.md) — the URL-relay surface this pipeline gates.
- [ADR-0009: `StreamNotifier` chokepoint](0009-stream-notifier-chokepoint.md) — the pattern the new `ModerationNotifier` follows.
- [ADR-0010: URL-relay whitelist mode](0010-url-relay-whitelist-mode.md) — the `url_relay_filter_entries` schema this pipeline extends.
- [OpenAI Moderation API](https://platform.openai.com/docs/guides/moderation)
- [Anthropic — Content moderation](https://platform.claude.com/docs/en/docs/about-claude/use-case-guides/content-moderation)
- [TechCrunch — Whisper transcription tool has hallucination issues](https://techcrunch.com/2024/10/26/openais-whisper-transcription-tool-has-hallucination-issues-researchers-say/)
- [Sap et al. 2019 — The Risk of Racial Bias in Hate Speech Detection](https://aclanthology.org/P19-1163/)
- [ACL 2025 — Auditing Twitch AutoMod](https://aclanthology.org/2025.acl-long.1110/)
- [EU DSA — Article 17 statement of reasons](https://digital-strategy.ec.europa.eu/en/policies/dsa-impact-platforms)
