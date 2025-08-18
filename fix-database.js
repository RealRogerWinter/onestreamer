const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

console.log('🔧 Fixing database schema issues...');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error opening database:', err);
    process.exit(1);
  }
  console.log('✅ Connected to database');
});

// Read the recording schema
const schemaPath = path.join(__dirname, 'server', 'database', 'recording-schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

db.serialize(() => {
  // Drop existing recordings table and related indexes
  console.log('🗑️  Dropping existing recordings table...');
  
  db.run('DROP INDEX IF EXISTS idx_recordings_status', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP INDEX IF EXISTS idx_recordings_session', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP INDEX IF EXISTS idx_recordings_user', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP INDEX IF EXISTS idx_recordings_created_at', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP INDEX IF EXISTS idx_recordings_streamer_id', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP INDEX IF EXISTS idx_recordings_quality_profile', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP TABLE IF EXISTS recording_events', (err) => {
    if (err) console.log('Note:', err.message);
  });
  
  db.run('DROP TABLE IF EXISTS recordings', (err) => {
    if (err) {
      console.error('❌ Error dropping recordings table:', err);
    } else {
      console.log('✅ Dropped existing recordings table');
    }
    
    // Now execute the schema SQL
    console.log('📝 Creating new recordings table with correct schema...');
    
    // Split the schema into individual statements
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    
    let completed = 0;
    const total = statements.length;
    
    statements.forEach((statement, index) => {
      db.run(statement + ';', (err) => {
        completed++;
        if (err) {
          console.error(`❌ Error executing statement ${index + 1}:`, err.message);
          console.error('Statement:', statement.substring(0, 100) + '...');
        } else {
          if (statement.includes('CREATE TABLE')) {
            console.log(`✅ Created table`);
          } else if (statement.includes('CREATE INDEX')) {
            console.log(`✅ Created index`);
          } else if (statement.includes('INSERT')) {
            console.log(`✅ Inserted default settings`);
          } else if (statement.includes('CREATE TRIGGER')) {
            console.log(`✅ Created trigger`);
          }
        }
        
        if (completed === total) {
          console.log('\n🎉 Database schema fixed successfully!');
          db.close((err) => {
            if (err) {
              console.error('Error closing database:', err);
            } else {
              console.log('✅ Database connection closed');
            }
            process.exit(0);
          });
        }
      });
    });
  });
});