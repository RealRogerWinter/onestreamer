const https = require('https');
const jwt = require('jsonwebtoken');

// Generate a JWT token for admin user
const JWT_SECRET = '***REMOVED-JWT-DEFAULT***';

const token = jwt.sign(
    { id: 1, username: 'admin', is_admin: 1, role: 'admin' },
    JWT_SECRET,
    { expiresIn: '24h' }
);

// Test the master-stream endpoint
const options = {
    hostname: '127.0.0.1',
    port: 8443,
    path: '/admin/review/master-stream',
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${token}`
    },
    rejectUnauthorized: false
};

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const lines = data.split('\n');
        const segments = lines.filter(l => l.includes('.ts'));
        const discontinuities = lines.filter(l => l.includes('#EXT-X-DISCONTINUITY'));

        // Calculate total duration from EXTINF tags
        let totalDuration = 0;
        for (const line of lines) {
            const match = line.match(/#EXTINF:([0-9.]+)/);
            if (match) {
                totalDuration += parseFloat(match[1]);
            }
        }

        console.log('Total segments:', segments.length);
        console.log('Total discontinuities:', discontinuities.length);
        console.log('Calculated duration:', (totalDuration / 60).toFixed(1), 'minutes');
        console.log('');

        // Show first and last few lines
        console.log('=== First 15 lines ===');
        console.log(lines.slice(0, 15).join('\n'));
        console.log('');
        console.log('=== Last 15 lines ===');
        console.log(lines.slice(-15).join('\n'));
    });
});

req.on('error', (e) => {
    console.error('Request error:', e);
});

req.end();
