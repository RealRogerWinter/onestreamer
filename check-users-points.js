const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking users and their points\n');
console.log('=' .repeat(60));

// Check all users
db.all(`
    SELECT 
        u.id,
        u.username,
        u.email,
        u.is_admin,
        us.points_balance,
        us.total_stream_time,
        us.total_view_time,
        us.chat_message_count
    FROM users u
    LEFT JOIN user_stats us ON u.id = us.user_id
    ORDER BY u.id
`, (err, users) => {
    if (err) {
        console.error('❌ Error querying users:', err);
        db.close();
        return;
    }
    
    console.log(`📊 FOUND ${users.length} USERS:\n`);
    
    if (users.length === 0) {
        console.log('No users found. You need to create a user account first.');
    } else {
        console.log('ID | Username       | Email                    | Admin | Points | Stream(m) | View(m) | Chat');
        console.log('-'.repeat(90));
        
        users.forEach(user => {
            const streamMinutes = Math.floor((user.total_stream_time || 0) / 60);
            const viewMinutes = Math.floor((user.total_view_time || 0) / 60);
            
            console.log(
                `${String(user.id).padEnd(2)} | ` +
                `${String(user.username || 'N/A').padEnd(14)} | ` +
                `${String(user.email || 'N/A').substring(0, 24).padEnd(24)} | ` +
                `${user.is_admin ? 'Yes' : 'No '.padEnd(5)} | ` +
                `${String(user.points_balance || 0).padEnd(6)} | ` +
                `${String(streamMinutes).padEnd(9)} | ` +
                `${String(viewMinutes).padEnd(7)} | ` +
                `${user.chat_message_count || 0}`
            );
        });
    }
    
    // Check recent transactions
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
        LIMIT 5
    `, (err, transactions) => {
        if (err) {
            console.error('❌ Error querying transactions:', err);
        } else if (transactions.length === 0) {
            console.log('  No transactions found');
        } else {
            console.log('\nUser     | Amount    | After     | Type       | Description');
            console.log('-'.repeat(65));
            transactions.forEach(tx => {
                const username = (tx.username || `ID:${tx.user_id}`).substring(0, 8);
                const desc = (tx.description || '').substring(0, 20);
                console.log(
                    `${username.padEnd(8)} | ` +
                    `${String(tx.amount).padEnd(9)} | ` +
                    `${String(tx.balance_after).padEnd(9)} | ` +
                    `${String(tx.type || '').padEnd(10)} | ` +
                    `${desc}`
                );
            });
        }
        
        console.log('\n💡 To add points to a user, you can:');
        console.log('  1. Stream or watch streams (automatic)');
        console.log('  2. Use the admin panel to manually add points');
        console.log('  3. Run: node add-points-to-user.js <user_id> <amount>');
        
        db.close();
    });
});