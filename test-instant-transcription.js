// Test the instant transcription feature
const fs = require('fs');
const path = require('path');

async function testInstantTranscription() {
    console.log('⚡ TESTING INSTANT TRANSCRIPTION FEATURE');
    console.log('=' .repeat(80));
    
    const SERVER_URL = 'http://localhost:8080';
    const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';
    
    try {
        // 1. Check for active stream
        console.log('\n1. CHECKING FOR ACTIVE STREAM');
        console.log('-'.repeat(40));
        
        const streamResponse = await fetch(`${SERVER_URL}/api/stream/active`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (!streamResponse.ok) {
            console.log('❌ Cannot check stream status');
            return;
        }
        
        const streamData = await streamResponse.json();
        
        if (!streamData.isActive) {
            console.log('⚠️ No active stream found');
            console.log('\nTo test instant transcription:');
            console.log('1. Start a stream with audio');
            console.log('2. Run this test again');
            return;
        }
        
        console.log(`✅ Active stream found: ${streamData.streamerId}`);
        
        // 2. Test instant transcription with different durations
        const testDurations = [10, 30, 60];
        
        for (const duration of testDurations) {
            console.log(`\n2. TESTING INSTANT TRANSCRIPTION (${duration} seconds)`);
            console.log('-'.repeat(40));
            
            console.log(`⏳ Requesting instant transcription for ${duration} seconds...`);
            
            const startTime = Date.now();
            
            const response = await fetch(`${SERVER_URL}/admin/transcription/instant`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-key': ADMIN_KEY
                },
                body: JSON.stringify({
                    streamerId: streamData.streamerId,
                    duration: duration
                })
            });
            
            const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
            
            if (!response.ok) {
                const error = await response.text();
                console.log(`❌ Request failed: ${error}`);
                continue;
            }
            
            const result = await response.json();
            
            if (!result.success) {
                console.log(`❌ Transcription failed: ${result.error}`);
                continue;
            }
            
            console.log(`✅ Instant transcription completed in ${processingTime}s`);
            console.log(`   Duration: ${result.duration}s`);
            console.log(`   Words: ${result.wordCount}`);
            
            if (result.transcription) {
                console.log(`   Transcription preview: "${result.transcription.substring(0, 100)}${result.transcription.length > 100 ? '...' : ''}"`);
                
                // Save transcription to file for review
                const outputFile = path.join(__dirname, 'temp', `instant_transcription_${duration}s_${Date.now()}.txt`);
                const tempDir = path.dirname(outputFile);
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                fs.writeFileSync(outputFile, result.transcription);
                console.log(`   Saved to: ${outputFile}`);
            } else {
                console.log('   ⚠️ No transcription text returned');
            }
            
            // Wait a bit between tests
            if (duration !== testDurations[testDurations.length - 1]) {
                console.log('\n⏳ Waiting 5 seconds before next test...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        // 3. Test rapid instant transcription (stress test)
        console.log('\n3. RAPID INSTANT TRANSCRIPTION TEST');
        console.log('-'.repeat(40));
        console.log('Testing multiple rapid requests...');
        
        const rapidResults = [];
        for (let i = 0; i < 3; i++) {
            console.log(`   Request ${i + 1}/3...`);
            
            const response = await fetch(`${SERVER_URL}/admin/transcription/instant`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-admin-key': ADMIN_KEY
                },
                body: JSON.stringify({
                    streamerId: streamData.streamerId,
                    duration: 5  // Short duration for rapid test
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                rapidResults.push(result.success);
            } else {
                rapidResults.push(false);
            }
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        const successCount = rapidResults.filter(r => r).length;
        console.log(`   Results: ${successCount}/3 successful`);
        
        // 4. Analysis
        console.log('\n4. ANALYSIS');
        console.log('-'.repeat(40));
        console.log('✅ Instant transcription feature is working if:');
        console.log('   - Requests complete within reasonable time');
        console.log('   - Transcriptions contain actual words (not empty or "you")');
        console.log('   - Multiple requests can be handled');
        console.log('\n❌ Issues to check if not working:');
        console.log('   - Stream has actual audio (not muted)');
        console.log('   - FFmpeg is properly capturing audio');
        console.log('   - Whisper model is loaded correctly');
        
    } catch (error) {
        console.error('❌ Test error:', error);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('INSTANT TRANSCRIPTION TEST COMPLETE');
    console.log('=' .repeat(80));
}

// Run test
console.log('Starting instant transcription test...');
console.log('Requirements:');
console.log('1. Server must be running (npm start)');
console.log('2. An active stream with audio must be running');
console.log('3. Admin key must be correct (currently: ***REMOVED-ADMIN-KEY***)\n');

testInstantTranscription().catch(console.error);