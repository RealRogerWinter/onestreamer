#!/usr/bin/env node

/**
 * Test LiveKit SDK connection and capabilities
 */

const { AccessToken } = require('livekit-server-sdk');

async function testLiveKitSDK() {
  console.log('🧪 Testing LiveKit SDK capabilities...');
  
  try {
    // Create access token
    const apiKey = process.env.LIVEKIT_API_KEY || 'REDACTED-LIVEKIT-API-KEY';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'REDACTED-LIVEKIT-API-SECRET';
    
    const token = new AccessToken(apiKey, apiSecret, {
      identity: 'test-viewbot',
      ttl: '1h',
    });
    
    token.addGrant({
      roomJoin: true,
      room: 'main',
      canPublish: true,
      canSubscribe: false,
    });
    
    const jwt = await token.toJwt();
    console.log('✅ Token created successfully');
    
    // The livekit-client SDK is for browsers
    // For server-side, we need to use different approaches:
    
    console.log('\n📋 Available options for server-side ViewBot streaming to LiveKit:');
    console.log('1. Use Puppeteer with headless browser (complex but works)');
    console.log('2. Use GStreamer with custom WebRTC signaling (requires implementation)');
    console.log('3. Use RTMP ingress if configured in LiveKit server');
    console.log('4. Use FFmpeg with WebRTC (limited support)');
    
    // Check if we can use the simple approach with fetch API
    const livekitUrl = 'https://onestreamer.live:7880';
    
    console.log(`\n🔍 Checking LiveKit server at ${livekitUrl}...`);
    
    // Try to get server info
    const https = require('https');
    const agent = new https.Agent({
      rejectUnauthorized: false
    });
    
    const response = await fetch(`${livekitUrl}/rtc`, {
      method: 'GET',
      agent: agent
    });
    
    console.log(`📡 LiveKit /rtc endpoint status: ${response.status}`);
    
    if (response.status === 404) {
      console.log('❌ LiveKit does not support WHIP protocol at /rtc endpoint');
    }
    
    // The best approach for ViewBots with LiveKit is to use
    // a headless browser with the LiveKit client SDK
    console.log('\n💡 Recommendation: Use Puppeteer with LiveKit client SDK for ViewBots');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testLiveKitSDK();