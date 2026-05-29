// server/services/moderation/TermsAdmin.js
//
// Terms + category-config CRUD collaborator for ModerationService.
// Extracted as part of the ModerationService decomposition — behavior is
// identical to the methods it replaces.
//
// Owns: getTerms, addTerm, setTermEnabled, removeTerm, _auditTerm,
//       getTermsAudit, getCategoryConfig, setCategoryConfig.

const Stage1 = require('../ModerationStage1');

const logger = require('../../bootstrap/logger').child({ svc: 'ModerationService' });

class TermsAdmin {
  /**
   * @param {object} deps
   * @param {object} deps.database       OneStreamer sqlite wrapper.
   * @param {function} deps.reloadCache  Callback to reload the terms cache
   *                                     after edits (ModerationService._loadTermsCache).
   */
  constructor({ database, reloadCache }) {
    this.database = database;
    this.reloadCache = reloadCache;
  }

  async getTerms({ enabled = null, category = null, source = null } = {}) {
    const where = [];
    const params = [];
    if (enabled !== null) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (source) { where.push('source = ?'); params.push(source); }
    let sql = 'SELECT * FROM moderation_terms';
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY category, severity, normalized_form';
    return this.database.allAsync(sql, params);
  }

  async addTerm({ term, category, severity = 'soft', notes = null }, adminId) {
    if (!term || typeof term !== 'string') throw new Error('term required');
    if (!['hate_speech', 'threat', 'sexual'].includes(category)) throw new Error('invalid category');
    if (!['hard', 'soft'].includes(severity)) throw new Error('invalid severity');
    const normalized = Stage1.normalize(term);
    if (!normalized) throw new Error('term normalizes to empty string');

    const result = await this.database.runAsync(
      `INSERT INTO moderation_terms
          (term, normalized_form, category, severity, source, enabled, created_by, notes)
        VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)`,
      [term, normalized, category, severity, adminId || null, notes]
    );
    const id = result && result.id;
    await this._auditTerm({ actor: adminId, action: 'add', term_id: id, after: { term, normalized_form: normalized, category, severity, notes } });
    await this.reloadCache();
    return { id, normalized_form: normalized };
  }

  async setTermEnabled(id, enabled, adminId) {
    const before = await this.database.getAsync('SELECT * FROM moderation_terms WHERE id = ?', [id]);
    if (!before) return { ok: false, error: 'not_found' };
    if (before.source === 'embedded' && enabled === false) {
      // Embedded rows can be soft-disabled, but they're re-enabled on the
      // next boot (the seed wins). Log it loudly so the admin understands
      // the durability semantics.
      logger.warn(`⚠️ ModerationService: admin disabled embedded term id=${id} ("${before.term}") — will be re-enabled on next boot`);
    }
    await this.database.runAsync(
      'UPDATE moderation_terms SET enabled = ? WHERE id = ?',
      [enabled ? 1 : 0, id]
    );
    await this._auditTerm({ actor: adminId, action: enabled ? 'enable' : 'disable', term_id: id, before, after: { ...before, enabled: enabled ? 1 : 0 } });
    await this.reloadCache();
    return { ok: true, id };
  }

  async removeTerm(id, adminId) {
    const before = await this.database.getAsync('SELECT * FROM moderation_terms WHERE id = ?', [id]);
    if (!before) return { ok: false, error: 'not_found' };
    if (before.source === 'embedded') {
      return { ok: false, error: 'cannot_remove_embedded' };
    }
    await this.database.runAsync('DELETE FROM moderation_terms WHERE id = ?', [id]);
    await this._auditTerm({ actor: adminId, action: 'remove', term_id: id, before });
    await this.reloadCache();
    return { ok: true, id };
  }

  async _auditTerm({ actor, action, term_id, before = null, after = null }) {
    // Hash-chain wiring is M6 — for now we store the rows with empty
    // prev_hash/row_hash and PR-M6 will backfill once a hash function is
    // chosen. The audit row itself is already useful for the events tab.
    await this.database.runAsync(
      `INSERT INTO moderation_terms_audit (actor, action, term_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?)`,
      [actor || null, action, term_id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  }

  async getTermsAudit({ limit = 50 } = {}) {
    return this.database.allAsync(
      'SELECT * FROM moderation_terms_audit ORDER BY at DESC, id DESC LIMIT ?',
      [Math.min(Number(limit) || 50, 500)]
    );
  }

  async getCategoryConfig() {
    return this.database.allAsync('SELECT * FROM moderation_config ORDER BY category');
  }

  async setCategoryConfig({ category, action_mode, stage2_threshold, stage3_required, enabled }, adminId) {
    if (!['hate_speech', 'threat', 'sexual'].includes(category)) throw new Error('invalid category');
    const fields = [];
    const params = [];
    if (action_mode !== undefined) {
      if (!['auto_ban', 'admin_review', 'mute_pending'].includes(action_mode)) throw new Error('invalid action_mode');
      fields.push('action_mode = ?'); params.push(action_mode);
    }
    if (stage2_threshold !== undefined) {
      const t = Number(stage2_threshold);
      if (!Number.isInteger(t) || t < 0 || t > 3) throw new Error('invalid stage2_threshold');
      fields.push('stage2_threshold = ?'); params.push(t);
    }
    if (stage3_required !== undefined) {
      fields.push('stage3_required = ?'); params.push(stage3_required ? 1 : 0);
    }
    if (enabled !== undefined) {
      fields.push('enabled = ?'); params.push(enabled ? 1 : 0);
    }
    if (fields.length === 0) return { ok: false, error: 'no_fields' };
    fields.push('updated_at = CURRENT_TIMESTAMP');
    fields.push('updated_by = ?'); params.push(adminId || null);
    params.push(category);
    await this.database.runAsync(
      `UPDATE moderation_config SET ${fields.join(', ')} WHERE category = ?`,
      params
    );
    return { ok: true, category };
  }
}

module.exports = TermsAdmin;
