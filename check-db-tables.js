const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking database tables\n');
console.log('=' .repeat(60));

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
    if (err) {
        console.error('❌ Error checking tables:', err);
        db.close();
        return;
    }
    
    console.log('📋 TABLES IN DATABASE:');
    tables.forEach(table => {
        console.log(`  - ${table.name}`);
    });
    
    // Check if user_stats table exists
    const hasUserStats = tables.some(t => t.name === 'user_stats');
    
    if (!hasUserStats) {
        console.log('\n⚠️ WARNING: user_stats table does not exist!');
        console.log('This table needs to be created for the points system to work.');
        
        // Check the migration status
        db.all("SELECT * FROM migrations ORDER BY executed_at DESC LIMIT 5", (err, migrations) => {
            if (err) {
                console.log('\n❌ Could not check migrations:', err.message);
            } else if (migrations && migrations.length > 0) {
                console.log('\n📝 RECENT MIGRATIONS:');
                migrations.forEach(m => {
                    console.log(`  - ${m.name} (executed: ${m.executed_at})`);
                });
            } else {
                console.log('\n❌ No migrations found or migrations table does not exist');
            }
            
            // Check users table structure
            console.log('\n📋 USERS TABLE STRUCTURE:');
            db.all("PRAGMA table_info(users)", (err, columns) => {
                if (err) {
                    console.error('❌ Error checking users table:', err);
                } else {
                    const relevantColumns = columns.filter(col => 
                        col.name.includes('point') || 
                        col.name.includes('stats') ||
                        col.name === 'id' ||
                        col.name === 'username'
                    );
                    relevantColumns.forEach(col => {
                        console.log(`  - ${col.name} (${col.type})`);
                    });
                    
                    // Check for points_balance in users table
                    const hasPointsBalance = columns.some(c => c.name === 'points_balance');
                    if (hasPointsBalance) {
                        console.log('\n✅ Found points_balance column in users table');
                        
                        // Query users with their points
                        db.all(`
                            SELECT id, username, email, points_balance
                            FROM users
                            ORDER BY points_balance DESC NULLS LAST
                            LIMIT 10
                        `, (err, users) => {
                            if (err) {
                                console.error('❌ Error querying users:', err);
                            } else {
                                console.log('\n📊 TOP USERS BY POINTS:');
                                console.log('ID  | Username       | Email                    | Points');
                                console.log('-'.repeat(65));
                                users.forEach(user => {
                                    console.log(
                                        `${String(user.id).padEnd(3)} | ` +
                                        `${String(user.username || 'N/A').padEnd(14)} | ` +
                                        `${String(user.email || 'N/A').substring(0, 24).padEnd(24)} | ` +
                                        `${user.points_balance || 0}`
                                    );
                                });
                            }
                            db.close();
                        });
                    } else {
                        console.log('\n❌ No points_balance column found in users table');
                        db.close();
                    }
                }
            });
        });
    } else {
        // user_stats table exists, check its structure
        console.log('\n✅ user_stats table exists');
        db.all("PRAGMA table_info(user_stats)", (err, columns) => {
            if (err) {
                console.error('❌ Error checking user_stats schema:', err);
            } else {
                console.log('\n📋 USER_STATS COLUMNS:');
                columns.forEach(col => {
                    console.log(`  - ${col.name} (${col.type})`);
                });
            }
            db.close();
        });
    }
});