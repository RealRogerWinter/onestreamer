const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');

async function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function migratePointsSystem() {
    const db = new sqlite3.Database(dbPath);

    console.log('🚀 Starting Points System Migration...\n');
    console.log('=' .repeat(50));

    try {
        // Guard: this script's Step 4 reads the legacy `points` column. That
        // column was dropped after the migration completed, so if it's gone
        // the migration has already run and there is nothing to do.
        const cols = await allAsync(db, `PRAGMA table_info(user_stats)`);
        const hasLegacyPoints = cols.some((c) => c.name === 'points');
        if (!hasLegacyPoints) {
            const hasBalance = cols.some((c) => c.name === 'points_balance');
            if (hasBalance) {
                console.log('ℹ️  Legacy `user_stats.points` column already removed and `points_balance` exists — migration already ran.');
            } else {
                console.log('ℹ️  No legacy `user_stats.points` column found — this looks like a FRESH database, not a migrated one.');
                console.log('   The points schema (user_stats.points_balance + points_transactions) is provisioned by');
                console.log('   server/database/database.js at boot; this script only migrates the pre-2026 legacy `points` column.');
            }
            console.log('   Nothing to do. (This script is preserved for forensic value only.)');
            return;
        }

        // Step 1: Add points_balance column to user_stats
        console.log('\n📊 Step 1: Adding points_balance column...');
        try {
            await runAsync(db, `
                ALTER TABLE user_stats 
                ADD COLUMN points_balance INTEGER DEFAULT 0
            `);
            console.log('✅ Added points_balance column');
        } catch (err) {
            if (err.message.includes('duplicate column')) {
                console.log('ℹ️  points_balance column already exists');
            } else {
                throw err;
            }
        }
        
        // Step 2: Create points_transactions table
        console.log('\n📊 Step 2: Creating points_transactions table...');
        await runAsync(db, `
            CREATE TABLE IF NOT EXISTS points_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                type VARCHAR(50) NOT NULL,
                description TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        `);
        console.log('✅ Created points_transactions table');
        
        // Step 3: Create indexes for performance
        console.log('\n📊 Step 3: Creating indexes...');
        await runAsync(db, `
            CREATE INDEX IF NOT EXISTS idx_points_transactions_user_id 
            ON points_transactions(user_id)
        `);
        await runAsync(db, `
            CREATE INDEX IF NOT EXISTS idx_points_transactions_created_at 
            ON points_transactions(created_at)
        `);
        console.log('✅ Created indexes');
        
        // Step 4: Migrate existing points to points_balance
        console.log('\n📊 Step 4: Migrating existing points to balance...');
        const users = await allAsync(db, `
            SELECT user_id, points, total_stream_time, total_view_time, chat_message_count 
            FROM user_stats
        `);
        
        console.log(`Found ${users.length} users to migrate\n`);
        
        for (const user of users) {
            // Use existing points value (already calculated with new multipliers)
            const balance = user.points || 0;
            
            // Update points_balance
            await runAsync(db, 
                'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
                [balance, user.user_id]
            );
            
            // Record initial balance transaction
            if (balance > 0) {
                await runAsync(db, `
                    INSERT INTO points_transactions 
                    (user_id, amount, balance_after, type, description, metadata)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [
                    user.user_id,
                    balance,
                    balance,
                    'migration',
                    'Initial balance from activity history',
                    JSON.stringify({
                        stream_time: user.total_stream_time,
                        view_time: user.total_view_time,
                        chat_count: user.chat_message_count
                    })
                ]);
            }
            
            console.log(`  ✅ User ${user.user_id}: ${balance.toLocaleString()} points`);
        }
        
        // Step 5: Verify migration
        console.log('\n📊 Step 5: Verifying migration...');
        const verification = await allAsync(db, `
            SELECT 
                COUNT(*) as user_count,
                SUM(points_balance) as total_balance,
                SUM(points) as total_old_points
            FROM user_stats
        `);
        
        console.log('\n✅ Migration Summary:');
        console.log(`  Users migrated: ${verification[0].user_count}`);
        console.log(`  Total balance: ${verification[0].total_balance?.toLocaleString() || 0} points`);
        console.log(`  Old points: ${verification[0].total_old_points?.toLocaleString() || 0} points`);
        
        console.log('\n' + '=' .repeat(50));
        console.log('✅ Points System Migration Complete!');
        console.log('\nNext steps:');
        console.log('1. Update services to use new points system');
        console.log('2. Test earning and spending points');
        console.log('3. Remove old calculatePoints functions');
        
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        throw error;
    } finally {
        db.close();
    }
}

// Run the migration
migratePointsSystem().catch(console.error);