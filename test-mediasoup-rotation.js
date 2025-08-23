/**
 * Test MediaSoup viewbot rotation
 */

const SimpleViewBotMediaSoup = require('./server/services/SimpleViewBotMediaSoup');
const MediasoupService = require('./server/services/MediasoupService');
const fs = require('fs');
const path = require('path');

async function test() {
  console.log('🧪 Testing MediaSoup ViewBot Rotation');
  console.log('=====================================\n');
  
  // Initialize MediaSoup
  const mediasoupService = new MediasoupService();
  await mediasoupService.initialize();
  console.log('✅ MediaSoup initialized');
  
  // Create rotation system
  const rotation = new SimpleViewBotMediaSoup(mediasoupService);
  
  // Find video files
  const videoFiles = [];
  const uploadsDir = '/root/onestreamer/server/uploads';
  
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    files.filter(f => f.endsWith('.mp4')).forEach(file => {
      videoFiles.push(path.join(uploadsDir, file));
    });
  }
  
  console.log(`Found ${videoFiles.length} video files`);
  
  // Create test bots
  const bots = [];
  
  // Add bots with video files
  videoFiles.slice(0, 4).forEach((file, i) => {
    bots.push({
      id: `bot-${i + 1}`,
      name: `Video Bot ${i + 1}`,
      mediaFile: file
    });
  });
  
  // Add test pattern bot
  bots.push({
    id: 'bot-test',
    name: 'Test Pattern Bot',
    mediaFile: null
  });
  
  // Configure for testing
  rotation.updateSettings({
    minRotationInterval: 15000,  // 15 seconds
    maxRotationInterval: 30000,  // 30 seconds
    cooldownDuration: 45000,     // 45 seconds
    enabled: true
  });
  
  // Initialize
  await rotation.initialize(bots);
  
  // Monitor
  const monitor = setInterval(() => {
    const status = rotation.getStatus();
    console.log('\n📊 Status:', {
      currentBot: status.currentBot,
      available: `${status.availableNow}/${status.totalBots}`,
      streaming: status.hasGStreamer && status.hasProducers
    });
    
    // Check GStreamer processes
    const { execSync } = require('child_process');
    try {
      const count = execSync('ps aux | grep gst-launch | grep -v grep | wc -l').toString().trim();
      console.log(`  GStreamer processes: ${count}`);
    } catch (e) {}
  }, 5000);
  
  // Test force rotation after 20 seconds
  setTimeout(() => {
    console.log('\n🔄 Testing force rotation...');
    rotation.forceRotation();
  }, 20000);
  
  // Run for 60 seconds
  setTimeout(async () => {
    console.log('\n🛑 Stopping test...');
    clearInterval(monitor);
    await rotation.shutdown();
    process.exit(0);
  }, 60000);
  
  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n🛑 Interrupted...');
    clearInterval(monitor);
    await rotation.shutdown();
    process.exit(0);
  });
}

test().catch(console.error);