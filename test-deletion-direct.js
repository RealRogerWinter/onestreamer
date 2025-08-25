// Direct test of account deletion functionality
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

console.log('Testing account deletion directly...\n');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    
    console.log('✓ Connected to database\n');
    
    // Test creating a deletion request
    testDeletionRequest();
});

function testDeletionRequest() {
    console.log('Testing deletion request...');
    
    // Check if we have any users
    db.all("SELECT id, email, username, is_verified, account_status FROM users LIMIT 5", (err, users) => {
        if (err) {
            console.error('Error fetching users:', err);
            return;
        }
        
        console.log('\nCurrent users:');
        if (users.length === 0) {
            console.log('  No users found in database');
        } else {
            users.forEach(user => {
                console.log(`  ID: ${user.id}, Username: ${user.username}, Email: ${user.email}, Verified: ${user.is_verified}, Status: ${user.account_status || 'active'}`);
            });
        }
        
        // Check for accounts pending deletion
        checkPendingDeletions();
    });
}

function checkPendingDeletions() {
    console.log('\nChecking for accounts pending deletion...');
    
    const query = `
        SELECT id, username, email, 
               deletion_requested_at, 
               deletion_confirmed_at, 
               deletion_scheduled_for,
               account_status
        FROM users 
        WHERE account_status = 'pending_deletion'
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Error checking pending deletions:', err);
        } else if (rows.length === 0) {
            console.log('  No accounts pending deletion');
        } else {
            console.log(`  Found ${rows.length} accounts pending deletion:`);
            rows.forEach(row => {
                console.log(`    - ${row.username} (${row.email})`);
                console.log(`      Requested: ${row.deletion_requested_at}`);
                console.log(`      Confirmed: ${row.deletion_confirmed_at}`);
                console.log(`      Scheduled for: ${row.deletion_scheduled_for}`);
            });
        }
        
        // Check deletion logs
        checkDeletionLogs();
    });
}

function checkDeletionLogs() {
    console.log('\nChecking deletion logs...');
    
    db.all("SELECT * FROM account_deletion_logs ORDER BY created_at DESC LIMIT 5", (err, logs) => {
        if (err) {
            console.error('Error checking deletion logs:', err);
        } else if (logs.length === 0) {
            console.log('  No deletion logs found');
        } else {
            console.log(`  Recent deletion actions:`);
            logs.forEach(log => {
                console.log(`    - ${log.action} for ${log.username} at ${log.created_at}`);
            });
        }
        
        db.close();
        console.log('\n✓ Test complete');
    });
}