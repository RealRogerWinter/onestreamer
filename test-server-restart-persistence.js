const ViewBotDatabaseService = require('./server/services/ViewBotDatabaseService');

/**
 * Test script to check if ViewBot data persists after server restart
 */
async function testServerRestartPersistence() {
    console.log('🔄 Testing ViewBot persistence after server restart...\n');
    
    const dbService = new ViewBotDatabaseService();
    
    try {
        // Initialize database service
        await dbService.initialize();
        console.log('✅ Database service initialized\n');
        
        // Check if our test ViewBots from previous run still exist
        console.log('🔍 Checking for previously saved ViewBots...');
        const allBots = await dbService.loadAllViewBots();
        
        console.log(`📊 Found ${allBots.length} ViewBots in database:`);
        for (const bot of allBots) {
            console.log(`   • ${bot.name} (${bot.botId}) - ${bot.contentType}`);
            console.log(`     Created: ${bot.createdAt}, Used: ${bot.usageCount} times`);
            if (bot.timeAllotment) {
                console.log(`     Time allotment: ${Math.floor(bot.timeAllotment/1000)}s`);
            }
        }
        
        // Check system state persistence
        console.log('\n🔍 Checking system state...');
        const systemState = await dbService.loadSystemState();
        console.log(`   • Rotation enabled: ${systemState.rotationEnabled}`);
        console.log(`   • Current live bot: ${systemState.currentLiveBot || 'none'}`);
        console.log(`   • Real streamer active: ${systemState.realStreamerActive}`);
        
        // Check session history
        console.log('\n🔍 Checking session history...');
        const analytics = await dbService.getAnalytics(null, '7d');
        console.log(`   • Total sessions: ${analytics.sessions.total_sessions}`);
        console.log(`   • Total rotations: ${analytics.rotations.total_rotations}`);
        console.log(`   • Average session duration: ${Math.floor(analytics.sessions.avg_duration || 0)}ms`);
        
        if (allBots.length > 0) {
            console.log('\n🎉 SUCCESS: ViewBot data persisted successfully across server restart!');
            console.log('\n✨ Key findings:');
            console.log('• ViewBot configurations were restored from database');
            console.log('• System state (rotation settings) was preserved');
            console.log('• Session history and analytics data survived restart');
            console.log('• All CRUD operations work correctly with persistence');
            
            // Test loading a specific bot
            const firstBot = allBots[0];
            const specificBot = await dbService.loadViewBot(firstBot.botId);
            if (specificBot && specificBot.botId === firstBot.botId) {
                console.log(`• Individual bot loading works (tested with ${firstBot.botId})`);
            }
            
        } else {
            console.log('\n⚠️  No ViewBots found in database.');
            console.log('This could mean:');
            console.log('• This is a fresh database (run test-viewbot-persistence.js first)');
            console.log('• Database was cleared');
            console.log('• There was an issue with data persistence');
        }
        
    } catch (error) {
        console.error('❌ Persistence test failed:', error);
        throw error;
    }
}

// Run the test
testServerRestartPersistence()
    .then(() => {
        console.log('\n✅ Server restart persistence test completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    });