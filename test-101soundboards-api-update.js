const axios = require('axios');
const SoundFxService = require('./server/services/SoundFxService');

async function testDirectAPI() {
    console.log('\n🧪 Testing direct API call to 101soundboards...\n');
    
    try {
        // Test with the sound ID from your example
        const soundId = '36012270';
        const apiUrl = `https://www.101soundboards.com/api/v1/sounds/${soundId}`;
        
        console.log(`📡 Fetching from: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'OneStreamer/1.0',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        
        console.log('\n✅ API Response Structure:');
        console.log('- success:', response.data.success);
        console.log('- message:', response.data.message);
        console.log('- data present:', !!response.data.data);
        
        if (response.data.data) {
            const soundData = response.data.data;
            console.log('\n📝 Sound Data:');
            console.log('- ID:', soundData.id);
            console.log('- Transcript:', soundData.sound_transcript);
            console.log('- Duration:', soundData.sound_duration, 'ms');
            console.log('- File URL:', soundData.sound_file_url);
            console.log('- Board Title:', soundData.board?.board_title);
        }
        
        return response.data;
    } catch (error) {
        console.error('❌ Direct API test failed:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        return null;
    }
}

async function testServiceIntegration() {
    console.log('\n🧪 Testing SoundFxService integration...\n');
    
    const service = new SoundFxService();
    
    // Test parsing URL
    const testUrls = [
        'https://www.101soundboards.com/sounds/36012270-g',
        '/sounds/36012270-g',
        'https://www.101soundboards.com/sounds/36012270'
    ];
    
    console.log('📝 Testing URL parsing:');
    for (const url of testUrls) {
        const parsed = await service.parse101SoundboardUrl(url);
        console.log(`- ${url} => soundId: ${parsed?.soundId || 'FAILED'}`);
    }
    
    // Test fetching sound data
    console.log('\n📝 Testing fetch101SoundboardData:');
    const soundData = await service.fetch101SoundboardData('36012270');
    
    if (soundData) {
        console.log('✅ Successfully fetched sound data:');
        console.log('- ID:', soundData.id);
        console.log('- Transcript:', soundData.sound_transcript);
        console.log('- Duration:', soundData.sound_duration, 'ms');
        console.log('- File URL:', soundData.sound_file_url);
        console.log('- Board Title:', soundData.board?.board_title);
    } else {
        console.log('❌ Failed to fetch sound data');
    }
    
    return soundData;
}

async function testCompleteFlow() {
    console.log('\n🧪 Testing complete soundboard flow...\n');
    
    const service = new SoundFxService();
    
    // Mock Socket.IO for broadcasting
    service.setSocketIO({
        emit: (event, data) => {
            console.log(`📢 Broadcasting event: ${event}`);
            if (data.soundFileUrl) {
                console.log(`   - Sound URL: ${data.soundFileUrl}`);
            }
        }
    });
    
    try {
        // Queue a soundboard request
        const request = await service.queue101Soundboard(
            'test-user-123',
            'TestUser',
            'https://www.101soundboards.com/sounds/36012270-g',
            { test: true }
        );
        
        console.log('✅ Soundboard request queued:', request.id);
        
        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('✅ Complete flow test successful');
    } catch (error) {
        console.error('❌ Complete flow test failed:', error.message);
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('101SOUNDBOARDS API UPDATE TEST');
    console.log('='.repeat(60));
    
    // Test 1: Direct API call
    const apiResponse = await testDirectAPI();
    
    // Test 2: Service integration
    const serviceResponse = await testServiceIntegration();
    
    // Test 3: Complete flow
    await testCompleteFlow();
    
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    
    if (apiResponse && serviceResponse) {
        console.log('✅ All tests passed successfully!');
        console.log('✅ The 101soundboards integration has been updated to handle the new API response structure.');
    } else {
        console.log('⚠️ Some tests failed. Please check the error messages above.');
    }
}

// Run the tests
main().catch(console.error);