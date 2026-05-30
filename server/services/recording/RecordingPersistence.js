const fs = require('fs');

const logger = require('../../bootstrap/logger').child({ svc: 'RecordingService' });

/**
 * RecordingPersistence - database/listing collaborator for RecordingService.
 *
 * Owns the SQLite reads/writes for recordings + recording_events and the
 * listing query. Extracted VERBATIM from RecordingService; all state (the
 * `runAsync`/`allAsync` helpers) lives on the owning service. Methods are thin
 * delegators with identical signatures (`this.` -> `owner.`).
 *
 * @param {Object} owner - The RecordingService instance (DB helpers + state).
 */
class RecordingPersistence {
  constructor(owner) {
    this.owner = owner;
  }

  async saveRecordingToDatabase(recordingSession) {
    const owner = this.owner;
    try {
      const sql = `
        INSERT INTO recordings (
          id, stream_id, streamer_id, start_time, file_path,
          quality_profile, format, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      await owner.runAsync(sql, [
        recordingSession.id,
        recordingSession.id, // Using recording ID as stream ID for now
        recordingSession.streamerId,
        recordingSession.startTime.toISOString(),
        recordingSession.filePath,
        recordingSession.quality,
        'webm',
        recordingSession.status,
        new Date().toISOString()
      ]);

    } catch (error) {
      logger.error('❌ RECORDING: Failed to save to database:', error);
    }
  }

  async updateRecordingInDatabase(recordingSession) {
    const owner = this.owner;
    try {
      const fileSize = fs.existsSync(recordingSession.filePath)
        ? fs.statSync(recordingSession.filePath).size
        : 0;

      const duration = recordingSession.endTime
        ? Math.floor((recordingSession.endTime - recordingSession.startTime) / 1000)
        : 0;

      const sql = `
        UPDATE recordings
        SET end_time = ?, duration = ?, file_size = ?, status = ?
        WHERE id = ?
      `;

      await owner.runAsync(sql, [
        recordingSession.endTime?.toISOString(),
        duration,
        fileSize,
        recordingSession.status,
        recordingSession.id
      ]);

    } catch (error) {
      logger.error('❌ RECORDING: Failed to update database:', error);
    }
  }

  async logRecordingEvent(recordingId, eventType, metadata = {}) {
    const owner = this.owner;
    try {
      const sql = `
        INSERT INTO recording_events (
          recording_id, event_type, metadata, timestamp
        ) VALUES (?, ?, ?, ?)
      `;

      await owner.runAsync(sql, [
        recordingId,
        eventType,
        JSON.stringify(metadata),
        new Date().toISOString()
      ]);

    } catch (error) {
      logger.error('❌ RECORDING: Failed to log event:', error);
    }
  }

  async getRecordingsList(limit = 50, offset = 0, status = null) {
    const owner = this.owner;
    try {
      let sql = `
        SELECT * FROM recordings
        ${status ? 'WHERE status = ?' : ''}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

      const params = status ? [status, limit, offset] : [limit, offset];
      const recordings = await owner.allAsync(sql, params);

      return recordings;

    } catch (error) {
      logger.error('❌ RECORDING: Failed to get recordings list:', error);
      return [];
    }
  }
}

module.exports = RecordingPersistence;
