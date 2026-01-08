// Test the fixed transcription system
const fs = require('fs');
const path = require('path');

async function testFixedTranscription() {
    console.log('🔧 TESTING FIXED TRANSCRIPTION SYSTEM');
    console.log('=' .repeat(80));
    
    const SERVER_URL = 'http://localhost:8080';
    const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';
    
    try {
        // 1. Enable transcription system
        console.log('\n1. ENABLING TRANSCRIPTION SYSTEM');
        console.log('-'.repeat(40));
        
        const enableResponse = await fetch(`${SERVER_URL}/admin/transcription/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_KEY
            },
            body: JSON.stringify({
                enable: true,
                autoStart: false,
                model: 'base',
                language: 'en',
                chunkDuration: 5000,
                bufferDuration: 60
            })
        });
        
        if (enableResponse.ok) {
            console.log('✅ Transcription system enabled');
        } else {
            console.log('❌ Failed to enable transcription');
        }
        
        // 2. Check for active stream
        console.log('\n2. CHECKING FOR ACTIVE STREAM');
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
            console.log('\nTo test transcription:');
            console.log('1. Start a stream (or test stream)');
            console.log('2. Run this test again');
            return;
        }
        
        console.log(`✅ Active stream found: ${streamData.streamerId}`);
        
        // 3. Start transcription
        console.log('\n3. STARTING TRANSCRIPTION');
        console.log('-'.repeat(40));
        
        const startResponse = await fetch(`${SERVER_URL}/admin/transcription/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_KEY
            },
            body: JSON.stringify({
                streamerId: streamData.streamerId,
                options: {
                    model: 'base',
                    language: 'en'
                }
            })
        });
        
        if (!startResponse.ok) {
            const error = await startResponse.text();
            console.log('❌ Failed to start transcription:', error);
            return;
        }
        
        const startResult = await startResponse.json();
        
        if (!startResult.success) {
            console.log('❌ Transcription start failed:', startResult.error);
            return;
        }
        
        console.log('✅ Transcription started');
        console.log(`   Session ID: ${startResult.sessionId}`);
        
        // 4. Monitor transcription progress
        console.log('\n4. MONITORING TRANSCRIPTION (30 seconds)');
        console.log('-'.repeat(40));
        
        let checkCount = 0;
        const maxChecks = 6; // Check every 5 seconds for 30 seconds
        
        const monitorInterval = setInterval(async () => {
            checkCount++;
            
            // Get current status
            const statusResponse = await fetch(`${SERVER_URL}/admin/transcription/status`, {
                headers: {
                    'x-admin-key': ADMIN_KEY
                }
            });
            
            if (statusResponse.ok) {
                const status = await statusResponse.json();
                const activeSession = status.status.activeSessions.find(s => s.id === startResult.sessionId);
                
                if (activeSession) {
                    console.log(`\n📊 Check ${checkCount}/${maxChecks}:`);
                    console.log(`   Words: ${activeSession.wordCount}`);
                    console.log(`   Chunks: ${activeSession.chunkCount}`);
                    console.log(`   Status: ${activeSession.status}`);
                    
                    if (activeSession.bufferStatus) {
                        console.log(`   Buffer: ${activeSession.bufferStatus.duration}s, ${(activeSession.bufferStatus.size / 1024).toFixed(2)}KB`);
                        
                        // Check if buffer is growing
                        if (activeSession.bufferStatus.size > 0 && activeSession.wordCount === 0) {
                            console.log('   ⚠️ Buffer growing but no words - checking audio content...');
                            
                            // Check if there are WAV files to analyze
                            const bufferFile = path.join(__dirname, 'audio-buffers', `${startResult.sessionId}.wav`);
                            if (fs.existsSync(bufferFile)) {
                                const stats = fs.statSync(bufferFile);
                                console.log(`   Buffer file exists: ${(stats.size / 1024).toFixed(2)}KB`);
                                
                                // Extract and test a sample
                                if (stats.size > 100000) { // If > 100KB
                                    console.log('   Testing buffer audio with Whisper...');
                                    await testBufferAudio(bufferFile);
                                }
                            }
                        }
                    }
                    
                    if (activeSession.wordCount > 0) {
                        console.log('   ✅ Transcription is working! Words are being captured.');
                    }
                } else {
                    console.log(`\n⚠️ Session ${startResult.sessionId} not found in active sessions`);
                }
            }
            
            if (checkCount >= maxChecks) {
                clearInterval(monitorInterval);
                
                // 5. Stop transcription
                console.log('\n5. STOPPING TRANSCRIPTION');
                console.log('-'.repeat(40));
                
                const stopResponse = await fetch(`${SERVER_URL}/admin/transcription/stop/${startResult.sessionId}`, {
                    method: 'POST',
                    headers: {
                        'x-admin-key': ADMIN_KEY
                    }
                });
                
                if (stopResponse.ok) {
                    const stopResult = await stopResponse.json();
                    console.log('✅ Transcription stopped');
                    console.log(`   Total duration: ${(stopResult.duration / 1000).toFixed(1)}s`);
                    console.log(`   Total words: ${stopResult.wordCount}`);
                    
                    // Analyze results
                    console.log('\n6. ANALYSIS');
                    console.log('-'.repeat(40));
                    
                    if (stopResult.wordCount === 0) {
                        console.log('❌ NO WORDS TRANSCRIBED - Issues detected:');
                        console.log('   1. Audio may be silence or very low volume');
                        console.log('   2. FFmpeg may not be receiving RTP packets');
                        console.log('   3. MediaSoup transport may not be properly connected');
                        console.log('\nRecommendations:');
                        console.log('   - Check if the stream has actual audio (not muted)');
                        console.log('   - Verify FFmpeg is running: tasklist | findstr ffmpeg');
                        console.log('   - Check server logs for MediaSoup transport errors');
                        console.log('   - Test with a known good audio source');
                    } else {
                        console.log('✅ TRANSCRIPTION SUCCESSFUL!');
                        console.log(`   Captured ${stopResult.wordCount} words in ${(stopResult.duration / 1000).toFixed(1)} seconds`);
                        console.log(`   Average: ${(stopResult.wordCount / (stopResult.duration / 60000)).toFixed(1)} words per minute`);
                    }
                } else {
                    console.log('❌ Failed to stop transcription');
                }
                
                console.log('\n' + '='.repeat(80));
                console.log('TEST COMPLETE');
            }
        }, 5000);
        
    } catch (error) {
        console.error('❌ Test error:', error);
    }
}

async function testBufferAudio(bufferFile) {
    const { spawn } = require('child_process');
    
    // Extract last 5 seconds for testing
    const testOutput = path.join(__dirname, 'temp', 'buffer_test.wav');
    
    // Ensure temp dir exists
    const tempDir = path.dirname(testOutput);
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    return new Promise((resolve) => {
        const ffmpegArgs = [
            '-i', bufferFile,
            '-ss', '0',
            '-t', '5',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            '-y',
            testOutput
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', async (code) => {
            if (code === 0 && fs.existsSync(testOutput)) {
                // Test with Whisper
                const whisperExe = path.join(__dirname, 'whisper', 'Release', 'whisper-cli.exe');
                const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-base.bin');
                
                if (fs.existsSync(whisperExe) && fs.existsSync(modelPath)) {
                    const whisperProcess = spawn(whisperExe, [
                        '-m', modelPath,
                        '-f', testOutput,
                        '--no-timestamps',
                        '-otxt'
                    ]);
                    
                    whisperProcess.on('close', (whisperCode) => {
                        if (whisperCode === 0) {
                            const txtPath = testOutput + '.txt';
                            if (fs.existsSync(txtPath)) {
                                const text = fs.readFileSync(txtPath, 'utf8').trim();
                                if (text && text !== 'you' && text !== '') {
                                    console.log(`      Buffer contains speech: "${text.substring(0, 50)}..."`);
                                } else {
                                    console.log(`      Buffer contains silence or noise (Whisper returned: "${text}")`);
                                }
                                fs.unlinkSync(txtPath);
                            }
                        }
                        
                        // Cleanup
                        if (fs.existsSync(testOutput)) {
                            fs.unlinkSync(testOutput);
                        }
                        resolve();
                    });
                } else {
                    resolve();
                }
            } else {
                resolve();
            }
        });
    });
}

// Run test
console.log('Starting transcription test...');
console.log('Make sure:');
console.log('1. Server is running (npm start)');
console.log('2. A stream is active (or start a test stream)');
console.log('3. The stream has audio (not muted)\n');

testFixedTranscription().catch(console.error);