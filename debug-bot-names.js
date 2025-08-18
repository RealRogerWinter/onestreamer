const database = require('./server/database/database');

async function debugBotNames() {
    console.log('🔍 Debugging bot name loading...\n');
    
    try {
        const bots = await database.allAsync('SELECT * FROM chatbots WHERE is_enabled = 1');
        
        console.log('📋 Enabled bots from database:');
        bots.forEach(bot => {
            console.log(`\nBot ID ${bot.id}: ${bot.name}`);
            console.log(`  use_assigned_name: ${bot.use_assigned_name} (type: ${typeof bot.use_assigned_name})`);
            console.log(`  is_enabled: ${bot.is_enabled}`);
            console.log(`  show_robot_emoji: ${bot.show_robot_emoji}`);
            
            // Show what name should be used
            const shouldUseAssigned = bot.use_assigned_name ? true : false;
            console.log(`  Should use: ${shouldUseAssigned ? 'Assigned name' : 'Random name'}`);
            console.log(`  Expected name in chat: ${shouldUseAssigned ? bot.name : '[Random Animal]'}`);
        });
        
        database.db.close();
    } catch (error) {
        console.error('Error:', error);
    }
}

debugBotNames();