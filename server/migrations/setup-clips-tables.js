/**
 * Setup clips and clip_views tables for the clipping system
 */
const setupClipsTables = async (db) => {
  const runAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  };

  console.log('📎 CLIPS: Setting up clips tables...');

  try {
    // Create clips table
    await runAsync(`
      CREATE TABLE IF NOT EXISTS clips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clip_id TEXT UNIQUE NOT NULL,
        recording_id TEXT,
        user_id INTEGER,
        streamer_user_id INTEGER,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        start_time_ms INTEGER NOT NULL,
        end_time_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT DEFAULT 'processing',
        file_path TEXT,
        thumbnail_path TEXT,
        file_size INTEGER DEFAULT 0,
        view_count INTEGER DEFAULT 0,
        is_public INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ CLIPS: Created clips table');

    // Create clip_views table for tracking views
    await runAsync(`
      CREATE TABLE IF NOT EXISTS clip_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clip_id TEXT NOT NULL,
        user_id INTEGER,
        ip_address TEXT,
        viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ CLIPS: Created clip_views table');

    // Create indexes for common queries
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_clips_clip_id ON clips(clip_id)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_clips_user_id ON clips(user_id)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips(created_at)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_clips_is_public ON clips(is_public)`);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_clip_views_clip_id ON clip_views(clip_id)`);
    console.log('✅ CLIPS: Created indexes');

    console.log('✅ CLIPS: Tables setup complete');
  } catch (error) {
    console.error('❌ CLIPS: Failed to setup tables:', error);
    throw error;
  }
};

module.exports = setupClipsTables;
