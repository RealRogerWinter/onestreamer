#!/usr/bin/env node

/**
 * Quick script to start a ViewBot streamer
 * Usage: node start-viewbot.js [pattern]
 * 
 * Patterns:
 *   - color-bars (default)
 *   - clock
 *   - moving-text
 *   - noise
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = 'your-secret-admin-key-123';

const pattern = process.argv[2] || 'color-bars';

async function startViewBot() {
  console.log(`🤖 Starting ViewBot with ${pattern} pattern...`);
  
  try {
    // Create ViewBot
    console.log('📦 Creating ViewBot...');
    const createResponse = await axios.post(`${SERVER_URL}/admin/viewbot-client/create-streamer`, {
      config: {
        contentType: 'testPattern',
        testPattern: pattern,
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
    
    if (createResponse.data.success) {
      const botId = createResponse.data.botId;
      console.log(`✅ ViewBot created and streaming: ${botId}`);
      console.log(`📺 Pattern: ${pattern}`);
      console.log(`🌐 View at: http://localhost:3000`);
      console.log('\nPress Ctrl+C to stop the ViewBot\n');
      
      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        console.log('\n🛑 Stopping ViewBot...');
        try {
          await axios.delete(`${SERVER_URL}/admin/viewbot-client/${botId}`, {
            headers: {
              'x-admin-key': ADMIN_KEY
            }
          });
          console.log('✅ ViewBot stopped');
        } catch (error) {
          console.error('❌ Error stopping ViewBot:', error.message);
        }
        process.exit(0);
      });
      
      // Keep the process running
      setInterval(() => {}, 1000);
      
    } else {
      console.error('❌ Failed to create ViewBot:', createResponse.data.message);
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