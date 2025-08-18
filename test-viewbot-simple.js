/**
 * Simple ViewBot test - creates a ViewBot and immediately starts streaming
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = 'your-secret-admin-key-123';

async function startViewBot() {
  try {
    console.log('🤖 Creating and starting ViewBot...');
    
    // Create a ViewBot that starts streaming immediately
    const response = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, {
      config: {
        contentType: 'testPattern',
        testPattern: 'color-bars',
        width: 1280,
        height: 720,
        frameRate: 30,
        autoStart: true
      }
    }, {
      headers: {
        'x-admin-key': ADMIN_KEY
      }
    });
    
    if (response.data.success) {
      console.log(`✅ ViewBot created and streaming: ${response.data.botId}`);
      console.log(`📺 Pattern: color-bars`);
      console.log(`🌐 View at: http://localhost:3000`);
      console.log('\nViewBot should now be streaming test pattern to viewers!');
      console.log('Check your browser - the stream should show color bars instead of black screen.');
      console.log('\nPress Ctrl+C when done testing\n');
      
      // Keep running
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', process.exit.bind(process, 0));
      
    } else {
      console.error('❌ Failed to create ViewBot:', response.data.message);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    
    if (error.response?.data?.message?.includes('FFmpeg')) {
      console.log('\n📋 FFmpeg Installation Required:');
      console.log('   Windows: winget install ffmpeg');
      console.log('   Or download from: https://ffmpeg.org/download.html');
      console.log('   Make sure FFmpeg is in your PATH');
    }
    
    process.exit(1);
  }
}

startViewBot();