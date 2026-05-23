# Strapi (blog CMS)

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer has a blog at `/blog/<slug>`. The content lives in a separate **Strapi v4** CMS running on `:1337`. The integration is deliberately one-way and minimal — the React SPA never talks to Strapi. The blog rendering is server-side, for SEO and rich link previews.

## What's happening

```
1. Browser hits https://onestreamer.live/blog/my-article-slug
2. nginx routes /blog/{slug} to main_backend (NOT to Strapi)
3. Main Node server fetches article metadata from Strapi:
     GET http://127.0.0.1:1337/api/articles?filters[slug]=my-article-slug
4. Main server injects OG meta tags (<title>, <meta name="og:title">, etc.) into a blog HTML template
5. Returns the HTML to the browser
6. Browser displays the article (which is just HTML + assets from /var/www/html/blog/)
```

The React SPA has **zero references** to Strapi (`grep -rn "strapi\|:1337\|/blog/api" client/src/` returns nothing). The point of the integration is making blog links preview cleanly on Discord, Twitter, etc. — those crawlers fetch the URL and read meta tags before the page renders. So OneStreamer's main server is the SSR layer that ensures the meta tags are right.

## Where Strapi lives

- **Codebase**: `/root/strapi-blog/backend/` (backend) and `/root/strapi-blog/frontend/` (frontend; less important — the public-facing rendering goes through the main server)
- **Process**: runs separately from the OneStreamer PM2 apps. Likely systemd or a separate PM2 entry depending on setup history.
- **Port**: `127.0.0.1:1337` (localhost only)
- **DB**: Strapi's own SQLite (file inside the Strapi project, typically `.tmp/data.db`)
- **Public URL surface**:
  - `/strapi/*` → nginx proxies to `:1337` (admin panel, REST API, file uploads — for editorial use)
  - `/blog/<slug>` → main_backend (SSR with OG meta)
  - `/blog/assets/*` → static `/var/www/html/blog/assets/`

## Setup

This is a Strapi installation, not an OneStreamer feature — refer to [Strapi's docs](https://docs.strapi.io/) for the canonical guide. Quick recap for OneStreamer's case:

```bash
cd /root/strapi-blog/backend
npm install
npm run develop                 # admin UI on http://localhost:1337/admin
# Create an admin user the first time
```

OneStreamer's main server reads the Strapi API anonymously (the `/api/articles` route is publicly readable in the Strapi config). If you change Strapi permissions to require auth, the SSR code in [`server/index.js`](../../server/index.js) around line 9427 would need updating to send a Strapi API token.

## Content model

The minimum Strapi content type required is `Article` with:

- `slug` (Text, unique) — used in the URL
- `title` (Text)
- `description` (Text — used in OG description)
- `cover` (Media — used in OG image)
- `body` (Rich text / blocks — the article content)
- `publishedAt` (DateTime — Strapi default)

If you add more fields, update the SSR code to pull them.

## Credentials

| Env var | Purpose |
|---------|---------|
| (none) | OneStreamer reads Strapi anonymously today |

If you tighten Strapi permissions, you'd add a Strapi API token to OneStreamer's `.env` and read it from the SSR code.

## Code paths

| Concern | File |
|---------|------|
| SSR blog handler (the OneStreamer side) | [`server/index.js`](../../server/index.js) around line 9427 — fetches from `http://127.0.0.1:1337/api/articles`, builds HTML with OG tags |
| nginx routing | `/etc/nginx/sites-available/onestreamer.live` (`/blog/{slug}`, `/blog/assets/`, `/strapi/*` blocks) |
| Strapi codebase | `/root/strapi-blog/backend/` |
| Static blog assets | `/var/www/html/blog/` |

## Operational notes

- **Strapi runs independently.** A Strapi restart affects only the blog; the rest of OneStreamer is unaffected.
- **File uploads** (article cover images, embedded media) live in Strapi's `public/uploads/` directory. nginx serves these via the `/strapi/*` rewrite when Strapi-admin links to them, but for public-facing blog assets, copy to `/var/www/html/blog/assets/` so they're served by nginx directly without going through Strapi.
- **The main server caches Strapi responses** — check [`server/index.js`](../../server/index.js) around the SSR block. Cache TTL determines how quickly published-article edits propagate to live previews.
- **Strapi admin UI** is at `https://onestreamer.live/strapi/admin`. **Lock this down** with Strapi's built-in admin user management — anyone hitting it can edit articles.

## Backup

Back up Strapi alongside the main server. See [`/docs/operations/backup-restore.md`](../operations/backup-restore.md) — there's a dedicated section for Strapi DB + uploads.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `/blog/<slug>` returns 404 | Strapi has no article with that slug, or `publishedAt` is null (drafts aren't served) |
| OG meta missing in Discord preview | Strapi article missing `cover` or `description`; or the SSR code isn't reading those fields |
| Blog images broken | Cover image not in `/var/www/html/blog/assets/`, or asset URL points to Strapi's internal `/uploads/` path (rewrite needed) |
| `/strapi/admin` returns 500 | Strapi crashed — `journalctl -u strapi -n 50` or `pm2 logs strapi` |
| Strapi admin unreachable from internet | nginx `/strapi/*` block needs the rewrite (`rewrite ^/strapi/?(.*)$ /$1 break;`) — check config |

## See also

- [`/docs/architecture/overview.md`](../architecture/overview.md) — where Strapi fits in the system
- [`/docs/operations/deployment.md`](../operations/deployment.md) — topology and process management
- [`/docs/operations/backup-restore.md`](../operations/backup-restore.md) — backing up Strapi
- [Strapi docs](https://docs.strapi.io/)
