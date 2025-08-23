/**
 * Test script for the simple viewbot rotation system
 */

const SimpleViewBotRotation = require('./server/services/SimpleViewBotRotation');
const path = require('path');
const fs = require('fs');

// Test configuration with actual video files
const testBots = [
  {
    id: 'viewbot-1',
    name: 'Death Grips Bot',
    mediaFile: '/root/onestreamer/server/uploads/Death_Grips___Beware_1755683969648.mp4'
  },
  {
    id: 'viewbot-2', 
    name: 'Patrick Hernandez Bot',
    mediaFile: '/root/onestreamer/server/uploads/Patrick_Hernandez___Born_To_Be_Alive__COVER__1755684147885.mp4'
  },
  {
    id: 'viewbot-3',
    name: 'Krab Borg Bot',
    mediaFile: '/root/onestreamer/server/uploads/Krab_A_Borg_Part_2_1755684119267.mp4'
  },
  {
    id: 'viewbot-4',
    name: 'SpongeBob Bot',
    mediaFile: '/root/onestreamer/server/uploads/SpongeBob_SquarePants_Season_2_Episode_8_Christmas_Who_part5_480p_1755684165853.mp4'
  },
  {
    id: 'viewbot-5',
    name: 'Test Video Bot',
    mediaFile: '/root/onestreamer/videos/test-video-short.mp4'
  },
  {
    id: 'viewbot-6',
    name: 'Test Pattern Bot',
    mediaFile: null // Will use test pattern
  }
];

// Verify files exist
testBots.forEach(bot => {
  if (bot.mediaFile && !fs.existsSync(bot.mediaFile)) {
    console.warn(`⚠️ Media file not found for ${bot.name}: ${bot.mediaFile}`);
    bot.mediaFile = null; // Fall back to test pattern
  }
});

async function runTest() {
  console.log('🧪 Starting Simple ViewBot Rotation Test');
  console.log('=====================================');
  
  // Configure for testing (shorter intervals)
  SimpleViewBotRotation.updateSettings({
    minRotationInterval: 10000,  // 10 seconds for testing
    maxRotationInterval: 30000,  // 30 seconds for testing
    cooldownDuration: 60000,     // 1 minute cooldown for testing
    enabled: true
  });
  
  // Initialize with test bots
  await SimpleViewBotRotation.initialize(testBots);
  
  // Monitor status
  setInterval(() => {
    const status = SimpleViewBotRotation.getStatus();
    console.log('\n📊 Current Status:', JSON.stringify(status, null, 2));
  }, 5000);
  
  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n⏹️ Shutting down test...');
    await SimpleViewBotRotation.shutdown();
    process.exit(0);
  });
  
  // Commands
  console.log('\n📌 Commands:');
  console.log('  s - Show status');
  console.log('  r - Force rotation');
  console.log('  p - Pause rotation');
  console.log('  e - Enable rotation');
  console.log('  q - Quit');
  console.log('');
  
  // Setup stdin for commands (if running in TTY)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', async (key) => {
      const cmd = key.toString();
      
      switch(cmd) {
        case 's':
          console.log('\n📊 Status:', JSON.stringify(SimpleViewBotRotation.getStatus(), null, 2));
          break;
        case 'r':
          console.log('\n🔄 Forcing rotation...');
          await SimpleViewBotRotation.rotateToNextBot();
          break;
        case 'p':
          console.log('\n⏸️ Pausing rotation...');
          SimpleViewBotRotation.updateSettings({ enabled: false });
          break;
        case 'e':
          console.log('\n▶️ Enabling rotation...');
          SimpleViewBotRotation.updateSettings({ enabled: true });
          break;
        case 'q':
        case '\x03': // Ctrl+C
          console.log('\n👋 Exiting...');
          await SimpleViewBotRotation.shutdown();
          process.exit(0);
          break;
      }
    });
  }
}

// Run the test
runTest().catch(console.error);