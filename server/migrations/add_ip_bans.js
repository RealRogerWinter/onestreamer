const { db } = require('../database/database');

const createIPBansTable = () => {
  return new Promise((resolve, reject) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS ip_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL UNIQUE,
        banned_by_user_id INTEGER,
        banned_by_username TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reason TEXT,
        permanent BOOLEAN DEFAULT 1,
        expires_at DATETIME,
        FOREIGN KEY (banned_by_user_id) REFERENCES users(id)
      )
    `;
    
    db.run(sql, (err) => {
      if (err) {
        console.error('❌ Failed to create ip_bans table:', err);
        reject(err);
      } else {
        console.log('✅ IP bans table created successfully');
        
        // Create index for faster lookups
        db.run('CREATE INDEX IF NOT EXISTS idx_ip_bans_ip ON ip_bans(ip_address)', (indexErr) => {
          if (indexErr) {
            console.error('❌ Failed to create IP bans index:', indexErr);
          } else {
            console.log('✅ IP bans index created');
          }
          resolve();
        });
      }
    });
  });
};

// Run migration
if (require.main === module) {
  createIPBansTable()
    .then(() => {
      console.log('✅ IP bans migration completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ IP bans migration failed:', err);
      process.exit(1);
    });
}

module.exports = createIPBansTable;