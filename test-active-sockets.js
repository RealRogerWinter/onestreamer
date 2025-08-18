const io = require('socket.io-client');
const fetch = require('node-fetch');

const SERVER_URL = 'http://localhost:8080';

async function checkActiveSockets() {
    console.log('Checking active sockets...\n');
    
    // Login first
    const loginResponse = await fetch(`${SERVER_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: 'user@example.com',
            password: '***REMOVED-ADMIN-KEY***'
        })
    });
    
    const loginData = await loginResponse.json();
    const authToken = loginData.token;
    
    // Fetch connections
    const response = await fetch(`${SERVER_URL}/admin/connections`, {
        headers: {
            'Authorization': `Bearer ${authToken}`
        }
    });
    
    const data = await response.json();
    
    console.log('Total socket connections:', data.totalConnections);
    console.log('Unique IPs:', data.uniqueViewers);
    console.log('\nActive sockets:');
    
    // Group by IP
    const byIp = {};
    data.connections.forEach(conn => {
        const ip = conn.handshake.address;
        if (!byIp[ip]) byIp[ip] = [];
        byIp[ip].push(conn);
    });
    
    Object.entries(byIp).forEach(([ip, conns]) => {
        console.log(`\nIP ${ip}: ${conns.length} socket(s)`);
        conns.forEach(conn => {
            const age = Date.now() - new Date(conn.handshake.time).getTime();
            const ageMinutes = Math.floor(age / 60000);
            console.log(`  - ${conn.id} (connected ${ageMinutes}m ago) ${conn.connected ? '✅' : '❌'}`);
        });
    });
    
    // Check sessions
    console.log('\n\nSessions for your user:');
    const userSessions = data.sessions.filter(s => s.userId === 3);
    console.log(`Found ${userSessions.length} sessions for user ID 3`);
    
    userSessions.forEach(s => {
        console.log(`  - Socket: ${s.socketId} | Active: ${s.isActive} | IP: ${s.ipAddress}`);
    });
}

checkActiveSockets().catch(console.error);