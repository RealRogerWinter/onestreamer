// Debug script to check database contents
const { getAsync, allAsync } = require('./database/database');
const AccountService = require('./services/AccountService');

async function debugDatabase() {
    console.log('🔍 DEBUG: Checking database contents...');
    
    try {
        // Check users
        const users = await allAsync('SELECT * FROM users ORDER BY created_at DESC LIMIT 5');
        console.log('📊 Users in database:', users.length);
        users.forEach(user => {
            console.log(`  - User ${user.id}: ${user.username} (${user.email})`);
        });
        
        // Check user stats
        const stats = await allAsync('SELECT * FROM user_stats ORDER BY updated_at DESC LIMIT 10');
        console.log('📊 User stats in database:', stats.length);
        stats.forEach(stat => {
            console.log(`  - User ${stat.user_id}: Stream=${stat.total_stream_time}s, View=${stat.total_view_time}s, Points=${stat.points}, Streams=${stat.stream_count}`);
        });
        
        // Test points calculation for each user
        const accountService = new AccountService();
        for (const user of users) {
            const userStats = await accountService.getUserStats(user.id);
            if (userStats) {
                const calculatedPoints = accountService.calculatePoints(
                    userStats.total_stream_time || 0,
                    userStats.total_view_time || 0
                );
                console.log(`  - User ${user.username}: DB points=${userStats.points}, Calculated=${calculatedPoints}`);
            }
        }
        
    } catch (error) {
        console.error('❌ Error checking database:', error);
    }
    
    process.exit(0);
}

debugDatabase();