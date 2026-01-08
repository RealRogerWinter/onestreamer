const { db } = require('../database/database');

const createStreamingLogsTable = () => {
  return new Promise((resolve, reject) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS streaming_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        streamer_id TEXT NOT NULL,
        streamer_name TEXT,
        user_id INTEGER,
        ip_address TEXT NOT NULL,
        user_agent TEXT,
        stream_type TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        duration INTEGER, -- in seconds
        viewer_peak INTEGER DEFAULT 0,
        is_viewbot BOOLEAN DEFAULT 0,
        is_banned BOOLEAN DEFAULT 0,
        disconnect_reason TEXT,
        country TEXT,
        city TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `;
    
    db.run(sql, (err) => {
      if (err) {
        console.error('❌ Failed to create streaming_logs table:', err);
        reject(err);
      } else {
        console.log('✅ Streaming logs table created successfully');
        
        // Create indexes for faster lookups
        const indexes = [
          'CREATE INDEX IF NOT EXISTS idx_streaming_logs_ip ON streaming_logs(ip_address)',
          'CREATE INDEX IF NOT EXISTS idx_streaming_logs_started ON streaming_logs(started_at DESC)',
          'CREATE INDEX IF NOT EXISTS idx_streaming_logs_user ON streaming_logs(user_id)',
          'CREATE INDEX IF NOT EXISTS idx_streaming_logs_session ON streaming_logs(session_id)',
          'CREATE INDEX IF NOT EXISTS idx_streaming_logs_viewbot ON streaming_logs(is_viewbot)'
        ];
        
        let completed = 0;
        indexes.forEach(indexSql => {
          db.run(indexSql, (indexErr) => {
            if (indexErr) {
              console.error('❌ Failed to create index:', indexErr);
            }
            completed++;
            if (completed === indexes.length) {
              console.log('✅ All streaming logs indexes created');
              resolve();
            }
          });
        });
      }
    });
  });
};

// Run migration
if (require.main === module) {
  createStreamingLogsTable()
    .then(() => {
      console.log('✅ Streaming logs migration completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Streaming logs migration failed:', err);
      process.exit(1);
    });
}

module.exports = createStreamingLogsTable;