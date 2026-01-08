// Comprehensive diagnosis of the transcription issues
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function runDiagnosis() {
    console.log('🔬 DIAGNOSIS: Running comprehensive transcription system diagnosis\n');
    console.log('=' .repeat(80));
    
    const results = {
        whisperStatus: false,
        ffmpegStatus: false,
        recordingCapability: false,
        audioExtraction: false,
        transcriptionResult: false,
        issues: [],
        recommendations: []
    };
    
    // 1. Check Whisper.cpp installation
    console.log('\n1. CHECKING WHISPER.CPP INSTALLATION');
    console.log('-'.repeat(40));
    
    const whisperExe = path.join(__dirname, 'whisper', 'Release', 'whisper-cli.exe');
    const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-base.bin');
    
    if (fs.existsSync(whisperExe)) {
        console.log('✅ Whisper executable found:', whisperExe);
        results.whisperStatus = true;
    } else {
        console.log('❌ Whisper executable NOT found');
        results.issues.push('Whisper.cpp executable missing');
    }
    
    if (fs.existsSync(modelPath)) {
        console.log('✅ Whisper model found:', modelPath);
        const stats = fs.statSync(modelPath);
        console.log(`   Model size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } else {
        console.log('❌ Whisper model NOT found');
        results.issues.push('Whisper model missing');
        results.whisperStatus = false;
    }
    
    // 2. Check FFmpeg availability
    console.log('\n2. CHECKING FFMPEG');
    console.log('-'.repeat(40));
    
    try {
        const ffmpegVersion = await checkFFmpeg();
        console.log('✅ FFmpeg available:', ffmpegVersion);
        results.ffmpegStatus = true;
    } catch (error) {
        console.log('❌ FFmpeg NOT available:', error.message);
        results.issues.push('FFmpeg not available or not in PATH');
    }
    
    // 3. Test audio extraction from recording
    console.log('\n3. TESTING AUDIO EXTRACTION FROM RECORDING');
    console.log('-'.repeat(40));
    
    const recordingPath = path.join(__dirname, 'recordings', 'completed', 'recording_gRmmYvYncp22CAQ3AAAT_2025-08-10T20-23-00_720p.webm');
    
    if (fs.existsSync(recordingPath)) {
        console.log('✅ Found test recording:', recordingPath);
        const extractResult = await extractAudioFromRecording(recordingPath);
        
        if (extractResult.success) {
            console.log('✅ Successfully extracted audio:', extractResult.audioPath);
            console.log(`   Audio size: ${(extractResult.size / 1024).toFixed(2)} KB`);
            results.audioExtraction = true;
            
            // 4. Test transcription on extracted audio
            console.log('\n4. TESTING TRANSCRIPTION ON EXTRACTED AUDIO');
            console.log('-'.repeat(40));
            
            if (results.whisperStatus) {
                const transcription = await transcribeAudio(extractResult.audioPath, whisperExe, modelPath);
                if (transcription) {
                    console.log('✅ Transcription successful:', transcription.substring(0, 100) + '...');
                    results.transcriptionResult = true;
                } else {
                    console.log('❌ Transcription failed or returned empty');
                    results.issues.push('Whisper transcription returned empty result');
                }
            }
            
            // Cleanup
            if (fs.existsSync(extractResult.audioPath)) {
                fs.unlinkSync(extractResult.audioPath);
            }
        } else {
            console.log('❌ Failed to extract audio:', extractResult.error);
            results.issues.push('Cannot extract audio from recording');
        }
    } else {
        console.log('⚠️ No test recording found');
        console.log('   Creating a test audio file...');
        
        const testAudio = await createTestAudio();
        if (testAudio.success) {
            console.log('✅ Created test audio:', testAudio.path);
            
            if (results.whisperStatus) {
                const transcription = await transcribeAudio(testAudio.path, whisperExe, modelPath);
                if (transcription) {
                    console.log('✅ Test transcription:', transcription);
                    results.transcriptionResult = true;
                }
            }
            
            fs.unlinkSync(testAudio.path);
        }
    }
    
    // 5. Analyze current implementation issues
    console.log('\n5. ANALYZING CURRENT IMPLEMENTATION');
    console.log('-'.repeat(40));
    
    console.log('📋 Known issues in current implementation:');
    console.log('   1. RtpReceiver accumulates raw Opus packets without proper decoding');
    console.log('   2. OpusDecoder creates invalid Opus stream from RTP payloads');
    console.log('   3. No proper synchronization between audio chunks and processing');
    console.log('   4. Recording-based transcription uses wrong time offsets');
    
    results.issues.push('RTP to Opus conversion is broken');
    results.issues.push('Audio chunk timing is not synchronized');
    results.issues.push('Recording segment extraction uses incorrect timestamps');
    
    // 6. Generate recommendations
    console.log('\n6. RECOMMENDATIONS');
    console.log('-'.repeat(40));
    
    results.recommendations.push('Use recording-based approach instead of RTP processing');
    results.recommendations.push('Extract audio segments based on byte offsets, not time');
    results.recommendations.push('Implement rolling 30-second buffer from active recording');
    results.recommendations.push('Use FFmpeg to extract audio segments directly from WebM');
    
    for (const rec of results.recommendations) {
        console.log(`💡 ${rec}`);
    }
    
    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('DIAGNOSIS SUMMARY');
    console.log('='.repeat(80));
    
    console.log('\n✅ Working components:');
    if (results.whisperStatus) console.log('   - Whisper.cpp installation');
    if (results.ffmpegStatus) console.log('   - FFmpeg');
    if (results.audioExtraction) console.log('   - Audio extraction from recordings');
    if (results.transcriptionResult) console.log('   - Whisper transcription (when given proper audio)');
    
    console.log('\n❌ Issues found:');
    for (const issue of results.issues) {
        console.log(`   - ${issue}`);
    }
    
    return results;
}

async function checkFFmpeg() {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', ['-version']);
        let output = '';
        
        ffmpeg.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                const version = output.split('\n')[0];
                resolve(version);
            } else {
                reject(new Error('FFmpeg not found'));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function extractAudioFromRecording(recordingPath) {
    return new Promise((resolve) => {
        const audioPath = path.join(__dirname, 'temp', 'extracted_audio.wav');
        
        // Ensure temp directory exists
        const tempDir = path.dirname(audioPath);
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
            audioPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(audioPath)) {
                const stats = fs.statSync(audioPath);
                resolve({ success: true, audioPath, size: stats.size });
            } else {
                resolve({ success: false, error: `FFmpeg failed with code ${code}` });
            }
        });
        
        ffmpeg.on('error', (error) => {
            resolve({ success: false, error: error.message });
        });
    });
}

async function transcribeAudio(audioPath, whisperExe, modelPath) {
    return new Promise((resolve) => {
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
                    resolve(transcription);
                } else {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
        
        whisper.on('error', () => resolve(null));
    });
}

async function createTestAudio() {
    return new Promise((resolve) => {
        const audioPath = path.join(__dirname, 'temp', 'test_speech.wav');
        
        // Create a simple test audio file
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=2',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            '-y',
            audioPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(audioPath)) {
                resolve({ success: true, path: audioPath });
            } else {
                resolve({ success: false });
            }
        });
        
        ffmpeg.on('error', () => resolve({ success: false }));
    });
}

// Run diagnosis
runDiagnosis().then(results => {
    console.log('\n📊 Diagnosis complete');
    process.exit(results.transcriptionResult ? 0 : 1);
}).catch(error => {
    console.error('❌ Diagnosis failed:', error);
    process.exit(1);
});