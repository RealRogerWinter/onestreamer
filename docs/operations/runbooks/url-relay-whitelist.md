# URL-relay whitelist — operations

_Last verified: 2026-05-26 against the worktree branch `worktree-url-relay-whitelist-mode` (Phase 0–5 plan unmerged at time of writing). Update once shipped._

## Symptoms this runbook covers

- "The Kick rotation keeps showing Bob Ross."
- "We just got a viewer complaint about <streamer>; need them off-air now."
- "A streamer is on the whitelist but the relay still won't relay them."
- "Logs show `[whitelist] fallback_engaged` repeatedly — is something broken?"
- "How do I temporarily disable whitelist mode for testing?"
- "How do I audit who added what entry?"

## How to confirm the system is healthy

Run these in order. The first one that doesn't pass tells you what's wrong.

```bash
# 1. Service is initialized.
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/whitelist/config | jq '.config'
# Expect: [{platform: "twitch", mode: "...", ...}, {platform: "kick", ...}]

# 2. Seed loaded.
sqlite3 server/data/onestreamer.db \
  "SELECT platform, list, COUNT(*) FROM url_relay_filter_entries GROUP BY platform, list;"
# Expect: rows for twitch+allow, twitch+block, kick+allow, kick+block.

# 3. Drift enforcer running.
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/whitelist/stats | jq '.enforcer'
# Expect: { running: true, lastTickAt: "<recent>", lastTickStatus: "ok" }

# 4. Platform APIs reachable. Look for "Twitch token refreshed" or
#    "Kick OAuth token refreshed" in the last hour.
grep -E '(Twitch|Kick) (token|OAuth)' logs/server-combined-0.log | tail -5
```

If 1–4 pass, the system is healthy. If any fails, follow the matching section below.

## Add or remove a streamer

**Via the admin UI (preferred):** AdminPanel → URL Stream Relay → Whitelist tab → select platform → Add Entry.

**Via the API (incident response — faster):**

```bash
# Add to allow list
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"twitch","entry_type":"streamer","value":"newstreamer","list":"allow","notes":"Added during incident, re-review later","risk_flag":"unreviewed"}' \
  http://127.0.0.1:8443/api/whitelist/entry

# Add to block list (removes from allow list automatically if there)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"twitch","entry_type":"streamer","value":"problematic","list":"block","notes":"Viewer complaint <ref>"}' \
  http://127.0.0.1:8443/api/whitelist/entry

# Get an entry ID to delete
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://127.0.0.1:8443/api/whitelist/config" \
  | jq '.entries[] | select(.value == "newstreamer") | {id, platform, entry_type, list}'

# Remove an entry
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/whitelist/entry/123
```

Changes take effect on the next candidate evaluation (within ~1s — the service invalidates its in-memory cache on mutation). If the relay is currently on that streamer, the drift checker stops it within `drift_check_seconds` (default 60s).

## Force-stop the current relay

If you need an immediate stop (you cannot wait the 60s drift window):

```bash
# Find the active urlId
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/url-stream/active | jq '.urlId'

# Stop it
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"urlId":"<urlId>"}' \
  http://127.0.0.1:8443/api/url-stream/stop
```

Then add the streamer to the block list (or remove from allow) so the rotation doesn't re-pick them.

## "The Kick rotation keeps showing Bob Ross / HotRadio"

**This is by design.** Kick's seeded whitelist is intentionally thin (~8 viable streamers). When none are live and no whitelisted-category stream meets the filters, the fallback cascade engages and relays an evergreen channel.

Confirm:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/whitelist/stats \
  | jq '.kick'
# fallbackActive: true is the signal.
```

If you want more variety on Kick:

1. Add more streamers to the Kick allow list (admin UI).
2. Or switch Kick to `mode: blacklist`, **accepting** the increased content risk — make sure the operator chain is informed.
3. Or set `platformWeight.kick` lower in the rotation settings so Twitch is picked more often.

## "Logs show `[whitelist] fallback_engaged` repeatedly"

Two flavors. Check which:

```bash
grep '\[whitelist\] fallback_engaged' logs/server-combined-0.log | tail -20
# Look for the "reason" field:
#   - "no_allowlist_live"    → expected behavior, no whitelisted streamer online
#   - "candidate_filter_rejected_all" → CCL/mature filter rejected everyone
#   - "platform_api_error"   → upstream API is degraded; investigate
```

For `no_allowlist_live`: nothing to do.

For `candidate_filter_rejected_all`: usually a Twitch CCL coverage edge case — many candidates flipped to `is_mature: true` simultaneously, e.g., after a category guideline update. Verify by spot-checking three of the rejected candidates and confirming Twitch labels them mature now.

For `platform_api_error`: see the next section.

## Platform API outage

If Twitch or Kick API is returning 5xx persistently, the enforcer tolerates this for **3 minutes** using cached last-known-good state. After that window, the active relay is stopped (we cannot prove it's still in policy) and the system falls back to the evergreen channel.

```bash
# Check enforcer's view of platform health
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/whitelist/stats \
  | jq '{twitch: .twitch.platformHealth, kick: .kick.platformHealth}'
# Expect: "healthy" / "degraded" / "down"
```

Action: wait it out. Both platforms post incidents at https://status.twitch.tv and https://status.kick.com.

If the outage is prolonged (>30 min) and operators decide to relax the gate during it, **temporarily** flip the mode to `off` via the admin UI and add a calendar reminder to flip back. **Do not leave `mode: off` in place after the outage resolves.**

## Temporarily disable whitelist for testing

```bash
# Save current modes so you can restore them.
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://127.0.0.1:8443/api/whitelist/config \
  | jq '.config' > /tmp/whitelist-config-backup.json

# Disable both
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"twitch","mode":"off"}' \
  http://127.0.0.1:8443/api/whitelist/mode
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"kick","mode":"off"}' \
  http://127.0.0.1:8443/api/whitelist/mode

# ... do testing ...

# Restore (read the backup file and POST each line)
```

The CCL / mature-flag gates still run in `off` mode — that's intentional and not configurable per the ADR.

## Audit — who added what

```bash
# Full recent activity
sqlite3 server/data/onestreamer.db \
  "SELECT at, actor, action, platform, entry_type, value, context
     FROM url_relay_filter_audit
     ORDER BY at DESC
     LIMIT 50;"

# Filter to a specific entry
sqlite3 server/data/onestreamer.db \
  "SELECT * FROM url_relay_filter_audit WHERE value = 'cohhcarnage';"

# Most recent mode changes
sqlite3 server/data/onestreamer.db \
  "SELECT at, actor, platform, before_json, after_json
     FROM url_relay_filter_audit
     WHERE action = 'mode_change'
     ORDER BY at DESC LIMIT 10;"
```

## Periodic re-review

Every 90 days, check for entries that haven't been re-reviewed:

```bash
sqlite3 server/data/onestreamer.db \
  "SELECT platform, list, value,
          COALESCE(last_reviewed_at, created_at) AS last_touched
     FROM url_relay_filter_entries
     WHERE julianday('now') - julianday(COALESCE(last_reviewed_at, created_at)) > 90
     ORDER BY last_touched ASC;"
```

For each: spot-check recent content. If still safe, hit the `POST /api/whitelist/entry/:id/review` endpoint (or click the "Mark reviewed" button in the admin UI). If no longer safe, remove or move to the block list.

## "A streamer is on the whitelist but isn't being picked"

Walk the funnel:

1. **Is the entry actually in the DB and on the right list?**
   ```bash
   sqlite3 server/data/onestreamer.db \
     "SELECT * FROM url_relay_filter_entries WHERE value = '<login>';"
   ```
2. **Is the streamer currently live?** Check on the platform manually.
3. **Is their current category passing?** A whitelisted streamer in a non-whitelisted, non-CCL-cleared category will still be rejected.
4. **Is the CCL gate rejecting them?**
   ```bash
   grep -i "blocked.*<login>" logs/server-combined-0.log | tail
   ```
5. **Did the rotation just not pick them this round?** Rotation is random within the candidate set — give it a few rotations.

## Prevention

- **Default fail-closed.** If `WhitelistService` fails to initialize, the server logs loud and rejects direct submissions when `URL_RELAY_REQUIRE_WHITELIST_SERVICE=true` (production default).
- **CCL coverage drift.** Twitch occasionally retroactively labels streams; this is mostly handled by the drift checker. If we see repeated late-labeling incidents, consider tightening `drift_check_seconds` from 60 to 30 — that doubles API cost but halves exposure.
- **Kick API changes.** The Public API is young (2024-2025). If endpoints move, the `KickRandomService` will start logging errors before the relay breaks. Monitor `[kick] api_error` log frequency.

## Related

- [ADR-0010](../../architecture/adr/0010-url-relay-whitelist-mode.md) — the design and rationale.
- [Implementation plan](../../architecture/plans/url-relay-whitelist-mode.md) — phased PR breakdown.
- [Seed data](../../../server/data/seeds/url-relay-whitelist.seed.json) — initial entries with risk flags.
- [`stream-stuck.md`](stream-stuck.md) — for relay-not-flowing issues unrelated to the gate.
- [`livekit-ingress-not-connected.md`](livekit-ingress-not-connected.md) — for the LiveKit-side failure mode.
