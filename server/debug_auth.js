const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'database.db');
const db = new sqlite3.Database(dbPath);

// Check onestreamer user details and test password
db.get("SELECT * FROM users WHERE username = 'onestreamer'", (err, user) => {
    if (err) {
        console.error('Database error:', err);
        return;
    }
    
    if (!user) {
        console.log('User onestreamer not found');
        return;
    }
    
    console.log('User found:');
    console.log('ID:', user.id);
    console.log('Email:', user.email);
    console.log('Username:', user.username);
    console.log('Is Admin:', user.is_admin);
    console.log('Password hash exists:', !!user.password);
    console.log('Password hash length:', user.password ? user.password.length : 0);
    
    // Test password verification with common passwords
    const testPasswords = ['password', 'onestreamer', '123456', 'admin', user.email];
    
    console.log('\nTesting password hashes...');
    testPasswords.forEach(testPwd => {
        try {
            const isValid = bcrypt.compareSync(testPwd, user.password);
            console.log(`Password "${testPwd}": ${isValid ? 'VALID ✓' : 'Invalid'}`);
        } catch (e) {
            console.log(`Password "${testPwd}": Error - ${e.message}`);
        }
    });
    
    db.close();
});