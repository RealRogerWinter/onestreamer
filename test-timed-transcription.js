// Test the timed transcription feature (records NEXT X seconds)
const fs = require('fs');
const path = require('path');

async function testTimedTranscription() {
    console.log('⏱️  TESTING TIMED TRANSCRIPTION FEATURE');
    console.log('=' .repeat(80));
    
    const SERVER_URL = 'http://localhost:8080';
    const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';
    
    try {
        // 1. Check for active stream
        console.log('\n1. CHECKING FOR ACTIVE STREAM');
        console.log('-'.repeat(40));
        
        const streamResponse = await fetch(`${SERVER_URL}/api/stream/active`);
        
        if (!streamResponse.ok) {
            console.log('❌ Cannot check stream status');
            return;
        }
        
        const streamData = await streamResponse.json();
        
        if (!streamData.isActive) {
            console.log('⚠️ No active stream found');
            console.log('\nTo test timed transcription:');
            console.log('1. Start a stream with audio');
            console.log('2. Run this test again');
            return;
        }
        
        console.log(`✅ Active stream found: ${streamData.streamerId}`);
        
        // 2. Test timed transcription
        const testDuration = 10; // Test with 10 seconds
        
        console.log(`\n2. TESTING TIMED TRANSCRIPTION (${testDuration} seconds)`);
        console.log('-'.repeat(40));
        console.log(`⏳ Starting ${testDuration}-second recording...`);
        console.log('   This will record the NEXT 10 seconds of audio');
        
        const startTime = Date.now();
        
        const response = await fetch(`${SERVER_URL}/admin/transcription/timed`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_KEY
            },
            body: JSON.stringify({
                streamerId: streamData.streamerId,
                duration: testDuration,
                options: {
                    model: 'base',
                    language: 'en',
                    chunkDuration: 5000
                }
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            console.log(`❌ Request failed: ${error}`);
            return;
        }
        
        const result = await response.json();
        
        if (!result.success) {
            console.log(`❌ Transcription failed: ${result.error}`);
            return;
        }
        
        console.log(`✅ Transcription started`);
        console.log(`   Session ID: ${result.sessionId}`);
        console.log(`   Start time: ${new Date(result.startTime).toLocaleTimeString()}`);
        
        // 3. Monitor progress
        console.log(`\n3. MONITORING RECORDING PROGRESS`);
        console.log('-'.repeat(40));
        
        let secondsElapsed = 0;
        const progressInterval = setInterval(() => {
            secondsElapsed++;
            const progress = Math.min(100, (secondsElapsed / testDuration) * 100);
            const progressBar = '█'.repeat(Math.floor(progress / 2)) + '░'.repeat(50 - Math.floor(progress / 2));
            process.stdout.write(`\r   Recording: [${progressBar}] ${progress.toFixed(0)}% (${secondsElapsed}/${testDuration}s)`);
        }, 1000);
        
        // Wait for transcription to complete (auto-stop after duration)
        console.log(`\n   Waiting for auto-stop after ${testDuration} seconds...`);
        
        // Poll for completion
        let isComplete = false;
        let pollCount = 0;
        const maxPolls = testDuration + 10; // Give it extra time
        
        while (!isComplete && pollCount < maxPolls) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            pollCount++;
            
            // Check session status
            const statusResponse = await fetch(`${SERVER_URL}/admin/transcription/status`, {
                headers: {
                    'x-admin-key': ADMIN_KEY
                }
            });
            
            if (statusResponse.ok) {
                const statusData = await statusResponse.json();
                const activeSession = statusData.status.activeSessions.find(s => s.id === result.sessionId);
                
                if (!activeSession) {
                    isComplete = true;
                    clearInterval(progressInterval);
                    process.stdout.write('\n');
                    console.log(`✅ Recording completed (auto-stopped after ${testDuration}s)`);
                }
            }
        }
        
        if (!isComplete) {
            clearInterval(progressInterval);
            process.stdout.write('\n');
            console.log(`⚠️ Recording did not auto-stop after ${testDuration}s`);
            
            // Try to stop manually
            console.log('   Attempting manual stop...');
            await fetch(`${SERVER_URL}/admin/transcription/stop/${result.sessionId}`, {
                method: 'POST',
                headers: {
                    'x-admin-key': ADMIN_KEY
                }
            });
        }
        
        // 4. Get transcription results
        console.log(`\n4. FETCHING TRANSCRIPTION RESULTS`);
        console.log('-'.repeat(40));
        
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for processing
        
        const transcriptResponse = await fetch(`${SERVER_URL}/api/transcription/${result.sessionId}`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (transcriptResponse.ok) {
            const transcript = await transcriptResponse.json();
            
            console.log(`✅ Transcription details:`);
            console.log(`   Duration: ${transcript.duration}s`);
            console.log(`   Words: ${transcript.word_count || 0}`);
            console.log(`   Status: ${transcript.status}`);
            
            if (transcript.full_text) {
                console.log(`   Text preview: "${transcript.full_text.substring(0, 100)}${transcript.full_text.length > 100 ? '...' : ''}"`);
                
                // Save to file
                const outputFile = path.join(__dirname, 'temp', `timed_transcription_${testDuration}s_${Date.now()}.txt`);
                const tempDir = path.dirname(outputFile);
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                fs.writeFileSync(outputFile, transcript.full_text);
                console.log(`   Saved to: ${outputFile}`);
            } else {
                console.log('   ⚠️ No transcription text available');
            }
        }
        
        // 5. Analysis
        console.log('\n5. ANALYSIS');
        console.log('-'.repeat(40));
        console.log('✅ Timed transcription is working correctly if:');
        console.log('   - Recording starts immediately after request');
        console.log('   - Recording automatically stops after specified duration');
        console.log('   - Transcription contains words from the recorded period');
        console.log('   - The text reflects audio from AFTER the start time');
        console.log('\n❌ Issues to check if not working:');
        console.log('   - Auto-stop timer not firing (check cleanupSession)');
        console.log('   - Stream has actual audio (not muted)');
        console.log('   - FFmpeg is properly capturing audio');
        
    } catch (error) {
        console.error('❌ Test error:', error);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('TIMED TRANSCRIPTION TEST COMPLETE');
    console.log('=' .repeat(80));
}

// Run test
console.log('Starting timed transcription test...');
console.log('Requirements:');
console.log('1. Server must be running (npm start)');
console.log('2. An active stream with audio must be running');
console.log('3. Admin key must be correct (currently: ***REMOVED-ADMIN-KEY***)\n');

testTimedTranscription().catch(console.error);