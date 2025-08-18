// Test the transcription admin panel integration
const fs = require('fs');
const path = require('path');

async function testAdminTranscription() {
    console.log('🧪 TESTING TRANSCRIPTION ADMIN PANEL INTEGRATION');
    console.log('=' .repeat(80));
    
    const SERVER_URL = 'http://localhost:8080';
    const ADMIN_KEY = 'supersecretadminkey'; // Replace with your actual admin key
    
    try {
        // 1. Test getting current status
        console.log('\n1. GETTING TRANSCRIPTION STATUS');
        console.log('-'.repeat(40));
        
        const statusResponse = await fetch(`${SERVER_URL}/admin/transcription/status`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (statusResponse.ok) {
            const status = await statusResponse.json();
            console.log('✅ Status retrieved:');
            console.log(`   Enabled: ${status.status.enabled}`);
            console.log(`   Auto-start: ${status.status.autoStart}`);
            console.log(`   Model: ${status.status.model}`);
            console.log(`   Language: ${status.status.language}`);
            console.log(`   Chunk duration: ${status.status.chunkDuration}ms`);
            console.log(`   Buffer duration: ${status.status.bufferDuration}s`);
            console.log(`   Active sessions: ${status.status.activeCount}`);
        } else {
            console.log('❌ Failed to get status:', statusResponse.status);
        }
        
        // 2. Test updating configuration
        console.log('\n2. UPDATING CONFIGURATION');
        console.log('-'.repeat(40));
        
        const configUpdate = {
            enable: true,
            autoStart: false,
            model: 'base',
            language: 'en',
            chunkDuration: 5000,
            bufferDuration: 60
        };
        
        const configResponse = await fetch(`${SERVER_URL}/admin/transcription/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_KEY
            },
            body: JSON.stringify(configUpdate)
        });
        
        if (configResponse.ok) {
            const result = await configResponse.json();
            console.log('✅ Configuration updated successfully');
            console.log('   New config:', result.config);
        } else {
            console.log('❌ Failed to update config:', configResponse.status);
        }
        
        // 3. Check if there's an active stream to test with
        console.log('\n3. CHECKING FOR ACTIVE STREAM');
        console.log('-'.repeat(40));
        
        const streamResponse = await fetch(`${SERVER_URL}/api/stream/active`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (streamResponse.ok) {
            const streamData = await streamResponse.json();
            console.log(`Stream active: ${streamData.isActive}`);
            
            if (streamData.isActive) {
                console.log(`Streamer ID: ${streamData.streamerId}`);
                
                // 4. Test starting transcription
                console.log('\n4. STARTING TRANSCRIPTION');
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
                
                if (startResponse.ok) {
                    const startResult = await startResponse.json();
                    if (startResult.success) {
                        console.log('✅ Transcription started successfully');
                        console.log(`   Session ID: ${startResult.sessionId}`);
                        console.log(`   Start time: ${startResult.startTime}`);
                        
                        // Wait a bit for some transcription to happen
                        console.log('\n⏳ Waiting 15 seconds for transcription...');
                        await new Promise(resolve => setTimeout(resolve, 15000));
                        
                        // 5. Check active transcriptions
                        console.log('\n5. CHECKING ACTIVE TRANSCRIPTIONS');
                        console.log('-'.repeat(40));
                        
                        const activeResponse = await fetch(`${SERVER_URL}/api/transcriptions/active`, {
                            headers: {
                                'x-admin-key': ADMIN_KEY
                            }
                        });
                        
                        if (activeResponse.ok) {
                            const activeData = await activeResponse.json();
                            console.log(`Active transcriptions: ${activeData.transcriptions.length}`);
                            activeData.transcriptions.forEach(session => {
                                console.log(`   - ${session.id}: ${session.wordCount} words, ${session.chunkCount} chunks`);
                            });
                        }
                        
                        // 6. Stop transcription
                        console.log('\n6. STOPPING TRANSCRIPTION');
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
                            console.log(`   Duration: ${stopResult.duration}ms`);
                            console.log(`   Word count: ${stopResult.wordCount}`);
                        }
                    } else {
                        console.log('❌ Failed to start transcription:', startResult.error);
                    }
                } else {
                    console.log('❌ Failed to start transcription:', startResponse.status);
                }
            } else {
                console.log('⚠️ No active stream - start a stream to test transcription');
            }
        } else {
            console.log('❌ Failed to check stream status');
        }
        
        // 7. Test getting transcription history
        console.log('\n7. GETTING TRANSCRIPTION HISTORY');
        console.log('-'.repeat(40));
        
        const historyResponse = await fetch(`${SERVER_URL}/api/transcriptions/history?limit=5`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (historyResponse.ok) {
            const historyData = await historyResponse.json();
            console.log(`Total transcriptions: ${historyData.total}`);
            console.log('Recent transcriptions:');
            historyData.transcriptions.forEach(trans => {
                console.log(`   - ${trans.id.substring(0, 8)}... | ${trans.word_count} words | ${trans.status}`);
            });
        } else {
            console.log('❌ Failed to get history');
        }
        
        // 8. Test disabling transcription
        console.log('\n8. DISABLING TRANSCRIPTION SYSTEM');
        console.log('-'.repeat(40));
        
        const disableResponse = await fetch(`${SERVER_URL}/admin/transcription/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-key': ADMIN_KEY
            },
            body: JSON.stringify({ enable: false })
        });
        
        if (disableResponse.ok) {
            console.log('✅ Transcription system disabled');
        } else {
            console.log('❌ Failed to disable system');
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('✅ ADMIN PANEL INTEGRATION TEST COMPLETE');
        console.log('='.repeat(80));
        console.log('\nNOTE: To fully test the admin panel:');
        console.log('1. Start the server: npm start');
        console.log('2. Open the admin panel: http://localhost:3000/admin');
        console.log('3. Navigate to the Transcription Management section');
        console.log('4. Start a stream (or test stream)');
        console.log('5. Toggle transcription on/off and observe real-time updates');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

// Run the test
testAdminTranscription().catch(console.error);