/**
 * Social-embed route module
 *
 * Mounts two Express GET handlers that intercept HTML page requests from
 * social-media crawlers (Discord, Twitter/X, Facebook, Slack) and rewrite
 * the index.html response with article- or clip-specific Open Graph + Twitter
 * Card + JSON-LD meta tags. Browsers asking for these URLs still get React
 * (the rewritten HTML still boots the SPA), but link unfurlers see rich
 * previews instead of a generic "OneStreamer" card.
 *
 * Extracted from `server/index.js` startServer() body in PR 4.3. The two
 * blocks were ~290 lines of self-contained Express middleware that didn't
 * touch any internal service except `clipService` (and the `app` instance
 * itself). Moving them out of startServer() makes the orchestrator body
 * shorter without changing wire behaviour.
 *
 *   GET /blog/:slug   — Strapi-backed blog article. Fetches the article over
 *                       HTTP from `http://127.0.0.1:1337/api/articles?...`
 *                       and rewrites the static blog HTML
 *                       (/var/www/html/blog/index.html). Non-matching slugs
 *                       fall through to `next()` so static assets and
 *                       index.html are served by the existing static
 *                       middleware.
 *   GET /clips/:clipId — UUID-shaped clip ID. Reads the React SPA's
 *                       index.html, injects video.other-typed Open Graph
 *                       tags + a Twitter player card pointing at the
 *                       /api/clips/<id>/stream endpoint. Non-UUID paths
 *                       fall through to React via `next()`.
 *
 * `deps` (all required unless noted):
 *   - clipService          Source of clip metadata for the /clips/:clipId
 *                          handler. The handler short-circuits to the React
 *                          SPA when the clip isn't ready/public, so a
 *                          missing service would manifest as 500s; pass it.
 *   - clientBuildIndexPath Absolute path to the built React index.html.
 *                          Was `path.join(__dirname, '..', 'client', 'build',
 *                          'index.html')` from inside startServer(); now the
 *                          caller (server/index.js) computes the path once
 *                          and threads it through here.
 *
 * The handler logic is **behaviour-equivalent** to the original two inline
 * blocks (review feedback corrected the original "byte-equivalent" claim;
 * the JSON-LD literal was rewritten from double-quoted-key style to ES
 * shorthand — `JSON.stringify` output is identical so the wire format
 * matches, but the source bytes differ; the `imageUrl` selection was also
 * restructured from `if/else if/else` mutation into an early-return helper).
 *
 * The two inline `escapeHtml` definitions at pre-PR `server/index.js:5379`
 * and `:5523` were byte-identical to each other (verified by diff) — they
 * collapse into one module-level function. The original inline `/blog/:slug`
 * handler also declared an unused `const https = require('https')` that is
 * silently dropped here (dead require).
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const BLOG_INDEX_PATH = '/var/www/html/blog/index.html';
const BLOG_DIR = '/var/www/html/blog';
const STRAPI_BASE = 'http://127.0.0.1:1337';
const BASE_URL = 'https://onestreamer.live';

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fetchArticle(slug) {
  const strapiUrl = `${STRAPI_BASE}/api/articles?filters[slug][$eq]=${encodeURIComponent(slug)}&populate=*`;
  return new Promise((resolve, reject) => {
    http.get(strapiUrl, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.data?.[0] || null);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function buildArticleImageUrl(article) {
  let imageUrl = `${BASE_URL}/og-blog.png`;
  const coverUrl = article.cover?.url || article.coverImage?.url;
  if (!coverUrl) return imageUrl;
  if (coverUrl.startsWith('http')) return coverUrl;
  // Strapi uploads need to go through /strapi path
  if (coverUrl.startsWith('/uploads')) return `${BASE_URL}/strapi${coverUrl}`;
  return `${BASE_URL}${coverUrl}`;
}

function renderBlogHtml({ article, slug }) {
  const title = escapeHtml(article.title) || 'Blog Post';
  const rawDescription = article.excerpt || article.content?.trim().substring(0, 160).replace(/[#*_`\n\r]/g, ' ').replace(/\s+/g, ' ').trim() + '...';
  const description = escapeHtml(rawDescription);
  const author = escapeHtml(article.author || 'OneStreamer Team');
  const articleUrl = `${BASE_URL}/blog/${slug}`;
  const imageUrl = buildArticleImageUrl(article);
  const publishedDate = article.publishedAt ? new Date(article.publishedAt).toISOString() : '';
  const modifiedDate = article.updatedAt ? new Date(article.updatedAt).toISOString() : '';

  let html = fs.readFileSync(BLOG_INDEX_PATH, 'utf8');

  // Update the title tag
  html = html.replace(
    /<title[^>]*>.*?<\/title>/,
    `<title>${title} | OneStreamer Blog</title>`
  );

  // Update meta tags with article-specific content
  html = html.replace(/id="page-title">.*?<\/title>/, `id="page-title">${title} | OneStreamer Blog</title>`);
  html = html.replace(/id="meta-title" content="[^"]*"/, `id="meta-title" content="${title} | OneStreamer Blog"`);
  html = html.replace(/id="page-description"[^>]*content="[^"]*"/, `id="page-description" name="description" content="${description}"`);
  html = html.replace(/id="canonical-url" href="[^"]*"/, `id="canonical-url" href="${articleUrl}"`);

  // Open Graph - match id, any attributes, then content
  html = html.replace(/id="og-type"[^>]*content="[^"]*"/, `id="og-type" property="og:type" content="article"`);
  html = html.replace(/id="og-url"[^>]*content="[^"]*"/, `id="og-url" property="og:url" content="${articleUrl}"`);
  html = html.replace(/id="og-title"[^>]*content="[^"]*"/, `id="og-title" property="og:title" content="${title}"`);
  html = html.replace(/id="og-description"[^>]*content="[^"]*"/, `id="og-description" property="og:description" content="${description}"`);
  html = html.replace(/id="og-image"[^>]*content="[^"]*"/, `id="og-image" property="og:image" content="${imageUrl}"`);

  // Twitter - match id, any attributes, then content
  html = html.replace(/id="twitter-url"[^>]*content="[^"]*"/, `id="twitter-url" name="twitter:url" content="${articleUrl}"`);
  html = html.replace(/id="twitter-title"[^>]*content="[^"]*"/, `id="twitter-title" name="twitter:title" content="${title}"`);
  html = html.replace(/id="twitter-description"[^>]*content="[^"]*"/, `id="twitter-description" name="twitter:description" content="${description}"`);
  html = html.replace(/id="twitter-image"[^>]*content="[^"]*"/, `id="twitter-image" name="twitter:image" content="${imageUrl}"`);

  // Article meta - match id, any attributes, then content
  html = html.replace(/id="article-author"[^>]*content="[^"]*"/, `id="article-author" property="article:author" content="${author}"`);
  html = html.replace(/id="article-published"[^>]*content="[^"]*"/, `id="article-published" property="article:published_time" content="${publishedDate}"`);
  html = html.replace(/id="article-modified"[^>]*content="[^"]*"/, `id="article-modified" property="article:modified_time" content="${modifiedDate}"`);

  // Update JSON-LD structured data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description: description,
    image: imageUrl,
    url: articleUrl,
    datePublished: publishedDate,
    dateModified: modifiedDate,
    author: {
      '@type': 'Person',
      name: author,
    },
    publisher: {
      '@type': 'Organization',
      name: 'OneStreamer',
      url: 'https://onestreamer.live',
      logo: {
        '@type': 'ImageObject',
        url: 'https://onestreamer.live/logo.png',
      },
    },
  };
  html = html.replace(
    /<script type="application\/ld\+json" id="schema-data">[\s\S]*?<\/script>/,
    `<script type="application/ld+json" id="schema-data">${JSON.stringify(jsonLd, null, 2)}</script>`
  );

  return html;
}

function renderClipHtml({ clip, clipId, clientBuildIndexPath }) {
  const durationSec = Math.round((clip.duration_ms || 0) / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const title = escapeHtml(clip.title) || 'Clip';
  const description = escapeHtml(clip.description) || `A ${durationStr} clip by ${escapeHtml(clip.creator_username || 'Anonymous')}`;
  const creatorName = escapeHtml(clip.creator_username || 'Anonymous');

  const clipUrl = `${BASE_URL}/clips/${clipId}`;
  const thumbnailUrl = `${BASE_URL}/api/clips/${clipId}/thumbnail`;
  const videoUrl = `${BASE_URL}/api/clips/${clipId}/stream`;

  let html = fs.readFileSync(clientBuildIndexPath, 'utf8');

  const gaScript = `
    <!-- Google Analytics -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-XN4PGT5J9W"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-XN4PGT5J9W', {
            page_path: window.location.pathname
        });
    </script>
`;

  const metaTags = `
    <!-- Open Graph Meta Tags for Social Media Sharing -->
    <meta property="og:site_name" content="OneStreamer">
    <meta property="og:url" content="${clipUrl}">
    <meta property="og:type" content="video.other">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${thumbnailUrl}">
    <meta property="og:image:width" content="1280">
    <meta property="og:image:height" content="720">
    <meta property="og:image:alt" content="${title}">
    <meta property="og:video" content="${videoUrl}">
    <meta property="og:video:secure_url" content="${videoUrl}">
    <meta property="og:video:type" content="video/mp4">
    <meta property="og:video:width" content="1280">
    <meta property="og:video:height" content="720">

    <!-- Twitter Card Meta Tags -->
    <meta name="twitter:card" content="player">
    <meta name="twitter:site" content="@onestreamer">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${thumbnailUrl}">
    <meta name="twitter:player" content="${clipUrl}?embed=true">
    <meta name="twitter:player:width" content="1280">
    <meta name="twitter:player:height" content="720">

    <!-- Additional metadata -->
    <meta property="video:duration" content="${durationSec}">
    <meta name="author" content="${creatorName}">
`;

  html = html.replace(
    /<title>.*?<\/title>/,
    `<title>${title} - OneStreamer Clip</title>`
  );

  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${description}">`
  );

  html = html.replace(
    /(<meta\s+name="description"\s+content="[^"]*"\s*\/?>)/,
    `$1${metaTags}`
  );

  html = html.replace(
    /<\/head>/,
    `${gaScript}</head>`
  );

  return html;
}

module.exports = function mountSocialEmbedRoutes(app, deps) {
  const { clipService, clientBuildIndexPath } = deps;

  // ─── Blog article social embed ───────────────────────────────────────
  app.get('/blog/:slug', async (req, res, next) => {
    const { slug } = req.params;

    // Skip static files and index.html
    if (slug === 'index.html' || slug.includes('.')) {
      return next();
    }

    try {
      const article = await fetchArticle(slug);
      if (!article) {
        return res.sendFile(path.join(BLOG_DIR, 'index.html'));
      }

      const html = renderBlogHtml({ article, slug });
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error(`❌ Error generating blog meta tags for ${slug}:`, error);
      // On error, fall back to serving the normal blog page
      res.sendFile(path.join(BLOG_DIR, 'index.html'));
    }
  });

  // ─── Clip social embed ───────────────────────────────────────────────
  app.get('/clips/:clipId', async (req, res, next) => {
    const { clipId } = req.params;

    // Validate clipId format (UUID)
    const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!uuidRegex.test(clipId)) {
      return next();
    }

    try {
      const clip = await clipService.getClip(clipId);
      if (!clip || clip.status !== 'ready' || !clip.is_public) {
        return res.sendFile(clientBuildIndexPath);
      }

      const html = renderClipHtml({ clip, clipId, clientBuildIndexPath });
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error(`❌ Error generating clip meta tags for ${clipId}:`, error);
      res.sendFile(clientBuildIndexPath);
    }
  });
};
