const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function testOAuthDeletion() {
    console.log('Testing OAuth User Deletion Flow\n');
    console.log('='.repeat(50));
    
    // First, check what OAuth users we have
    const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');
    const db = new sqlite3.Database(dbPath);
    
    // Get an OAuth user for testing
    db.get("SELECT * FROM users WHERE oauth_provider = 'google' LIMIT 1", async (err, user) => {
        if (err) {
            console.error('Database error:', err);
            db.close();
            return;
        }
        
        if (!user) {
            console.log('No OAuth users found in database');
            db.close();
            return;
        }
        
        console.log('Testing with OAuth user:');
        console.log('  ID:', user.id);
        console.log('  Username:', user.username);
        console.log('  Email:', user.email);
        console.log('  Provider:', user.oauth_provider);
        console.log('  Verified:', user.is_verified);
        console.log('');
        
        // Now we need to authenticate as this user
        // Since OAuth users don't have passwords, we'll need to use a different approach
        // We'll directly call the AuthService method with the user ID
        
        console.log('Simulating deletion request for OAuth user...\n');
        
        // Import the services directly
        const AuthService = require('./server/services/AuthService');
        const authService = new AuthService();
        
        try {
            console.log('Calling requestAccountDeletion for user ID:', user.id);
            const result = await authService.requestAccountDeletion(user.id);
            console.log('\n✅ Deletion request successful:', result);
        } catch (error) {
            console.error('\n❌ Deletion request failed:', error.message);
            console.error('Full error:', error);
        }
        
        db.close();
    });
}

testOAuthDeletion().catch(console.error);