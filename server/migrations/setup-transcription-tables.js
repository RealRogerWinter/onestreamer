const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');

async function setupTranscriptionTables() {
    console.log('🔧 Setting up transcription tables...');
    
    const db = new sqlite3.Database(dbPath);
    
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Create transcriptions table
            db.run(`
                CREATE TABLE IF NOT EXISTS transcriptions (
                    id TEXT PRIMARY KEY,
                    stream_id TEXT,
                    streamer_id TEXT NOT NULL,
                    recording_id TEXT,
                    start_time DATETIME NOT NULL,
                    end_time DATETIME,
                    duration INTEGER,
                    language TEXT DEFAULT 'en',
                    model TEXT DEFAULT 'base',
                    word_count INTEGER DEFAULT 0,
                    status TEXT DEFAULT 'active',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (streamer_id) REFERENCES users(id),
                    FOREIGN KEY (recording_id) REFERENCES recordings(id)
                )
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating transcriptions table:', err);
                } else {
                    console.log('✅ Transcriptions table created');
                }
            });
            
            // Create transcription_chunks table for storing text segments
            db.run(`
                CREATE TABLE IF NOT EXISTS transcription_chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transcription_id TEXT NOT NULL,
                    chunk_number INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    timestamp DATETIME NOT NULL,
                    word_count INTEGER DEFAULT 0,
                    confidence REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE,
                    UNIQUE(transcription_id, chunk_number)
                )
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating transcription_chunks table:', err);
                } else {
                    console.log('✅ Transcription chunks table created');
                }
            });
            
            // Create indexes for better query performance
            db.run(`
                CREATE INDEX IF NOT EXISTS idx_transcriptions_streamer 
                ON transcriptions(streamer_id, created_at DESC)
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating streamer index:', err);
                } else {
                    console.log('✅ Streamer index created');
                }
            });
            
            db.run(`
                CREATE INDEX IF NOT EXISTS idx_transcriptions_status 
                ON transcriptions(status, created_at DESC)
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating status index:', err);
                } else {
                    console.log('✅ Status index created');
                }
            });
            
            db.run(`
                CREATE INDEX IF NOT EXISTS idx_chunks_transcription 
                ON transcription_chunks(transcription_id, chunk_number)
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating chunks index:', err);
                } else {
                    console.log('✅ Chunks index created');
                }
            });
            
            // Create transcription_events table for tracking events
            db.run(`
                CREATE TABLE IF NOT EXISTS transcription_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transcription_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    metadata TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating transcription_events table:', err);
                } else {
                    console.log('✅ Transcription events table created');
                }
            });
            
            // Create transcription_settings table for user preferences
            db.run(`
                CREATE TABLE IF NOT EXISTS transcription_settings (
                    user_id TEXT PRIMARY KEY,
                    auto_transcribe BOOLEAN DEFAULT 0,
                    preferred_language TEXT DEFAULT 'en',
                    preferred_model TEXT DEFAULT 'base',
                    show_live_captions BOOLEAN DEFAULT 1,
                    save_transcripts BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )
            `, (err) => {
                if (err) {
                    console.error('❌ Error creating transcription_settings table:', err);
                } else {
                    console.log('✅ Transcription settings table created');
                }
            });
        });
        
        db.close((err) => {
            if (err) {
                console.error('❌ Error closing database:', err);
                reject(err);
            } else {
                console.log('✅ Transcription tables setup complete');
                resolve();
            }
        });
    });
}

// Run the migration
if (require.main === module) {
    setupTranscriptionTables()
        .then(() => {
            console.log('✨ Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Migration failed:', error);
            process.exit(1);
        });
}

module.exports = setupTranscriptionTables;