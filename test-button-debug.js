/**
 * Debug test for the rotation toggle functionality
 */

const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

async function debugButtonFlow() {
  console.log('🔍 Debugging ViewBot Rotation Toggle Flow\n');
  
  try {
    // Step 1: Check initial health status
    console.log('1. Checking initial health status...');
    const initialHealth = await axios.get(`${SERVER_URL}/admin/viewbot-client/health`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log('Initial rotation state:', {
      rotationEnabled: initialHealth.data.rotationEnabled,
      realStreamerActive: initialHealth.data.realStreamerActive,
      currentLiveBot: initialHealth.data.currentLiveBot
    });

    // Step 2: Toggle rotation to true
    console.log('\n2. Toggling rotation to ENABLED...');
    const toggleResponse1 = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, 
      { enabled: true }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log('Toggle response 1:', toggleResponse1.data);

    // Step 3: Check health status after toggle
    console.log('\n3. Checking health status after toggle...');
    const healthAfterToggle1 = await axios.get(`${SERVER_URL}/admin/viewbot-client/health`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log('Health after toggle to true:', {
      rotationEnabled: healthAfterToggle1.data.rotationEnabled,
      realStreamerActive: healthAfterToggle1.data.realStreamerActive
    });

    // Step 4: Toggle rotation to false
    console.log('\n4. Toggling rotation to DISABLED...');
    const toggleResponse2 = await axios.post(`${SERVER_URL}/admin/viewbot-client/rotation/toggle`, 
      { enabled: false }, 
      { headers: { 'x-admin-key': ADMIN_KEY } }
    );
    console.log('Toggle response 2:', toggleResponse2.data);

    // Step 5: Check final health status
    console.log('\n5. Checking final health status...');
    const finalHealth = await axios.get(`${SERVER_URL}/admin/viewbot-client/health`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    console.log('Final health status:', {
      rotationEnabled: finalHealth.data.rotationEnabled,
      realStreamerActive: finalHealth.data.realStreamerActive
    });

    console.log('\n✅ Debug test completed successfully!');
    console.log('\nNow try clicking the "Enable Rotation" button in the admin panel.');
    console.log('Check the browser console for the debug logs we added.');

  } catch (error) {
    console.error('❌ Debug test failed:', error.response?.data || error.message);
  }
}

debugButtonFlow();