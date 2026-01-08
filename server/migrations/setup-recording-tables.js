const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

async function setupRecordingTables() {
  console.log('🗃️ RECORDING: Setting up recording database tables...');
  
  try {
    // Open database connection
    const dbPath = path.join(__dirname, '../data/onestreamer.db');
    const db = new sqlite3.Database(dbPath);
    
    // Read SQL schema
    const schemaPath = path.join(__dirname, '../database/recording-schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Split SQL statements and execute them
    // Handle triggers specially as they contain semicolons
    const statements = [];
    let currentStatement = '';
    let inTrigger = false;
    
    const lines = schemaSql.split('\n');
    for (const line of lines) {
      currentStatement += line + '\n';
      
      if (line.trim().toUpperCase().includes('CREATE TRIGGER')) {
        inTrigger = true;
      }
      
      if (line.trim() === 'END;' && inTrigger) {
        statements.push(currentStatement.trim());
        currentStatement = '';
        inTrigger = false;
      } else if (line.trim().endsWith(';') && !inTrigger && currentStatement.trim()) {
        statements.push(currentStatement.trim());
        currentStatement = '';
      }
    }
    
    // Add any remaining statement
    if (currentStatement.trim()) {
      statements.push(currentStatement.trim());
    }
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i].trim();
      if (statement && !statement.startsWith('--')) {
        await new Promise((resolve, reject) => {
          db.run(statement, (err) => {
            if (err) {
              console.error(`❌ RECORDING: Error executing statement ${i + 1}:`, err);
              console.error(`Statement was: ${statement.substring(0, 200)}...`);
              reject(err);
            } else {
              console.log(`✅ RECORDING: Executed statement ${i + 1}: ${statement.substring(0, 50)}...`);
              resolve();
            }
          });
        });
      }
    }
    
    // Close database connection
    db.close();
    
    console.log('✅ RECORDING: Recording database tables setup completed');
    return { success: true };
    
  } catch (error) {
    console.error('❌ RECORDING: Failed to setup recording tables:', error);
    return { success: false, error: error.message };
  }
}

// Run migration if called directly
if (require.main === module) {
  setupRecordingTables().then(result => {
    if (result.success) {
      console.log('🎉 RECORDING: Database migration completed successfully');
      process.exit(0);
    } else {
      console.error('💥 RECORDING: Database migration failed:', result.error);
      process.exit(1);
    }
  });
}

module.exports = { setupRecordingTables };