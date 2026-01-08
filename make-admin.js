const database = require('./server/database/database');

async function makeAdmin() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage: node make-admin.js <username or email>');
        console.log('\nCurrent users:');
        const users = await database.allAsync('SELECT id, username, email, is_admin FROM users');
        users.forEach(user => {
            console.log(`  ${user.username} (${user.email}) - ${user.is_admin ? 'Admin' : 'User'}`);
        });
        database.db.close();
        return;
    }
    
    const identifier = args[0];
    
    try {
        // Try to find user by username or email
        const user = await database.getAsync(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [identifier, identifier]
        );
        
        if (!user) {
            console.log(`❌ User not found: ${identifier}`);
            console.log('\nAvailable users:');
            const users = await database.allAsync('SELECT id, username, email FROM users');
            users.forEach(u => {
                console.log(`  - ${u.username} (${u.email})`);
            });
        } else {
            // Make the user an admin
            await database.runAsync(
                'UPDATE users SET is_admin = 1 WHERE id = ?',
                [user.id]
            );
            
            console.log(`✅ User "${user.username}" (${user.email}) is now an admin!`);
            console.log('\n📝 Please log out and log back in for changes to take effect.');
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        database.db.close();
    }
}

makeAdmin();