# Runbook: CSAM incident response

## When this runbook applies

A viewer, moderator, automated alert, or admin has reason to believe a OneStreamer broadcast contains, contained, or distributed child sexual abuse material (CSAM). Examples:

- A viewer reports CSAM in chat, DMs, or the support email.
- The AI moderation tab shows a flagged event whose review reveals CSAM.
- A law-enforcement contact reaches out about a specific stream / user.
- Internal review of recordings discovers CSAM.

**OneStreamer's automated image moderation (ADR-0021 / OmniImageMod) does NOT detect CSAM from images.** OpenAI's omni-moderation `sexual/minors` category is text-only — it triggers from transcript content, not from screenshots. The image moderation gate is for `sexual`, `violence`, `violence/graphic`, `self-harm`, `self-harm/intent`, `self-harm/instructions`. Image-based CSAM screening requires a separate vendor (PhotoDNA / Thorn Safer / NCMEC hash list); that integration is deferred.

This runbook covers the manual workflow until that integration ships.

## Legal context (US-domiciled platform)

**18 U.S.C. § 2258A** requires electronic service providers to report apparent CSAM to the National Center for Missing & Exploited Children (NCMEC) CyberTipline. Failure to report when on actual knowledge is a federal offense punishable by fines and potential officer liability. The obligation is on the platform, not on third-party tooling (e.g., OpenAI). Using OpenAI's moderation API does not discharge OneStreamer's reporting obligation.

The reporting standard is **actual knowledge of apparent CSAM**, not "verified CSAM." Err on the side of reporting; NCMEC has the resources to verify and route to law enforcement.

## Immediate response (first 10 minutes)

> **DO NOT** save extra copies of the content. **DO NOT** distribute, screenshot, or share the content in Slack / email / DMs. The minimum evidence necessary is already preserved by the moderation pipeline; additional copies create additional legal exposure.

1. **Stop the stream**. Admin UI → ban the streamer immediately. This blocks the user from re-streaming and from logging in. If the streamer is currently live, the ban also triggers `RandomStreamRotationService` to advance to the next URL stream.

2. **Stop recording** for the affected session. `ContinuousRecordingService` is writing HLS segments to `egress-recordings/<sessionId>/`. **Do NOT delete these files** — they're evidence. Stop new writes via the admin UI or by calling `continuousRecordingService.stopRecording()` directly.

3. **Preserve the moderation_events row** (if one exists). If a `final_decision` row was already written by the moderation pipeline, do not reverse it. The `image_path` field and `stage3_verdict_json` are part of the evidence chain.

4. **Notify the on-call admin + legal counsel**. Slack `#oncall` with subject "URGENT: suspected CSAM incident — see runbook". Do NOT include the content itself in the message. Reference `moderation_events.id` only.

5. **Lock down support tickets**. If a viewer reported via support email / DMs, do NOT reply with anything other than "Thank you for the report; we're investigating." DO NOT request the viewer to send more details / screenshots / links — that creates additional distribution.

## NCMEC CyberTipline submission (within statutory window)

Report submission window: as soon as possible, no later than the next business day. OneStreamer's general counsel signs off before submission. The platform's contact (not the on-call admin's personal account) is the registered reporter.

**Submission channels:**

- **CyberTipline web form**: https://report.cybertip.org/ (designated reporter login)
- **CyberTipline phone**: 1-800-843-5678 (24/7; use for time-critical cases)
- **NCMEC ESP API** (the platform's automated channel, when registered): see [`docs/integrations/ncmec.md`](../../integrations/ncmec.md) (deferred / not yet implemented as of ADR-0021)

**Information to include:**

- Time the suspected CSAM was observed (UTC + timezone).
- `moderation_events.id` of the row tied to the incident (gives NCMEC a stable reference back to the platform's audit trail).
- `streamer_id`, the resolved `user_id`, the streamer's account email and IP/geolocation captured at session start.
- The audit JPEG (`moderation_events.image_path`) if one exists. NCMEC's secure upload accepts this. **Do not email; upload to the secure intake.**
- The recording session ID and the path to the local HLS segments — NCMEC may request the full recording.
- The conversation / chat transcript snippet near the time of incident — pulled from the `messages` table.

**Do NOT include in the report:**

- Speculation about the streamer's identity or motive.
- Internal investigation notes.
- Other unrelated platform data.

After submission, NCMEC returns a report ID. Log it in the internal incident tracker; do **not** put it in `moderation_events`.

## Preservation period

§ 2258A requires preservation of the reported material for **90 days** from the date of the report. This applies to:

- The audit JPEG (`logs/visionbot/frames/banned/<event_id>.jpg`). The standard 30-day retention configured in `moderation_global_config.image_frame_retention_days` is INSUFFICIENT for a CSAM incident. Manually copy the file to `logs/csam-preservation/<incident_id>/` (root-readable only) and add `incident_id` to the off-rotation preservation tracker.
- The HLS recording segments under `egress-recordings/<sessionId>/`. Do not let `RecordingCleanupScheduler` purge them. Tag the `recording_sessions` row with `legal_hold=1` to suppress retention.
- The chat transcript (messages table) around the incident window.
- The `moderation_events` row(s) tied to the incident.

The preservation window may be extended by court order — the platform's general counsel handles that.

## Post-incident actions

1. **Stream rotation review**: confirm the offending streamer is fully banned (`users.banned_at IS NOT NULL`). If they had multiple sessions, confirm all are terminated.
2. **Allowlist / blocklist propagation**: if the source was a URL relay, add the source URL / channel ID to the URL-relay blocklist via `WhitelistService.addEntry({list: 'block'})`.
3. **Viewer-reporter follow-up**: send a generic acknowledgement: "Thank you for the report. We have taken appropriate action and reported to the relevant authorities. We cannot share specific details due to legal restrictions." Do not confirm or deny the specifics.
4. **Internal review**: schedule a post-incident review within 1 week with on-call admin, eng lead, and legal. Identify pipeline gaps — was the content visible long enough that automated detection should have caught it? Should we accelerate the PhotoDNA / Thorn integration?

## What this runbook does NOT cover

- **NCMEC API integration**: deferred. Manual web-form / phone submission is the v1 workflow.
- **PhotoDNA / Thorn Safer image hash matching**: deferred. Image-CSAM detection from screenshots is currently out of automated scope.
- **Civil litigation or law enforcement subpoenas**: handled by general counsel, separate process.
- **GDPR / CCPA right-to-erasure requests** that intersect with a CSAM incident: legal counsel reviews; CSAM preservation under § 2258A overrides erasure rights under Article 6(1)(c) of GDPR (legal obligation).

## Contact directory

- **Internal escalation**: Slack `#oncall`, paging via PagerDuty `oncall-platform`
- **General counsel**: see internal directory; do not include personal contact info here
- **NCMEC CyberTipline**: 1-800-843-5678 (24/7) / https://report.cybertip.org/
- **FBI**: 1-800-CALL-FBI (1-800-225-5324) — for active imminent-harm situations only; NCMEC routes routine reports to law enforcement themselves
