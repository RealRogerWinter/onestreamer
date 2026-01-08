#!/usr/bin/env node

/**
 * Test script to verify chat message tracking is working properly
 */

const axios = require('axios');

const MAIN_SERVER_URL = 'http://localhost:8080';
const CHAT_SERVER_URL = 'http://localhost:8081';

async function testChatMessageTracking() {
  console.log('🧪 Testing chat message tracking...');

  try {
    // Test 1: Direct API call to track-chat-message endpoint
    console.log('\n1. Testing direct API call with userId...');
    const response1 = await axios.post(`${MAIN_SERVER_URL}/api/internal/track-chat-message`, {
      userId: 1,
      ip: '127.0.0.1'
    });
    console.log('✅ Direct API call result:', response1.data);

    // Test 2: API call with only IP (should find user by session)
    console.log('\n2. Testing API call with only IP...');
    const response2 = await axios.post(`${MAIN_SERVER_URL}/api/internal/track-chat-message`, {
      ip: '127.0.0.1'
    });
    console.log('✅ IP-only API call result:', response2.data);

    // Test 3: Check chat service health
    console.log('\n3. Testing chat service health...');
    const response3 = await axios.get(`${CHAT_SERVER_URL}/health`);
    console.log('✅ Chat service health:', response3.data);

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

// Run the test
testChatMessageTracking();