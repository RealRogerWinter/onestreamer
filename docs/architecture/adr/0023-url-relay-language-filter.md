# ADR-0023: URL-relay English-language filter

* **Status:** Accepted
* **Date:** 2026-05-27
* **Phase:** Extends ADR-0010 (URL-relay whitelist mode)
* **Related:** [`server/services/WhitelistService.js`](../../../server/services/WhitelistService.js), [`server/services/TwitchRandomService.js`](../../../server/services/TwitchRandomService.js), [`server/services/KickRandomService.js`](../../../server/services/KickRandomService.js), [`server/database/url-relay-whitelist-schema.sql`](../../../server/database/url-relay-whitelist-schema.sql)

## Context

[ADR-0010](0010-url-relay-whitelist-mode.md) introduced the per-platform whitelist for the URL relay. The current selection logic surfaces streams in any language the broadcaster declares. `TwitchRandomService.getLiveStreams()` already passes `language=en` as a query parameter to `/helix/streams`, but the per-stream `language` field on the response (`TwitchRandomService.js:339`) is never re-checked, and the field is plumbed nowhere — so a Helix mislabel, a `language=other` row, or a streamer whose interface language doesn't match their spoken content can pass through. Kick's `KickRandomService` has no language filter at all: it relies on `/stream/livestreams/<lang>` URL-path filtering, but that has the same broadcaster-declared-mislabel problem and we never verify the response.

Product mandate (matching ADR-0010's family-friendly bar): the unattended 24h rotation should default to English-language content. Today's behavior is "trust the platform's per-stream language tag" — but neither service actually checks the tag against a preference. We need an explicit gate.

Per the API research we did:

* **Twitch Helix** `language` on `/helix/streams` is ISO-639-1, broadcaster-declared, ~10–20% mislabel rate per Twitch's own dev-forum threads.
* **Kick** has a public API since 2024 with a `language` field on `/public/v1/livestreams` and `/public/v1/channels`, plus a `livestream.metadata.updated` webhook. The existing helper does not use this API — it scrapes `kick.com/stream/livestreams/<lang>` via curl_cffi. Moving to the official API is **not** part of this ADR; see "Deferred" below.
* **Kick scrape-endpoint quirks discovered during live verification (2026-05-27):**
  - The `language` field IS present per-stream on the scrape response, but its value is a **lowercase English language name** (`"english"`, `"spanish"`, `"turkish"`, `"polish"`, `"portuguese"`, `"russian"`, `"arabic"`), NOT an ISO-639-1 code. Twitch returns the ISO code (`"en"`). The two surfaces are not compatible by default.
  - The `/livestreams/<lang>` URL filter is a **hint, not a hard constraint**: of 30 streams requested with `/livestreams/en`, only 11 actually carried `language: "english"`. The remaining 19 returned `spanish` / `turkish` / `polish` / etc.
  - These two facts together make the post-filter via WhitelistService load-bearing. A naive trust of the URL filter would surface ~63% non-English content for an English-only operator.

## Decision

### Configuration model

Add a JSON-encoded TEXT column `preferred_languages` to `url_relay_filter_config`, populated from the seed with `["en"]` for both platforms by default. Empty array disables the language gate for that platform (operator opt-out).

### Gate semantics

A new gate inside `WhitelistService.checkAllowed()`, evaluated **after** the always-on `mature_flag` and `ccl_gate` checks and **after** the `mode === 'off'` short-circuit. Off mode skips the language gate entirely; that's the operator's explicit "no policy" knob.

When `preferred_languages` is non-empty:

| `snapshot.language`            | `mode = 'blacklist'`          | `mode = 'whitelist'`          |
| ------------------------------ | ----------------------------- | ----------------------------- |
| set, in preferred list         | pass                          | pass                          |
| set, not in preferred list     | reject (`language_not_preferred:<lang>`) | reject (same) |
| missing/null                   | pass (**lenient**)            | reject (`language_unknown_strict`) |

The lenient-on-null path in blacklist mode is the deliberate trade-off: blacklist mode's product intent is "include by default unless specifically excluded." Treating an absent language tag as exclusion would over-filter in the exact mode designed for permissiveness. Whitelist mode already encodes "exclude by default unless specifically included" — strict-on-null matches that posture.

### Plumbing

Both `TwitchRandomService` and `KickRandomService` already shape candidates for `WhitelistService.filterCandidates(platform, shaped)`. This change adds a `language` field to the shape:

* **Twitch**: pass through `stream.language` from the Helix `/helix/streams` payload (always present on live streams).
* **Kick**: pass through `stream.language` after the Python helper normalizes from any of `language`, `broadcaster_language`, `channel.language`, `channel.broadcaster_language` carriers (the scrape endpoint's exact shape isn't formally documented; we probe the known spots and fall back to the URL-path filter as the last-resort signal). The helper also **maps Kick's English language names to ISO-639-1 codes** via a `LANGUAGE_NAME_TO_ISO` table (40+ languages); a 2-letter input is passed through unchanged. Unknown names normalize to `None`, which the gate treats as "truly unknown" (strict-rejects in whitelist mode, lenient in blacklist mode) — the operator can extend the mapping if Kick ships a new option.

`getCurrentStreamSnapshot()` on both services likewise gains a `language` field, so the existing `WhitelistEnforcer` drift check picks up if a streamer switches their declared language mid-broadcast.

### Admin API

New endpoint `POST /api/whitelist/language` accepting `{ platform, preferred_languages: ["en", ...] }`. Lives in `server/routes/whitelist.js` alongside the existing `/mode`, `/fallback`, `/entry` endpoints. Reads use the existing `GET /api/whitelist/config` (the cache returns parsed arrays). All writes hit `WhitelistService.setLanguagePreference`, which normalizes (trim → lowercase → dedupe) and writes a `language_preference_change` audit row.

### Helix `language` query parameter

The hardcoded `language=en` on Twitch's `/helix/streams` query (`TwitchRandomService.js:167`) is preserved as a server-side prefilter for the default case. It's **not** consulted from `preferred_languages` because Helix's parameter accepts only a single language and the rotation service doesn't currently read the whitelist config. The post-filter via `WhitelistService` is the authoritative check that handles mislabels. To support a different default language (`preferred_languages=['ja']` etc.), Phase 2 will plumb the config through to the Helix query — see Deferred.

## Consequences

**Positive.**

* English-only rotation is now an explicit DB-controlled gate, not an implicit side effect of one hardcoded Helix query parameter that nothing verifies.
* The same machinery covers both platforms, including the drift check.
* The lenient-vs-strict-on-null split matches the precision posture already encoded in each mode, so no new operator knob is needed for Phase 1.
* Empty `preferred_languages` is a clean opt-out path for operators who later want to allow multi-language rotation without disabling the whole mode.

**Negative / accepted.**

* Twitch's `language` field has documented ~10–20% mislabel — Tier 1 alone leaks accordingly. Mitigated only when Tier 2 (title-text detection) ships.
* Kick's scrape endpoint may not return `language` per stream. The Python helper falls back to the URL-path language as the signal, which is "trust the URL filter." This trades strict accuracy for not over-filtering Kick to zero. The drift check separately exercises the channel API which has more reliable language data.
* Whitelist-mode-strict-on-null can reject Kick streams whose language wasn't surfaced. Operationally, the seed already runs Kick in whitelist mode with a tight allowlist, so the surface is small.

## Deferred (future phases)

These were considered and explicitly NOT done in Phase 1 to keep the PR scope tight:

1. **Kick Public API + OAuth migration.** Switching the helper from unauth scrape (`kick.com/stream/livestreams/<lang>`, `kick.com/api/v2/channels/<slug>`) to authenticated `api.kick.com/public/v1/*` calls is the right way to get reliable `language` data and would let us subscribe to the `livestream.metadata.updated` webhook. Free of cost (OAuth registration is no-fee per `dev.kick.com`); deferred only for blast radius — the scrape path is what provides authenticated JWT playback URLs, and replacing it needs its own PR.
2. **Twitch Helix multi-language query.** Plumb `preferred_languages` from the WhitelistService into `TwitchRandomService.getLiveStreams()`'s `language` URL parameter, with a multi-query strategy when the operator picks more than one language. Today's hardcoded `language=en` works correctly for the default; non-English defaults need this work.
3. **Title-text language detection.** When the API field is missing or returns `"other"`, run the title through `lingua-language-detector` (~7ms, Rust-backed, designed for short noisy text). Per the research, this catches ~most of the remaining mislabeling at trivial cost.
4. **Whisper audio sampling.** Last-resort 15–30s HLS audio probe with `faster-whisper` tiny model when both API and title detection are inconclusive. ~5–8s per check, CPU-only. Gated behind a `language_verdict_cache` table with 7-day TTL.
5. **EventSub / Kick webhook integration.** Push-invalidate language verdicts on `channel.update` v2 (Twitch) and `livestream.metadata.updated` (Kick).
6. **Admin UI surface.** Phase 1 ships DB+API+seed only. A future React panel exposes the toggle alongside the existing mode/fallback controls.

## Migration

`server/migrations/202605270010-url-relay-add-preferred-languages.js` ADDs the column on existing DBs. The migration skips silently when `url_relay_filter_config` doesn't exist yet — that table is owned by `WhitelistService._applySchema()` which runs after the migration runner on a fresh install, and the updated schema file declares the column at CREATE TABLE time.
