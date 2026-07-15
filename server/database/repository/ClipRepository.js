/**
 * ClipRepository
 *
 * Pure SQL wrapper for the three clip tables:
 *   - clips                (one row per clip)
 *   - clip_views           (1:N view-log rows; counter on `clips.view_count`)
 *   - clip_chat_messages   (1:N chat-snapshot rows captured at clip-creation
 *                           time so playback can show the conversation that
 *                           was happening during the clipped window)
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Domain orchestration (rate
 * limiting, profanity filter, chat-service HTTP fetch, processor
 * queue) stays in ClipService.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository /
 * ViewBotRepository / BuffRepository / ContinuousRecordingRepository /
 * SessionChatMessageRepository / AdminReviewSettingsRepository pattern:
 * deps may be injected for unit-test mocking; when omitted the repo
 * falls back to the real primitives from `server/database/database.js`.
 *
 * **Transactional re-use** (PR 7.1 / ADR-0015): when a caller wraps a
 * multi-statement scope in `withTransaction(async (tx) => …)`, it can
 * construct a temporary repo bound to `tx`'s primitives — `new
 * ClipRepository(tx)` — and call methods on it. Every method's SQL
 * runs inside the open transaction. This is the convention spelled
 * out in ADR-0015 ("Repo methods constructed with `{getAsync: tx.getAsync, …}`
 * as deps run their queries inside the transaction without knowing
 * they're in one"). PR 10.2 uses this pattern at the `recordView`
 * and `deleteClip` callsites in ClipService.
 *
 * **Scope note** — cross-table JOINs against `users` (in `getClip`,
 * `listClips`, `getUserClips`) intentionally stay inline in ClipService.
 * Single-domain repositories don't reach across tables; the JOIN to
 * `users` is a presentation-layer enrichment (the creator's username
 * for display) and belongs to the service / route, not the repo. This
 * matches the convention PR 6.3 + PR 10.1 set for ContinuousRecording
 * and admin-recordings.
 *
 * Extracted from `server/services/ClipService.js` in PR 10.2 (Phase 10).
 * Pre-extraction: 18 inline SQL call-sites — 15 collapsed to repo
 * methods, 3 cross-table JOINs left inline per the scope note above.
 */
class ClipRepository {
    /**
     * @param {object} [deps]
     * @param {Function} [deps.getAsync] - (sql, params) => Promise<row|undefined>
     * @param {Function} [deps.runAsync] - (sql, params) => Promise<{ id, changes }>
     * @param {Function} [deps.allAsync] - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        const fallback = require('./../database');
        this.getAsync = deps.getAsync || fallback.getAsync;
        this.runAsync = deps.runAsync || fallback.runAsync;
        this.allAsync = deps.allAsync || fallback.allAsync;
    }

    // ============================================================
    // clips
    // ============================================================

    /**
     * INSERT a clip row with `status='processing'` baked in. Handles
     * both the live-clip path (which has a `streamer_user_id` to thread
     * through — currently passed as NULL by the live path because
     * ClipService doesn't know which streamer was on at clip time) and
     * the recording-clip path (no streamer attribution). One method;
     * `streamerUserId` defaults to NULL so the recording path doesn't
     * have to pass it.
     */
    async insertClip({
        clipId,
        recordingId,
        userId,
        streamerUserId = null,
        title,
        description,
        startMs,
        endMs,
        durationMs,
    }) {
        return await this.runAsync(`
            INSERT INTO clips (
                clip_id, recording_id, user_id, streamer_user_id, title, description,
                start_time_ms, end_time_ms, duration_ms, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')
        `, [
            clipId, recordingId, userId, streamerUserId,
            title, description,
            startMs, endMs, durationMs,
        ]);
    }

    /**
     * SELECT * by clip_id (single-table, no JOIN). Internal callers
     * that don't need the creator username use this. The user-facing
     * `getClip` path on ClipService stays inline for the JOIN.
     */
    async getClipById(clipId) {
        return await this.getAsync(
            'SELECT * FROM clips WHERE clip_id = ?',
            [clipId]
        );
    }

    /**
     * Dynamic-SET UPDATE driven by the user-supplied `updates` object.
     * `allowedFields` is enforced by the caller before this method
     * runs (ClipService validates the field whitelist + profanity-
     * checks the title/description); this method just builds the
     * SET clause. `updated_at = CURRENT_TIMESTAMP` is always appended.
     *
     * Returns the `runAsync` result row (`{ id, changes }`); the
     * caller checks `changes` only indirectly (via re-reading the
     * row).
     */
    async updateClipFields(clipId, fieldValues) {
        const setClauses = [];
        const params = [];
        for (const [key, value] of Object.entries(fieldValues)) {
            setClauses.push(`${key} = ?`);
            params.push(value);
        }
        if (setClauses.length === 0) return { changes: 0 };
        setClauses.push('updated_at = CURRENT_TIMESTAMP');
        params.push(clipId);
        return await this.runAsync(
            `UPDATE clips SET ${setClauses.join(', ')} WHERE clip_id = ?`,
            params
        );
    }

    /**
     * DELETE a clip row. Pair with `deleteViewsByClipId` inside a
     * `withTransaction` scope for atomicity (the legacy code did the
     * two DELETEs back-to-back without a transaction — PR 10.2 fixes
     * that, see ADR-0015).
     */
    async deleteClipById(clipId) {
        return await this.runAsync(
            'DELETE FROM clips WHERE clip_id = ?',
            [clipId]
        );
    }

    /**
     * Atomic-counter UPDATE: `view_count = view_count + 1`. The
     * relative arithmetic shape (PR 5.1 / ADR-0013a) avoids the
     * read-compute-write race. Pair with `insertView` inside a
     * `withTransaction` scope so the audit row and the counter bump
     * commit together.
     */
    async incrementViewCount(clipId) {
        return await this.runAsync(
            'UPDATE clips SET view_count = view_count + 1 WHERE clip_id = ?',
            [clipId]
        );
    }

    /**
     * Mark a clip ready after processing. Updates four columns plus
     * `updated_at`. Matches the legacy SQL byte-for-byte (statement
     * order in the SET clause + the CURRENT_TIMESTAMP literal).
     */
    async setClipReady(clipId, { filePath, thumbnailPath, fileSize }) {
        return await this.runAsync(`
            UPDATE clips SET
                status = 'ready', file_path = ?, thumbnail_path = ?, file_size = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE clip_id = ?
        `, [filePath, thumbnailPath, fileSize, clipId]);
    }

    /**
     * Mark a clip failed after processing. Single column + timestamp.
     */
    async setClipFailed(clipId) {
        return await this.runAsync(
            "UPDATE clips SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE clip_id = ?",
            [clipId]
        );
    }

    /**
     * Boot-time crash sweep (audit Plan 01 P2.3-residual, flagged in
     * PR #36): flip rows stuck at `status='processing'` for longer than
     * `cutoffMs` to `'failed'`. A crash between `insertClip` (which bakes
     * 'processing' in) and `setClipReady`/`setClipFailed` otherwise leaves
     * the row 'processing' forever — no code path ever revisits it, and it
     * inflates the getStats processing count for the life of the DB.
     *
     * `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP, UTC) is compared
     * against `datetime('now', '-N seconds')` (also UTC). Genuinely
     * in-flight clips are young (processing takes seconds, the cutoff is
     * minutes), so a recent 'processing' row is left alone.
     *
     * @param {number} cutoffMs - age threshold; rows older than this flip.
     * @returns {Promise<{id: number|undefined, changes: number}>}
     */
    async failStaleProcessing(cutoffMs) {
        const cutoffSeconds = Math.max(0, Math.floor(cutoffMs / 1000));
        return await this.runAsync(`
            UPDATE clips SET status = 'failed', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing'
              AND created_at <= datetime('now', ?)
        `, [`-${cutoffSeconds} seconds`]);
    }

    /**
     * Aggregate stats across all clips. Same SQL as the legacy
     * `getStats` — single-row CASE-COUNT projection.
     */
    async getStats() {
        return await this.getAsync(`
            SELECT
                COUNT(*) as total_clips,
                SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_clips,
                SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_clips,
                SUM(view_count) as total_views,
                SUM(file_size) as total_size
            FROM clips
        `);
    }

    // ============================================================
    // clip_views
    // ============================================================

    /**
     * SELECT an id-only row for a clip+viewer pair viewed within the
     * last hour. Used by ClipService.recordView to short-circuit
     * duplicate views from the same (user_id OR ip_address) inside
     * the cooldown window. Returns the row or `undefined`.
     *
     * SQL byte-equivalent to admin-recordings.js's legacy form, with
     * the `datetime('now', '-1 hour')` literal preserved.
     */
    async findRecentView({ clipId, userId, ipAddress }) {
        return await this.getAsync(`
            SELECT id FROM clip_views
            WHERE clip_id = ? AND (user_id = ? OR ip_address = ?)
                AND viewed_at > datetime('now', '-1 hour')
            LIMIT 1
        `, [clipId, userId, ipAddress]);
    }

    /**
     * INSERT a new clip_views row. Pair with `incrementViewCount`
     * inside a `withTransaction` scope so the audit row and the
     * counter bump commit together.
     */
    async insertView({ clipId, userId, ipAddress }) {
        return await this.runAsync(
            'INSERT INTO clip_views (clip_id, user_id, ip_address) VALUES (?, ?, ?)',
            [clipId, userId, ipAddress]
        );
    }

    /**
     * DELETE every clip_views row for a clip. Pair with `deleteClipById`
     * inside a `withTransaction` scope for atomic clip deletion.
     */
    async deleteViewsByClipId(clipId) {
        return await this.runAsync(
            'DELETE FROM clip_views WHERE clip_id = ?',
            [clipId]
        );
    }

    // ============================================================
    // clip_chat_messages
    // ============================================================

    /**
     * INSERT a single chat-snapshot row. Called in a loop by
     * ClipService.captureChatForClip. NOT currently wrapped in a
     * transaction by the service (the legacy code accepts partial
     * insertion of the chat snapshot under per-statement try/catch);
     * a future PR could fold the whole loop into one
     * `withTransaction` scope for atomicity + perf, but the error-
     * tolerance shape would change, so PR 10.2 leaves the loop as-is.
     */
    async insertClipChatMessage({ clipId, username, message, relativeTimeMs, originalTimestamp }) {
        return await this.runAsync(`
            INSERT INTO clip_chat_messages (clip_id, username, message, relative_time_ms, original_timestamp)
            VALUES (?, ?, ?, ?, ?)
        `, [clipId, username, message, relativeTimeMs, originalTimestamp]);
    }

    /**
     * SELECT chat-snapshot rows for a clip, ordered by `relative_time_ms ASC`
     * (negative values for context, zero+ for the clipped window).
     * Four-column projection — match the legacy SQL.
     */
    async listChatByClip(clipId) {
        return await this.allAsync(`
            SELECT username, message, relative_time_ms, original_timestamp
            FROM clip_chat_messages
            WHERE clip_id = ?
            ORDER BY relative_time_ms ASC
        `, [clipId]);
    }

    /**
     * COUNT chat-snapshot rows for a clip. Returns the raw getAsync row
     * (`{ count }`).
     */
    async countChatByClip(clipId) {
        return await this.getAsync(
            'SELECT COUNT(*) as count FROM clip_chat_messages WHERE clip_id = ?',
            [clipId]
        );
    }
}

module.exports = ClipRepository;
