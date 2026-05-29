const logger = require('../../bootstrap/logger').child({ svc: 'TranscriptionRepository' });

/**
 * TranscriptionRepository
 *
 * Pure SQL wrapper for the transcription tables:
 *   - transcriptions          (one row per session)
 *   - transcription_chunks    (1:N child rows of transcribed text)
 *
 * No business logic — methods are thin shims over the DB primitives
 * (`runAsync`, `getAsync`, `allAsync`). Session orchestration stays in
 * TranscriptionService.
 *
 * Extracted from `server/services/TranscriptionService.js`.
 */
class TranscriptionRepository {
    /**
     * @param {object} deps
     * @param {Function} deps.runAsync - (sql, params) => Promise<{ id, changes }>
     * @param {Function} deps.getAsync - (sql, params) => Promise<row|undefined>
     * @param {Function} deps.allAsync - (sql, params) => Promise<row[]>
     */
    constructor(deps = {}) {
        this.runAsync = deps.runAsync;
        this.getAsync = deps.getAsync;
        this.allAsync = deps.allAsync;
    }

    async saveTranscriptionToDatabase(session) {
        try {
            const sql = `
                INSERT INTO transcriptions (
                    id, stream_id, streamer_id, start_time,
                    language, model, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;

            await this.runAsync(sql, [
                session.id,
                session.id, // Using session ID as stream ID for now
                session.streamerId,
                session.startTime.toISOString(),
                session.config.language || 'auto',
                session.config.model,
                session.status,
                new Date().toISOString()
            ]);

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to save to database:', error);
        }
    }

    async saveTranscriptionChunk(session, text, chunkNumber) {
        try {
            const sql = `
                INSERT INTO transcription_chunks (
                    transcription_id, chunk_number, text,
                    timestamp, word_count
                ) VALUES (?, ?, ?, ?, ?)
            `;

            await this.runAsync(sql, [
                session.id,
                chunkNumber,
                text,
                new Date().toISOString(),
                text.split(/\s+/).length
            ]);

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to save chunk to database:', error);
        }
    }

    async updateTranscriptionInDatabase(session) {
        try {
            const duration = session.endTime
                ? Math.floor((session.endTime - session.startTime) / 1000)
                : 0;

            const sql = `
                UPDATE transcriptions
                SET end_time = ?, duration = ?, word_count = ?, status = ?
                WHERE id = ?
            `;

            await this.runAsync(sql, [
                session.endTime?.toISOString(),
                duration,
                session.wordCount,
                session.status,
                session.id
            ]);

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to update database:', error);
        }
    }

    async getTranscription(sessionId) {
        try {
            const sql = `
                SELECT t.*, GROUP_CONCAT(tc.text, ' ') as full_text
                FROM transcriptions t
                LEFT JOIN transcription_chunks tc ON t.id = tc.transcription_id
                WHERE t.id = ?
                GROUP BY t.id
            `;

            const result = await this.getAsync(sql, [sessionId]);
            return result;

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to get transcription:', error);
            return null;
        }
    }

    async getTranscriptionHistory(limit = 50, offset = 0, filters = {}) {
        try {
            let sql = `
                SELECT t.*,
                       COUNT(tc.id) as chunk_count,
                       GROUP_CONCAT(tc.text, ' ') as full_text
                FROM transcriptions t
                LEFT JOIN transcription_chunks tc ON t.id = tc.transcription_id
                WHERE 1=1
            `;

            const params = [];

            // Add filters
            if (filters.status) {
                sql += ' AND t.status = ?';
                params.push(filters.status);
            }

            if (filters.streamerId) {
                sql += ' AND t.streamer_id = ?';
                params.push(filters.streamerId);
            }

            if (filters.startDate) {
                sql += ' AND DATE(t.start_time) >= DATE(?)';
                params.push(filters.startDate);
            }

            if (filters.endDate) {
                sql += ' AND DATE(t.start_time) <= DATE(?)';
                params.push(filters.endDate);
            }

            sql += `
                GROUP BY t.id
                ORDER BY t.created_at DESC
                LIMIT ? OFFSET ?
            `;

            params.push(limit, offset);

            const transcriptions = await this.allAsync(sql, params);

            // Get total count for pagination
            const countSql = `
                SELECT COUNT(DISTINCT id) as total
                FROM transcriptions
                WHERE 1=1
                ${filters.status ? ' AND status = ?' : ''}
                ${filters.streamerId ? ' AND streamer_id = ?' : ''}
                ${filters.startDate ? ' AND DATE(start_time) >= DATE(?)' : ''}
                ${filters.endDate ? ' AND DATE(start_time) <= DATE(?)' : ''}
            `;

            const countParams = params.slice(0, -2); // Remove limit and offset
            const countResult = await this.getAsync(countSql, countParams);

            return {
                transcriptions: transcriptions || [],
                total: countResult?.total || 0,
                limit,
                offset
            };

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to get history:', error);
            return {
                transcriptions: [],
                total: 0,
                limit,
                offset
            };
        }
    }

    async deleteOldTranscriptions(daysOld = 30) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysOld);

            const sql = `
                DELETE FROM transcriptions
                WHERE created_at < ? AND status = 'completed'
            `;

            const result = await this.runAsync(sql, [cutoffDate.toISOString()]);

            return {
                success: true,
                deletedCount: result.changes
            };

        } catch (error) {
            logger.error('❌ TRANSCRIPTION: Failed to delete old transcriptions:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

module.exports = TranscriptionRepository;
