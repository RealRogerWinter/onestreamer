// server/services/moderation/SchemaSeed.js
//
// Schema application + seed integrity/upsert collaborator for
// ModerationService. Extracted as part of the ModerationService
// decomposition — behavior is identical to the methods it replaces.
//
// Owns: _applySchema, _verifySeedIntegrity, _upsertEmbeddedTerms.

const fs = require('fs');
const crypto = require('crypto');
const Stage1 = require('../ModerationStage1');

const logger = require('../../bootstrap/logger').child({ svc: 'ModerationService' });

class SchemaSeed {
  /**
   * @param {object} deps
   * @param {object} deps.database     OneStreamer sqlite wrapper.
   * @param {string} deps.schemaPath   Path to ai-moderation-schema.sql.
   * @param {string} deps.seedPath     Path to embedded seed JSON.
   * @param {string} deps.seedHashPath Path to SHA-256 sibling file.
   * @param {boolean} deps.failClosed  If true, throw on read/hash mismatch.
   */
  constructor({ database, schemaPath, seedPath, seedHashPath, failClosed }) {
    this.database = database;
    this.schemaPath = schemaPath;
    this.seedPath = seedPath;
    this.seedHashPath = seedHashPath;
    this.failClosed = failClosed;
  }

  /**
   * Apply ai-moderation-schema.sql. Idempotent (CREATE TABLE IF NOT EXISTS
   * + INSERT OR IGNORE on the config seed). Mirrors WhitelistService's
   * _applySchema pattern. Strips `--` line comments BEFORE splitting on `;`
   * so any semicolons inside comments don't break the split.
   */
  async applySchema() {
    let schema;
    try {
      schema = fs.readFileSync(this.schemaPath, 'utf8');
    } catch (err) {
      const msg = `ModerationService: cannot read schema file at ${this.schemaPath}: ${err.message}`;
      if (this.failClosed) throw new Error(msg);
      logger.warn('⚠️ ' + msg);
      return;
    }

    const commentStripped = schema
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');

    const statements = commentStripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      try {
        await this.database.runAsync(stmt + ';');
      } catch (err) {
        // SQLite raises "duplicate column name: X" when an ALTER TABLE adds
        // a column that already exists. The OmniImageMod schema additions
        // (ADR-0021) ship ALTERs that need to be idempotent across reboots,
        // so we tolerate that specific error and move on. Any other schema
        // failure still throws.
        if (err && typeof err.message === 'string' && err.message.toLowerCase().includes('duplicate column')) {
          continue;
        }
        logger.error('❌ ModerationService: schema statement failed:', err.message);
        logger.error('   Offending statement:', stmt.slice(0, 200));
        throw err;
      }
    }
  }

  /**
   * Verify the embedded seed file against its SHA-256 sibling. On mismatch:
   * fail closed (throw) if failClosed=true, else log and continue. The
   * seed file is committed alongside its checksum so any out-of-band edit
   * is detected at boot, matching the WhitelistService startup pattern.
   */
  async verifySeedIntegrity() {
    let seedBytes;
    let storedHash;
    try {
      seedBytes = fs.readFileSync(this.seedPath);
    } catch (err) {
      const msg = `ModerationService: cannot read seed file at ${this.seedPath}: ${err.message}`;
      if (this.failClosed) throw new Error(msg);
      logger.warn('⚠️ ' + msg);
      return;
    }
    try {
      storedHash = fs.readFileSync(this.seedHashPath, 'utf8').trim();
    } catch (err) {
      const msg = `ModerationService: cannot read seed hash file at ${this.seedHashPath}: ${err.message}`;
      if (this.failClosed) throw new Error(msg);
      logger.warn('⚠️ ' + msg);
      return;
    }
    const computed = crypto.createHash('sha256').update(seedBytes).digest('hex');
    if (computed !== storedHash) {
      const msg = `ModerationService: seed integrity mismatch (computed=${computed.slice(0, 16)}, stored=${storedHash.slice(0, 16)})`;
      if (this.failClosed) throw new Error(msg);
      logger.warn('⚠️ ' + msg);
      return;
    }
    logger.debug('✅ ModerationService: seed integrity verified');
  }

  /**
   * Upsert embedded terms from the seed JSON into the moderation_terms
   * table with source='embedded'. Idempotent: a `INSERT OR IGNORE` on the
   * UNIQUE(normalized_form, category) constraint plus an UPDATE that flips
   * `enabled` back to 1 (so an admin can't permanently disable an embedded
   * term — they can only soft-disable until the next boot, at which point
   * the seed wins).
   *
   * NOTE: Re-enabling on every boot is deliberate. Stage 1 is recall-only,
   * and an admin who wants a hard-tier slur permanently off the list
   * should remove it from the seed file (and update the SHA-256) rather
   * than rely on a runtime override that vanishes on restart. The audit
   * log will show the disable, the re-enable on boot, and the admin's
   * decision history.
   */
  async upsertEmbeddedTerms() {
    let seed;
    try {
      seed = JSON.parse(fs.readFileSync(this.seedPath, 'utf8'));
    } catch (err) {
      logger.warn('⚠️ ModerationService: failed to parse seed JSON:', err.message);
      return;
    }
    if (!seed || !Array.isArray(seed.terms)) {
      logger.warn('⚠️ ModerationService: seed JSON has no terms array');
      return;
    }

    let inserted = 0;
    let restored = 0;
    for (const entry of seed.terms) {
      if (!entry || typeof entry.term !== 'string') continue;
      const normalized = Stage1.normalize(entry.normalized_form || entry.term);
      if (!normalized) continue;

      try {
        // INSERT OR IGNORE: if the (normalized_form, category) pair exists,
        // the row is left alone — including its `enabled` flag.
        const result = await this.database.runAsync(
          `INSERT OR IGNORE INTO moderation_terms
              (term, normalized_form, category, severity, source, enabled, created_by, notes)
            VALUES (?, ?, ?, ?, 'embedded', 1, 'seed', ?)`,
          [entry.term, normalized, entry.category, entry.severity || 'hard', entry.notes || null]
        );
        if (result && (result.changes > 0 || result.lastID)) {
          inserted += 1;
        } else {
          // Row already existed. Re-enable it (the boot-wins policy noted
          // above) and refresh source='embedded' attribution if an admin
          // had cloned the row.
          const upd = await this.database.runAsync(
            `UPDATE moderation_terms
                SET enabled = 1, source = 'embedded'
              WHERE normalized_form = ? AND category = ? AND (enabled = 0 OR source <> 'embedded')`,
            [normalized, entry.category]
          );
          if (upd && upd.changes > 0) restored += 1;
        }
      } catch (err) {
        logger.warn(`⚠️ ModerationService: upsert failed for term "${entry.term}":`, err.message);
      }
    }
    logger.debug(`✅ ModerationService: seed upserted (inserted=${inserted}, restored=${restored}, total=${seed.terms.length})`);
  }
}

module.exports = SchemaSeed;
