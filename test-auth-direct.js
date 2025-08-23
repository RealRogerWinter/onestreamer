const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

console.log('Testing direct database authentication...\n');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

// Test with known admin user
const testEmail = 'user@example.com';
const testPassword = 'REDACTED-ADMIN-KEY'; // Common default password

db.get(
    `SELECT * FROM users WHERE email = ?`,
    [testEmail],
    async (err, user) => {
        if (err) {
            console.error('Database error:', err);
            db.close();
            return;
        }
        
        if (!user) {
            console.log('❌ User not found with email:', testEmail);
            
            // List all users
            db.all(`SELECT id, email, username, is_admin FROM users LIMIT 10`, (err, users) => {
                if (!err && users) {
                    console.log('\nAvailable users:');
                    users.forEach(u => {
                        console.log(`  ID: ${u.id}, Email: ${u.email}, Username: ${u.username}, Admin: ${u.is_admin}`);
                    });
                }
                db.close();
            });
            return;
        }
        
        console.log('✅ User found:');
        console.log('  ID:', user.id);
        console.log('  Email:', user.email);
        console.log('  Username:', user.username);
        console.log('  Is Admin:', user.is_admin);
        console.log('  Is Verified:', user.is_verified);
        console.log('  Has Password:', !!user.password);
        
        if (!user.password) {
            console.log('❌ User has no password set (might be OAuth user)');
            
            // Try to set a password for testing
            const hashedPassword = await bcrypt.hash('REDACTED-ADMIN-KEY', 10);
            db.run(
                `UPDATE users SET password = ? WHERE id = ?`,
                [hashedPassword, user.id],
                (err) => {
                    if (err) {
                        console.error('Failed to set password:', err);
                    } else {
                        console.log('✅ Password has been set to "REDACTED-ADMIN-KEY" for user');
                    }
                    db.close();
                }
            );
        } else {
            // Test password
            const validPassword = await bcrypt.compare(testPassword, user.password);
            console.log('\nPassword test with "' + testPassword + '":', validPassword ? '✅ Valid' : '❌ Invalid');
            
            if (!validPassword) {
                // Set the password to REDACTED-ADMIN-KEY
                const hashedPassword = await bcrypt.hash('REDACTED-ADMIN-KEY', 10);
                db.run(
                    `UPDATE users SET password = ? WHERE id = ?`,
                    [hashedPassword, user.id],
                    (err) => {
                        if (err) {
                            console.error('Failed to update password:', err);
                        } else {
                            console.log('✅ Password has been updated to "REDACTED-ADMIN-KEY" for user');
                        }
                        db.close();
                    }
                );
            } else {
                db.close();
            }
        }
    }
);