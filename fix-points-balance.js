const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔧 Fixing points_balance for all users\n');
console.log('=' .repeat(60));

// Get the latest balance_after for each user from transactions
db.all(`
    SELECT 
        user_id,
        MAX(id) as latest_transaction_id
    FROM points_transactions
    GROUP BY user_id
`, (err, userTransactions) => {
    if (err) {
        console.error('❌ Error getting user transactions:', err);
        db.close();
        return;
    }
    
    if (userTransactions.length === 0) {
        console.log('No transactions found. Nothing to fix.');
        db.close();
        return;
    }
    
    console.log(`Found ${userTransactions.length} users with transactions\n`);
    
    let fixed = 0;
    let remaining = userTransactions.length;
    
    userTransactions.forEach(ut => {
        // Get the latest transaction for this user
        db.get(`
            SELECT 
                pt.user_id,
                pt.balance_after,
                u.username
            FROM points_transactions pt
            LEFT JOIN users u ON pt.user_id = u.id
            WHERE pt.id = ?
        `, [ut.latest_transaction_id], (err, transaction) => {
            if (err) {
                console.error(`❌ Error getting transaction ${ut.latest_transaction_id}:`, err);
            } else if (transaction) {
                // Update the user_stats table with the correct balance
                db.run(`
                    UPDATE user_stats 
                    SET points_balance = ?
                    WHERE user_id = ?
                `, [transaction.balance_after, transaction.user_id], function(err) {
                    if (err) {
                        console.error(`❌ Error updating user ${transaction.user_id}:`, err);
                    } else if (this.changes > 0) {
                        console.log(`✅ Updated user ${transaction.username || transaction.user_id}: points_balance = ${transaction.balance_after}`);
                        fixed++;
                    } else {
                        // User stats might not exist, create it
                        db.run(`
                            INSERT INTO user_stats (user_id, points_balance)
                            VALUES (?, ?)
                            ON CONFLICT(user_id) DO UPDATE SET
                            points_balance = excluded.points_balance
                        `, [transaction.user_id, transaction.balance_after], function(err) {
                            if (err) {
                                console.error(`❌ Error inserting user_stats for user ${transaction.user_id}:`, err);
                            } else {
                                console.log(`✅ Created/Updated user_stats for ${transaction.username || transaction.user_id}: points_balance = ${transaction.balance_after}`);
                                fixed++;
                            }
                        });
                    }
                    
                    remaining--;
                    if (remaining === 0) {
                        console.log(`\n🎉 Fixed ${fixed} user balances!`);
                        
                        // Verify the fix
                        console.log('\n📊 VERIFICATION:');
                        db.all(`
                            SELECT 
                                u.username,
                                us.points_balance
                            FROM users u
                            LEFT JOIN user_stats us ON u.id = us.user_id
                            WHERE us.points_balance > 0
                            ORDER BY us.points_balance DESC
                        `, (err, users) => {
                            if (err) {
                                console.error('❌ Error verifying:', err);
                            } else {
                                users.forEach(user => {
                                    console.log(`  ${user.username}: ${user.points_balance} points`);
                                });
                            }
                            db.close();
                        });
                    }
                });
            }
        });
    });
});