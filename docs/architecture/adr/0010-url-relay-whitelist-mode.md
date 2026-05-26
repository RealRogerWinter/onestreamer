# ADR-0010: URL-relay whitelist mode for family-friendly content

_Status: accepted_
_Date: 2026-05-26_

## Context

OneStreamer's URL-relay subsystem ([ADR-0008](0008-revive-livekit-for-url-streams-and-recording.md)) pulls live video from Twitch and Kick via two entry points:

1. **Direct admin submission** — `POST /api/url-stream` → `ViewBotURLService.startURLStream(url, ...)` (`server/services/ViewBotURLService.js:403`). Validates the URL and pipes it to LiveKit ingress. **No content filter.** An admin can paste any Twitch or Kick URL and the relay starts.
2. **Random rotation** — `RandomStreamRotationService._rotateToNewStream()` (`server/services/RandomStreamRotationService.js:1496`) picks a random live streamer from one platform every 1–11 minutes. Filtering is a coarse, hardcoded **blocklist** on category names: `['ASMR', 'Pools, Hot Tubs, and Beaches']` (`RandomStreamRotationService.js:106`). The check is duplicated inside `TwitchRandomService.findRandomStreamer()` (line 253) and `KickRandomService.findRandomStreamer()` (line 170).

That blocklist is **insufficient for the family-friendly bar** we now want. Specific gaps:

- Twitch's "Just Chatting" category absorbs the post-2023 hot-tub/swimwear meta after `Pools, Hot Tubs, and Beaches` was split off — yet "Just Chatting" is not blocked.
- Twitch's Content Classification Labels (`SexualThemes`, `ViolentGraphic`, `DrugsIntoxication`, `Gambling`, `ProfanityVulgarity`, `DebatedSocialIssuesAndPolitics`) are not consulted.
- Kick's gambling-focused top channels (Slots & Casino, Sports Betting) are not blocked, and Kick is culturally more permissive than Twitch — slot streams, IRL stunts, and crypto-betting promo are the default content tier.
- The direct-submission path has no filter at all, so an admin or a takeover-mode operator can put anything on-air.
- An allowlist-shaped policy ("only these streamers, only these categories") cannot be expressed at all in the current model.
- A whitelisted streamer can switch their own stream mid-broadcast into a non-whitelisted category; nothing catches that today.

The product mandate is: this relay must be safe for an unattended 24-hour rotation visible to a general audience including minors. Blocklists are reactive — anything new is allowed by default. We need a switch to invert that and an enforcement loop that holds it.

## Decision

Introduce a three-mode content filter, scoped per-platform, applied at three enforcement points, with a fallback cascade when no whitelisted source is live.

### The three modes (per platform)

A new `url_relay_filter_config` row per platform (`twitch`, `kick`) with `mode`:

- **`off`** — current behavior. Nothing is filtered beyond the existing two hardcoded blocked categories. Kept so we can ship the feature without forcing it on. Default for `twitch`. Default for `kick` is **`whitelist`** because Kick's surface area is materially less safe.
- **`blacklist`** — admin maintains a list of blocked streamer logins and blocked category names. The existing two-entry hardcoded blocklist is removed and seeded into this table.
- **`whitelist`** — admin maintains an allowlist of permitted streamer logins and permitted category names. **Anything not on the list is rejected.** A stream is permitted iff its streamer login is on the streamer-allowlist **OR** its current game/category is on the category-allowlist, **AND** it passes the per-platform mature/CCL gates described below.

### Three enforcement points

1. **Direct URL submission gate** — inside `ViewBotURLService.startURLStream()`, immediately after the existing `validateURL()` succeeds (`ViewBotURLService.js:461`) and before `getStreamURL()` is called (`:472`). New `WhitelistService.checkAllowed({platform, login, currentGameId})` returns `{allowed, reason}`. If `!allowed`, return early with `{success: false, error: reason}`.

2. **Rotation candidate filter** — inside `TwitchRandomService.findRandomStreamer()` and `KickRandomService.findRandomStreamer()`, replace the local `this.blockedCategories` Set with a call back into the shared `WhitelistService`. Filter the candidate list down to permitted streams **before** the random pick, not after — otherwise we'd reject the pick and silently fall through to "no streamer found".

3. **Mid-stream category-drift check** — a new `WhitelistEnforcer` service polls the current relay's `{login, currentGameId}` against the live whitelist every 60s. If the streamer switches to a non-whitelisted category mid-stream, the enforcer stops the current relay and triggers a rotation. This is the single most important safety property — without it, a whitelisted streamer can voluntarily break the policy at any moment.

### Mature/CCL gates (always on, regardless of mode)

Even in `off` mode, when the platform API is reachable we additionally reject streams where:

- `is_mature === true` on the Twitch `/helix/streams` response.
- Any of `SexualThemes`, `ViolentGraphic`, `DrugsIntoxication` appears in the channel's `content_classification_labels` (Twitch `/helix/channels`).
- `has_mature_content === true` on Kick `/public/v1/livestreams`.

These gates are independent of the mode setting because they reflect platform-supplied content labels, not local policy. They give us defense-in-depth against an admin accidentally allowlisting something whose CCLs change later.

### Fallback cascade

When `_rotateToNewStream()` finds no whitelisted streamer live on either platform:

1. **Whitelisted-category fallback.** Pick the top-viewer-count stream in a whitelisted category (e.g., Minecraft) that *also* clears the mature/CCL gates. Defaults to `twitch::Minecraft` because both volume and content distribution are best there.
2. **24/7 evergreen fallback.** If even category-fallback returns nothing, relay one of the configured always-on safe channels (`bobross`, `monstercat`, `chillhopmusic`). These get a special seed row with `is_evergreen = true`.
3. **Black-frame placeholder.** If LiveKit ingress to an evergreen also fails, the relay stays stopped and the UI shows the existing "no stream available" state. We do not invent a synthetic stream.

The fallback choice is logged at INFO level and reflected in the admin UI status panel ("Currently on fallback: bobross — no whitelisted streamer live").

### Where the data lives

Three new SQLite tables (schema in `server/database/url-relay-whitelist-schema.sql`):

- `url_relay_filter_config(platform PK, mode, fallback_category, fallback_evergreen_login, updated_at)` — one row per platform.
- `url_relay_filter_entries(id PK, platform, entry_type ['streamer'|'category'], value, list ['allow'|'block'], notes, created_at, created_by)` — the actual entries. Unique on `(platform, entry_type, value, list)`.
- `url_relay_filter_audit(id PK, action, platform, entry_type, value, actor, before, after, at)` — append-only audit log, so we can answer "who added this Kick streamer last Tuesday?".

A new stateful service `WhitelistService` is instantiated once in `server/index.js` and exposed via `app.locals.whitelistService` per the [coding-conventions](../../contributing/coding-conventions.md) guidance. Existing `global.viewBotURLService` continues to receive the service via a setter (`setWhitelistService()`) to keep wiring consistent with how it already gets `streamService`, `livekitService`, etc.

## Consequences

**Positive.**

- The 24/7 relay can be trusted for a general audience including minors. The two enforcement points + drift check together make it materially harder for the relay to surface anything outside the policy.
- The same machinery handles both blacklist and whitelist styles, so we can run blacklist on Twitch (large permissive surface, mostly fine) and whitelist on Kick (small unsafe surface, allowlist only) from one codebase.
- Drift enforcement closes the hole where a whitelisted streamer switches their own category mid-broadcast — today this is invisible to us.
- Replacing two hardcoded `blockedCategories` Sets with one DB-backed source of truth means category changes don't require a deploy.
- The audit log gives us "why was this on-air at 3am" answers for the inevitable post-hoc review.

**Negative.**

- Admin maintenance burden. Streamers go offline, change rebrand, change content style — the whitelist needs periodic re-review. We mitigate with a `last_reviewed_at` field per entry and a UI nag at 90 days, but the work doesn't disappear.
- Polling cost. Liveness checks at 60s for ~50 Twitch + ~20 Kick streamers plus channel-info follow-ups for CCL run **~4 outbound calls/min combined** — well inside both platforms' free-tier limits but a new operational dependency. If the platform APIs degrade, the relay degrades too. Mitigation: cached last-known-good liveness for 3 minutes during platform outages.
- False negatives on category drift between polls. Worst case: a whitelisted streamer switches to a non-whitelisted category and we relay it for up to 60s before the drift check catches it. Tightening below 60s burns API quota for marginal safety gain; 60s is the accepted floor.
- Whitelist mode + thin Kick whitelist (~12 viable streamers per research) means Kick will frequently fall back to the evergreen channel. That's the right behavior, but it means "Kick" as a tab/category in the UI will spend most of its time showing Bob Ross. Document this expectation in the runbook.
- Defaulting `kick.mode = whitelist` on rollout is a **behavior change** for existing installs: random Kick rotation will narrow dramatically the moment this ships. Migration includes a one-time UI banner explaining the change and a link to the admin page.
- The mature/CCL gates rely on the streamer (or Twitch) having applied the right labels. Per [Ofcom's 2025 evaluation](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/how-accurate-are-twitchs-new-content-classification-labels), CCL coverage is incomplete and lagging. So CCL absence is not a clean signal — combine it with the streamer-level whitelist, don't rely on CCL alone. This is exactly why the layered model exists.
- The existing two-entry hardcoded blocklist gets removed in this PR. If for any reason the new service fails to initialize, we must **fail closed** (block direct submission, halt rotation) rather than silently revert to "no filter". The startup path explicitly checks for this.

## Alternatives considered

- **Just expand the hardcoded `blockedCategories` array.** Cheapest possible change. Rejected because (a) it remains a blocklist — new mature categories appear continually; (b) it doesn't address the direct-submission path having no filter at all; (c) it doesn't catch mid-stream drift; (d) requires a deploy per change.
- **Use only Twitch CCLs + Kick `has_mature_content` flags, skip the streamer/category list entirely.** Lower maintenance burden. Rejected because CCL coverage is incomplete (Ofcom finding above), Kick's mature flag is widely under-applied per the public-API issue tracker, and we want positive control over the relay's content rather than trusting upstream platform labeling.
- **Maintain the whitelist as a static JSON file in the repo.** Simpler than a DB table, no admin UI needed initially. Rejected because (a) every adjustment is a deploy; (b) audit trail is `git log` rather than per-row; (c) the existing admin UI for URL-stream management is the natural home; (d) we already use SQLite for everything else streaming-related.
- **Pull a curated family-friendly list from an external service (e.g., StreamElements "family friendly" team membership) on a schedule.** Sounds easy, but no external service publishes a list strict enough for our PG bar, and trusting an external classifier means we lose positive control. Rejected.
- **Only one mode (whitelist), no blacklist mode.** Simpler model. Rejected because Twitch's content distribution skews safe enough that a blocklist there is a less restrictive and still-acceptable starting point, and shipping both modes lets operators tune per-platform without code changes.
- **Apply enforcement only at the rotation candidate filter, not at direct submission.** Less new code, but the direct submission path remains a hole — anyone with admin auth can paste any URL. Rejected.
- **Apply enforcement only at submission, not via mid-stream drift checks.** Saves the polling cost. Rejected because drift is exactly the case the platform APIs make easy to catch and the case a blocklist/allowlist can't catch by itself.

## References

- [ADR-0008: Revive LiveKit for URL streams, recording, and transcription](0008-revive-livekit-for-url-streams-and-recording.md) — the URL-relay subsystem this gates.
- [Implementation plan](../plans/url-relay-whitelist-mode.md) — the phased PR breakdown and code-level design.
- [Seed whitelist data](../../../server/data/seeds/url-relay-whitelist.seed.json) — Twitch and Kick streamer + category whitelists with risk flags.
- [Runbook: URL-relay whitelist operations](../../operations/runbooks/url-relay-whitelist.md) — adding/removing entries, diagnosing fallback engagement, periodic re-review.
- [Twitch — Content Classification Labels](https://blog.twitch.tv/en/2023/06/20/introducing-content-classification-labels/)
- [Kick Public API documentation](https://docs.kick.com)
- [Ofcom — How accurate are Twitch's content classification labels?](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/how-accurate-are-twitchs-new-content-classification-labels)
