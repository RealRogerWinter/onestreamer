// Test live transcription by creating a synthetic RTP stream
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dgram = require('dgram');

async function testLiveTranscription() {
    console.log('🎙️ LIVE TEST: Testing transcription with synthetic RTP stream...');
    
    // Create a real Opus file with speech-like content
    const tempDir = path.join(__dirname, 'temp', 'transcription');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const speechOpusPath = path.join(tempDir, 'speech_test.opus');
    
    // Create synthetic speech-like audio (multiple tones that might trigger speech recognition)
    console.log('📝 Creating synthetic speech audio...');
    await createSpeechLikeOpus(speechOpusPath);
    
    // Test this with Whisper directly
    console.log('📝 Testing speech audio with Whisper...');
    const speechResult = await testWithWhisper(speechOpusPath);
    console.log('🎯 Speech test result:', speechResult);
    
    // Now test the TranscriptionService directly with this audio
    console.log('📝 Testing TranscriptionService convertOpusToWav method...');
    const serviceTest = await testTranscriptionService(speechOpusPath);
    console.log('🎯 Service test result:', serviceTest);
    
    // Test creating RTP packets from real Opus data
    console.log('📝 Testing RTP packet creation from real Opus...');
    const rtpTest = await testRealOpusRtpProcessing(speechOpusPath);
    console.log('🎯 RTP test result:', rtpTest);
    
    // Cleanup
    try {
        if (fs.existsSync(speechOpusPath)) fs.unlinkSync(speechOpusPath);
    } catch (e) {}
    
    console.log('✅ LIVE TEST: All tests completed');
}

async function createSpeechLikeOpus(outputPath) {
    return new Promise((resolve, reject) => {
        // Create audio that simulates human speech patterns (mix of frequencies)
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'sine=frequency=200:duration=0.5,sine=frequency=400:duration=0.5,sine=frequency=600:duration=0.5,sine=frequency=300:duration=0.5',
            '-filter_complex', '[0:0][1:0][2:0][3:0]concat=n=4:v=0:a=1[out]',
            '-map', '[out]',
            '-c:a', 'libopus',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '64k',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Created speech-like Opus file: ${outputPath}`);
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function testWithWhisper(audioPath) {
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
        
        whisper.on('close', (code) => {
            if (code === 0) {
                const txtPath = audioPath + '.txt';
                if (fs.existsSync(txtPath)) {
                    const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                    fs.unlinkSync(txtPath);
                    resolve(`✅ Direct Whisper: "${transcription}"`);
                } else {
                    resolve(`⚠️ Whisper completed but no output text`);
                }
            } else {
                resolve(`❌ Whisper failed with code ${code}`);
            }
        });
        
        whisper.on('error', (error) => {
            resolve(`❌ Whisper error: ${error.message}`);
        });
    });
}

async function testTranscriptionService(opusPath) {
    return new Promise(async (resolve) => {
        try {
            // Read the TranscriptionService and test the convertOpusToWav method
            const TranscriptionService = require('./server/services/TranscriptionService');
            
            // Create a mock database object (minimal for testing)
            const mockDB = {
                db: null,
                runAsync: () => Promise.resolve(),
                getAsync: () => Promise.resolve(null),
                allAsync: () => Promise.resolve([])
            };
            
            // Create service instance 
            const transcriptionService = new TranscriptionService(mockDB, null);
            
            // Read the Opus file
            const opusData = fs.readFileSync(opusPath);
            
            // Test the conversion method
            const tempWavPath = opusPath.replace('.opus', '_service_test.wav');
            
            await transcriptionService.convertOpusToWav(opusData, tempWavPath);
            
            if (fs.existsSync(tempWavPath)) {
                // Test with Whisper
                const whisperResult = await testWithWhisper(tempWavPath);
                
                // Cleanup
                fs.unlinkSync(tempWavPath);
                
                resolve(`✅ Service conversion works. ${whisperResult}`);
            } else {
                resolve('❌ Service conversion failed - no WAV file created');
            }
            
        } catch (error) {
            resolve(`❌ Service test error: ${error.message}`);
        }
    });
}

async function testRealOpusRtpProcessing(opusPath) {
    return new Promise(async (resolve) => {
        try {
            // Read the real Opus file
            const opusData = fs.readFileSync(opusPath);
            
            // Split into chunks to simulate RTP packets
            const chunkSize = 160; // Typical RTP payload size
            const rtpPayloads = [];
            
            for (let i = 0; i < opusData.length; i += chunkSize) {
                const chunk = opusData.slice(i, Math.min(i + chunkSize, opusData.length));
                rtpPayloads.push(chunk);
            }
            
            console.log(`📊 Created ${rtpPayloads.length} RTP-like payloads from Opus file`);
            
            // Test with OpusDecoder
            const OpusDecoder = require('./server/services/OpusDecoder');
            const opusDecoder = new OpusDecoder();
            
            const pcm = await opusDecoder.processRtpOpusPayloads(rtpPayloads);
            
            if (pcm && pcm.length > 0) {
                // Check if it's silence or actual data
                const isSilence = pcm.every(byte => byte === 0);
                
                if (isSilence) {
                    resolve(`⚠️ RTP processing returned ${pcm.length} bytes of silence`);
                } else {
                    // Save as WAV and test with Whisper
                    const testWavPath = opusPath.replace('.opus', '_rtp_test.wav');
                    
                    // Create WAV from PCM data
                    await createWavFromPCM(pcm, testWavPath);
                    
                    const whisperResult = await testWithWhisper(testWavPath);
                    
                    // Cleanup
                    fs.unlinkSync(testWavPath);
                    
                    resolve(`✅ RTP processing works - ${pcm.length} bytes PCM. ${whisperResult}`);
                }
            } else {
                resolve('❌ RTP processing failed - no PCM data returned');
            }
            
        } catch (error) {
            resolve(`❌ RTP test error: ${error.message}`);
        }
    });
}

async function createWavFromPCM(pcmData, outputPath) {
    // Create WAV header for 16kHz mono 16-bit PCM
    const wavHeader = Buffer.alloc(44);
    
    // RIFF header
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + pcmData.length, 4);
    wavHeader.write('WAVE', 8);
    
    // fmt chunk
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16); // fmt chunk size
    wavHeader.writeUInt16LE(1, 20); // PCM format
    wavHeader.writeUInt16LE(1, 22); // Mono
    wavHeader.writeUInt32LE(16000, 24); // 16kHz
    wavHeader.writeUInt32LE(32000, 28); // byte rate (16000 * 1 * 2)
    wavHeader.writeUInt16LE(2, 32); // block align
    wavHeader.writeUInt16LE(16, 34); // bits per sample
    
    // data chunk
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(pcmData.length, 40);
    
    // Write WAV file
    const wavData = Buffer.concat([wavHeader, pcmData]);
    fs.writeFileSync(outputPath, wavData);
}

// Run the tests
testLiveTranscription().catch(console.error);