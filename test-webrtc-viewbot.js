#!/usr/bin/env node

/**
 * Test script to create a WebRTC-based viewbot that works with mobile 5G/TURN
 */

const axios = require('axios');

const SERVER_URL = 'http://127.0.0.1:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function createWebRTCViewbot() {
  try {
    console.log('🚀 Creating WebRTC viewbot for mobile 5G compatibility...');
    
    const response = await axios.post(
      `${SERVER_URL}/admin/viewbot-webrtc/create`,
      {
        config: {
          pattern: 'testsrc2',
          width: 1280,
          height: 720,
          frameRate: 30,
          customText: 'WebRTC ViewBot - Mobile 5G Test',
          useWebRTC: true  // Force WebRTC transport
        }
      },
      {
        headers: {
          'x-admin-key': ADMIN_KEY
        }
      }
    );
    
    if (response.data.success) {
      console.log('✅ WebRTC viewbot created:', response.data);
      
      const botId = response.data.botId;
      console.log(`🎬 Starting viewbot ${botId}...`);
      
      // Start the viewbot
      const startResponse = await axios.post(
        `${SERVER_URL}/admin/viewbot-webrtc/${botId}/start`,
        {},
        {
          headers: {
            'x-admin-key': ADMIN_KEY
          }
        }
      );
      
      console.log('📺 WebRTC viewbot started:', startResponse.data);
      console.log('\n✨ WebRTC viewbot is now streaming with TURN support for mobile 5G!');
      console.log('📱 Mobile viewers should now be able to watch this stream.');
      
      // Keep running and show status
      setInterval(async () => {
        try {
          const statusResponse = await axios.get(
            `${SERVER_URL}/admin/viewbot-webrtc/status`,
            {
              headers: {
                'x-admin-key': ADMIN_KEY
              }
            }
          );
          console.log(`📊 Active WebRTC viewbots:`, statusResponse.data.viewbots.length);
        } catch (error) {
          // Ignore status check errors
        }
      }, 30000); // Check every 30 seconds
      
    } else {
      console.error('❌ Failed to create WebRTC viewbot:', response.data);
    }
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Run the test
createWebRTCViewbot();

console.log('Press Ctrl+C to stop...');
