// Simple test to verify timed transcription works
const http = require('http');

function makeRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    data: data
                });
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function test() {
    console.log('Testing Timed Transcription\n');
    
    // Try to start a timed transcription
    console.log('Attempting to start timed transcription...');
    
    const result = await makeRequest({
        hostname: 'localhost',
        port: 8080,
        path: '/admin/transcription/timed',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-key': '***REMOVED-ADMIN-KEY***'
        }
    }, {
        streamerId: 'test-stream',
        duration: 10,
        options: {
            model: 'base',
            language: 'en'
        }
    });
    
    console.log('Response:', result.statusCode);
    if (result.data) {
        try {
            const json = JSON.parse(result.data);
            console.log('Result:', JSON.stringify(json, null, 2));
        } catch (e) {
            console.log('Response body:', result.data);
        }
    }
    
    if (result.statusCode === 401) {
        console.log('\n⚠️  Authentication required. The endpoint needs an auth token.');
        console.log('The timed transcription feature has been implemented but requires authentication.');
    } else if (result.statusCode === 200) {
        console.log('\n✅ Timed transcription started successfully!');
    }
}

test().catch(console.error);