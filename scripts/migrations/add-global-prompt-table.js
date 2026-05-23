const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('Adding global prompt table to database...');

db.serialize(() => {
    // Create the global chatbot config table
    db.run(`
        CREATE TABLE IF NOT EXISTS chatbot_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            global_prompt TEXT DEFAULT 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('Error creating table:', err);
        } else {
            console.log('✅ Created chatbot_config table');
        }
    });
    
    // Insert default config if it doesn't exist
    db.run(`
        INSERT OR IGNORE INTO chatbot_config (id, global_prompt) 
        VALUES (1, 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.')
    `, (err) => {
        if (err) {
            console.error('Error inserting default config:', err);
        } else {
            console.log('✅ Inserted default global prompt');
        }
    });
    
    // Verify the table and data
    db.get('SELECT * FROM chatbot_config WHERE id = 1', (err, row) => {
        if (err) {
            console.error('Error verifying config:', err);
        } else if (row) {
            console.log('✅ Global prompt configuration ready:');
            console.log('   Prompt length:', row.global_prompt.length, 'characters');
        }
        
        db.close();
        console.log('\n✨ Migration complete! Restart the server to use the global prompt feature.');
    });
});