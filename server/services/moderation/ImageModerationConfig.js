// server/services/moderation/ImageModerationConfig.js
//
// Image-moderation config collaborator for ModerationService (OmniImageMod
// PR 2/3, ADR-0021). Extracted as part of the ModerationService
// decomposition — behavior is identical to the methods it replaces.
//
// Owns: getImageModerationConfig, setImageModerationConfig, and the image
// branch of _loadGlobalConfig (applyGlobalConfigRow).
//
// The cached config fields (_imageModerationEnabled, _imageCategoriesEnabled,
// _imageFrameRetentionDays) live on the owning ModerationService instance —
// handleVisionFrame (which stays in ModerationService) and the test suite
// read/write them directly — so this collaborator mutates them in place on
// the injected `owner`.

const IMAGE_SUPPORTED_DEFAULTS = [
  'sexual', 'violence', 'violence/graphic',
  'self-harm', 'self-harm/intent', 'self-harm/instructions',
];

class ImageModerationConfig {
  /**
   * @param {object} deps
   * @param {object} deps.database  OneStreamer sqlite wrapper.
   * @param {object} deps.owner     ModerationService instance owning the
   *                                cached _image* fields and frameCaptureService.
   */
  constructor({ database, owner }) {
    this.database = database;
    this.owner = owner;
  }

  /**
   * Apply the image-moderation knobs from a loaded global-config row onto
   * the owning service. Called from ModerationService._loadGlobalConfig.
   *
   * Defaults are conservative — feature off, only the 6 omni
   * image-supported categories enabled, 30-day banned-frame retention.
   */
  applyGlobalConfigRow(row) {
    const owner = this.owner;
    owner._imageModerationEnabled = !!(row && row.image_moderation_enabled === 1);
    let cats = null;
    if (row && row.image_categories_enabled_json) {
      try { cats = JSON.parse(row.image_categories_enabled_json); } catch (_) { cats = null; }
    }
    if (!Array.isArray(cats) || cats.length === 0) {
      cats = IMAGE_SUPPORTED_DEFAULTS.slice();
    }
    owner._imageCategoriesEnabled = new Set(cats);
    owner._imageFrameRetentionDays = (row && Number.isFinite(row.image_frame_retention_days))
      ? row.image_frame_retention_days
      : 30;
    if (owner.frameCaptureService && typeof owner.frameCaptureService.setBannedRetentionDays === 'function') {
      owner.frameCaptureService.setBannedRetentionDays(owner._imageFrameRetentionDays);
    }
  }

  /**
   * Read the image-moderation config from the DB (full shape for admin UI).
   */
  async getImageModerationConfig() {
    const row = await this.database.getAsync(
      `SELECT image_moderation_enabled, image_categories_enabled_json, image_frame_retention_days
         FROM moderation_global_config WHERE id = 1`
    );
    let categories = null;
    if (row && row.image_categories_enabled_json) {
      try { categories = JSON.parse(row.image_categories_enabled_json); } catch (_) { categories = null; }
    }
    return {
      enabled: !!(row && row.image_moderation_enabled === 1),
      categories: Array.isArray(categories) ? categories : [],
      frame_retention_days: row ? row.image_frame_retention_days : 30,
    };
  }

  /**
   * Update image-moderation config. Validates inputs server-side so PR 3's
   * admin endpoint doesn't have to repeat the logic. `categories` must be a
   * subset of the 6 image-capable omni-moderation categories; passing a
   * text-only category (e.g., 'sexual/minors') silently drops it because
   * image input cannot trigger those.
   */
  async setImageModerationConfig({ enabled, categories, frame_retention_days } = {}, adminId = null) {
    const owner = this.owner;
    const IMAGE_SUPPORTED = new Set(IMAGE_SUPPORTED_DEFAULTS);
    const fields = [];
    const params = [];
    if (typeof enabled === 'boolean') {
      fields.push('image_moderation_enabled = ?');
      params.push(enabled ? 1 : 0);
      owner._imageModerationEnabled = enabled;
    }
    if (Array.isArray(categories)) {
      const filtered = categories.filter((c) => IMAGE_SUPPORTED.has(c));
      fields.push('image_categories_enabled_json = ?');
      params.push(JSON.stringify(filtered));
      owner._imageCategoriesEnabled = new Set(filtered);
    }
    if (Number.isFinite(frame_retention_days)) {
      const clamped = Math.max(1, Math.min(365, Math.floor(frame_retention_days)));
      fields.push('image_frame_retention_days = ?');
      params.push(clamped);
      owner._imageFrameRetentionDays = clamped;
      if (owner.frameCaptureService && typeof owner.frameCaptureService.setBannedRetentionDays === 'function') {
        owner.frameCaptureService.setBannedRetentionDays(clamped);
      }
    }
    if (fields.length === 0) return { changed: false };
    fields.push('updated_at = CURRENT_TIMESTAMP');
    if (adminId) {
      fields.push('updated_by = ?');
      params.push(String(adminId));
    }
    await this.database.runAsync(
      `UPDATE moderation_global_config SET ${fields.join(', ')} WHERE id = 1`,
      params
    );
    return { changed: true };
  }
}

module.exports = ImageModerationConfig;
