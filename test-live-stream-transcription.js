// Test transcription with a simulated live stream
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function testLiveStreamTranscription() {
    console.log('🎬 LIVE STREAM TRANSCRIPTION TEST');
    console.log('=' .repeat(80));
    
    try {
        // Check if there's an existing recording we can use
        const recordingPath = path.join(__dirname, 'recordings', 'completed', 
            'recording_gRmmYvYncp22CAQ3AAAT_2025-08-10T20-23-00_720p.webm');
        
        if (!fs.existsSync(recordingPath)) {
            console.log('⚠️ No existing recording found to test with');
            console.log('Creating a test audio stream instead...\n');
            
            // Create a longer test audio file that simulates speech
            const testAudio = await createSpeechLikeAudio();
            await testWithAudioFile(testAudio);
            
            // Cleanup
            if (fs.existsSync(testAudio)) {
                fs.unlinkSync(testAudio);
            }
        } else {
            console.log('✅ Found existing recording to test with:', recordingPath);
            console.log('\nExtracting and testing audio from recording...\n');
            
            // Extract audio from the recording
            const extractedAudio = await extractAudioFromRecording(recordingPath);
            if (extractedAudio.success) {
                await testWithAudioFile(extractedAudio.audioPath);
                
                // Cleanup
                if (fs.existsSync(extractedAudio.audioPath)) {
                    fs.unlinkSync(extractedAudio.audioPath);
                }
            }
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('✅ LIVE STREAM TRANSCRIPTION TEST COMPLETE');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

async function testWithAudioFile(audioPath) {
    console.log('TESTING AUDIO BUFFER AND TRANSCRIPTION');
    console.log('-'.repeat(40));
    
    const AudioBufferService = require('./server/services/AudioBufferService');
    const audioBuffer = new AudioBufferService();
    
    // Simulate buffering the audio file
    const sessionId = 'live-test-' + Date.now();
    const bufferPath = path.join(__dirname, 'audio-buffers', `${sessionId}.wav`);
    
    // Ensure directory exists
    const bufferDir = path.dirname(bufferPath);
    if (!fs.existsSync(bufferDir)) {
        fs.mkdirSync(bufferDir, { recursive: true });
    }
    
    // Copy audio to buffer location
    fs.copyFileSync(audioPath, bufferPath);
    const audioStats = fs.statSync(bufferPath);
    const audioDuration = Math.floor((audioStats.size - 44) / (16000 * 2)); // Calculate duration
    
    console.log(`📊 Audio buffer stats:`);
    console.log(`   Size: ${(audioStats.size / 1024).toFixed(2)}KB`);
    console.log(`   Duration: ~${audioDuration}s`);
    
    // Manually create session for testing
    audioBuffer.sessions.set(sessionId, {
        id: sessionId,
        startTime: new Date(),
        bufferFile: bufferPath,
        bytesWritten: audioStats.size,
        isActive: true,
        extractionCount: 0
    });
    
    // Test extracting different segments
    console.log('\nTESTING ROLLING 30-SECOND EXTRACTION');
    console.log('-'.repeat(40));
    
    const segments = [];
    const segmentDuration = Math.min(30, audioDuration - 1); // Extract up to 30 seconds
    
    for (let i = 0; i < 3; i++) {
        console.log(`\n📍 Extraction ${i + 1}:`);
        
        const extractResult = await audioBuffer.extractLastNSeconds(sessionId, segmentDuration);
        
        if (extractResult.success) {
            console.log(`   ✅ Extracted ${extractResult.duration.toFixed(1)}s (${(extractResult.size / 1024).toFixed(2)}KB)`);
            
            // Test transcription
            const transcription = await transcribeAudio(extractResult.audioPath);
            
            if (transcription.success) {
                console.log(`   📝 Transcription: "${transcription.text.substring(0, 100)}${transcription.text.length > 100 ? '...' : ''}"`);
                segments.push({
                    index: i,
                    duration: extractResult.duration,
                    transcription: transcription.text
                });
            } else {
                console.log(`   ❌ Transcription failed: ${transcription.error}`);
            }
            
            // Cleanup extraction
            if (fs.existsSync(extractResult.audioPath)) {
                fs.unlinkSync(extractResult.audioPath);
            }
            
            // Simulate time passing
            await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
            console.log(`   ❌ Extraction failed: ${extractResult.error}`);
        }
    }
    
    // Analyze results
    console.log('\nTRANSCRIPTION ANALYSIS');
    console.log('-'.repeat(40));
    
    const validSegments = segments.filter(s => 
        s.transcription && 
        s.transcription.trim() !== '' && 
        s.transcription.trim() !== 'you'
    );
    
    console.log(`Total segments: ${segments.length}`);
    console.log(`Valid transcriptions: ${validSegments.length}`);
    
    if (validSegments.length > 0) {
        console.log('\nSample transcriptions:');
        validSegments.forEach((seg, idx) => {
            console.log(`  ${idx + 1}. "${seg.transcription.substring(0, 80)}..."`);
        });
    }
    
    // Check for common issues
    const hasYouHallucination = segments.some(s => s.transcription === 'you');
    const hasEmptyTranscriptions = segments.some(s => !s.transcription || s.transcription.trim() === '');
    
    if (hasYouHallucination) {
        console.log('\n⚠️ Warning: Some segments returned "you" hallucination');
    }
    if (hasEmptyTranscriptions) {
        console.log('⚠️ Warning: Some segments returned empty transcriptions');
    }
    
    if (validSegments.length === segments.length) {
        console.log('\n✅ All segments transcribed successfully!');
    }
    
    // Cleanup
    audioBuffer.stopBuffering(sessionId);
    if (fs.existsSync(bufferPath)) {
        fs.unlinkSync(bufferPath);
    }
}

async function createSpeechLikeAudio() {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(__dirname, 'temp', 'speech_like_audio.wav');
        
        // Ensure temp directory exists
        const tempDir = path.dirname(outputPath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Create varied frequency audio that might simulate speech patterns
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'anoisesrc=d=35:c=pink:r=16000:a=0.5',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            '-y',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`✅ Created test audio: ${outputPath}`);
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function extractAudioFromRecording(recordingPath) {
    return new Promise((resolve) => {
        const outputPath = path.join(__dirname, 'temp', 'extracted_stream_audio.wav');
        
        // Ensure temp directory exists
        const tempDir = path.dirname(outputPath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const ffmpegArgs = [
            '-i', recordingPath,
            '-vn', // No video
            '-ar', '16000', // Whisper sample rate
            '-ac', '1', // Mono
            '-f', 'wav',
            '-y',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                const stats = fs.statSync(outputPath);
                console.log(`✅ Extracted ${(stats.size / 1024).toFixed(2)}KB audio from recording`);
                resolve({ success: true, audioPath: outputPath });
            } else {
                resolve({ success: false, error: `FFmpeg failed with code ${code}` });
            }
        });
        
        ffmpeg.on('error', (error) => {
            resolve({ success: false, error: error.message });
        });
    });
}

async function transcribeAudio(audioPath) {
    return new Promise((resolve) => {
        const whisperExe = path.join(__dirname, 'whisper', 'Release', 'whisper-cli.exe');
        const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-base.bin');
        
        if (!fs.existsSync(whisperExe) || !fs.existsSync(modelPath)) {
            resolve({ success: false, error: 'Whisper not installed' });
            return;
        }
        
        const args = [
            '-m', modelPath,
            '-f', audioPath,
            '--no-timestamps',
            '-otxt'
        ];
        
        const whisper = spawn(whisperExe, args);
        
        whisper.on('close', (code) => {
            if (code === 0) {
                const txtPath = audioPath + '.txt';
                if (fs.existsSync(txtPath)) {
                    const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                    fs.unlinkSync(txtPath);
                    resolve({ success: true, text: transcription });
                } else {
                    resolve({ success: false, error: 'No output file' });
                }
            } else {
                resolve({ success: false, error: `Whisper failed with code ${code}` });
            }
        });
        
        whisper.on('error', () => resolve({ success: false, error: 'Process error' }));
    });
}

// Run the test
testLiveStreamTranscription().catch(console.error);