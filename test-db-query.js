const database = require('./server/database/database');

async function testQuery() {
    console.log('Testing database query...\n');
    
    const bots = await database.allAsync('SELECT * FROM chatbots WHERE is_enabled = 1');
    
    console.log('Raw query result:');
    console.log(JSON.stringify(bots, null, 2));
    
    console.log('\nField analysis:');
    bots.forEach(bot => {
        console.log(`\nBot ${bot.id}: ${bot.name}`);
        console.log('  Fields present:');
        Object.keys(bot).forEach(key => {
            console.log(`    ${key}: ${bot[key]} (type: ${typeof bot[key]})`);
        });
    });
    
    database.db.close();
}

testQuery();