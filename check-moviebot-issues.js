const { io: ioClient } = require('socket.io-client');

async function diagnoseMovieBotIssues() {
    console.log('\n🔍 Diagnosing MovieBot Issues...\n');
    console.log('=' .repeat(70));
    
    // Connect to server
    const adminSocket = ioClient('http://localhost:8080', {
        transports: ['websocket']
    });
    
    adminSocket.on('connect', async () => {
        console.log('✅ Connected to server\n');
        
        // Request bot status
        adminSocket.emit('admin-get-bots', { adminKey: '***REMOVED-ADMIN-KEY***' });
        
        adminSocket.on('admin-bots-list', (data) => {
            console.log('📋 All Bots Status:\n');
            
            const movieBotEnabled = [];
            const movieBotDisabled = [];
            const notMovieBot = [];
            
            data.bots.forEach(bot => {
                if (bot.moviebot_enabled) {
                    if (bot.is_enabled && bot.connected) {
                        movieBotEnabled.push(bot);
                    } else {
                        movieBotDisabled.push(bot);
                    }
                } else {
                    notMovieBot.push(bot);
                }
            });
            
            console.log(`✅ MovieBot Enabled & Connected: ${movieBotEnabled.length}`);
            movieBotEnabled.forEach(bot => {
                console.log(`   - ${bot.name} (ID: ${bot.id}) - ✅ Enabled, ✅ Connected`);
            });
            
            console.log(`\n⚠️ MovieBot Enabled but Offline/Disabled: ${movieBotDisabled.length}`);
            movieBotDisabled.forEach(bot => {
                const status = [];
                if (!bot.is_enabled) status.push('❌ Disabled');
                if (!bot.connected) status.push('❌ Not Connected');
                console.log(`   - ${bot.name} (ID: ${bot.id}) - ${status.join(', ')}`);
            });
            
            console.log(`\n❌ Not MovieBot Enabled: ${notMovieBot.length}`);
            notMovieBot.forEach(bot => {
                console.log(`   - ${bot.name} (ID: ${bot.id})`);
            });
            
            console.log('\n' + '=' .repeat(70));
            console.log('\n📊 Summary:');
            console.log(`   Total bots: ${data.bots.length}`);
            console.log(`   MovieBot enabled (total): ${movieBotEnabled.length + movieBotDisabled.length}`);
            console.log(`   MovieBot active (enabled & connected): ${movieBotEnabled.length}`);
            console.log(`   MovieBot inactive: ${movieBotDisabled.length}`);
            
            console.log('\n💡 Issues Found:');
            if (movieBotEnabled.length < 6) {
                console.log(`   ⚠️ Only ${movieBotEnabled.length}/6 expected bots are active for MovieBot`);
            }
            if (movieBotDisabled.length > 0) {
                console.log(`   ⚠️ ${movieBotDisabled.length} MovieBot-enabled bots are offline or disabled`);
            }
            
            console.log('\n🔧 Recommendations:');
            if (movieBotDisabled.length > 0) {
                console.log('   1. Enable disabled MovieBot bots');
                console.log('   2. Ensure all MovieBot bots are connected');
            }
            if (movieBotEnabled.length < 6) {
                console.log('   3. Check if all expected bots have moviebot_enabled = 1 in database');
            }
            
            process.exit(0);
        });
    });
    
    adminSocket.on('connect_error', (error) => {
        console.error('❌ Failed to connect:', error.message);
        process.exit(1);
    });
}

diagnoseMovieBotIssues().catch(console.error);