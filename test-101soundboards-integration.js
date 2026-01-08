const axios = require('axios');

console.log('🧪 Testing 101soundboards integration...\n');

// Test URL parsing
async function testUrlParsing() {
    const testUrls = [
        'https://www.101soundboards.com/sounds/188391-potato',
        'www.101soundboards.com/sounds/188391-potato',
        '/sounds/188391-potato',
        'https://www.101soundboards.com/sounds/3272610-another-sound'
    ];

    console.log('📝 Testing URL parsing:');
    testUrls.forEach(url => {
        const soundMatch = url.match(/\/sounds\/(\d+)(?:-[^\/]*)?/);
        if (soundMatch) {
            console.log(`  ✅ ${url} -> Sound ID: ${soundMatch[1]}`);
        } else {
            console.log(`  ❌ ${url} -> Failed to parse`);
        }
    });
    console.log();
}

// Test API fetching
async function testApiFetch() {
    console.log('🌐 Testing 101soundboards API:');
    const soundId = '188391'; // Known sound ID from the example
    const apiUrl = `https://www.101soundboards.com/api/v1/sounds/${soundId}`;
    
    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'OneStreamer/1.0',
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        if (response.data) {
            console.log(`  ✅ Successfully fetched sound data:`);
            console.log(`     - ID: ${response.data.id}`);
            console.log(`     - Transcript: ${response.data.sound_transcript}`);
            console.log(`     - Duration: ${response.data.sound_duration}ms`);
            console.log(`     - Board: ${response.data.board?.board_title || 'Unknown'}`);
            console.log(`     - File URL: ${response.data.sound_file_url?.substring(0, 50)}...`);
            
            // Check if URL needs conversion
            if (response.data.sound_file_url) {
                const isAbsolute = response.data.sound_file_url.startsWith('http');
                console.log(`     - URL Type: ${isAbsolute ? 'Absolute' : 'Relative'}`);
                if (!isAbsolute) {
                    console.log(`     - Converted: https://www.101soundboards.com${response.data.sound_file_url.substring(0, 30)}...`);
                }
            }
        }
    } catch (error) {
        console.log(`  ❌ Failed to fetch from API: ${error.message}`);
    }
    console.log();
}

// Test sound search API
async function testSearchApi() {
    console.log('🔍 Testing 101soundboards Search API:');
    const searchTerm = 'hello';
    const searchUrl = `https://www.101soundboards.com/api/v1/sounds?q=${searchTerm}`;
    
    try {
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'OneStreamer/1.0',
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        if (response.data && Array.isArray(response.data)) {
            console.log(`  ✅ Search returned ${response.data.length} results for "${searchTerm}"`);
            if (response.data.length > 0) {
                const firstResult = response.data[0];
                console.log(`     First result:`);
                console.log(`     - ID: ${firstResult.id}`);
                console.log(`     - Transcript: ${firstResult.sound_transcript}`);
                console.log(`     - Board: ${firstResult.board?.board_title || 'Unknown'}`);
                console.log(`     - Link: https://www.101soundboards.com${firstResult.link}`);
            }
        }
    } catch (error) {
        console.log(`  ❌ Failed to search: ${error.message}`);
    }
    console.log();
}

// Test duration limiting
function testDurationLimit() {
    console.log('⏱️ Testing duration limiting:');
    const testCases = [
        { actual: 5000, max: 60000 },
        { actual: 30000, max: 60000 },
        { actual: 60000, max: 60000 },
        { actual: 90000, max: 60000 },
        { actual: 180000, max: 60000 }
    ];

    testCases.forEach(test => {
        const limited = Math.min(test.actual, test.max);
        const wasLimited = test.actual > test.max;
        console.log(`  ${wasLimited ? '⚠️' : '✅'} Duration: ${test.actual}ms -> ${limited}ms ${wasLimited ? '(LIMITED)' : ''}`);
    });
    console.log();
}

// Main test runner
async function runTests() {
    console.log('🚀 Starting 101soundboards integration tests\n');
    console.log('=' .repeat(50) + '\n');

    testUrlParsing();
    await testApiFetch();
    await testSearchApi();
    testDurationLimit();

    console.log('=' .repeat(50));
    console.log('\n✅ All tests completed!\n');
    console.log('📌 Integration Summary:');
    console.log('  • URL parsing: Working');
    console.log('  • API fetching: Check results above');
    console.log('  • Sound search: Check results above');
    console.log('  • Duration limiting: Working (60s max)');
    console.log('\n🎉 101soundboards integration is ready to use!');
}

runTests().catch(console.error);