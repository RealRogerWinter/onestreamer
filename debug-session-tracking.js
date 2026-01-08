const database = require('./server/database/database');
const SessionService = require('./server/services/SessionService');

// Create session service instance
const sessionService = new SessionService();

console.log('\n🔍 Debugging Session Tracking\n');
console.log('================================\n');

// Get raw internal state
console.log('Internal Maps:');
console.log('- socketToIp:', sessionService.socketToIp);
console.log('- ipToSockets:', sessionService.ipToSockets);
console.log('- sessions:', sessionService.sessions);
console.log('- uniqueViewers:', sessionService.uniqueViewers);

console.log('\n================================\n');

// Get all sessions as returned to admin panel
const allSessions = sessionService.getAllSessions();
console.log(`Total session entries: ${allSessions.length}`);

// Group by IP
const byIP = {};
allSessions.forEach(session => {
    if (!byIP[session.ipAddress]) {
        byIP[session.ipAddress] = [];
    }
    byIP[session.ipAddress].push(session);
});

console.log('\nSessions by IP:');
for (const [ip, sessions] of Object.entries(byIP)) {
    console.log(`\nIP: ${ip} - ${sessions.length} entries`);
    sessions.forEach(s => {
        console.log(`  - Socket: ${s.socketId}`);
        console.log(`    Active: ${s.isActive}`);
        console.log(`    User: ${s.userId || 'Anonymous'}`);
    });
}

// Check actual socket connections
const { createServer } = require('http');
const { Server } = require('socket.io');
const server = createServer();
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
    }
});

io.on('connection', (socket) => {
    console.log('Test connection:', socket.id);
    socket.disconnect();
});

const PORT = 8089;
server.listen(PORT, () => {
    console.log(`\n✅ Debug server running on port ${PORT}`);
    
    // After a moment, check main server
    setTimeout(() => {
        const axios = require('axios');
        
        axios.get('http://localhost:8080/api/admin/connections', {
            headers: {
                'Authorization': `Bearer ${process.env.ADMIN_TOKEN || ''}`
            }
        }).then(response => {
            console.log('\n📊 Admin API Response:');
            console.log(`Total connections: ${response.data.totalConnections}`);
            console.log(`Unique IPs: ${response.data.uniqueIPs}`);
            console.log(`Session count: ${response.data.sessions.length}`);
        }).catch(err => {
            console.log('\n❌ Could not fetch from admin API:', err.message);
        }).finally(() => {
            process.exit(0);
        });
    }, 1000);
});