const http = require('http');

const API_BASE = 'http://localhost:8080';
const USER_TOKEN = process.env.TEST_TOKEN || 'your-test-token-here'; // Get from browser localStorage

async function testTomatoEffect() {
    console.log('🍅 Testing Tomato Effect via API');
    console.log('================================');
    
    try {
        // First, check if tomato item exists
        console.log('1. Checking available items...');
        const itemsResponse = await new Promise((resolve, reject) => {
            http.get(`${API_BASE}/api/items`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(JSON.parse(data)));
            }).on('error', reject);
        });
        const items = itemsResponse;
        
        const tomatoItem = items.find(item => item.name === 'tomato');
        if (!tomatoItem) {
            console.error('❌ Tomato item not found in database');
            return;
        }
        
        console.log(`✅ Found tomato item: ${tomatoItem.display_name} (ID: ${tomatoItem.id})`);
        console.log(`   Price: ${tomatoItem.base_price} points`);
        console.log(`   Cooldown: ${tomatoItem.cooldown_seconds}s`);
        
        // Note: To test the API endpoint, you would need a valid auth token
        console.log('\n📝 To test the API endpoint manually:');
        console.log('1. Open browser and login to OneStreamer');
        console.log('2. Open browser console (F12)');
        console.log('3. Get your auth token: localStorage.getItem("auth_token")');
        console.log('4. Use fetch to trigger item usage:');
        console.log(`
const token = localStorage.getItem('auth_token');
fetch('/api/inventory/use/${tomatoItem.id}', {
    method: 'POST',
    headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json'
    }
}).then(r => r.json()).then(console.log);
        `);
        
    } catch (error) {
        console.error('❌ API test failed:', error);
    }
}

// Run the test
testTomatoEffect();