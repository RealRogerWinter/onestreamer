/**
 * Test the integrated ViewBot rotation system
 */

const ViewBotRotationIntegration = require('./server/services/ViewBotRotationIntegration');

async function test() {
  console.log('🧪 Testing Integrated ViewBot Rotation System');
  console.log('=============================================\n');
  
  // Initialize the system
  const result = await ViewBotRotationIntegration.initialize();
  console.log('Initialization result:', result);
  
  if (!result.success) {
    console.error('❌ Failed to initialize');
    process.exit(1);
  }
  
  // Get initial status
  console.log('\n📊 Initial Status:', ViewBotRotationIntegration.getStatus());
  
  // Update settings for faster testing
  ViewBotRotationIntegration.updateSettings({
    minRotationInterval: 15000,  // 15 seconds
    maxRotationInterval: 30000,  // 30 seconds
    cooldownDuration: 45000,     // 45 seconds
    enabled: true
  });
  
  // Start rotation
  console.log('\n▶️ Starting rotation...');
  await ViewBotRotationIntegration.startRotation();
  
  // Monitor for 60 seconds
  let checkCount = 0;
  const monitor = setInterval(() => {
    checkCount++;
    const status = ViewBotRotationIntegration.getStatus();
    console.log(`\n[Check ${checkCount}] Current bot: ${status.currentBot || 'none'}, Available: ${status.availableNow}/${status.totalBots}`);
    
    // Check for GStreamer processes
    const { execSync } = require('child_process');
    try {
      const gstCount = execSync('ps aux | grep gst-launch | grep -v grep | wc -l').toString().trim();
      console.log(`  GStreamer processes: ${gstCount}`);
    } catch (e) {
      console.log('  Could not check GStreamer processes');
    }
    
    if (checkCount >= 12) { // 60 seconds
      clearInterval(monitor);
      shutdown();
    }
  }, 5000);
  
  // Test force rotation after 10 seconds
  setTimeout(() => {
    console.log('\n🔄 Testing force rotation...');
    ViewBotRotationIntegration.forceRotation();
  }, 10000);
  
  // Test real streamer takeover after 25 seconds
  setTimeout(() => {
    console.log('\n👤 Testing real streamer takeover...');
    ViewBotRotationIntegration.handleRealStreamerActive(true);
    
    // Resume after 10 seconds
    setTimeout(() => {
      console.log('\n👤 Real streamer done, resuming...');
      ViewBotRotationIntegration.handleRealStreamerActive(false);
    }, 10000);
  }, 25000);
  
  async function shutdown() {
    console.log('\n🛑 Shutting down test...');
    await ViewBotRotationIntegration.shutdown();
    process.exit(0);
  }
  
  // Handle Ctrl+C
  process.on('SIGINT', shutdown);
}

test().catch(console.error);