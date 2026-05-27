/**
 * URLStreamDatabaseService.js - Database operations for URL streams
 *
 * Manages persistence of URL stream sessions, logs, health metrics, and presets
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const applyPragmas = require('../database/applyPragmas');

const logger = require('../bootstrap/logger').child({ svc: 'URLStreamDatabaseService' });
class URLStreamDatabaseService {
  constructor() {
    this.db = null;
    this.dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');
    this.schemaPath = path.join(__dirname, '..', 'database', 'url-stream-schema.sql');
    this.initialized = false;

    logger.debug('📦 URLStreamDatabaseService created');
  }

  /**
   * Initialize the database connection and schema
   */
  async initialize() {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          logger.error('❌ Error opening database:', err);
          reject(err);
          return;
        }

        logger.debug('✅ URLStreamDatabaseService connected to database');

        // Per-connection PRAGMAs don't propagate from the main handle.
        applyPragmas(this.db)
          .then(() => this._initializeSchema())
          .then(() => {
            this.initialized = true;
            resolve();
          })
          .catch(reject);
      });
    });
  }

  /**
   * Initialize database schema
   */
  async _initializeSchema() {
    return new Promise((resolve, reject) => {
      // Read and execute schema
      if (fs.existsSync(this.schemaPath)) {
        const schema = fs.readFileSync(this.schemaPath, 'utf8');
        const statements = schema
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.startsWith('--'));

        this.db.serialize(() => {
          for (const statement of statements) {
            this.db.run(statement + ';', (err) => {
              if (err) {
                logger.error('Schema error:', err.message);
              }
            });
          }
          logger.debug('✅ URL stream schema initialized');
          resolve();
        });
      } else {
        // Create tables inline if schema file missing
        this._createTablesInline().then(resolve).catch(reject);
      }
    });
  }

  /**
   * Create tables inline (fallback)
   */
  async _createTablesInline() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS url_streams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url_id TEXT UNIQUE NOT NULL,
            source_url TEXT NOT NULL,
            platform TEXT,
            quality TEXT DEFAULT 'best',
            display_name TEXT,
            status TEXT DEFAULT 'pending',
            started_at DATETIME,
            ended_at DATETIME,
            end_reason TEXT,
            total_uptime INTEGER DEFAULT 0,
            reconnect_count INTEGER DEFAULT 0,
            auto_reconnect BOOLEAN DEFAULT 1,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS url_stream_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url_stream_id INTEGER REFERENCES url_streams(id),
            url_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            message TEXT,
            metadata TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        this.db.run(`
          CREATE TABLE IF NOT EXISTS url_stream_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source_url TEXT NOT NULL,
            platform TEXT,
            quality TEXT DEFAULT 'best',
            display_name TEXT,
            auto_reconnect BOOLEAN DEFAULT 1,
            is_active BOOLEAN DEFAULT 1,
            last_used DATETIME,
            use_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Create indexes
        this.db.run('CREATE INDEX IF NOT EXISTS idx_url_streams_url_id ON url_streams(url_id)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_url_streams_status ON url_streams(status)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_url_stream_logs_url_id ON url_stream_logs(url_id)');

        resolve();
      });
    });
  }

  // ==================== URL STREAMS ====================

  /**
   * Create a new URL stream record
   */
  async createURLStream(streamData) {
    await this.initialize();

    const {
      urlId,
      sourceUrl,
      platform,
      quality,
      displayName,
      autoReconnect
    } = streamData;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO url_streams (url_id, source_url, platform, quality, display_name, status, started_at, auto_reconnect)
         VALUES (?, ?, ?, ?, ?, 'streaming', datetime('now'), ?)`,
        [urlId, sourceUrl, platform, quality, displayName, autoReconnect ? 1 : 0],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ id: this.lastID, urlId });
          }
        }
      );
    });
  }

  /**
   * Update URL stream status
   */
  async updateURLStreamStatus(urlId, status, endReason = null) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      const updates = ['status = ?'];
      const params = [status];

      if (status === 'ended' || status === 'error') {
        updates.push('ended_at = datetime("now")');
        if (endReason) {
          updates.push('end_reason = ?');
          params.push(endReason);
        }
      }

      params.push(urlId);

      this.db.run(
        `UPDATE url_streams SET ${updates.join(', ')} WHERE url_id = ?`,
        params,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /**
   * Update reconnect count
   */
  async incrementReconnectCount(urlId) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE url_streams SET reconnect_count = reconnect_count + 1 WHERE url_id = ?',
        [urlId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /**
   * Get URL stream by ID
   */
  async getURLStream(urlId) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM url_streams WHERE url_id = ?',
        [urlId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  /**
   * Get all URL streams (with optional status filter)
   */
  async getAllURLStreams(status = null) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM url_streams ORDER BY created_at DESC';
      const params = [];

      if (status) {
        query = 'SELECT * FROM url_streams WHERE status = ? ORDER BY created_at DESC';
        params.push(status);
      }

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get recent URL streams
   */
  async getRecentURLStreams(limit = 20) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM url_streams ORDER BY created_at DESC LIMIT ?',
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  // ==================== STREAM LOGS ====================

  /**
   * Add log entry
   */
  async addLog(urlId, eventType, message, metadata = null) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO url_stream_logs (url_id, event_type, message, metadata)
         VALUES (?, ?, ?, ?)`,
        [urlId, eventType, message, metadata ? JSON.stringify(metadata) : null],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  }

  /**
   * Get logs for a URL stream
   */
  async getLogs(urlId, limit = 50) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM url_stream_logs WHERE url_id = ? ORDER BY timestamp DESC LIMIT ?`,
        [urlId, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  // ==================== PRESETS ====================

  /**
   * Create a preset
   */
  async createPreset(presetData) {
    await this.initialize();

    const { name, sourceUrl, platform, quality, displayName, autoReconnect } = presetData;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO url_stream_presets (name, source_url, platform, quality, display_name, auto_reconnect)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, sourceUrl, platform, quality, displayName, autoReconnect ? 1 : 0],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  }

  /**
   * Get all presets
   */
  async getAllPresets() {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM url_stream_presets WHERE is_active = 1 ORDER BY use_count DESC',
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Get preset by ID
   */
  async getPreset(id) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM url_stream_presets WHERE id = ?',
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  /**
   * Update preset usage
   */
  async updatePresetUsage(id) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE url_stream_presets SET use_count = use_count + 1, last_used = datetime('now') WHERE id = ?`,
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /**
   * Delete preset
   */
  async deletePreset(id) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE url_stream_presets SET is_active = 0 WHERE id = ?',
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // ==================== CLEANUP ====================

  /**
   * Clean up old records
   */
  async cleanup(daysOld = 30) {
    await this.initialize();

    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM url_stream_logs WHERE timestamp < datetime('now', '-${daysOld} days')`,
        [],
        (err) => {
          if (err) {
            reject(err);
          } else {
            logger.debug(`🗑️ Cleaned up URL stream logs older than ${daysOld} days`);
            resolve();
          }
        }
      );
    });
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

module.exports = URLStreamDatabaseService;
