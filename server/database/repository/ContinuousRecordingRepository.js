/**
 * ContinuousRecordingRepository
 *
 * Pure SQL wrapper for the continuous-recording tables:
 *   - recording_sessions          (one row per recording session — typically one per day)
 *   - recording_stream_segments   (1:N child rows tracking which streamer was live during what
 *                                  window inside the session's recording)
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`getAsync`, `runAsync`, `allAsync`). Domain orchestration (LiveKit
 * EgressClient calls, filesystem segment writes, cleanup retention
 * policy) stays in ContinuousRecordingService.
 *
 * Constructor mirrors the UserRepository / ChatBotRepository /
 * ViewBotRepository / BuffRepository pattern: deps may be injected for
 * unit-test mocking; when omitted the repo falls back to the real
 * primitives from `server/database/database.js`.
 *
 * **Scope note**: ContinuousRecordingService has 12 inline SQL
 * call-sites, but only 10 touch the two recording tables. The two
 * cross-table reads against `url_streams` (a stream-routing detail
 * needed to enrich segment metadata) and `streaming_logs` (an
 * unrelated audit log used as a username fallback) are intentionally
 * left inline in the service — they belong to other domains and a
 * single-domain repository shouldn't reach across. PR 10.x will
 * revisit those domains.
 *
 * Extracted from `server/services/ContinuousRecordingService.js` in
 * PR 6.3. Pre-extraction: 10 inline call-sites against recording_*.
 */
class ContinuousRecordingRepository {
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
    // recording_sessions
    // ============================================================

    /**
     * INSERT a new recording_sessions row if no row with the same
     * `session_id` exists. The legacy SQL uses `INSERT OR IGNORE`
     * because the service may re-enter `createSessionRecord` for the
     * same daily session (recording restarts mid-day) and a duplicate
     * would silently corrupt the per-day duration math.
     *
     * Status is hard-coded to `'recording'` and `created_at` to
     * `CURRENT_TIMESTAMP` in the SQL, matching the legacy shape
     * byte-for-byte.
     */
    async insertSessionIfMissing({ sessionId, streamerIdentity, streamerUserId, streamerUsername, startTime, localPath }) {
        return await this.runAsync(`
                INSERT OR IGNORE INTO recording_sessions
                (session_id, streamer_identity, streamer_user_id, streamer_username, start_time, status, local_path, created_at)
                VALUES (?, ?, ?, ?, ?, 'recording', ?, CURRENT_TIMESTAMP)
            `, [sessionId, streamerIdentity, streamerUserId, streamerUsername, startTime, localPath]);
    }

    /**
     * Flip a session row's status back to `'recording'` and bump
     * `updated_at`. The service runs this immediately after the
     * INSERT-OR-IGNORE above so that a session that was previously
     * marked as ended (by an earlier shutdown) is re-activated when
     * recording resumes — without resetting the start_time or other
     * fields.
     */
    async setSessionRecording(sessionId) {
        return await this.runAsync(`
                UPDATE recording_sessions SET status = 'recording', updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
            `, [sessionId]);
    }

    /**
     * Update a session row when recording ends. The legacy SQL uses
     * `segment_count = segment_count + ?` (relative arithmetic) so
     * mid-day restarts accumulate rather than overwrite. Single
     * statement; no read-compute-write race.
     */
    async updateSessionEnd(sessionId, { endTime, durationMs, segmentCount }) {
        return await this.runAsync(`
                UPDATE recording_sessions
                SET end_time = ?, duration_ms = ?, segment_count = segment_count + ?, updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?
            `, [endTime, durationMs, segmentCount, sessionId]);
    }

    /**
     * SELECT a session's `start_time` only. Service uses this for the
     * end-of-recording duration math; pulling just the one column
     * keeps the round trip small.
     */
    async getSessionStartTime(sessionId) {
        return await this.getAsync(
            'SELECT start_time FROM recording_sessions WHERE session_id = ?',
            [sessionId]
        );
    }

    /**
     * SELECT a full session row by session_id.
     */
    async getSessionById(sessionId) {
        return await this.getAsync(
            'SELECT * FROM recording_sessions WHERE session_id = ?',
            [sessionId]
        );
    }

    /**
     * Dynamic-filtered SELECT used by the admin "recordings" listings.
     * Destructuring `options` acts as the key whitelist — extra keys
     * are ignored. The service passes its `options` object through
     * unchanged (the legacy inline code did the same dynamic builder
     * pattern — moved here so the SQL stays in one place).
     *
     * All fragments are static-string conditionals; `params` is the
     * only path values flow on, so there is no injection surface.
     */
    async listSessions({ status, streamerIdentity, fromTime, toTime, limit, offset } = {}) {
        let sql = 'SELECT * FROM recording_sessions WHERE 1=1';
        const params = [];

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        if (streamerIdentity) {
            sql += ' AND streamer_identity = ?';
            params.push(streamerIdentity);
        }

        if (fromTime) {
            sql += ' AND start_time >= ?';
            params.push(fromTime);
        }

        if (toTime) {
            sql += ' AND start_time <= ?';
            params.push(toTime);
        }

        sql += ' ORDER BY start_time DESC';

        if (limit) {
            sql += ' LIMIT ?';
            params.push(limit);
        }

        if (offset) {
            sql += ' OFFSET ?';
            params.push(offset);
        }

        return await this.allAsync(sql, params);
    }

    /**
     * Sessions still awaiting B2 upload. Service uses this in the
     * cleanup tick to gate "delete the local files" on "the upload
     * has confirmed (b2_file_id IS NOT NULL)". Returns id-only —
     * cleanup only needs the session_id.
     *
     * PR 2.6 introduced this gate to close the cleanup-vs-upload
     * race. Phase 8.4 will tighten the window further with the
     * retry-window OR clause.
     */
    async listSessionsPendingUpload() {
        return await this.allAsync(
            `SELECT session_id FROM recording_sessions WHERE b2_file_id IS NULL`
        );
    }

    // ============================================================
    // recording_stream_segments
    // ============================================================

    /**
     * INSERT a new stream-segment row when the streamer identity
     * changes during a recording session. Eight columns, last one
     * `created_at` defaulted to `CURRENT_TIMESTAMP` in SQL.
     */
    async insertStreamSegment({ sessionId, streamIdentity, streamType, displayName, platform, sourceUrl, startedAt }) {
        return await this.runAsync(`
                INSERT INTO recording_stream_segments
                (session_id, stream_identity, stream_type, display_name, platform, source_url, started_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [sessionId, streamIdentity, streamType, displayName, platform, sourceUrl, startedAt]);
    }

    /**
     * Close out a stream segment by id, but only if it's still open
     * (`ended_at IS NULL`). The legacy SQL's guard prevents
     * accidentally overwriting an already-closed segment's ended_at
     * if the service logs an end for a segment that was already
     * ended via `endAllOpenSegments`.
     */
    async endStreamSegment(segmentId, endedAt) {
        return await this.runAsync(`
                UPDATE recording_stream_segments
                SET ended_at = ?
                WHERE id = ? AND ended_at IS NULL
            `, [endedAt, segmentId]);
    }

    /**
     * Close every still-open segment for a session in one UPDATE.
     * Used on shutdown when the service can't iterate individual
     * segments. Same `ended_at IS NULL` guard so already-closed
     * segments aren't touched.
     */
    async endAllOpenSegments(sessionId, endedAt) {
        return await this.runAsync(`
                UPDATE recording_stream_segments
                SET ended_at = ?
                WHERE session_id = ? AND ended_at IS NULL
            `, [endedAt, sessionId]);
    }
}

module.exports = ContinuousRecordingRepository;
