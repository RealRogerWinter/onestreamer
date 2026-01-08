const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking points system for all users\n');
console.log('=' .repeat(60));

// First check the schema
db.all("PRAGMA table_info(user_stats)", (err, columns) => {
    if (err) {
        console.error('❌ Error checking schema:', err);
        db.close();
        return;
    }
    
    console.log('\n📋 USER_STATS TABLE SCHEMA:');
    const pointsColumns = columns.filter(col => col.name.includes('point'));
    pointsColumns.forEach(col => {
        console.log(`  - ${col.name} (${col.type})`);
    });
    
    // Now check all users' points
    db.all(`
        SELECT 
            us.user_id,
            u.username,
            us.points_balance,
            us.total_stream_time,
            us.total_view_time,
            us.chat_message_count
        FROM user_stats us
        LEFT JOIN users u ON us.user_id = u.id
        ORDER BY us.points_balance DESC
        LIMIT 10
    `, (err, rows) => {
        if (err) {
            console.error('❌ Error querying users:', err);
            db.close();
            return;
        }
        
        console.log('\n📊 TOP USERS BY POINTS BALANCE:');
        console.log('User ID | Username       | Points Balance | Stream Time | View Time | Chat Messages');
        console.log('-'.repeat(85));
        
        rows.forEach(row => {
            const streamMinutes = Math.floor((row.total_stream_time || 0) / 60);
            const viewMinutes = Math.floor((row.total_view_time || 0) / 60);
            console.log(
                `${String(row.user_id).padEnd(7)} | ` +
                `${String(row.username || 'N/A').padEnd(14)} | ` +
                `${String(row.points_balance || 0).padEnd(14)} | ` +
                `${String(streamMinutes).padEnd(11)}m | ` +
                `${String(viewMinutes).padEnd(9)}m | ` +
                `${row.chat_message_count || 0}`
            );
        });
        
        // Check recent points transactions
        console.log('\n💳 RECENT POINTS TRANSACTIONS:');
        db.all(`
            SELECT 
                pt.user_id,
                u.username,
                pt.amount,
                pt.balance_after,
                pt.type,
                pt.description,
                pt.created_at
            FROM points_transactions pt
            LEFT JOIN users u ON pt.user_id = u.id
            ORDER BY pt.created_at DESC
            LIMIT 10
        `, (err, transactions) => {
            if (err) {
                console.error('❌ Error querying transactions:', err);
            } else if (transactions.length === 0) {
                console.log('  No transactions found');
            } else {
                console.log('User     | Amount    | Balance After | Type       | Description');
                console.log('-'.repeat(75));
                transactions.forEach(tx => {
                    const username = (tx.username || `ID:${tx.user_id}`).substring(0, 8);
                    const desc = (tx.description || '').substring(0, 25);
                    console.log(
                        `${username.padEnd(8)} | ` +
                        `${String(tx.amount).padEnd(9)} | ` +
                        `${String(tx.balance_after).padEnd(13)} | ` +
                        `${String(tx.type || '').padEnd(10)} | ` +
                        `${desc}`
                    );
                });
            }
            
            // Check for specific test user
            console.log('\n🔍 CHECKING SPECIFIC TEST USER (if exists):');
            db.get(`
                SELECT 
                    u.id,
                    u.username,
                    u.email,
                    us.points_balance,
                    us.total_stream_time,
                    us.total_view_time,
                    us.chat_message_count
                FROM users u
                LEFT JOIN user_stats us ON u.id = us.user_id
                WHERE u.username = 'testuser' OR u.email LIKE '%test%'
                LIMIT 1
            `, (err, testUser) => {
                if (err) {
                    console.error('❌ Error finding test user:', err);
                } else if (!testUser) {
                    console.log('  No test user found');
                } else {
                    console.log(`  User: ${testUser.username} (ID: ${testUser.id})`);
                    console.log(`  Email: ${testUser.email}`);
                    console.log(`  Points Balance: ${testUser.points_balance || 0}`);
                    console.log(`  Stream Time: ${Math.floor((testUser.total_stream_time || 0) / 60)} minutes`);
                    console.log(`  View Time: ${Math.floor((testUser.total_view_time || 0) / 60)} minutes`);
                    console.log(`  Chat Messages: ${testUser.chat_message_count || 0}`);
                }
                
                db.close();
            });
        });
    });
});