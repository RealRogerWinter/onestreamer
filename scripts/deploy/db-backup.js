// WAL-consistent SQLite backup + retention, run INSIDE the app image as uid 1001
// (better-sqlite3 is already present, and uid 1001 owns the DB) so the deploy
// user needs no `sudo sqlite3` / `sudo sh` (ADR-0026, security review).
//
// Invoked by scripts/deploy/deploy.sh:
//   docker run --rm --user 1001:1001 \
//     -v <home>/server/data:/data:ro -v <backups>:/out \
//     -e RELEASE_SHA -e KEEP_BACKUPS -e DB_PATH=/data/onestreamer.db -e OUT_DIR=/out \
//     --entrypoint node <image> scripts/deploy/db-backup.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SRC = process.env.DB_PATH || '/data/onestreamer.db';
const OUT = process.env.OUT_DIR || '/out';
const SHA = (process.env.RELEASE_SHA || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '');
const KEEP = Math.max(1, parseInt(process.env.KEEP_BACKUPS || '3', 10));

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[db-backup] source DB not found: ${SRC}`);
    process.exit(2);
  }
  const ts = new Date().toISOString().replace(/[:T]/g, '').replace(/\..+$/, '').slice(0, 14);
  const dest = path.join(OUT, `onestreamer-${SHA}-${ts}.db`);

  const db = new Database(SRC, { readonly: true });
  try {
    await db.backup(dest); // SQLite online-backup API — consistent snapshot incl. WAL
  } finally {
    db.close();
  }
  console.log(`[db-backup] wrote ${dest} (${fs.statSync(dest).size} bytes)`);

  // Retention: keep the newest KEEP, prune the rest (also in-container, uid 1001).
  const stale = fs.readdirSync(OUT)
    .filter((f) => /^onestreamer-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(KEEP);
  for (const { f } of stale) {
    fs.rmSync(path.join(OUT, f), { force: true });
    console.log(`[db-backup] pruned ${f}`);
  }
})().catch((e) => {
  console.error('[db-backup] FAILED', e);
  process.exit(1);
});
