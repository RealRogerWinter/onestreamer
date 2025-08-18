const io = require('socket.io-client');
const fetch = require('node-fetch');
require('dotenv').config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const ADMIN_KEY = process.env.ADMIN_KEY || 'onestreamer-admin-2024';

async function testAuthConnection() {
    console.log('🔍 Testing Authentication and Session Linking...\n');
    
    // Step 1: Login to get a token
    console.log('Step 1: Logging in to get auth token...');
    try {
        const loginResponse = await fetch(`${SERVER_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'user@example.com',
                password: '***REMOVED-ADMIN-KEY***'
            })
        });
        
        if (!loginResponse.ok) {
            console.log('❌ Login failed:', loginResponse.status, loginResponse.statusText);
            const errorText = await loginResponse.text();
            console.log('Error details:', errorText);
            return;
        }
        
        const loginData = await loginResponse.json();
        var authToken = loginData.token;
        var userId = loginData.user ? loginData.user.id : loginData.id;
        var username = loginData.user ? loginData.user.username : loginData.username;
        
        console.log(`✅ Logged in successfully!`);
        console.log(`   - Username: ${username}`);
        console.log(`   - User ID: ${userId}`);
        console.log(`   - Token: ${authToken.substring(0, 20)}...`);
        
    } catch (error) {
        console.error('❌ Login error:', error);
        return;
    }
    
    // Step 2: Connect with socket using auth token
    console.log('\nStep 2: Connecting socket with authentication...');
    
    const socket = io(SERVER_URL, {
        auth: {
            token: authToken
        },
        transports: ['websocket', 'polling']
    });
    
    await new Promise((resolve) => {
        socket.on('connect', () => {
            console.log(`✅ Socket connected!`);
            console.log(`   - Socket ID: ${socket.id}`);
            resolve();
        });
        
        socket.on('connect_error', (error) => {
            console.error('❌ Socket connection error:', error.message);
            resolve();
        });
    });
    
    // Step 3: Join as viewer to trigger session registration
    console.log('\nStep 3: Joining as viewer to register session...');
    socket.emit('join-as-viewer');
    
    // Wait a moment for server to process
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 4: Check connections via admin API
    console.log('\nStep 4: Fetching connections data from admin API...');
    
    try {
        const connectionsResponse = await fetch(`${SERVER_URL}/admin/connections`, {
            headers: {
                'x-admin-key': ADMIN_KEY,
                'Authorization': `Bearer ${authToken}`
            }
        });
        
        if (!connectionsResponse.ok) {
            console.log('❌ Failed to fetch connections:', connectionsResponse.status);
            return;
        }
        
        const connectionsData = await connectionsResponse.json();
        
        console.log('\n📊 Connections Data:');
        console.log(`   - Total Connections: ${connectionsData.totalConnections}`);
        console.log(`   - Unique Viewers: ${connectionsData.uniqueViewers}`);
        console.log(`   - Active Sessions: ${connectionsData.activeSessions}`);
        
        // Find our session
        const mySession = connectionsData.sessions.find(s => s.socketId === socket.id);
        
        if (mySession) {
            console.log('\n✅ Found my session:');
            console.log(`   - Socket ID: ${mySession.socketId}`);
            console.log(`   - IP Address: ${mySession.ipAddress}`);
            console.log(`   - User ID: ${mySession.userId || 'NOT SET'}`);
            console.log(`   - Chat Username: ${mySession.chatUsername || 'NOT SET'}`);
            console.log(`   - Is Active: ${mySession.isActive}`);
            console.log(`   - Authenticated User: ${JSON.stringify(mySession.authenticatedUser) || 'NOT SET'}`);
            
            console.log('\n📝 Full session object:');
            console.log(JSON.stringify(mySession, null, 2));
            
            if (!mySession.userId) {
                console.log('\n⚠️ WARNING: User ID is not set in session!');
                console.log('This means the authentication is not being linked properly.');
            }
            
            if (!mySession.authenticatedUser) {
                console.log('\n⚠️ WARNING: Authenticated user details are not included!');
                console.log('The enhanced session data is not being populated.');
            }
        } else {
            console.log('\n❌ Could not find my session in the connections data!');
            console.log('Available sessions:');
            connectionsData.sessions.forEach(s => {
                console.log(`   - ${s.socketId}: User ID = ${s.userId || 'none'}`);
            });
        }
        
        // Check if any sessions have userId set
        const authenticatedSessions = connectionsData.sessions.filter(s => s.userId);
        console.log(`\n📈 Authenticated sessions: ${authenticatedSessions.length} out of ${connectionsData.sessions.length}`);
        
        if (authenticatedSessions.length > 0) {
            console.log('Authenticated sessions found:');
            authenticatedSessions.forEach(s => {
                console.log(`   - Socket: ${s.socketId.substring(0, 12)}... User ID: ${s.userId}`);
            });
        }
        
    } catch (error) {
        console.error('❌ Error fetching connections:', error);
    }
    
    // Step 5: Test direct session service data
    console.log('\n\nStep 5: Checking server-side session data...');
    console.log('Check server logs for session registration details.');
    
    // Clean up
    socket.disconnect();
    console.log('\n✅ Test complete! Socket disconnected.');
}

// Run the test
testAuthConnection().catch(console.error);