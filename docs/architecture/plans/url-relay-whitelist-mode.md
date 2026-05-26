# Implementation plan: URL-relay whitelist mode

_Companion to [ADR-0010](../adr/0010-url-relay-whitelist-mode.md). The ADR captures the **why**; this document captures the **how**._

This is a multi-PR feature. Each phase is independently mergeable, with no flag-flip behavior change until Phase 5.

## Phase 0 — Scaffolding & seed data (PR-W1)

### Deliverables

- New database tables (migration script, idempotent).
- Seed data populated from research (Twitch + Kick whitelists, evergreen channels, blocklist seed).
- A `WhitelistService` class that reads from these tables but is wired to nothing yet.
- Unit tests for the service's pure logic (mode checks, fallback resolution).

### Files

- `server/database/url-relay-whitelist-schema.sql` — new.
- `server/database/migrations/20260527-url-relay-whitelist.js` — runs the schema, applies seed.
- `server/services/WhitelistService.js` — new, ~250 lines.
- `server/data/seeds/url-relay-whitelist.seed.json` — already in this PR.
- `test/whitelist-service.test.js` — unit tests.

### Schema

```sql
-- One row per platform. Holds mode + fallback choices.
CREATE TABLE IF NOT EXISTS url_relay_filter_config (
  platform           TEXT PRIMARY KEY CHECK (platform IN ('twitch', 'kick')),
  mode               TEXT NOT NULL CHECK (mode IN ('off', 'blacklist', 'whitelist')) DEFAULT 'off',
  fallback_category  TEXT,                  -- e.g., 'Minecraft' (resolved to game_id at runtime)
  fallback_evergreen TEXT,                  -- e.g., 'bobross' (channel login)
  drift_check_seconds INTEGER NOT NULL DEFAULT 60,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by         TEXT
);

-- The actual allow/block entries.
CREATE TABLE IF NOT EXISTS url_relay_filter_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL CHECK (platform IN ('twitch', 'kick')),
  entry_type   TEXT NOT NULL CHECK (entry_type IN ('streamer', 'category')),
  value        TEXT NOT NULL,               -- streamer login (lowercase) or category name (canonical)
  list         TEXT NOT NULL CHECK (list IN ('allow', 'block')),
  is_evergreen INTEGER NOT NULL DEFAULT 0,  -- used by fallback cascade
  risk_flag    TEXT,                        -- nullable freeform: 'borderline', 'sponsor-reads', etc.
  notes        TEXT,
  source       TEXT,                        -- 'seed', 'admin', 'imported'
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by   TEXT,
  last_reviewed_at DATETIME,
  UNIQUE (platform, entry_type, value, list)
);
CREATE INDEX IF NOT EXISTS idx_filter_entries_lookup
  ON url_relay_filter_entries(platform, entry_type, list, value);

-- Append-only audit log.
CREATE TABLE IF NOT EXISTS url_relay_filter_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  actor       TEXT,
  action      TEXT NOT NULL,                -- 'add', 'remove', 'mode_change', 'fallback_engaged', 'drift_block'
  platform    TEXT,
  entry_type  TEXT,
  value       TEXT,
  before_json TEXT,
  after_json  TEXT,
  context     TEXT
);
```

### `WhitelistService` shape

```js
class WhitelistService {
  constructor({ db }) { this.db = db; this._cache = null; this._cacheAt = 0; }

  async initialize() { /* load + warm cache, throw on schema mismatch */ }

  // Returns { allowed: boolean, reason: string, gateThatBlocked: string }
  // currentGameId may be null if not yet known; caller is expected to re-check
  // post-getStreamURL when it is known.
  async checkAllowed({ platform, login, currentGameId, currentGameName, isMature, ccls, hasMatureContent }) { ... }

  // Returns array of { login, gameId, gameName, viewers } eligible right now.
  // Used by rotation as a positive filter on a candidate set.
  filterCandidates(platform, candidates) { ... }

  // For drift checks: is THIS stream still in policy right now?
  async isStillAllowed(streamSnapshot) { return this.checkAllowed(streamSnapshot); }

  // Fallback cascade entry point.
  async chooseFallback() {
    // 1) top live stream in a whitelisted-category for the configured fallback_category
    // 2) configured fallback_evergreen channel
    // 3) null (caller must black-frame)
  }

  // Mutators — all write to url_relay_filter_audit.
  async setMode(platform, mode, actor) { ... }
  async addEntry({ platform, entry_type, value, list, ... }, actor) { ... }
  async removeEntry(id, actor) { ... }

  // Subscriber pattern so Twitch/Kick random services hear about changes
  // without polling the DB on every candidate filter.
  onChange(cb) { ... }
}
```

The service is **stateful** (per `CLAUDE.md`): instantiate once in `server/index.js`, expose via `app.locals.whitelistService`. The two random services and `ViewBotURLService` receive it through their existing setter pattern.

### Mature-flag / CCL inputs

`checkAllowed` accepts platform-provided signals as inputs rather than fetching them itself. The caller (rotation, drift checker) is responsible for having the data. This keeps the service pure and avoids hidden network calls.

The Twitch random service already calls `/helix/streams`; CCL is a follow-up call to `/helix/channels?broadcaster_id=...` batched up to 100 at a time. Add that batch call in Phase 2.

### Tests in Phase 0

- `mode=off` allows everything (subject to CCL gate when supplied).
- `mode=blacklist` blocks listed streamers and listed categories.
- `mode=whitelist` allows iff streamer login on allowlist OR category on allowlist.
- CCL gate independent of mode: `SexualThemes` always blocks, regardless.
- `chooseFallback` returns category-fallback when candidates exist, evergreen when not, null when neither.
- Audit rows written on every mutation.
- Cache invalidation: a `setMode` call invalidates the cache; next `checkAllowed` reflects new mode.

---

## Phase 1 — Direct submission gate (PR-W2)

### Deliverables

- `ViewBotURLService.startURLStream()` calls `WhitelistService.checkAllowed()` after `validateURL()` and before `getStreamURL()`.
- A new setter `setWhitelistService()` follows the existing pattern (`setStreamService`, `setLiveKitService`, etc.).
- The gate is **fail-closed**: if `WhitelistService` is missing or its initialize threw, direct submission is rejected with HTTP 503 and a clear message.

### Insertion point

In `server/services/ViewBotURLService.js`, between lines 461 and 462 (post-`validateURL` success log, pre-`getStreamURL` call):

```js
// existing:  console.log(`✅ URL validated: ${validation.title} (${validation.platform})`);

if (this.whitelistService) {
  const channelLogin = this._extractLoginFromUrl(url, validation.platform);
  const check = await this.whitelistService.checkAllowed({
    platform: validation.platform,
    login: channelLogin,
    currentGameId: null,        // not known yet; will be re-checked after getStreamURL
    currentGameName: null,
    isMature: null,
    ccls: null,
    hasMatureContent: null,
  });
  if (!check.allowed) {
    console.log(`⛔ URL STREAM: whitelist gate rejected ${urlId}: ${check.reason}`);
    this._startingStream = false;
    return {
      success: false,
      error: `Content policy: ${check.reason}`,
      urlId,
      gateThatBlocked: check.gateThatBlocked,
    };
  }
} else if (process.env.URL_RELAY_REQUIRE_WHITELIST_SERVICE === 'true') {
  this._startingStream = false;
  return { success: false, error: 'Whitelist service not initialized', urlId };
}

// existing: const streamInfo = await this.extractorService.getStreamURL(url, quality);
```

`_extractLoginFromUrl` is one new private method that delegates to `URLStreamExtractorService.extractIdentifier(url)` and lowercases the result.

The optional `URL_RELAY_REQUIRE_WHITELIST_SERVICE=true` env flag turns on strict "must have whitelist service or refuse" mode. Off by default in Phase 1 (so partial rollout is safe); flipped on in Phase 5.

### Post-extraction recheck

After `getStreamURL()` returns and the platform's actual current category is known (we have `validation.platform` + `validation.title` and we can call the platform API for game_name), call `checkAllowed` once more with the category info. This catches the case where a streamer's current game changed between the time we resolved them and the time we started the stream. Only meaningful in `whitelist` mode; in `off` and `blacklist` mode the categorical check is symmetric.

### Tests in Phase 1

- Submission of `https://twitch.tv/some_blocked_login` returns 403 + reason when blacklist mode.
- Submission of `https://twitch.tv/cohhcarnage` succeeds in whitelist mode.
- Submission of a YouTube URL is unaffected by the gate (platform not on either list).
- Server stays up and direct submission works when `WhitelistService` failed to initialize and the env flag is off.
- Server refuses all submissions when `WhitelistService` failed AND the env flag is on.
- Audit row written on each rejection.

---

## Phase 2 — Rotation candidate filter + CCL fetch (PR-W3)

### Deliverables

- `TwitchRandomService.findRandomStreamer()` and `KickRandomService.findRandomStreamer()` consult `WhitelistService.filterCandidates()` rather than the local `this.blockedCategories` Set.
- The hardcoded `blockedCategories: ['ASMR', 'Pools, Hot Tubs, and Beaches']` in `RandomStreamRotationService:106` is removed (the seed migrates these into the DB as blacklist entries).
- New CCL fetch step in `TwitchRandomService`: after the initial `/helix/streams` call, batch `/helix/channels?broadcaster_id=...` for the candidate set (≤100 per call) and attach `content_classification_labels` to each candidate. Pass the augmented candidates to `filterCandidates`.
- Add an equivalent `has_mature_content` field on Kick candidates (it's already in the `/public/v1/livestreams` response — just plumb it through).
- New Twitch API call: `GET /helix/games?name=Minecraft` etc. at startup to resolve fallback category name → `game_id`, cached forever.

### Files

- `server/services/TwitchRandomService.js` — modify `findRandomStreamer`, add `_fetchCclForCandidates`.
- `server/services/KickRandomService.js` — modify `findRandomStreamer`, plumb mature flag.
- `server/services/RandomStreamRotationService.js` — remove hardcoded `blockedCategories` (lines 106, 1958, 1963, 1971), remove the duplicate filter logic.
- `server/services/WhitelistService.js` — extend with `_resolveGameId(platform, name)` caching.

### Filter integration

```js
// Before (TwitchRandomService.findRandomStreamer):
const filtered = streams.filter(s => !this.blockedCategories.has(s.game_name));

// After:
let candidates = streams;
if (this.whitelistService) {
  // Attach CCL data (one batched call per ≤100 candidates).
  candidates = await this._attachCclData(candidates);
  candidates = this.whitelistService.filterCandidates('twitch',
    candidates.map(s => ({
      login: s.user_login,
      gameId: s.game_id,
      gameName: s.game_name,
      isMature: s.is_mature,
      ccls: s.content_classification_labels || [],
      viewers: s.viewer_count,
      raw: s,
    }))
  );
}
```

### Cost guardrails

Per the API research: 50 Twitch + 20 Kick users at 60s liveness is ~3.5 calls/min plus follow-ups, well inside both platforms' quotas. CCL adds ~1 call/min, still fine. We log `Ratelimit-Remaining` on every Twitch response and emit a warning at <50.

### Tests in Phase 2

- Rotation in `whitelist` mode picks only from the seeded streamer list.
- Rotation in `blacklist` mode skips a streamer once added to the blocklist at runtime (cache invalidates within 1s of the mutation).
- A Twitch candidate with `is_mature: true` is dropped even in `off` mode.
- A Twitch candidate with `content_classification_labels: ['SexualThemes']` is dropped even in `off` mode.
- A Kick candidate with `has_mature_content: true` is dropped even in `off` mode.
- The category fallback for `twitch::Minecraft` returns the top-viewer Minecraft stream when the streamer allowlist has no live members.

---

## Phase 3 — Mid-stream drift enforcement (PR-W4)

### Deliverables

- New service `WhitelistEnforcer` that runs in the main server process.
- Polls the current active URL relay's `{platform, login, currentGameId, ccls, isMature}` every `drift_check_seconds` (default 60s).
- On policy violation: calls `viewBotURLService.stopURLStream(urlId)` and emits a Socket.IO event `'whitelist-drift-stop'` so the admin UI shows the reason. The rotation service's existing failure handler then naturally triggers the next rotation; we do **not** force a rotation directly — that keeps the lifecycle linear.

### Files

- `server/services/WhitelistEnforcer.js` — new, ~120 lines.
- `server/index.js` — instantiate, wire to `viewBotURLService` and `whitelistService`, store on `app.locals`.

### Sketch

```js
class WhitelistEnforcer {
  constructor({ viewBotURLService, whitelistService, twitchClient, kickClient, io }) { ... }

  start() {
    this._timer = setInterval(() => this._tick().catch(...), 60_000);
  }

  async _tick() {
    const active = this.viewBotURLService.getActiveStream();
    if (!active || active.platform === 'youtube') return;     // not gated

    const fresh = await this._refreshStreamSnapshot(active);  // re-fetch CCL + game
    const check = await this.whitelistService.isStillAllowed(fresh);
    if (!check.allowed) {
      await this.whitelistService.logAudit({
        action: 'drift_block', platform: fresh.platform, value: fresh.login,
        context: check.reason,
      });
      await this.viewBotURLService.stopURLStream(active.urlId);
      this.io.emit('whitelist-drift-stop', {
        urlId: active.urlId, reason: check.reason, login: fresh.login,
      });
    }
  }
}
```

### Why this is its own service, not part of `WhitelistService`

`WhitelistService` is pure policy. `WhitelistEnforcer` orchestrates I/O — platform polls, stream stops, socket emits. Keeping them separate lets us unit-test policy without mocking the world.

### Tests in Phase 3

- A streamer who starts in a whitelisted game and switches to a blacklisted one is stopped within one tick.
- A streamer whose CCLs gain `SexualThemes` mid-broadcast is stopped within one tick.
- A platform API outage that returns 5xx three times in a row does **not** stop the stream (the enforcer tolerates transient failures; cached last-known-good is used for up to 3 minutes).
- Stopping triggers a rotation, not a manual restart.

---

## Phase 4 — Admin UI (PR-W5)

### Deliverables

- New tab/section in `client/src/components/URLStreamManagement.tsx` (or a sibling component imported into the same page) for whitelist management.
- Per-platform panels (Twitch / Kick) with:
  - Mode selector (off / blacklist / whitelist).
  - Fallback category text input (with a search-affordance against the platform's category list — out-of-scope for v1, just a text field).
  - Fallback evergreen channel login input.
  - Allow list (streamers + categories).
  - Block list (streamers + categories).
  - Add-entry form: type (streamer/category), value, notes, risk flag.
- Recent audit-log view (latest 50 events) with filter by action.
- Live status: "currently on fallback? which one? why?" badge.
- Drift event toast: when `whitelist-drift-stop` arrives, surface "Stopped <login> — drifted to <new game>".

### Files

- `client/src/components/admin/WhitelistManagement.tsx` — new.
- `client/src/components/admin/WhitelistManagement.css` — new.
- `client/src/components/URLStreamManagement.tsx` — import and render the new component in a new tab.
- `client/src/services/whitelistApi.ts` — new, thin fetch wrapper.

### API endpoints (Phase 4, in new `server/routes/whitelist.js`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/api/whitelist/config` | admin | Both platforms' config + entries + recent audit. |
| `POST` | `/api/whitelist/mode` | admin | `{platform, mode}`. |
| `POST` | `/api/whitelist/entry` | admin | `{platform, entry_type, value, list, notes, risk_flag}`. |
| `DELETE` | `/api/whitelist/entry/:id` | admin | Remove. |
| `POST` | `/api/whitelist/fallback` | admin | `{platform, fallback_category, fallback_evergreen}`. |
| `POST` | `/api/whitelist/entry/:id/review` | admin | Stamp `last_reviewed_at = now()`, no other change. |
| `GET`  | `/api/whitelist/audit` | admin | Paginated audit log. |

All endpoints behind `authenticateAdmin` middleware (existing pattern in `server/middleware/auth.js`, called out in `CLAUDE.md` as non-bypassable).

### UI tests (RTL)

- Adding an entry hits the API and the row appears in the table.
- Changing mode shows a confirmation when going to/from `whitelist` (because behavior changes meaningfully).
- A `whitelist-drift-stop` socket event surfaces a toast with the reason and the new game.

---

## Phase 5 — Flip defaults, write runbook entry, document (PR-W6)

### Deliverables

- `url_relay_filter_config.mode` defaults: `twitch = blacklist`, `kick = whitelist`. **Migration sets these on first run only**; subsequent restarts respect the operator's last setting.
- Set `URL_RELAY_REQUIRE_WHITELIST_SERVICE=true` in production env.
- Update [`docs/getting-started/first-stream.md`](../../getting-started/first-stream.md) to mention that URL relay now respects a content filter and link to the runbook.
- Update [`docs/architecture/overview.md`](../overview.md) to add the WhitelistService + WhitelistEnforcer to the service inventory.
- Add a CHANGELOG entry under "Unreleased":
  - `### Added` — Whitelist mode for URL relay (Twitch, Kick).
  - `### Changed` — Kick relay defaults to whitelist on first install; expect a banner.
- Mark ADR-0010 status from `proposed` to `accepted`.

---

## Observability

Every block decision writes one audit row. Beyond that:

- `console.log` with a structured prefix `[whitelist]` on every block, mode change, and fallback engagement — picks up cleanly in the existing log pipeline.
- New Socket.IO admin event: `whitelist:status` emitted every minute and on change, payload `{platform, mode, allowedNow: number, blockedNow: number, fallbackActive: boolean, fallbackTarget: string|null}`. The admin UI uses this for the live status badge.
- Optional: a 24-hour rolling counter of (blocks, fallbacks, drift_stops) exposed at `GET /api/whitelist/stats` for inclusion in any future dashboard.

We do **not** add Prometheus metrics or a separate monitoring agent — out of scope and inconsistent with the project's current observability surface.

## Testing strategy summary

| Layer | What it covers | Where |
|---|---|---|
| Unit | Pure policy decisions in `WhitelistService` | `test/whitelist-service.test.js` |
| Integration | Direct-submission gate end-to-end with mock URL extractor | `test/url-stream-whitelist.test.js` |
| Integration | Rotation candidate filter with mocked Twitch/Kick API responses | `test/rotation-whitelist.test.js` |
| Integration | Drift enforcer with a fake clock and mocked `viewBotURLService` | `test/whitelist-enforcer.test.js` |
| RTL | Admin UI flows | `client/src/components/admin/__tests__/WhitelistManagement.test.tsx` |
| Smoke | Walk through [`first-stream.md`](../../getting-started/first-stream.md) with whitelist mode on, confirm fallback engages when no whitelisted streamer is live | Manual, recorded in PR description per `CLAUDE.md` requirement |

External API calls are **never made in tests** — Twitch and Kick clients are mocked. The unit tests run with `WHITELIST_TEST_FIXTURES_PATH` pointing at canned JSON in `test/fixtures/`.

## Migration & rollout

1. **Deploy Phase 0.** Tables exist, seed is in, service is wired but does nothing because no caller consults it. Zero behavior change.
2. **Deploy Phase 1.** Direct submission gate active. `mode=off` everywhere, so behavior unchanged for normal use. Verify by submitting a known-clean URL.
3. **Deploy Phase 2.** Rotation respects the service. Still `mode=off`, so behavior is identical to before *except* the CCL + mature flags now actually filter (previously not consulted at all). Watch for false-positive blocks of legitimate streams.
4. **Deploy Phase 3.** Drift checker active. Still `mode=off`, so drift only catches CCL changes mid-stream. Watch for stop frequency.
5. **Deploy Phase 4.** Admin UI shipped. Operator manually flips Kick to `whitelist` and watches the rotation for an hour to verify fallback behavior.
6. **Deploy Phase 5.** Defaults change on first install; production already has operator-chosen settings so this is no-op for the current install. Production env flag `URL_RELAY_REQUIRE_WHITELIST_SERVICE=true` is set, making any future startup-time misconfiguration fail closed.

Each phase is one PR. The maintainer can pause between any two with no system in a broken state.

## Open questions

- **How aggressively should category-fallback filter by viewer count?** Currently planned: top stream in the fallback category. Could be the top-10-then-random to spread load. Defer to operator feedback after Phase 5.
- **Do we want a "review nag" notification** in the admin UI when entries pass 90 days without `last_reviewed_at`? Probably yes, but it's out of scope for this feature and belongs in a follow-up.
- **Cross-platform identity:** if a streamer has the same login on both Twitch and Kick (common — e.g., `cohhcarnage`), do we want one entry to cover both? Current design: two separate entries, one per platform. Simpler, no false-positive matches. Reconsider if the operator burden grows.
- **Should `mode` change require a confirmation step in the API** (not just the UI)? Today no — a single POST flips it. Could add `?confirm=true` for `whitelist` transitions. Defer.
