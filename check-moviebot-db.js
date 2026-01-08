const { db } = require('./server/database/database.js');

function checkMovieBotDatabase() {
    console.log('\n🔍 Checking MovieBot Database Configuration...\n');
    console.log('=' .repeat(70));
    
    db.all(
        'SELECT id, name, is_enabled, moviebot_enabled FROM chatbots ORDER BY name',
        [],
        (err, bots) => {
            if (err) {
                console.error('Error querying database:', err);
                return;
            }
            
            const movieBotEnabled = bots.filter(b => b.moviebot_enabled === 1);
            const activeMovieBots = bots.filter(b => b.moviebot_enabled === 1 && b.is_enabled === 1);
            const inactiveMovieBots = bots.filter(b => b.moviebot_enabled === 1 && b.is_enabled === 0);
            
            console.log('📋 All Bots in Database:\n');
            bots.forEach(bot => {
                const movieBot = bot.moviebot_enabled ? '🎬' : '  ';
                const enabled = bot.is_enabled ? '✅' : '❌';
                console.log(`  ${movieBot} ${enabled} Bot ${bot.id}: ${bot.name}`);
            });
            
            console.log('\n' + '=' .repeat(70));
            console.log('\n📊 MovieBot Statistics:');
            console.log(`  Total bots: ${bots.length}`);
            console.log(`  MovieBot-enabled bots: ${movieBotEnabled.length}`);
            console.log(`  Active MovieBots (enabled): ${activeMovieBots.length}`);
            console.log(`  Inactive MovieBots (disabled): ${inactiveMovieBots.length}`);
            
            console.log('\n🎬 Active MovieBots:');
            activeMovieBots.forEach(bot => {
                console.log(`  ✅ ${bot.name}`);
            });
            
            if (inactiveMovieBots.length > 0) {
                console.log('\n⚠️ Inactive MovieBots (need enabling):');
                inactiveMovieBots.forEach(bot => {
                    console.log(`  ❌ ${bot.name}`);
                });
            }
            
            // Check if we have the expected bots
            const expectedBots = ['TheInventor', 'TheArtist', 'TheScholar', 'TheComedian', 'TheMystic', 'TheStrategist'];
            const foundBots = activeMovieBots.map(b => b.name);
            const missingBots = expectedBots.filter(name => !foundBots.includes(name));
            
            if (missingBots.length > 0) {
                console.log('\n❌ Missing Expected MovieBots:');
                missingBots.forEach(name => {
                    const bot = bots.find(b => b.name === name);
                    if (bot) {
                        if (!bot.moviebot_enabled) {
                            console.log(`  ${name} - moviebot_enabled is 0`);
                        } else if (!bot.is_enabled) {
                            console.log(`  ${name} - is_enabled is 0`);
                        }
                    } else {
                        console.log(`  ${name} - not found in database`);
                    }
                });
            }
            
            console.log('\n' + '=' .repeat(70));
            
            process.exit(0);
        }
    );
}

checkMovieBotDatabase();