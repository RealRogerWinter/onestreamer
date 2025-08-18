const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

console.log('🔧 Fixing database schema issues...');

// Open database
const db = new Database(dbPath);
console.log('✅ Connected to database');

try {
  // Read the recording schema
  const schemaPath = path.join(__dirname, 'server', 'database', 'recording-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  
  // Drop existing tables and indexes
  console.log('🗑️  Dropping existing recordings tables and indexes...');
  
  const dropStatements = [
    'DROP INDEX IF EXISTS idx_recordings_status',
    'DROP INDEX IF EXISTS idx_recordings_session',
    'DROP INDEX IF EXISTS idx_recordings_user',
    'DROP INDEX IF EXISTS idx_recordings_created_at',
    'DROP INDEX IF EXISTS idx_recordings_streamer_id',
    'DROP INDEX IF EXISTS idx_recordings_quality_profile',
    'DROP INDEX IF EXISTS idx_recording_events_recording_id',
    'DROP INDEX IF EXISTS idx_recording_events_timestamp',
    'DROP INDEX IF EXISTS idx_recording_events_event_type',
    'DROP TRIGGER IF EXISTS update_recordings_timestamp',
    'DROP TABLE IF EXISTS recording_events',
    'DROP TABLE IF EXISTS recording_settings',
    'DROP TABLE IF EXISTS recordings'
  ];
  
  dropStatements.forEach(statement => {
    try {
      db.prepare(statement).run();
      console.log(`✅ Executed: ${statement}`);
    } catch (err) {
      console.log(`Note: ${err.message}`);
    }
  });
  
  console.log('\n📝 Creating new tables with correct schema...');
  
  // Split the schema into individual statements
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  let successCount = 0;
  let errorCount = 0;
  
  statements.forEach((statement, index) => {
    try {
      db.prepare(statement).run();
      successCount++;
      
      if (statement.includes('CREATE TABLE')) {
        const tableName = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || 'table';
        console.log(`✅ Created table: ${tableName}`);
      } else if (statement.includes('CREATE INDEX')) {
        const indexName = statement.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1] || 'index';
        console.log(`✅ Created index: ${indexName}`);
      } else if (statement.includes('INSERT')) {
        console.log(`✅ Inserted default settings`);
      } else if (statement.includes('CREATE TRIGGER')) {
        console.log(`✅ Created trigger`);
      }
    } catch (err) {
      errorCount++;
      console.error(`❌ Error executing statement ${index + 1}: ${err.message}`);
      console.error('Statement preview:', statement.substring(0, 100) + '...');
    }
  });
  
  console.log(`\n📊 Results: ${successCount} successful, ${errorCount} errors`);
  
  // Verify the tables were created
  console.log('\n🔍 Verifying database structure...');
  
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables in database:', tables.map(t => t.name).join(', '));
  
  // Check if recordings table has the quality_profile column
  const recordingsInfo = db.prepare("PRAGMA table_info(recordings)").all();
  const hasQualityProfile = recordingsInfo.some(col => col.name === 'quality_profile');
  
  if (hasQualityProfile) {
    console.log('✅ recordings table has quality_profile column');
  } else {
    console.log('❌ recordings table missing quality_profile column');
  }
  
  console.log('\n🎉 Database schema fix complete!');
  
} catch (err) {
  console.error('❌ Fatal error:', err);
  process.exit(1);
} finally {
  db.close();
  console.log('✅ Database connection closed');
}