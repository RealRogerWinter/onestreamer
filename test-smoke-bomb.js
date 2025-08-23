const https = require('https');

async function testSmokeBomb() {
    try {
        // First, get auth token
        const authData = JSON.stringify({
            username: 'streamer',
            password: 'password'
        });

        const authOptions = {
            hostname: '127.0.0.1',
            port: 8443,
            path: '/api/auth/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': authData.length
            },
            rejectUnauthorized: false
        };

        const token = await new Promise((resolve, reject) => {
            const req = https.request(authOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    const result = JSON.parse(data);
                    resolve(result.token);
                });
            });
            req.on('error', reject);
            req.write(authData);
            req.end();
        });

        console.log('✅ Got auth token');

        // Get smoke bomb item ID
        const itemsOptions = {
            hostname: '127.0.0.1',
            port: 8443,
            path: '/api/items',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            rejectUnauthorized: false
        };

        const items = await new Promise((resolve, reject) => {
            const req = https.request(itemsOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve(JSON.parse(data));
                });
            });
            req.on('error', reject);
            req.end();
        });

        const smokeBomb = items.find(item => item.name === 'smoke_bomb');
        if (!smokeBomb) {
            console.error('❌ Smoke bomb item not found');
            return;
        }

        console.log(`✅ Found smoke bomb item: ID ${smokeBomb.id}, duration: ${smokeBomb.duration_seconds}s`);

        // Use the smoke bomb
        const useOptions = {
            hostname: '127.0.0.1',
            port: 8443,
            path: `/api/inventory/use/${smokeBomb.id}`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            rejectUnauthorized: false
        };

        const result = await new Promise((resolve, reject) => {
            const req = https.request(useOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve(JSON.parse(data));
                });
            });
            req.on('error', reject);
            req.end();
        });

        console.log('📦 Use result:', JSON.stringify(result, null, 2));

        // Check server logs after a moment
        setTimeout(() => {
            console.log('\n📋 Check server logs with: pm2 logs onestreamer-server | grep CANVASFX');
        }, 2000);

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

testSmokeBomb();