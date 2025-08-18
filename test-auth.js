const jwt = require('jsonwebtoken');
const database = require('./server/database/database');

async function testAuth() {
    console.log('🔍 Testing Authentication...\n');
    
    // Get the token from command line
    const token = process.argv[2];
    
    if (!token) {
        console.log('Please provide your token as an argument.');
        console.log('You can find it in browser DevTools:');
        console.log('1. Press F12');
        console.log('2. Go to Application → Local Storage → localhost:3000');
        console.log('3. Copy the value of "token"');
        console.log('4. Run: node test-auth.js YOUR_TOKEN_HERE');
        database.db.close();
        return;
    }
    
    try {
        // Decode the token
        const JWT_SECRET = process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***';
        const decoded = jwt.verify(token, JWT_SECRET);
        
        console.log('✅ Token is valid!');
        console.log('Decoded token:', decoded);
        console.log('User ID from token:', decoded.id);
        
        // Check user in database
        const user = await database.getAsync(
            'SELECT id, username, email, is_admin, is_banned FROM users WHERE id = ?',
            [decoded.id]
        );
        
        if (!user) {
            console.log('❌ User not found in database!');
        } else {
            console.log('\n📊 User details:');
            console.log('  ID:', user.id);
            console.log('  Username:', user.username);
            console.log('  Email:', user.email);
            console.log('  Is Admin:', user.is_admin ? '✅ YES' : '❌ NO');
            console.log('  Is Banned:', user.is_banned ? '⛔ YES' : '✅ NO');
            
            if (!user.is_admin) {
                console.log('\n⚠️  This user is NOT an admin!');
                console.log('Run: node make-admin.js', user.username);
            } else if (user.is_banned) {
                console.log('\n⚠️  This user is BANNED!');
            } else {
                console.log('\n✅ User has admin access and should be able to use ChatBots!');
            }
        }
        
    } catch (error) {
        console.error('❌ Token verification failed:', error.message);
        
        if (error.message === 'jwt expired') {
            console.log('\n⚠️  Your token has expired. Please log out and log in again.');
        } else if (error.message === 'invalid signature') {
            console.log('\n⚠️  Token signature is invalid. This might be from a different server instance.');
            console.log('Please log out and log in again.');
        }
    } finally {
        database.db.close();
    }
}

testAuth();