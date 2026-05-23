# Upgrades

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer is a rolling-deployment project — there's no semver release cadence today. Operators pull `main`, run migrations, restart. This page captures the pattern.

> [!NOTE]
> Once the project starts tagging releases (planned for the docs-overhaul PR — initial tag `v0.1.0`), this page will gain a per-version changelog. For now, the canonical change history is the git log; significant database changes are captured in [`server/migrations/`](../../server/migrations/).

## Upgrade procedure (current)

```bash
# 0. Back up first. Always.
cd /root/onestreamer
cp server/data/onestreamer.db server/data/onestreamer.db.backup-$(date +%F-%H%M)

# 1. Pull
git fetch
git log HEAD..origin/main --oneline    # preview what's coming
git pull origin main

# 2. Dependencies (only if package.json changed)
git diff HEAD~1 -- package.json client/package.json chat-service/package.json
# If anything changed:
npm install
cd client && npm install && cd ..
cd chat-service && npm install && cd ..

# 3. Migrations
ls -la server/migrations/                 # see what scripts exist
# Run any new migration scripts. Each is idempotent (re-running is safe).
node server/migrations/<new-migration>.js

# 4. Restart
pm2 restart all --update-env
pm2 logs                                   # watch for boot errors for ~30 seconds

# 5. Smoke-test
curl -sk https://onestreamer.live/health
curl -sk https://onestreamer.live/api/stream/status
# Open the site in a browser, confirm it loads
```

The `--update-env` flag is important. Without it, PM2 keeps the previously-loaded environment and won't pick up `.env` changes.

## What to back up before upgrading

| Concern | Action |
|---------|--------|
| Database schema change | Back up `server/data/onestreamer.db` |
| Migration adds a column or table | Back up before, verify after |
| Migration changes existing data | Back up before, **dry-run on a copy first** |
| nginx config change | Back up `/etc/nginx/sites-available/onestreamer.live` |
| Whisper version change | Back up `whisper/models/*.bin` (or re-download) |

See [`backup-restore.md`](backup-restore.md) for the full backup procedure.

## Migration scripts

[`server/migrations/`](../../server/migrations/) holds standalone scripts that idempotently apply schema or data changes. Each is self-contained — run with `node server/migrations/<name>.js`.

Examples by category:

| Category | Examples |
|----------|----------|
| Schema additions | `add_ip_bans.js`, `add_streaming_logs.js`, `add-account-deletion-tables.js`, `add_bug_reports.js`, `add-summon-bot-support.js`, `add-auto-summon-bot.js`, `add-avatar-description.js`, `add-global-prompt-table.js`, `add-llm-model-column.js` |
| Table creation | `setup-transcription-tables.js`, `setup-clips-tables.js`, `setup-viewbot-tables.js`, `setup-recording-tables.js`, `create_chatbots_table.sql`, `create_streambot_messages.sql` |
| Data migrations | `migrate-points-system.js` (calculated → balance), `migrate_stock_unlimited.js`, `migrate_unlimited_stacks.js` |
| Item seeding | `add-101soundboards-item.js`, `add-megaphone-item.js`, `add-heart-swarm.js`, `add-stream-reducer-item.js`, `add-visualfx-items.js`, `add-sample-emojis.js` |

After running any migration, **restart the main server** so it re-reads the schema on boot.

## Rollback

If an upgrade goes badly:

```bash
# 1. Stop the app
pm2 stop all

# 2. Roll back code
git log --oneline -5             # find the previous-known-good commit
git reset --hard <previous-good-sha>

# 3. Restore the pre-upgrade DB
cp server/data/onestreamer.db.backup-<date> server/data/onestreamer.db

# 4. If you ran a destructive migration, you may also need to skip it in future
#    (or write a reverse-migration). Investigate before re-pulling.

# 5. Reinstall dependencies in case they changed
npm install
cd client && npm install && cd ..
cd chat-service && npm install && cd ..

# 6. Restart
pm2 restart all --update-env
```

There is **no automated rollback tooling**. Manual rollback is the only path. Hence: always back up before upgrading.

## Specific upgrade hazards to know about

### Node version

The project targets **Node 18+**. Bumping major Node versions (16 → 18, 18 → 20) requires reinstalling `node_modules` from scratch — native modules (mediasoup, @roamhq/wrtc, bcrypt) have ABI bindings per Node major.

```bash
rm -rf node_modules client/node_modules chat-service/node_modules
npm run install-all
```

### mediasoup version bump

The mediasoup native worker is locked to the package version. Bumping `mediasoup` in `package.json` requires:

1. Rebuilding the worker (`npm install` triggers the build).
2. Restarting the server.
3. Browser-side `mediasoup-client` major version should match — keep them in lockstep.

### whisper.cpp updates

The bundled `whisper.cpp` binary lives in `/root/onestreamer/whisper/whisper.cpp/`. To update:

```bash
cd /root/onestreamer/whisper/whisper.cpp
git pull
make clean && make
# Confirm the new binary works
./main --version
pm2 restart onestreamer-server
```

Models are forward-compatible but new models may need re-downloading via `node setup-whisper.js`.

### Schema changes that touch `users` or `user_stats`

These two tables are foundational. Any migration here:

1. Back up first.
2. Run on a copy: `cp server/data/onestreamer.db /tmp/test.db && node server/migrations/<migration>.js --db /tmp/test.db` (if the script supports a `--db` flag; otherwise edit the script's DB path temporarily).
3. Verify the result with `sqlite3 /tmp/test.db ".schema users"` and a few sanity queries.
4. Only then run against production.

### LiveKit re-enablement (someday)

If [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md) is reversed and LiveKit returns to the production streaming path:

- Confirm `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are no longer the dev defaults (`devkey` / `secret`).
- Confirm the dormant `ViewBotLiveKit*.js` services still build (they may have rotted).
- Update [ADR-0002](../architecture/adr/0002-mediasoup-primary-livekit-dormant.md) with a **superseded by ADR-XXXX** note rather than editing.

### Strapi major-version bump

Strapi is on v4 (per `package.json` in `/root/strapi-blog/backend`). v5 introduces breaking changes (Content API differences, plugin system). Plan:

1. Bring up a Strapi v5 instance on a non-prod port with the same DB schema.
2. Export → import content.
3. Update the main server's blog-rendering code (`server/index.js` around line 9427) to match v5 API responses.
4. Swap traffic by changing nginx upstream.

## Upgrade checklist template

Copy this into a runbook / incident doc when planning an upgrade:

```markdown
## Upgrade: <date> from <previous-sha> to <target-sha>

- [ ] Pre-upgrade backup taken: <backup path>
- [ ] Reviewed commits via `git log <prev>..<target> --oneline`
- [ ] Reviewed migration list: <migration files run, in order>
- [ ] Reviewed any dependency bumps: <none / list>
- [ ] Maintenance window communicated in chat
- [ ] Pulled
- [ ] Dependencies installed
- [ ] Migrations run
- [ ] Restarted
- [ ] Smoke test: `/health` + signup + take over a stream + chat
- [ ] No new errors in `pm2 logs` for 5 minutes post-restart
- [ ] CHANGELOG.md entry added (once the project has one)
```

## See also

- [`backup-restore.md`](backup-restore.md) — back up before you upgrade
- [`deployment.md`](deployment.md) — the topology you're upgrading
- [`/docs/architecture/data-model.md`](../architecture/data-model.md) — how migrations relate to the schema
- [`/CHANGELOG.md`](../../CHANGELOG.md) — version-by-version changes (once tagged releases begin)
