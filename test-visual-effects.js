#!/usr/bin/env node

/**
 * Visual Effects Testing Script
 * 
 * This script tests the VisualFX service functionality by applying various effects
 * to active streams and monitoring their behavior.
 */

const io = require('socket.io-client');
const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const socket = io(SERVER_URL);

console.log('🎬 VISUALFX TEST: Starting visual effects testing...');

// Test configuration
const TEST_CONFIG = {
  serverUrl: SERVER_URL,
  testDuration: 60000, // 1 minute
  effectTestInterval: 5000, // Test new effect every 5 seconds
  apiTestEnabled: true,
  socketTestEnabled: true
};

// Track test results
const testResults = {
  apiTests: [],
  socketTests: [],
  errors: [],
  totalEffectsApplied: 0,
  totalEffectsRemoved: 0
};

// Available effects to test (subset for testing)
const TEST_EFFECTS = [
  'resolution_240p',
  'resolution_360p',
  'bitrate_potato',
  'framerate_choppy',
  'packet_loss_mild',
  'pixelate',
  'grayscale',
  'static_noise',
  'freeze_frame',
  'audio_pitch_high'
];

// Connect to server
socket.on('connect', () => {
  console.log('✅ VISUALFX TEST: Connected to server');
  
  // Join as viewer to receive stream updates
  socket.emit('join-as-viewer');
  
  // Start tests after a short delay
  setTimeout(startTests, 2000);
});

socket.on('disconnect', () => {
  console.log('❌ VISUALFX TEST: Disconnected from server');
});

// Listen for visual effect events
socket.on('visual-effect-applied', (data) => {
  console.log(`✅ VISUALFX TEST: Effect applied - ${data.effectName} (${data.duration}ms)`);
  testResults.totalEffectsApplied++;
});

socket.on('visual-effect-removed', (data) => {
  console.log(`🗑️ VISUALFX TEST: Effect removed - Instance ${data.effectInstanceId}`);
  testResults.totalEffectsRemoved++;
});

socket.on('visual-effect-error', (error) => {
  console.error('❌ VISUALFX TEST: Socket error:', error.error);
  testResults.errors.push({ type: 'socket', error: error.error, timestamp: Date.now() });
});

socket.on('visual-effects-list', (data) => {
  console.log(`📋 VISUALFX TEST: Received effects list - ${data.availableEffects.length} available, ${data.activeEffects.length} active`);
});

socket.on('visual-fx-stats', (data) => {
  console.log('📊 VISUALFX TEST: Stats received:', JSON.stringify(data.stats, null, 2));
});

// Start testing
async function startTests() {
  console.log('🚀 VISUALFX TEST: Starting comprehensive tests...');
  
  try {
    // Test 1: Get available effects via API
    await testGetEffectsAPI();
    
    // Test 2: Get available effects via Socket
    await testGetEffectsSocket();
    
    // Test 3: Test effect application via API
    if (TEST_CONFIG.apiTestEnabled) {
      await testEffectApplicationAPI();
    }
    
    // Test 4: Test effect application via Socket
    if (TEST_CONFIG.socketTestEnabled) {
      await testEffectApplicationSocket();
    }
    
    // Test 5: Test preset combinations
    await testPresetEffects();
    
    // Test 6: Test statistics endpoints
    await testStatisticsEndpoints();
    
    // Test 7: Stress test with multiple effects
    await testMultipleEffects();
    
    // Wait for all effects to complete
    setTimeout(() => {
      console.log('\n📊 VISUALFX TEST: Final Results');
      console.log('=====================================');
      printTestResults();
      process.exit(0);
    }, TEST_CONFIG.testDuration);
    
  } catch (error) {
    console.error('❌ VISUALFX TEST: Test suite failed:', error);
    process.exit(1);
  }
}

// Test API endpoint for getting effects
async function testGetEffectsAPI() {
  console.log('\n🧪 Testing: Get Effects API');
  try {
    const response = await axios.get(`${SERVER_URL}/api/visualfx/effects`);
    
    if (response.data.success && response.data.effects.length > 0) {
      console.log(`✅ API Test: Found ${response.data.effects.length} effects`);
      testResults.apiTests.push({ test: 'get-effects', success: true, count: response.data.effects.length });
    } else {
      throw new Error('No effects returned from API');
    }
  } catch (error) {
    console.error('❌ API Test: Get effects failed:', error.message);
    testResults.apiTests.push({ test: 'get-effects', success: false, error: error.message });
  }
}

// Test Socket endpoint for getting effects
async function testGetEffectsSocket() {
  console.log('\n🧪 Testing: Get Effects Socket');
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error('❌ Socket Test: Get effects timeout');
      testResults.socketTests.push({ test: 'get-effects', success: false, error: 'timeout' });
      resolve();
    }, 5000);
    
    const handler = (data) => {
      clearTimeout(timeout);
      if (data.availableEffects && data.availableEffects.length > 0) {
        console.log(`✅ Socket Test: Found ${data.availableEffects.length} effects`);
        testResults.socketTests.push({ test: 'get-effects', success: true, count: data.availableEffects.length });
      } else {
        console.error('❌ Socket Test: No effects received');
        testResults.socketTests.push({ test: 'get-effects', success: false, error: 'no effects' });
      }
      socket.off('visual-effects-list', handler);
      resolve();
    };
    
    socket.on('visual-effects-list', handler);
    socket.emit('get-visual-effects');
  });
}

// Test effect application via API
async function testEffectApplicationAPI() {
  console.log('\n🧪 Testing: Effect Application API');
  
  const testEffect = TEST_EFFECTS[Math.floor(Math.random() * TEST_EFFECTS.length)];
  
  try {
    const response = await axios.post(`${SERVER_URL}/api/visualfx/apply`, {
      effectId: testEffect,
      options: {
        duration: 10000,
        testMode: true
      }
    });
    
    if (response.data.success) {
      console.log(`✅ API Test: Applied effect ${testEffect}`);
      testResults.apiTests.push({ test: 'apply-effect', success: true, effectId: testEffect });
      
      // Test removal after 5 seconds
      if (response.data.effect && response.data.effect.id) {
        setTimeout(async () => {
          try {
            await axios.delete(`${SERVER_URL}/api/visualfx/remove/${response.data.effect.id}`);
            console.log(`✅ API Test: Removed effect ${response.data.effect.id}`);
            testResults.apiTests.push({ test: 'remove-effect', success: true, effectId: testEffect });
          } catch (error) {
            console.error(`❌ API Test: Remove effect failed:`, error.message);
            testResults.apiTests.push({ test: 'remove-effect', success: false, error: error.message });
          }
        }, 5000);
      }
    } else {
      throw new Error(response.data.error || 'Unknown API error');
    }
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message;
    console.error(`❌ API Test: Apply effect failed:`, errorMsg);
    testResults.apiTests.push({ test: 'apply-effect', success: false, error: errorMsg });
  }
}

// Test effect application via Socket
async function testEffectApplicationSocket() {
  console.log('\n🧪 Testing: Effect Application Socket');
  
  const testEffect = TEST_EFFECTS[Math.floor(Math.random() * TEST_EFFECTS.length)];
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error('❌ Socket Test: Apply effect timeout');
      testResults.socketTests.push({ test: 'apply-effect', success: false, error: 'timeout' });
      resolve();
    }, 10000);
    
    const successHandler = (data) => {
      clearTimeout(timeout);
      console.log(`✅ Socket Test: Applied effect ${testEffect}`);
      testResults.socketTests.push({ test: 'apply-effect', success: true, effectId: testEffect });
      socket.off('visual-effect-success', successHandler);
      socket.off('visual-effect-error', errorHandler);
      resolve();
    };
    
    const errorHandler = (error) => {
      clearTimeout(timeout);
      console.error('❌ Socket Test: Apply effect error:', error.error);
      testResults.socketTests.push({ test: 'apply-effect', success: false, error: error.error });
      socket.off('visual-effect-success', successHandler);
      socket.off('visual-effect-error', errorHandler);
      resolve();
    };
    
    socket.on('visual-effect-success', successHandler);
    socket.on('visual-effect-error', errorHandler);
    
    socket.emit('apply-visual-effect', {
      effectId: testEffect,
      options: {
        duration: 8000,
        testMode: true
      }
    });
  });
}

// Test preset effects
async function testPresetEffects() {
  console.log('\n🧪 Testing: Preset Effects');
  
  try {
    // First get available presets
    const presetsResponse = await axios.get(`${SERVER_URL}/api/visualfx/presets`);
    
    if (presetsResponse.data.success) {
      const presetNames = Object.keys(presetsResponse.data.presets);
      const testPreset = presetNames[0]; // Test the first preset
      
      console.log(`📋 Found ${presetNames.length} presets, testing: ${testPreset}`);
      
      // Apply the preset
      const applyResponse = await axios.post(`${SERVER_URL}/api/visualfx/preset/${testPreset}`);
      
      if (applyResponse.data.success) {
        console.log(`✅ Preset Test: Applied preset ${testPreset}`);
        testResults.apiTests.push({ test: 'apply-preset', success: true, preset: testPreset });
      } else {
        throw new Error(applyResponse.data.error);
      }
    } else {
      throw new Error('Failed to get presets');
    }
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message;
    console.error('❌ Preset Test: Failed:', errorMsg);
    testResults.apiTests.push({ test: 'apply-preset', success: false, error: errorMsg });
  }
}

// Test statistics endpoints
async function testStatisticsEndpoints() {
  console.log('\n🧪 Testing: Statistics Endpoints');
  
  try {
    // Test API stats
    const apiResponse = await axios.get(`${SERVER_URL}/api/visualfx/stats`);
    if (apiResponse.data.success) {
      console.log('✅ Stats API: Retrieved successfully');
      console.log('📊 Current stats:', JSON.stringify(apiResponse.data.stats, null, 2));
      testResults.apiTests.push({ test: 'get-stats', success: true });
    } else {
      throw new Error('Stats API failed');
    }
    
    // Test Socket stats
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error('❌ Socket Stats: Timeout');
        testResults.socketTests.push({ test: 'get-stats', success: false, error: 'timeout' });
        resolve();
      }, 5000);
      
      const handler = (data) => {
        clearTimeout(timeout);
        console.log('✅ Stats Socket: Retrieved successfully');
        testResults.socketTests.push({ test: 'get-stats', success: true });
        socket.off('visual-fx-stats', handler);
        resolve();
      };
      
      socket.on('visual-fx-stats', handler);
      socket.emit('get-visual-fx-stats');
    });
    
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message;
    console.error('❌ Stats Test: Failed:', errorMsg);
    testResults.apiTests.push({ test: 'get-stats', success: false, error: errorMsg });
  }
}

// Test multiple effects simultaneously
async function testMultipleEffects() {
  console.log('\n🧪 Testing: Multiple Effects Stress Test');
  
  const promises = [];
  const effectsToTest = TEST_EFFECTS.slice(0, 5); // Test first 5 effects
  
  for (let i = 0; i < effectsToTest.length; i++) {
    const effectId = effectsToTest[i];
    
    // Stagger the applications
    const promise = new Promise(resolve => {
      setTimeout(async () => {
        try {
          const response = await axios.post(`${SERVER_URL}/api/visualfx/apply`, {
            effectId: effectId,
            options: {
              duration: 15000,
              stressTest: true
            }
          });
          
          if (response.data.success) {
            console.log(`✅ Stress Test: Applied ${effectId}`);
            resolve({ success: true, effectId });
          } else {
            throw new Error(response.data.error);
          }
        } catch (error) {
          console.error(`❌ Stress Test: Failed to apply ${effectId}:`, error.message);
          resolve({ success: false, effectId, error: error.message });
        }
      }, i * 1000); // 1 second between each effect
    });
    
    promises.push(promise);
  }
  
  const results = await Promise.all(promises);
  const successful = results.filter(r => r.success).length;
  
  console.log(`📊 Stress Test: ${successful}/${effectsToTest.length} effects applied successfully`);
  testResults.apiTests.push({ 
    test: 'stress-test', 
    success: successful > 0, 
    applied: successful, 
    total: effectsToTest.length 
  });
}

// Print test results summary
function printTestResults() {
  const apiSuccessful = testResults.apiTests.filter(t => t.success).length;
  const socketSuccessful = testResults.socketTests.filter(t => t.success).length;
  const totalErrors = testResults.errors.length;
  
  console.log(`\n📈 Test Summary:`);
  console.log(`   API Tests: ${apiSuccessful}/${testResults.apiTests.length} passed`);
  console.log(`   Socket Tests: ${socketSuccessful}/${testResults.socketTests.length} passed`);
  console.log(`   Effects Applied: ${testResults.totalEffectsApplied}`);
  console.log(`   Effects Removed: ${testResults.totalEffectsRemoved}`);
  console.log(`   Total Errors: ${totalErrors}`);
  
  if (testResults.errors.length > 0) {
    console.log('\n❌ Error Details:');
    testResults.errors.forEach(error => {
      console.log(`   ${error.type}: ${error.error}`);
    });
  }
  
  if (testResults.apiTests.length > 0) {
    console.log('\n🔧 API Test Details:');
    testResults.apiTests.forEach(test => {
      const status = test.success ? '✅' : '❌';
      console.log(`   ${status} ${test.test}: ${test.success ? 'PASSED' : test.error}`);
    });
  }
  
  if (testResults.socketTests.length > 0) {
    console.log('\n🔌 Socket Test Details:');
    testResults.socketTests.forEach(test => {
      const status = test.success ? '✅' : '❌';
      console.log(`   ${status} ${test.test}: ${test.success ? 'PASSED' : test.error}`);
    });
  }
  
  const overallSuccess = (apiSuccessful + socketSuccessful) >= (testResults.apiTests.length + testResults.socketTests.length) * 0.8;
  
  console.log(`\n🎯 Overall Result: ${overallSuccess ? '✅ PASSED' : '❌ FAILED'}`);
  
  if (!overallSuccess) {
    console.log('\n⚠️  Some tests failed. Check the logs above for details.');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 VISUALFX TEST: Shutting down...');
  socket.disconnect();
  printTestResults();
  process.exit(0);
});

// Start the test if run directly
if (require.main === module) {
  console.log('🎬 VISUALFX TEST: Use this script to test the Visual Effects service');
  console.log('📝 Make sure the server is running and there is an active stream');
  console.log('⚡ Starting test in 3 seconds...\n');
  
  setTimeout(() => {
    // Tests will start when socket connects
  }, 3000);
}