/**
 * ContinuousRecordingRepository
 *
 * Pure SQL wrapper for the continuous-recording tables:
 *   - recording_sessions          (one row per recording RUN — per-run ids since ADR-0028;
 *                                  pre-cutover rows were per-day buckets)
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
 *
 * PR 10.1 (Phase 10) extended this repo to cover the admin-side
 * read paths in `server/routes/admin-recordings.js`. The repo's
 * existing scope (single ownership of `recording_sessions` and
 * `recording_stream_segments`) is the reason the admin queries land
 * here rather than in a sibling `RecordingSessionRepository` — two
 * repos writing/reading the same table is a smell we avoided. The
 * 14 admin call-sites split into nine new methods below; the JOIN
 * at admin-recordings.js:~1034 (session_chat_messages ⋈ recording_sessions)
 * intentionally stays inline because cross-table queries belong to
 * the route layer per the repository pattern.
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
     * `session_id` exists. With per-run session ids (ADR-0028) this
     * inserts a fresh row on every run; the `INSERT OR IGNORE` remains
     * as a guard against a re-entrant `createSessionRecord` for the
     * SAME run (e.g. a retried start), where a duplicate would corrupt
     * the duration math.
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
     *
     * Guarded so it can never DOWNGRADE a terminal row (audit R8): a
     * session that is `'uploaded'` (archived, local files deleted) or
     * `'processing'` (upload in flight) must not silently flip back to
     * `'recording'` — with per-run ids that could only be a re-entrant
     * start colliding with an old id, and reviving it would re-expose
     * the R2/R4 skip-and-delete hazards.
     */
    async setSessionRecording(sessionId) {
        return await this.runAsync(`
                UPDATE recording_sessions SET status = 'recording', updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ? AND status NOT IN ('uploaded', 'processing')
            `, [sessionId]);
    }

    /**
     * Mark a run's row terminal once its recording stops (ADR-0028).
     * Guarded on status = 'recording' so a late/duplicate stop can't
     * regress an `'uploaded'`/`'processing'` row. This is what makes
     * upload recovery (RecordingUploadScheduler.loadPendingUploads)
     * and DB-row reaping (RecordingCleanupScheduler's
     * status IN ('completed','uploaded') filter) reach steady state —
     * the per-day model deliberately never wrote a terminal status,
     * so rows accumulated forever.
     */
    async markSessionCompleted(sessionId) {
        return await this.runAsync(`
                UPDATE recording_sessions SET status = 'completed', updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ? AND status = 'recording'
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
        // P2.2: upload_failed is terminal — un-pin those dirs from the disk
        // scanner's don't-delete gate immediately (they reclaim at plain
        // retention) instead of holding them the full 26h pending grace.
        return await this.allAsync(
            `SELECT session_id FROM recording_sessions WHERE b2_file_id IS NULL AND status != 'upload_failed'`
        );
    }

    // ------------------------------------------------------------
    // Admin-side queries (PR 10.1)
    // ------------------------------------------------------------
    //
    // The admin "review" routes hit recording_sessions with a
    // different filter shape than the service. They search by
    // partial streamer name (LIKE on two columns), they paginate,
    // they need COUNT(*) for the pagination header, and they project
    // to a few different column lists depending on the surface
    // (timeline / playback / master-stream). The methods below keep
    // each legacy SQL string byte-for-byte; that's the convention
    // PR 6.3 set and the maintainer reviews against.

    /**
     * Dynamic-filtered SELECT used by the admin /sessions listing.
     * Distinct from `listSessions` above because the admin endpoint
     * matches `streamer` partially against either `streamer_identity`
     * OR `streamer_username` (the legacy SQL OR-pair at admin-recordings.js:106).
     * Pagination is required (limit + offset are always non-null on
     * this path; the route defaults to limit=20, page=1).
     *
     * All fragments are static-string conditionals; user-controlled
     * values only flow on `params`. The `streamer` value is wrapped
     * with `%...%` in the route layer, matching legacy behaviour.
     */
    async listSessionsForAdmin({ status, streamer, dateFromMs, dateToMs, limit, offset } = {}) {
        let sql = 'SELECT * FROM recording_sessions WHERE 1=1';
        const params = [];
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        if (streamer) {
            sql += ' AND (streamer_identity LIKE ? OR streamer_username LIKE ?)';
            params.push(`%${streamer}%`, `%${streamer}%`);
        }
        if (dateFromMs) {
            sql += ' AND start_time >= ?';
            params.push(dateFromMs);
        }
        if (dateToMs) {
            sql += ' AND start_time <= ?';
            params.push(dateToMs);
        }
        sql += ' ORDER BY start_time DESC';
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);
        return await this.allAsync(sql, params);
    }

    /**
     * Matching COUNT for `listSessionsForAdmin`. Builds the same
     * WHERE-fragments (no pagination tail) so the count is
     * consistent with the page query. Legacy used `sql.replace`
     * trickery (admin-recordings.js:121); rebuilding here is
     * clearer and avoids the implicit replace-once contract.
     */
    async countSessionsForAdmin({ status, streamer, dateFromMs, dateToMs } = {}) {
        let sql = 'SELECT COUNT(*) as count FROM recording_sessions WHERE 1=1';
        const params = [];
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        if (streamer) {
            sql += ' AND (streamer_identity LIKE ? OR streamer_username LIKE ?)';
            params.push(`%${streamer}%`, `%${streamer}%`);
        }
        if (dateFromMs) {
            sql += ' AND start_time >= ?';
            params.push(dateFromMs);
        }
        if (dateToMs) {
            sql += ' AND start_time <= ?';
            params.push(dateToMs);
        }
        return await this.getAsync(sql, params);
    }

    /**
     * SELECT local_path-only by session_id. Used by the segment-
     * serving endpoint where the rest of the row is dead weight.
     * Matches the legacy SQL at admin-recordings.js:995.
     */
    async getSessionLocalPath(sessionId) {
        return await this.getAsync(
            'SELECT local_path FROM recording_sessions WHERE session_id = ?',
            [sessionId]
        );
    }

    /**
     * Total session COUNT. Used by /status. No parameters.
     */
    async countAllSessions() {
        return await this.getAsync(
            'SELECT COUNT(*) as count FROM recording_sessions'
        );
    }

    /**
     * COUNT by status. Legacy /status endpoint runs this twice with
     * hard-coded 'recording' and 'uploaded' literals; here it's
     * parameterized so the SQL is one string instead of two.
     */
    async countSessionsByStatus(status) {
        return await this.getAsync(
            'SELECT COUNT(*) as count FROM recording_sessions WHERE status = ?',
            [status]
        );
    }

    /**
     * Sessions with a non-null `local_path`, ordered ASC. Five-column
     * projection used by the /timeline endpoint (matches
     * admin-recordings.js:574-579).
     */
    async listSessionsWithLocalPathBasic() {
        return await this.allAsync(`
            SELECT session_id, start_time, end_time, local_path, status
            FROM recording_sessions
            WHERE local_path IS NOT NULL
            ORDER BY start_time ASC
        `);
    }

    /**
     * Sessions with a non-null `local_path`, ordered ASC. Seven-column
     * projection used by the /playback endpoint (matches
     * admin-recordings.js:787-792).
     */
    async listSessionsWithLocalPathFull() {
        return await this.allAsync(`
            SELECT session_id, start_time, end_time, local_path, status, duration_ms, segment_count
            FROM recording_sessions
            WHERE local_path IS NOT NULL
            ORDER BY start_time ASC
        `);
    }

    /**
     * Sessions with a non-null `local_path`, ordered ASC. Two-column
     * projection used by the /master-stream endpoint (matches
     * admin-recordings.js:858-862). Three separate methods rather
     * than one widest projection because the existing repo's
     * `listSessionsPendingUpload` set the precedent — different
     * column lists get different methods to keep each SQL string
     * matchable against the legacy source.
     */
    async listSessionsWithLocalPathIdsOnly() {
        return await this.allAsync(`
            SELECT session_id, local_path
            FROM recording_sessions
            WHERE local_path IS NOT NULL
            ORDER BY start_time ASC
        `);
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

    /**
     * SELECT stream segments started on/after `sinceMs`. Nine-column
     * projection drives the admin /timeline event list (matches
     * admin-recordings.js:616-630). ASC order so the route can build
     * events without re-sorting at the repo layer.
     */
    async listStreamSegmentsSince(sinceMs) {
        return await this.allAsync(`
            SELECT
                id,
                session_id,
                stream_identity,
                stream_type,
                display_name,
                platform,
                source_url,
                started_at,
                ended_at
            FROM recording_stream_segments
            WHERE started_at >= ?
            ORDER BY started_at ASC
        `, [sinceMs]);
    }
}

module.exports = ContinuousRecordingRepository;
