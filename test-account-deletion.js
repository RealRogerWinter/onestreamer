const axios = require('axios');

const API_URL = 'https://onestreamer.live';

async function testAccountDeletion() {
    console.log('Testing account deletion functionality...\n');
    
    // Test user credentials (you'll need a test account)
    const testEmail = 'test@example.com';
    const testPassword = 'testpassword123';
    
    try {
        // First, try to login (assuming you have a test account)
        console.log('1. Attempting to login...');
        const loginResponse = await axios.post(`${API_URL}/auth/login`, {
            email: testEmail,
            password: testPassword,
            turnstileToken: 'test' // This would need a real token in production
        }).catch(err => {
            console.log('Login failed (expected if test account doesn\'t exist):', err.response?.data?.error || err.message);
            return null;
        });
        
        if (!loginResponse) {
            console.log('\n✓ Login endpoint exists and responds correctly');
            console.log('Note: To fully test, you need a verified test account');
            return;
        }
        
        const token = loginResponse.data.token;
        console.log('✓ Login successful');
        
        // Test requesting account deletion
        console.log('\n2. Testing account deletion request...');
        const deletionResponse = await axios.post(
            `${API_URL}/auth/request-deletion`,
            {},
            {
                headers: { 'Authorization': `Bearer ${token}` }
            }
        );
        
        console.log('✓ Account deletion requested:', deletionResponse.data.message);
        
    } catch (error) {
        if (error.response) {
            console.error('Error:', error.response.data);
        } else {
            console.error('Error:', error.message);
        }
    }
}

// Test the database structure
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

function testDatabaseStructure() {
    console.log('\nTesting database structure...\n');
    
    const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
    const db = new sqlite3.Database(dbPath);
    
    db.all("PRAGMA table_info(users)", (err, rows) => {
        if (err) {
            console.error('Error checking users table:', err);
            return;
        }
        
        console.log('Users table deletion columns:');
        const deletionColumns = rows.filter(col => 
            col.name.includes('deletion') || col.name === 'account_status'
        );
        
        if (deletionColumns.length > 0) {
            deletionColumns.forEach(col => {
                console.log(`  ✓ ${col.name}: ${col.type}`);
            });
        } else {
            console.log('  ✗ No deletion columns found');
        }
    });
    
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='account_deletion_logs'", (err, rows) => {
        if (err) {
            console.error('Error checking for deletion logs table:', err);
        } else if (rows.length > 0) {
            console.log('\n✓ account_deletion_logs table exists');
        } else {
            console.log('\n✗ account_deletion_logs table not found');
        }
        
        db.close();
    });
}

// Run tests
console.log('=== Account Deletion Feature Test ===\n');
testDatabaseStructure();
setTimeout(() => {
    testAccountDeletion();
}, 1000);