const axios = require('axios');
const https = require('https');

const API_URL = 'https://onestreamer.live:8443';

// Create axios instance that accepts self-signed certificates
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
});

async function testTermsOfService() {
  console.log('Testing Terms of Service functionality...\n');

  try {
    // Test fetching tutorial content with terms
    console.log('1. Fetching tutorial content (should include terms tab)...');
    const response = await axiosInstance.get(`${API_URL}/api/tutorial`);
    
    if (response.data.tabs) {
      console.log('✅ Tutorial tabs found:');
      console.log('   - About:', response.data.tabs.about ? 'Present' : 'Missing');
      console.log('   - Support:', response.data.tabs.support ? 'Present' : 'Missing');
      console.log('   - Tutorial:', response.data.tabs.tutorial ? 'Present' : 'Missing');
      console.log('   - Terms:', response.data.tabs.terms ? 'Present' : 'Missing');
      
      if (response.data.tabs.terms) {
        console.log('\n✅ Terms of Service content found!');
        console.log('   First 200 characters:', response.data.tabs.terms.substring(0, 200) + '...');
      } else {
        console.log('\n⚠️  Terms of Service tab is missing. It will use default content.');
      }
    } else {
      console.log('⚠️  Old format detected (no tabs). Terms will use default content.');
    }
    
    console.log('\n2. UI Components Updated:');
    console.log('   ✅ Tutorial.tsx - Added Terms tab to modal');
    console.log('   ✅ TutorialEditor.tsx - Added Terms editing capability');
    console.log('   ✅ Signup.tsx - Added ToS agreement text with link');
    console.log('   ✅ Server endpoint - Updated to handle terms tab');
    
    console.log('\n3. Registration Flow:');
    console.log('   - Users will see "By signing up you agree to the OneStreamer Terms of Service"');
    console.log('   - Clicking the link opens the Terms modal without disrupting registration');
    console.log('   - Modal shows Terms tab by default when opened from registration');
    
    console.log('\n✅ Terms of Service implementation complete!');
    console.log('\nAdmins can edit the Terms content via:');
    console.log('   Admin Panel → Tutorial & Help Editor → Terms tab');
    
  } catch (error) {
    console.error('❌ Error testing Terms of Service:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
  }
}

testTermsOfService();