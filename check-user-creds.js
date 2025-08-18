const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    } else {
        console.log('🔍 Connected to SQLite database to check user credentials');
    }
});

async function checkUserCreds() {
    return new Promise((resolve, reject) => {
        console.log('🔍 Looking for user with email user@example.com...');
        
        db.get('SELECT * FROM users WHERE email = ?', ['user@example.com'], (err, user) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!user) {
                console.log('❌ User not found with email user@example.com');
                
                // Show all users for reference
                db.all('SELECT id, email, username, created_at FROM users', (err, allUsers) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    
                    console.log('\n📋 All users in database:');
                    allUsers.forEach(u => {
                        console.log(`  ID: ${u.id}, Email: ${u.email}, Username: ${u.username}, Created: ${u.created_at}`);
                    });
                    
                    resolve();
                });
                return;
            }
            
            console.log(`✅ Found user:`);
            console.log(`   ID: ${user.id}`);
            console.log(`   Email: ${user.email}`);
            console.log(`   Username: ${user.username}`);
            console.log(`   Has password: ${user.password ? 'Yes' : 'No'}`);
            console.log(`   OAuth provider: ${user.oauth_provider || 'None'}`);
            console.log(`   Created: ${user.created_at}`);
            console.log(`   Is verified: ${user.is_verified}`);
            console.log(`   Is admin: ${user.is_admin}`);
            
            resolve();
        });
    });
}

checkUserCreds().then(() => {
    console.log('\n🔍 User credential check complete');
    db.close();
    process.exit(0);
}).catch(error => {
    console.error('❌ Check failed:', error.message);
    db.close();
    process.exit(1);
});