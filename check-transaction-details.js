const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking transaction details\n');
console.log('=' .repeat(60));

// Get the latest transaction
db.get(`
    SELECT 
        pt.*,
        u.username
    FROM points_transactions pt
    LEFT JOIN users u ON pt.user_id = u.id
    ORDER BY pt.id DESC
    LIMIT 1
`, (err, latest) => {
    if (err) {
        console.error('❌ Error getting latest transaction:', err);
        db.close();
        return;
    }
    
    if (!latest) {
        console.log('No transactions found');
        db.close();
        return;
    }
    
    console.log('📊 LATEST TRANSACTION:');
    console.log(`  ID: ${latest.id}`);
    console.log(`  User: ${latest.username || `ID ${latest.user_id}`}`);
    console.log(`  Amount: ${latest.amount}`);
    console.log(`  Balance After: ${latest.balance_after}`);
    console.log(`  Type: ${latest.type}`);
    console.log(`  Description: ${latest.description}`);
    console.log(`  Created: ${latest.created_at}`);
    
    // Now check the actual points_balance
    db.get(`
        SELECT points_balance
        FROM user_stats
        WHERE user_id = ?
    `, [latest.user_id], (err, stats) => {
        if (err) {
            console.error('❌ Error getting user stats:', err);
        } else if (!stats) {
            console.log('\n❌ No user_stats record found for this user');
        } else {
            console.log(`\n📊 CURRENT POINTS BALANCE: ${stats.points_balance}`);
            
            if (stats.points_balance !== latest.balance_after) {
                console.log(`\n⚠️ MISMATCH DETECTED!`);
                console.log(`  Transaction says: ${latest.balance_after}`);
                console.log(`  Database has: ${stats.points_balance}`);
                console.log(`  Difference: ${latest.balance_after - stats.points_balance}`);
                
                // Fix it
                console.log('\n🔧 Fixing the balance...');
                db.run(`
                    UPDATE user_stats 
                    SET points_balance = ?
                    WHERE user_id = ?
                `, [latest.balance_after, latest.user_id], function(err) {
                    if (err) {
                        console.error('❌ Error updating balance:', err);
                    } else {
                        console.log(`✅ Fixed! Set points_balance to ${latest.balance_after}`);
                    }
                    db.close();
                });
            } else {
                console.log('\n✅ Balance is correct!');
                db.close();
            }
        }
    });
});