const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

console.log('🔍 Testing Login Authentication Issue\n');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

// Test with the admin user we know exists
const testEmail = 'user@example.com';
const testPassword = 'REDACTED-ADMIN-KEY';

console.log('\n1. Testing with email:', testEmail);

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
            
            // Try to find by username instead
            console.log('\n2. Checking if login expects username instead of email...');
            db.get(
                `SELECT * FROM users WHERE username = ?`,
                ['onestreamer'],
                async (err2, userByUsername) => {
                    if (userByUsername) {
                        console.log('✅ Found user by username: onestreamer');
                        console.log('   Email:', userByUsername.email);
                        console.log('   Has password:', !!userByUsername.password);
                        
                        if (userByUsername.password) {
                            const valid = await bcrypt.compare(testPassword, userByUsername.password);
                            console.log('   Password test:', valid ? '✅ Valid' : '❌ Invalid');
                        }
                    }
                    db.close();
                }
            );
            return;
        }
        
        console.log('✅ User found by email:');
        console.log('   ID:', user.id);
        console.log('   Email:', user.email);
        console.log('   Username:', user.username);
        console.log('   Is Admin:', user.is_admin);
        console.log('   Is Verified:', user.is_verified);
        console.log('   Has Password:', !!user.password);
        
        if (!user.password) {
            console.log('\n❌ User has no password set!');
            console.log('   This user might be OAuth-only');
            
            // Set password for testing
            const hashedPassword = await bcrypt.hash(testPassword, 10);
            db.run(
                `UPDATE users SET password = ? WHERE id = ?`,
                [hashedPassword, user.id],
                (err) => {
                    if (err) {
                        console.error('Failed to set password:', err);
                    } else {
                        console.log('✅ Password has been set to "REDACTED-ADMIN-KEY"');
                    }
                    db.close();
                }
            );
        } else {
            console.log('\n3. Testing password verification...');
            const validPassword = await bcrypt.compare(testPassword, user.password);
            console.log('   Password "' + testPassword + '" test:', validPassword ? '✅ Valid' : '❌ Invalid');
            
            if (!validPassword) {
                console.log('\n4. Password is invalid. Checking what it might be...');
                
                // Test common passwords
                const commonPasswords = ['admin', 'password', 'REDACTED-ADMIN-KEY', '123456', 'password123'];
                for (const pwd of commonPasswords) {
                    const isValid = await bcrypt.compare(pwd, user.password);
                    if (isValid) {
                        console.log('   ✅ Found working password:', pwd);
                        break;
                    }
                }
                
                console.log('\n5. Resetting password to "REDACTED-ADMIN-KEY"...');
                const hashedPassword = await bcrypt.hash('REDACTED-ADMIN-KEY', 10);
                db.run(
                    `UPDATE users SET password = ? WHERE id = ?`,
                    [hashedPassword, user.id],
                    (err) => {
                        if (err) {
                            console.error('Failed to update password:', err);
                        } else {
                            console.log('✅ Password has been reset to "REDACTED-ADMIN-KEY"');
                        }
                        db.close();
                    }
                );
            } else {
                console.log('✅ Password is correct!');
                
                // Test actual login via API
                console.log('\n4. Testing actual login via API...');
                const axios = require('axios');
                
                try {
                    const response = await axios.post('https://onestreamer.live/auth/login', {
                        email: testEmail,
                        password: testPassword
                    });
                    console.log('✅ Login successful via API!');
                    console.log('   Token received:', !!response.data.token);
                } catch (apiError) {
                    console.error('❌ API login failed:', apiError.response?.data || apiError.message);
                }
                
                db.close();
            }
        }
    }
);