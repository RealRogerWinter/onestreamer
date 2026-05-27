/**
 * URL-relay whitelist: add `preferred_languages` per-platform config column.
 *
 * Phase 1 of the language filter (extends ADR-0010). When non-empty, the
 * WhitelistService rejects candidates whose ISO-639-1 broadcaster language
 * isn't in the list. Stored as a JSON-encoded TEXT array so SQLite stays
 * happy without a side-table.
 *
 * Why the table-existence check: `url_relay_filter_config` is owned by
 * `WhitelistService._applySchema()`, not the main database bootstrap, and
 * that runs AFTER the migration runner. On a fresh install the table
 * doesn't exist yet when we reach here — the updated schema file in
 * server/database/url-relay-whitelist-schema.sql declares the column at
 * CREATE TABLE time, so the migration's only job is the existing-DB
 * upgrade path. Skip silently when the table isn't there yet.
 *
 * Idempotent via _runner.addColumn (swallows "duplicate column").
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='url_relay_filter_config'",
        (err, row) => {
            if (err) {
                logger.error(
                    { err },
                    'preferred_languages migration: table existence check failed'
                );
                return;
            }
            if (!row) {
                // Table will be created by WhitelistService._applySchema() with
                // the column included via the updated schema file. No-op here.
                return;
            }
            addColumn(
                db,
                'url_relay_filter_config',
                'preferred_languages',
                "TEXT NOT NULL DEFAULT '[\"en\"]'",
                logger
            );
        }
    );
}

module.exports = { run };
