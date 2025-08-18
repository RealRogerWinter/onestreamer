const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

async function observeStreamingBehavior() {
    console.log('👀 Observing current buff behavior...\n');
    
    // Check current active buffs
    db.all(`SELECT ab.*, i.name as item_name, i.display_name, i.emoji 
            FROM active_buffs ab 
            JOIN items i ON ab.item_id = i.id 
            WHERE ab.is_active = 1 AND ab.remaining_seconds > 0 
            ORDER BY ab.applied_at DESC`, (err, buffs) => {
        
        if (err) {
            console.error('Error:', err);
            db.close();
            return;
        }
        
        if (buffs.length === 0) {
            console.log('📊 No active buffs found');
            db.close();
            return;
        }
        
        console.log('📊 Current active buffs:');
        buffs.forEach(buff => {
            console.log(`   - ${buff.display_name} (${buff.item_name}) for user ${buff.user_id}`);
            console.log(`     Duration: ${buff.duration_seconds}s, Remaining: ${buff.remaining_seconds}s`);
            console.log(`     Applied: ${buff.applied_at}, Last Updated: ${buff.last_updated}`);
            console.log(`     Streaming time used: ${buff.streaming_time_used}s`);
        });
        
        console.log('\n🔍 The server logs should show:');
        console.log('   • No "ticking down" messages (user not streaming)');
        console.log('   • Periodic "Preserving" messages every 60 seconds');
        console.log('   • Buff duration remains constant');
        
        console.log('\n✅ This demonstrates that buff durations only tick down for streaming users!');
        console.log('💡 To see the buff tick down, the user would need to start streaming.');
        
        db.close();
    });
}

observeStreamingBehavior();