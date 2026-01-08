const axios = require('axios');
const { spawn } = require('child_process');

function getConnectionCount() {
    return new Promise((resolve) => {
        const proc = spawn('cmd', ['/c', 'netstat -ano | findstr :8081 | findstr ESTABLISHED | find /c /v ""'], { shell: true });
        let output = '';
        proc.stdout.on('data', (data) => output += data);
        proc.on('close', () => resolve(parseInt(output.trim()) || 0));
    });
}

async function testChatbotDisconnection() {
    console.log('🧪 FINAL CHATBOT DISABLE TEST\n');
    
    try {
        // Step 1: Get auth token
        console.log('1️⃣ Getting authentication token...');
        const loginResponse = await axios.post('http://localhost:8080/auth/login', {
            email: 'user@example.com',
            password: '***REMOVED-ADMIN-KEY***'
        });
        const token = loginResponse.data.token;
        const headers = { 'Authorization': `Bearer ${token}` };
        console.log('   ✅ Authenticated successfully\n');

        // Step 2: Check initial connection count
        console.log('2️⃣ Checking initial connection count...');
        const initialCount = await getConnectionCount();
        console.log(`   📊 Initial connections to chat service: ${initialCount}\n`);

        // Step 3: Enable all chatbots
        console.log('3️⃣ Enabling all chatbots...');
        const enableResponse = await axios.post('http://localhost:8080/api/chatbots/all/enable', {}, { headers });
        console.log(`   ✅ Enable response:`, enableResponse.data);
        
        // Step 4: Wait for connections
        console.log('4️⃣ Waiting 10 seconds for chatbots to connect...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const enabledCount = await getConnectionCount();
        console.log(`   📊 Connections after enable: ${enabledCount}\n`);

        // Step 5: Disable all chatbots
        console.log('5️⃣ 🔴 DISABLING ALL CHATBOTS...');
        const disableResponse = await axios.post('http://localhost:8080/api/chatbots/all/disable', {}, { headers });
        console.log(`   📋 Disable response:`, JSON.stringify(disableResponse.data, null, 2));

        // Step 6: Wait and check connection count
        console.log('6️⃣ Waiting 5 seconds after disable...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const finalCount = await getConnectionCount();
        console.log(`   📊 Connections after disable: ${finalCount}\n`);

        // Results
        console.log('📊 RESULTS:');
        console.log(`   Initial: ${initialCount} connections`);
        console.log(`   After enable: ${enabledCount} connections`);
        console.log(`   After disable: ${finalCount} connections`);
        console.log(`   Disconnected: ${enabledCount - finalCount} connections`);

        if (finalCount < enabledCount) {
            console.log('\n✅ SUCCESS: Chatbot connections properly dropped after disable!');
            console.log('   The fix is working - chatbots are being disconnected from chat service');
        } else {
            console.log('\n❌ FAILURE: No connections dropped after disable');
            console.log('   The fix still needs work - chatbots are not being disconnected');
        }

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
    }
}

testChatbotDisconnection();