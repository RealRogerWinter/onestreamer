/**
 * Simple event monitor to watch for ViewBot streaming events
 * This will help us see what happens when you click the play button in the UI
 */

const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:8080';

let testSocket = null;

async function monitorViewBotEvents() {
  console.log('🔍 ViewBot Event Monitor Started');
  console.log('📡 Connecting to server to monitor events...\n');
  
  try {
    testSocket = io(SERVER_URL);
    
    testSocket.on('connect', () => {
      console.log(`✅ Monitor connected: ${testSocket.id}`);
      console.log('🎯 Monitoring for ViewBot-related events...\n');
      console.log('   - stream-ready (ViewBot becomes available to viewers)');
      console.log('   - stream-status (stream state changes)');
      console.log('   - stream-started (stream begins)');
      console.log('   - stream-ended (stream stops)');
      console.log('   - streaming-approved (ViewBot gets permission)');
      console.log('\n💡 Now try clicking the play button on a ViewBot in the admin panel...\n');
    });
    
    testSocket.on('connect_error', (error) => {
      console.log(`❌ Connection failed: ${error.message}`);
    });
    
    testSocket.on('disconnect', () => {
      console.log('🔌 Monitor disconnected');
    });
    
    // Monitor all ViewBot-related events
    testSocket.on('stream-ready', (data) => {
      console.log(`📺 STREAM-READY:`, data);
      if (data.isViewBot) {
        console.log(`   ✅ ViewBot ${data.botId} is now ready for viewers!`);
      }
    });
    
    testSocket.on('stream-status', (data) => {
      console.log(`📊 STREAM-STATUS:`, {
        isStreaming: data.isStreaming,
        streamer: data.streamer?.substring(0, 12) + '...' || 'None',
        viewerCount: data.viewerCount,
        streamType: data.streamType
      });
    });
    
    testSocket.on('stream-started', (data) => {
      console.log(`🎬 STREAM-STARTED:`, data);
    });
    
    testSocket.on('stream-ended', (data) => {
      console.log(`🛑 STREAM-ENDED:`, data);
    });
    
    testSocket.on('streaming-approved', (data) => {
      console.log(`✅ STREAMING-APPROVED:`, data);
    });
    
    testSocket.on('takeover-denied', (data) => {
      console.log(`🚫 TAKEOVER-DENIED:`, data);
    });
    
    testSocket.on('stream-takeover', (data) => {
      console.log(`📢 STREAM-TAKEOVER:`, data);
    });
    
    // Monitor viewer-related events
    testSocket.on('viewer-count-update', (count) => {
      console.log(`👥 VIEWER-COUNT: ${count}`);
    });
    
    // Log any unexpected events
    testSocket.onAny((eventName, ...args) => {
      // Only log events we haven't specifically handled
      const handledEvents = [
        'connect', 'disconnect', 'connect_error',
        'stream-ready', 'stream-status', 'stream-started', 'stream-ended',
        'streaming-approved', 'takeover-denied', 'stream-takeover',
        'viewer-count-update'
      ];
      
      if (!handledEvents.includes(eventName)) {
        console.log(`🔍 OTHER-EVENT: ${eventName}`, args);
      }
    });
    
    // Keep monitoring for 5 minutes
    const monitoringDuration = 5 * 60 * 1000; // 5 minutes
    console.log(`⏰ Monitoring for ${monitoringDuration / 1000} seconds...`);
    console.log('🎯 Go ahead and try starting a ViewBot now!\n');
    
    setTimeout(() => {
      console.log('\n⏰ Monitoring period complete. Disconnecting...');
      if (testSocket) {
        testSocket.disconnect();
      }
    }, monitoringDuration);
    
  } catch (error) {
    console.error('❌ Monitor failed:', error);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down monitor...');
  if (testSocket) {
    testSocket.disconnect();
  }
  process.exit(0);
});

console.log('📡 ViewBot Event Monitor');
console.log('=======================');
console.log('This tool monitors server events to help diagnose ViewBot streaming issues.');
console.log('Leave this running and try starting a ViewBot from the admin panel.\n');

monitorViewBotEvents();