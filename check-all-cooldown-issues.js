const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔍 Connected to SQLite database to check all cooldown issues');
    }
});

async function checkAllCooldownIssues() {
    return new Promise((resolve, reject) => {
        console.log('🔍 Checking for ALL future timestamp entries in item_usage_log...');
        
        // Find all entries where the used_at timestamp is in the future when compared with JavaScript Date
        db.all(
            `SELECT iul.*, i.name, i.display_name, u.username, u.email 
             FROM item_usage_log iul
             JOIN items i ON iul.item_id = i.id  
             JOIN users u ON iul.user_id = u.id
             ORDER BY iul.used_at DESC`,
            (err, allEntries) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const now = new Date();
                console.log(`🕒 Current time: ${now.toISOString()}`);
                console.log(`📊 Total item usage entries: ${allEntries.length}`);
                
                // Find entries with future timestamps
                const futureEntries = allEntries.filter(entry => {
                    const usedAt = new Date(entry.used_at);
                    return usedAt > now;
                });
                
                console.log(`\n🚨 Found ${futureEntries.length} entries with FUTURE timestamps:`);
                
                if (futureEntries.length === 0) {
                    console.log('✅ No future timestamp issues found!');
                    resolve({ allEntries, futureEntries: [] });
                    return;
                }
                
                // Group by user and item
                const groupedIssues = {};
                futureEntries.forEach(entry => {
                    const key = `${entry.username} (${entry.email}) - ${entry.display_name}`;
                    if (!groupedIssues[key]) {
                        groupedIssues[key] = [];
                    }
                    groupedIssues[key].push(entry);
                });
                
                console.log('\n📋 Grouped by User and Item:');
                Object.keys(groupedIssues).forEach((key, index) => {
                    const entries = groupedIssues[key];
                    console.log(`\n  ${index + 1}. ${key}:`);
                    entries.forEach((entry, entryIndex) => {
                        const usedAt = new Date(entry.used_at);
                        const hoursInFuture = (usedAt - now) / (1000 * 60 * 60);
                        console.log(`     ${entryIndex + 1}. ID: ${entry.id}, Used: ${usedAt.toISOString()} (${hoursInFuture.toFixed(1)}h in future)`);
                    });
                });
                
                console.log('\n🔧 Would you like to clean up ALL future timestamp entries?');
                console.log('   This will remove problematic cooldown entries for all affected users and items.');
                
                resolve({ allEntries, futureEntries, groupedIssues });
            }
        );
    });
}

checkAllCooldownIssues().then((result) => {
    console.log('\n🔍 Comprehensive cooldown check complete');
    
    if (result.futureEntries.length > 0) {
        console.log('\n❌ SYSTEMATIC ISSUE DETECTED:');
        console.log('   Multiple items have future timestamp cooldown entries');  
        console.log('   This suggests a timezone/timestamp handling problem in the application');
        console.log('\n💡 RECOMMENDATION:');
        console.log('   1. Clean up all existing future timestamp entries (immediate fix)');
        console.log('   2. Investigate the root cause of timestamp storage (long-term fix)');
        
        db.close();
        process.exit(1);
    } else {
        console.log('\n✅ All cooldown timestamps look correct');
        db.close();
        process.exit(0);
    }
}).catch(error => {
    console.error('❌ Check failed:', error.message);
    db.close();
    process.exit(1);
});