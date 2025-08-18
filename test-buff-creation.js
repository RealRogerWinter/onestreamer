const { runAsync, getAsync, allAsync } = require('./server/database/database');

async function testBuffCreation() {
    console.log('🧪 Testing Buff Creation Process\n');
    console.log('=' .repeat(50));
    
    try {
        // Test creating a buff directly
        const testUserId = 999; // Test user ID
        const itemId = 65; // Emboss item ID (or any visual FX item)
        const duration = 20;
        
        console.log('1. Creating test buff...');
        const result = await runAsync(`
            INSERT INTO active_buffs (
                user_id, item_id, applied_by_user_id, buff_type,
                duration_seconds, remaining_seconds, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [testUserId, itemId, testUserId, 'buff', duration, duration, null]);
        
        console.log(`   Created buff with ID: ${result.id}`);
        
        // Immediately fetch it back
        console.log('\n2. Fetching buff immediately after creation...');
        const buff = await getAsync(`
            SELECT * FROM active_buffs WHERE id = ?
        `, [result.id]);
        
        console.log(`   Duration: ${buff.duration_seconds}s`);
        console.log(`   Remaining: ${buff.remaining_seconds}s`);
        console.log(`   Is Active: ${buff.is_active}`);
        console.log(`   Applied At: ${buff.applied_at}`);
        
        // Check if it would be returned by getActiveBuffsForUser query
        console.log('\n3. Testing getActiveBuffsForUser query...');
        const activeBuffs = await allAsync(`
            SELECT ab.*, i.name as item_name, i.display_name, i.emoji
            FROM active_buffs ab
            JOIN items i ON ab.item_id = i.id
            WHERE ab.user_id = ? AND ab.is_active = 1 AND ab.remaining_seconds > 0
        `, [testUserId]);
        
        console.log(`   Found ${activeBuffs.length} active buffs for user ${testUserId}`);
        if (activeBuffs.length > 0) {
            activeBuffs.forEach(b => {
                console.log(`   - ${b.display_name}: ${b.remaining_seconds}s remaining`);
            });
        }
        
        // Clean up
        await runAsync('DELETE FROM active_buffs WHERE id = ?', [result.id]);
        console.log('\n4. ✅ Cleaned up test buff');
        
        // Now check the actual buffs that are showing 0 seconds
        console.log('\n5. Checking existing buffs with 0 seconds...');
        const zeroSecondBuffs = await allAsync(`
            SELECT ab.*, i.display_name
            FROM active_buffs ab
            JOIN items i ON ab.item_id = i.id
            WHERE ab.remaining_seconds = 0
            LIMIT 5
        `);
        
        console.log(`   Found ${zeroSecondBuffs.length} buffs with 0 seconds remaining`);
        zeroSecondBuffs.forEach(b => {
            console.log(`   - ${b.display_name}: duration=${b.duration_seconds}s, remaining=${b.remaining_seconds}s, active=${b.is_active}`);
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        process.exit(0);
    }
}

testBuffCreation();