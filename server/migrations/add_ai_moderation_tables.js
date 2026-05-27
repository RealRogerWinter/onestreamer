/**
 * Migration: AI moderation tables.
 *
 * Applies server/database/ai-moderation-schema.sql to create:
 *   - moderation_terms          : embedded + admin-editable word list
 *   - moderation_terms_audit    : append-only audit log with hash-chained rows
 *   - moderation_events         : one row per decision, DSA-shaped
 *   - moderation_config         : per-category dial (auto_ban / admin_review / mute_pending)
 *
 * The schema is idempotent (CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE),
 * so this can run on every boot. The actual bootstrap path will eventually be
 * called from server/database/database.js alongside the other schemas; this
 * standalone script exists for the same reason add_streaming_logs.js does:
 * manual / one-off application during dev.
 *
 * See docs/architecture/adr/0013-ai-moderation-pipeline.md.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../database/database');

const SCHEMA_PATH = path.join(__dirname, '..', 'database', 'ai-moderation-schema.sql');

function runStatement(stmt) {
    return new Promise((resolve, reject) => {
        db.run(stmt, (err) => (err ? reject(err) : resolve()));
    });
}

async function applyAIModerationSchema() {
    let schema;
    try {
        schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    } catch (err) {
        throw new Error(`Cannot read schema file at ${SCHEMA_PATH}: ${err.message}`);
    }

    // Strip `--` line comments FIRST (a semicolon inside a comment would
    // otherwise wrongly split the next statement), then split on `;`.
    const commentStripped = schema
        .split('\n')
        .map((line) => {
            const idx = line.indexOf('--');
            return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join('\n');

    const statements = commentStripped
        .split(';')
        .map((stmt) => stmt.trim())
        .filter((stmt) => stmt.length > 0);

    for (const stmt of statements) {
        try {
            await runStatement(stmt + ';');
        } catch (err) {
            console.error('❌ AI moderation schema: statement failed:', err.message);
            console.error('   Offending statement:', stmt.slice(0, 200));
            throw err;
        }
    }
    console.log(`✅ AI moderation schema applied (${statements.length} statements)`);
}

if (require.main === module) {
    applyAIModerationSchema()
        .then(() => {
            console.log('✅ AI moderation tables migration completed');
            process.exit(0);
        })
        .catch((err) => {
            console.error('❌ AI moderation tables migration failed:', err);
            process.exit(1);
        });
}

module.exports = applyAIModerationSchema;
