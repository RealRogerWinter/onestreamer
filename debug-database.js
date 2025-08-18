const database = require('./server/database/database');

async function checkDatabase() {
    try {
        console.log('🔍 Checking database for chatbots...\n');
        
        // Check chatbots table
        const bots = await database.allAsync('SELECT * FROM chatbots ORDER BY id');
        console.log(`Found ${bots.length} chatbots in database:`);
        
        bots.forEach(bot => {
            console.log(`  ID: ${bot.id}, Name: ${bot.name}, Enabled: ${bot.is_enabled}, Created: ${bot.created_at}`);
        });
        
        if (bots.length === 0) {
            console.log('  No chatbots found in database.');
        }
        
        console.log('\n🔍 Checking chatbot sessions...');
        const sessions = await database.allAsync('SELECT * FROM chatbot_sessions ORDER BY id');
        console.log(`Found ${sessions.length} active sessions:`);
        
        sessions.forEach(session => {
            console.log(`  ID: ${session.id}, Bot ID: ${session.chatbot_id}, Username: ${session.username}, Connected: ${session.connected_at}`);
        });
        
        if (sessions.length === 0) {
            console.log('  No active sessions found.');
        }
        
    } catch (error) {
        console.error('❌ Error checking database:', error);
    } finally {
        database.db.close();
    }
}

checkDatabase();