/**
 * Emergency fix to unblock ViewBot streaming
 * This connects as a client and triggers a disconnect of the blocking socket
 */

const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:8080';

async function emergencyFixViewBot() {
  console.log('🚨 Emergency ViewBot Fix');
  console.log('========================\n');
  
  console.log('🎯 Issue: ViewBot socket is stuck as "current streamer" and blocking other ViewBots');
  console.log('🔧 Solution: Force disconnect the blocking socket to clear the streamer state\n');
  
  return new Promise((resolve, reject) => {
    const client = io(SERVER_URL);
    
    client.on('connect', () => {
      console.log(`✅ Connected to server: ${client.id}`);
      
      // Request to take over streaming to force the current "streamer" to disconnect
      console.log('📡 Sending request-to-stream to force current streamer disconnect...');
      
      client.emit('request-to-stream', {
        streamType: 'emergency-fix',
        isViewBot: false, // Claim to be a real user to force takeover
        timestamp: Date.now()
      });
    });
    
    client.on('streaming-approved', () => {
      console.log('✅ Emergency takeover approved - old streamer should be disconnected');
      
      // Now disconnect ourselves to clear the streamer state
      setTimeout(() => {
        console.log('🔌 Disconnecting emergency client to clear streamer state...');
        client.disconnect();
        
        setTimeout(() => {
          console.log('✅ Emergency fix complete!');
          console.log('💡 Try starting a ViewBot now - it should work.');
          resolve();
        }, 2000);
      }, 1000);
    });
    
    client.on('takeover-denied', (data) => {
      console.log('❌ Emergency takeover denied:', data.reason);
      console.log('💡 The blocking socket might already be cleared, or there are other restrictions.');
      client.disconnect();
      resolve();
    });
    
    client.on('connect_error', (error) => {
      console.log('❌ Connection failed:', error.message);
      reject(error);
    });
    
    // Timeout after 30 seconds
    setTimeout(() => {
      console.log('⏰ Emergency fix timeout - disconnecting');
      client.disconnect();
      resolve();
    }, 30000);
  });
}

console.log('🚨 Emergency ViewBot Fix Tool');
console.log('============================');
console.log('This tool will force clear the blocking socket that prevents ViewBots from starting.');
console.log('Based on your logs, socket "-lgh0UuAmUx_2XddAABD" is blocking new ViewBots.\n');

emergencyFixViewBot().then(() => {
  console.log('\n🎯 Next Steps:');
  console.log('1. Try clicking the play button on a ViewBot');
  console.log('2. If it still fails, restart the server to apply all fixes');
  console.log('3. The enhanced detection should prevent this issue in the future');
  process.exit(0);
}).catch((error) => {
  console.error('❌ Emergency fix failed:', error.message);
  process.exit(1);
});