const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('Adding LLM model column to chatbots table...\n');

db.serialize(() => {
    // Check if column already exists
    db.all("PRAGMA table_info(chatbots)", (err, columns) => {
        if (err) {
            console.error('Error checking table info:', err);
            db.close();
            return;
        }
        
        const hasLlmModel = columns.some(col => col.name === 'llm_model');
        
        if (hasLlmModel) {
            console.log('✅ llm_model column already exists');
            db.close();
            return;
        }
        
        // Add the column if it doesn't exist
        db.run(`
            ALTER TABLE chatbots 
            ADD COLUMN llm_model TEXT
        `, (err) => {
            if (err) {
                console.error('Error adding llm_model column:', err);
            } else {
                console.log('✅ Added llm_model column to chatbots table');
                
                // Set default model for existing bots (null means use global default)
                console.log('   Setting existing bots to use global default model...');
                
                // Show current bots
                db.all('SELECT id, name, llm_model FROM chatbots', (err, bots) => {
                    if (!err && bots.length > 0) {
                        console.log('\n📋 Updated chatbots:');
                        bots.forEach(bot => {
                            const model = bot.llm_model || 'Uses global default';
                            console.log(`   Bot "${bot.name}" (ID: ${bot.id}) - Model: ${model}`);
                        });
                    }
                    
                    db.close();
                    console.log('\n✨ Database update complete!');
                });
            }
        });
    });
});