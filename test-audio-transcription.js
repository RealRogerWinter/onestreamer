// Test script to verify transcription system with synthetic audio
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Test the transcription system with synthetic audio
async function testTranscriptionSystem() {
    console.log('🧪 TRANSCRIPTION TEST: Starting synthetic audio test...');
    
    const tempDir = path.join(__dirname, 'temp', 'transcription');
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Test 1: Create a simple WAV file with silence and test Whisper directly
    console.log('📝 TEST 1: Testing Whisper.cpp with synthetic WAV file...');
    
    const testWavPath = path.join(tempDir, 'test_audio.wav');
    
    // Create a 3-second test audio file with a simple tone
    await createTestWavFile(testWavPath);
    
    // Test Whisper directly
    const whisperResult = await testWhisperDirect(testWavPath);
    console.log('🎯 Whisper direct test result:', whisperResult);
    
    // Test 2: Create synthetic Opus data and test the conversion pipeline
    console.log('📝 TEST 2: Testing Opus to WAV conversion...');
    
    const testOpusPath = path.join(tempDir, 'test_audio.opus');
    
    // Create test Opus file
    await createTestOpusFile(testOpusPath);
    
    // Test Opus to WAV conversion
    const conversionResult = await testOpusToWavConversion(testOpusPath);
    console.log('🎯 Opus conversion test result:', conversionResult);
    
    // Test 3: Create synthetic RTP packets and test the full pipeline
    console.log('📝 TEST 3: Testing RTP packet processing...');
    
    const rtpResult = await testRtpProcessing();
    console.log('🎯 RTP processing test result:', rtpResult);
    
    console.log('✅ TRANSCRIPTION TEST: All tests completed');
    
    // Cleanup
    try {
        if (fs.existsSync(testWavPath)) fs.unlinkSync(testWavPath);
        if (fs.existsSync(testOpusPath)) fs.unlinkSync(testOpusPath);
    } catch (e) {}
}

async function createTestWavFile(outputPath) {
    return new Promise((resolve, reject) => {
        // Create a 3-second WAV file with a simple tone using FFmpeg
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'sine=frequency=1000:duration=3',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Created test WAV file: ${outputPath}`);
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function createTestOpusFile(outputPath) {
    return new Promise((resolve, reject) => {
        // Create a test Opus file using FFmpeg
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'sine=frequency=500:duration=2',
            '-c:a', 'libopus',
            '-ar', '48000',
            '-ac', '2',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Created test Opus file: ${outputPath}`);
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function testWhisperDirect(audioPath) {
    return new Promise((resolve) => {
        const whisperPath = path.join(__dirname, 'whisper', 'Release', 'whisper-cli.exe');
        const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-base.bin');
        
        if (!fs.existsSync(whisperPath)) {
            resolve('❌ Whisper executable not found');
            return;
        }
        
        if (!fs.existsSync(modelPath)) {
            resolve('❌ Whisper model not found');
            return;
        }
        
        const args = [
            '-m', modelPath,
            '-f', audioPath,
            '--no-timestamps',
            '-otxt'
        ];
        
        const whisper = spawn(whisperPath, args);
        let output = '';
        
        whisper.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        whisper.stderr.on('data', (data) => {
            output += data.toString();
        });
        
        whisper.on('close', (code) => {
            if (code === 0) {
                // Check for output text file
                const txtPath = audioPath + '.txt';
                if (fs.existsSync(txtPath)) {
                    const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                    fs.unlinkSync(txtPath);
                    resolve(`✅ Whisper transcription: "${transcription}"`);
                } else {
                    resolve(`⚠️ Whisper completed but no text file: ${output}`);
                }
            } else {
                resolve(`❌ Whisper failed with code ${code}: ${output}`);
            }
        });
        
        whisper.on('error', (error) => {
            resolve(`❌ Whisper error: ${error.message}`);
        });
    });
}

async function testOpusToWavConversion(opusPath) {
    return new Promise((resolve) => {
        const wavPath = opusPath.replace('.opus', '_converted.wav');
        
        const ffmpegArgs = [
            '-y',
            '-i', opusPath,
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            wavPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', async (code) => {
            if (code === 0 && fs.existsSync(wavPath)) {
                // Test the converted WAV with Whisper
                const whisperResult = await testWhisperDirect(wavPath);
                
                // Cleanup
                try {
                    fs.unlinkSync(wavPath);
                } catch (e) {}
                
                resolve(`✅ Opus to WAV conversion successful. ${whisperResult}`);
            } else {
                resolve(`❌ Opus to WAV conversion failed with code ${code}`);
            }
        });
        
        ffmpeg.on('error', (error) => {
            resolve(`❌ Conversion error: ${error.message}`);
        });
    });
}

async function testRtpProcessing() {
    try {
        // Test the RtpReceiver and OpusDecoder classes
        const RtpReceiver = require('./server/services/RtpReceiver');
        const OpusDecoder = require('./server/services/OpusDecoder');
        
        console.log('🔧 Testing RtpReceiver initialization...');
        const rtpReceiver = new RtpReceiver(5999);
        
        console.log('🔧 Testing OpusDecoder initialization...');
        const opusDecoder = new OpusDecoder();
        
        // Create some fake Opus data (just random bytes for testing structure)
        const fakeOpusPayloads = [
            Buffer.from([0x01, 0x02, 0x03, 0x04]), // Fake Opus frame 1
            Buffer.from([0x05, 0x06, 0x07, 0x08]), // Fake Opus frame 2
            Buffer.from([0x09, 0x0A, 0x0B, 0x0C])  // Fake Opus frame 3
        ];
        
        console.log('🔧 Testing Opus stream creation...');
        const opusStream = opusDecoder.createOpusStreamFromRtp(fakeOpusPayloads);
        
        if (opusStream && opusStream.length > 0) {
            console.log(`✅ Created Opus stream: ${opusStream.length} bytes`);
            
            // Test saving to file (this will probably fail decoding but tests the structure)
            const testOpusFile = path.join(__dirname, 'temp', 'transcription', 'rtp_test.opus');
            fs.writeFileSync(testOpusFile, opusStream);
            
            // Try to convert it (will likely fail but tests the pipeline)
            const conversionResult = await testOpusToWavConversion(testOpusFile);
            
            // Cleanup
            try {
                fs.unlinkSync(testOpusFile);
            } catch (e) {}
            
            return `✅ RTP processing structure works. ${conversionResult}`;
        } else {
            return '❌ Failed to create Opus stream from RTP payloads';
        }
    } catch (error) {
        return `❌ RTP processing error: ${error.message}`;
    }
}

// Run the tests
testTranscriptionSystem().catch(console.error);