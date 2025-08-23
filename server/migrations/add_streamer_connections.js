const { db } = require('../database/database');

const createStreamerConnectionsTable = () => {
  return new Promise((resolve, reject) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS streamer_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streamer_id TEXT NOT NULL,
        streamer_name TEXT,
        ip_address TEXT NOT NULL,
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        disconnected_at DATETIME,
        stream_duration INTEGER, -- in seconds
        connection_type TEXT, -- 'webrtc', 'websocket', etc.
        user_agent TEXT,
        was_banned BOOLEAN DEFAULT 0,
        disconnect_reason TEXT
      )
    `;
    
    db.run(sql, (err) => {
      if (err) {
        console.error('❌ Failed to create streamer_connections table:', err);
        reject(err);
      } else {
        console.log('✅ Streamer connections table created successfully');
        
        // Create indexes for faster lookups
        const indexes = [
          'CREATE INDEX IF NOT EXISTS idx_streamer_connections_ip ON streamer_connections(ip_address)',
          'CREATE INDEX IF NOT EXISTS idx_streamer_connections_streamer ON streamer_connections(streamer_id)',
          'CREATE INDEX IF NOT EXISTS idx_streamer_connections_connected ON streamer_connections(connected_at DESC)'
        ];
        
        let completed = 0;
        indexes.forEach(indexSql => {
          db.run(indexSql, (indexErr) => {
            if (indexErr) {
              console.error('❌ Failed to create index:', indexErr);
            }
            completed++;
            if (completed === indexes.length) {
              console.log('✅ All streamer connections indexes created');
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
  createStreamerConnectionsTable()
    .then(() => {
      console.log('✅ Streamer connections migration completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Streamer connections migration failed:', err);
      process.exit(1);
    });
}

module.exports = createStreamerConnectionsTable;