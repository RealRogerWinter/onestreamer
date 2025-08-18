const database = require('./server/database/database.js');

async function checkBotStatus() {
    const db = database;
    
    console.log('\n📋 Checking MovieBot-enabled bots...\n');
    console.log('=' .repeat(70));
    
    // Get all moviebot-enabled bots
    const query = `
        SELECT id, name, username, is_enabled, moviebot_enabled 
        FROM bots 
        WHERE moviebot_enabled = 1
        ORDER BY name
    `;
    
    const bots = db.prepare(query).all();
    
    console.log(`\nFound ${bots.length} bots with MovieBot enabled:\n`);
    
    bots.forEach(bot => {
        const status = bot.is_enabled ? '✅ Enabled' : '❌ Disabled';
        console.log(`  Bot ${bot.id}: ${bot.name} (${bot.username})`);
        console.log(`    Status: ${status}`);
        console.log(`    MovieBot: ${bot.moviebot_enabled ? 'YES' : 'NO'}`);
        console.log();
    });
    
    // Count online bots
    const enabledCount = bots.filter(b => b.is_enabled).length;
    console.log('=' .repeat(70));
    console.log(`\n📊 Summary:`);
    console.log(`  Total MovieBot bots: ${bots.length}`);
    console.log(`  Currently enabled: ${enabledCount}`);
    console.log(`  Currently disabled: ${bots.length - enabledCount}`);
    
    // db.close();
}

checkBotStatus().catch(console.error);