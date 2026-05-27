# Stale frontend after deploy

_Last verified: 2026-05-27 against commit a7891d0._

## Symptoms

- A merged-and-pulled client feature isn't visible in the browser.
- Code review confirms the component is wired correctly (mounted in `App.tsx`, registered in the nav, etc.) and the test suite passes.
- Hard-refreshing the browser (`Ctrl/Cmd-Shift-R`) doesn't change anything.
- `git log` shows the PR landed on `main` days or weeks ago.
- A fresh `cd client && npm run build` succeeds, but the live site still doesn't show the feature.

The historical version of this incident: on 2026-05-27 the PR-W5 Relay Whitelist UI (merged 2026-05-26) was invisible in the admin panel despite multiple `pm2 restart`s. Diagnosis revealed `/var/www/html/static/js/main.af6f3bce.js` had been the live bundle for **four months** (since 2026-01-11).

## How to confirm

Compare the bundle hash nginx serves to the one in `client/build`:

```bash
grep -oE 'main\.[a-f0-9]+\.js' /var/www/html/index.html
grep -oE 'main\.[a-f0-9]+\.js' /root/onestreamer/client/build/index.html
```

If they differ — or `/var/www/html/index.html` is older than the latest commit that touched `client/` — the docroot is stale.

Quick sanity probe for a specific feature (substitute your string):

```bash
curl -ks https://localhost/ | grep -oE 'main\.[a-f0-9]+\.js'
curl -ks https://onestreamer.live/static/js/main.<hash>.js | grep -o "Relay Whitelist"
```

If the string is absent, the live bundle predates the feature.

## Likely causes

1. **The deploy step that builds + rsyncs to `/var/www/html` was skipped.** This is the dominant cause. nginx's catch-all (`location /` in `/etc/nginx/sites-available/onestreamer.live`) serves static files from `/var/www/html`, **not** from `client/build` and **not** by proxying to the Node server. A `git pull && pm2 restart` updates the backend but does nothing for the frontend.
2. **CDN or browser cache.** Less likely — bundle hashes change per build, so a stale cached `main.<hash>.js` only happens if the index.html is also stale (which collapses into cause 1).
3. **Build silently failed.** Check `client/build/index.html` mtime vs. the time you ran the build.

## Resolution

The fast path (assuming `client/` is at the desired commit):

```bash
cd /root/onestreamer/client
npm run build                                              # ~1–2 min, warnings are fine
sudo rsync -a --no-owner --no-group build/ /var/www/html/  # no --delete, preserves blog/ + turn-test.html
grep -oE 'main\.[a-f0-9]+\.js' /var/www/html/index.html    # confirm new hash
curl -ks https://onestreamer.live/ | grep -oE 'main\.[a-f0-9]+\.js'  # confirm nginx serves new hash
```

No nginx reload needed — `/var/www/html` is served via `try_files`, and the index.html's `<script>` tag points to a new content-hashed filename, so browsers auto-bust.

If something looks wrong after the swap, the previous docroot was backed up during the 2026-05-27 incident at `/var/www/html.bak-20260527-0205`. Future deploys should snapshot to `/var/www/html.bak-<date>` before rsync.

## Prevention

- `scripts/deploy/start-production.sh` (updated 2026-05-27) now builds the client and syncs to `/var/www/html` between the SSL-cert check and the nginx reload. Always use this script for full deploys.
- `config/ecosystem.config.js` carries an in-file comment pointing here, so anyone debugging PM2 config sees the manual-deploy recipe.
- The `/var/www/html` docroot is **not** managed by git; treat it like any other build artifact. The repo source of truth is `client/build`, which itself is `.gitignore`d.
- If you ever again see a "PR merged but feature missing" report, run the bundle-hash comparison from "How to confirm" *first* — it takes 5 seconds and rules out (or in) the deploy gap before you dig into code.
