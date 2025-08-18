const axios = require('axios');

async function testDisable() {
    const serverUrl = 'http://localhost:8080';
    
    try {
        console.log('Getting auth token...');
        const login = await axios.post(`${serverUrl}/auth/login`, {
            email: 'user@example.com',
            password: '***REMOVED-ADMIN-KEY***'
        });
        
        const token = login.data.token;
        const config = { headers: { 'Authorization': `Bearer ${token}` }};
        
        console.log('Checking connections before enable...');
        const beforeEnable = await new Promise((resolve) => {
            const { spawn } = require('child_process');
            const proc = spawn('powershell', ['-c', '(netstat -ano | findstr :8081 | findstr ESTABLISHED).count']);
            let output = '';
            proc.stdout.on('data', (data) => output += data);
            proc.on('close', () => resolve(parseInt(output.trim()) || 0));
        });
        console.log(`Connections before enable: ${beforeEnable}`);
        
        console.log('\nEnabling all chatbots...');
        await axios.post(`${serverUrl}/api/chatbots/all/enable`, {}, config);
        
        console.log('Waiting 8 seconds for connections...');
        await new Promise(resolve => setTimeout(resolve, 8000));
        
        console.log('Checking connections after enable...');
        const afterEnable = await new Promise((resolve) => {
            const { spawn } = require('child_process');
            const proc = spawn('powershell', ['-c', '(netstat -ano | findstr :8081 | findstr ESTABLISHED).count']);
            let output = '';
            proc.stdout.on('data', (data) => output += data);
            proc.on('close', () => resolve(parseInt(output.trim()) || 0));
        });
        console.log(`Connections after enable: ${afterEnable}`);
        
        console.log('\n🔴 DISABLING ALL CHATBOTS...');
        const disableResponse = await axios.post(`${serverUrl}/api/chatbots/all/disable`, {}, config);
        console.log('Disable response:', disableResponse.data);
        
        console.log('Waiting 5 seconds after disable...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log('Checking connections after disable...');
        const afterDisable = await new Promise((resolve) => {
            const { spawn } = require('child_process');
            const proc = spawn('powershell', ['-c', '(netstat -ano | findstr :8081 | findstr ESTABLISHED).count']);
            let output = '';
            proc.stdout.on('data', (data) => output += data);
            proc.on('close', () => resolve(parseInt(output.trim()) || 0));
        });
        console.log(`Connections after disable: ${afterDisable}`);
        
        console.log('\n📊 RESULTS:');
        console.log(`Before enable: ${beforeEnable} connections`);
        console.log(`After enable: ${afterEnable} connections`);
        console.log(`After disable: ${afterDisable} connections`);
        console.log(`Connection drop: ${afterEnable - afterDisable} connections disconnected`);
        
        if (afterDisable < afterEnable) {
            console.log('✅ SUCCESS: Connections dropped after disable!');
        } else {
            console.log('❌ FAILED: No connections were dropped after disable');
        }
        
    } catch (error) {
        console.error('Test error:', error.message);
    }
}

testDisable();