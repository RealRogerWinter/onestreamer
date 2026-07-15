#!/usr/bin/env node
/**
 * Regenerate server/tests/fixtures/schema-snapshot-pre-pr-14-1.json — the
 * committed PRAGMA-shape snapshot that the bit-identical bootstrap test
 * (server/tests/database/migrations.runner.test.js) diffs every run.
 *
 * Run this ONLY when a PR deliberately changes the boot DDL (database.js
 * and/or the numbered migrations), and commit the regenerated fixture in the
 * same PR. NEVER hand-edit the fixture — a typo blessed by hand becomes the
 * schema tripwire's blind spot.
 *
 * Usage:  node scripts/ops/regenerate-schema-snapshot.js
 *
 * The snapshot format mirrors snapshotSchema() in migrations.runner.test.js:
 * { tableName: [ { name, type, notnull, dflt_value, pk }, ... ] } with
 * tables and columns sorted by name.
 *
 * (The filename's "pre-pr-14-1" is historical — the fixture has been
 * re-baselined several times since; kept to avoid churning every reference.)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const FIXTURE_PATH = path.join(
    __dirname, '..', '..',
    'server', 'tests', 'fixtures', 'schema-snapshot-pre-pr-14-1.json'
);

// The schema module is side-effect-free (unlike database/database, whose
// require self-boots against the real data file).
const { initializeSchema } = require('../../server/database/schema');

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function snapshotSchema(db) {
    const tables = await allAsync(
        db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const out = {};
    for (const { name } of tables) {
        const cols = await allAsync(db, `PRAGMA table_info(${name})`);
        out[name] = cols
            .map((c) => ({
                name: c.name,
                type: c.type,
                notnull: c.notnull,
                dflt_value: c.dflt_value,
                pk: c.pk,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k];
    return sorted;
}

async function main() {
    const db = new sqlite3.Database(':memory:');
    const quiet = {
        error: (...args) => console.error('[regenerate-schema-snapshot]', ...args),
        debug: () => {},
    };
    await initializeSchema(db, quiet);
    const snapshot = await snapshotSchema(db);
    await new Promise((r) => db.close(r));

    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(
        `Wrote ${Object.keys(snapshot).length} tables to ${path.relative(process.cwd(), FIXTURE_PATH)}`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
