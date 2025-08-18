/**
 * Comprehensive diagnostic for socket connection issues
 */

const io = require('socket.io-client');
const axios = require('axios');

async function diagnoseConnections() {
  console.log('🔍 Socket Connection Diagnostic Tool\n');
  console.log('=' .repeat(60));
  
  try {
    // 1. Check server connections via API
    console.log('\n📊 Step 1: Checking server-reported connections...\n');
    
    try {
      const response = await axios.get('http://localhost:8080/api/admin/connections');
      const data = response.data;
      
      console.log(`Total connections: ${data.totalConnections}`);
      console.log(`Unique viewers: ${data.uniqueViewers}`);
      console.log(`Active sessions: ${data.activeSessions}`);
      
      if (data.sessions) {
        console.log('\nSession details:');
        data.sessions.forEach(session => {
          console.log(`  - Socket ID: ${session.socketId}`);
          console.log(`    IP: ${session.ipAddress}`);
          console.log(`    User: ${session.authenticatedUser?.username || 'Anonymous'}`);
          console.log(`    Connected: ${new Date(session.connectedAt).toLocaleTimeString()}`);
        });
      }
    } catch (error) {
      console.log('Could not fetch server connections:', error.message);
    }
    
    // 2. Test creating connections manually
    console.log('\n🧪 Step 2: Testing manual socket connections...\n');
    
    // Create a test connection to main server
    console.log('Creating test connection to main server (8080)...');
    const mainTestSocket = io('http://localhost:8080', {
      transports: ['websocket', 'polling'],
      forceNew: true
    });
    
    await new Promise((resolve) => {
      mainTestSocket.on('connect', () => {
        console.log(`✅ Main test socket connected: ${mainTestSocket.id}`);
        resolve();
      });
    });
    
    // Create a test connection to chat server
    console.log('Creating test connection to chat server (8081)...');
    const chatTestSocket = io('http://localhost:8081', {
      transports: ['websocket', 'polling'],
      forceNew: true
    });
    
    await new Promise((resolve) => {
      chatTestSocket.on('connect', () => {
        console.log(`✅ Chat test socket connected: ${chatTestSocket.id}`);
        resolve();
      });
    });
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 3. Check connections again
    console.log('\n📊 Step 3: Checking connections after test sockets...\n');
    
    try {
      const response = await axios.get('http://localhost:8080/api/admin/connections');
      const data = response.data;
      
      console.log(`Total connections now: ${data.totalConnections}`);
      console.log('Should be +1 from before (our test connection)');
    } catch (error) {
      console.log('Could not fetch server connections:', error.message);
    }
    
    // 4. Disconnect test sockets
    console.log('\n🔌 Step 4: Disconnecting test sockets...\n');
    mainTestSocket.disconnect();
    chatTestSocket.disconnect();
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 5. Final check
    console.log('\n📊 Step 5: Final connection check...\n');
    
    try {
      const response = await axios.get('http://localhost:8080/api/admin/connections');
      const data = response.data;
      
      console.log(`Total connections final: ${data.totalConnections}`);
      console.log('Should be back to original count');
    } catch (error) {
      console.log('Could not fetch server connections:', error.message);
    }
    
    // 6. Check for socket.io manager issues
    console.log('\n🔧 Step 6: Checking Socket.IO configuration...\n');
    
    // Test with different configurations
    const configs = [
      { forceNew: false, multiplex: true, desc: 'Multiplex enabled' },
      { forceNew: false, multiplex: false, desc: 'Multiplex disabled' },
      { forceNew: true, desc: 'Force new connection' }
    ];
    
    for (const config of configs) {
      console.log(`\nTesting: ${config.desc}`);
      const testSocket = io('http://localhost:8080', config);
      
      await new Promise((resolve) => {
        testSocket.on('connect', () => {
          console.log(`  Connected: ${testSocket.id}`);
          testSocket.disconnect();
          resolve();
        });
      });
    }
    
    console.log('\n' + '=' .repeat(60));
    console.log('📋 DIAGNOSTIC SUMMARY:\n');
    
    console.log('Possible issues to check:');
    console.log('1. React StrictMode double-mounting components');
    console.log('2. Hot Module Replacement creating new connections');
    console.log('3. Multiple component instances creating sockets');
    console.log('4. Socket.IO multiplex settings');
    console.log('5. Server not cleaning up disconnected sockets properly');
    
  } catch (error) {
    console.error('Diagnostic failed:', error);
  }
  
  process.exit(0);
}

// Run diagnostic
diagnoseConnections().catch(console.error);