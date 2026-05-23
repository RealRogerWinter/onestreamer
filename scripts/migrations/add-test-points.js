const { AccountService } = require('../../server/services/AccountService');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'data', 'onestreamer.db');

async function addTestPoints() {
    console.log('💰 Adding test points to user\n');
    console.log('=' .repeat(60));
    
    const accountService = new AccountService();
    
    // Get user ID 1 (onestreamer)
    const userId = 1;
    const amount = 50000; // Add 50,000 points
    
    try {
        // Get current balance
        const currentBalance = await accountService.getPointsBalance(userId);
        console.log(`Current balance for user ${userId}: ${currentBalance} points`);
        
        // Add points
        const newBalance = await accountService.addPoints(
            userId,
            amount,
            'admin_test',
            'Test points added by admin script'
        );
        
        console.log(`✅ Added ${amount} points`);
        console.log(`New balance: ${newBalance} points`);
        
        // Verify in database
        const db = new sqlite3.Database(dbPath);
        db.get(`
            SELECT points_balance 
            FROM user_stats 
            WHERE user_id = ?
        `, [userId], (err, row) => {
            if (err) {
                console.error('❌ Error verifying:', err);
            } else {
                console.log(`\n📊 Database verification:`);
                console.log(`   points_balance in DB: ${row?.points_balance || 0}`);
            }
            
            // Check latest transaction
            db.get(`
                SELECT * FROM points_transactions 
                WHERE user_id = ? 
                ORDER BY id DESC 
                LIMIT 1
            `, [userId], (err, tx) => {
                if (err) {
                    console.error('❌ Error checking transaction:', err);
                } else if (tx) {
                    console.log(`\n📝 Latest transaction:`);
                    console.log(`   Amount: ${tx.amount}`);
                    console.log(`   Balance After: ${tx.balance_after}`);
                    console.log(`   Type: ${tx.type}`);
                    console.log(`   Description: ${tx.description}`);
                }
                
                console.log('\n✅ Test complete! Points have been added.');
                console.log('   Now login to the app and check if points display correctly.');
                
                db.close();
                process.exit(0);
            });
        });
        
    } catch (error) {
        console.error('❌ Error adding points:', error);
        process.exit(1);
    }
}

addTestPoints();