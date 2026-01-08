const AccountService = require('./server/services/AccountService');

async function testAccountService() {
    console.log('Testing AccountService.getUserById...\n');
    
    const accountService = new AccountService();
    
    // Test with user ID 3 (from the previous test)
    const userId = 3;
    
    console.log(`Looking up user with ID: ${userId}`);
    
    try {
        const user = await accountService.getUserById(userId);
        
        if (user) {
            console.log('✅ User found:');
            console.log(`   - ID: ${user.id}`);
            console.log(`   - Username: ${user.username}`);
            console.log(`   - Email: ${user.email}`);
            console.log(`   - Is Admin: ${user.is_admin}`);
            console.log('\nFull user object:');
            console.log(JSON.stringify(user, null, 2));
        } else {
            console.log('❌ User not found');
        }
    } catch (error) {
        console.error('❌ Error fetching user:', error);
    }
    
    process.exit(0);
}

testAccountService().catch(console.error);