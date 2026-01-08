// Test the new transcription system with AudioBufferService
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function testNewTranscription() {
    console.log('🧪 TESTING NEW TRANSCRIPTION SYSTEM');
    console.log('=' .repeat(80));
    
    try {
        // 1. Test AudioBufferService standalone
        console.log('\n1. TESTING AUDIOBUFFERSERVICE');
        console.log('-'.repeat(40));
        
        const AudioBufferService = require('./server/services/AudioBufferService');
        const audioBuffer = new AudioBufferService();
        
        console.log('✅ AudioBufferService initialized');
        console.log(`   Buffer duration: ${audioBuffer.config.bufferDuration}s`);
        console.log(`   Sample rate: ${audioBuffer.config.sampleRate}Hz`);
        
        // 2. Create a test audio file to simulate streaming
        console.log('\n2. CREATING TEST AUDIO');
        console.log('-'.repeat(40));
        
        const testAudioPath = await createTestAudioFile();
        console.log('✅ Created test audio file:', testAudioPath);
        
        // 3. Test audio extraction from the buffer
        console.log('\n3. TESTING AUDIO EXTRACTION');
        console.log('-'.repeat(40));
        
        // Simulate a buffer file
        const testSessionId = 'test-session-001';
        const bufferPath = path.join(__dirname, 'audio-buffers', `${testSessionId}.wav`);
        
        // Copy test audio to buffer location
        const bufferDir = path.dirname(bufferPath);
        if (!fs.existsSync(bufferDir)) {
            fs.mkdirSync(bufferDir, { recursive: true });
        }
        
        fs.copyFileSync(testAudioPath, bufferPath);
        console.log('✅ Simulated buffer file created');
        
        // Manually add session to test extraction
        audioBuffer.sessions.set(testSessionId, {
            id: testSessionId,
            startTime: new Date(),
            bufferFile: bufferPath,
            bytesWritten: fs.statSync(bufferPath).size,
            isActive: true,
            extractionCount: 0
        });
        
        // Test extraction
        const extractResult = await audioBuffer.extractLastNSeconds(testSessionId, 5);
        
        if (extractResult.success) {
            console.log('✅ Successfully extracted audio');
            console.log(`   Duration: ${extractResult.duration}s`);
            console.log(`   Size: ${(extractResult.size / 1024).toFixed(2)}KB`);
            
            // 4. Test Whisper transcription on extracted audio
            console.log('\n4. TESTING WHISPER TRANSCRIPTION');
            console.log('-'.repeat(40));
            
            const transcription = await testWhisperTranscription(extractResult.audioPath);
            console.log('Transcription result:', transcription);
            
            // Cleanup
            if (fs.existsSync(extractResult.audioPath)) {
                fs.unlinkSync(extractResult.audioPath);
            }
        } else {
            console.log('❌ Failed to extract audio:', extractResult.error);
        }
        
        // 5. Test integrated TranscriptionService
        console.log('\n5. TESTING INTEGRATED TRANSCRIPTION SERVICE');
        console.log('-'.repeat(40));
        
        const TranscriptionService = require('./server/services/TranscriptionService');
        
        // Create mock database
        const mockDB = {
            db: null,
            runAsync: () => Promise.resolve(),
            getAsync: () => Promise.resolve(null),
            allAsync: () => Promise.resolve([])
        };
        
        // Create mock MediaSoup service
        const mockMediaSoup = {
            router: null,
            producers: new Map(),
            getCurrentStreamer: () => null
        };
        
        const transcriptionService = new TranscriptionService(mockDB, mockMediaSoup);
        console.log('✅ TranscriptionService initialized with AudioBufferService');
        
        // Test the whisper transcription directly
        const whisperResult = await transcriptionService.transcribeWithWhisperCpp(
            testAudioPath,
            { model: 'base', language: 'en' }
        );
        
        console.log('Direct Whisper test:', whisperResult ? `"${whisperResult.substring(0, 100)}..."` : 'No result');
        
        // Cleanup
        audioBuffer.stopBuffering(testSessionId);
        if (fs.existsSync(bufferPath)) {
            fs.unlinkSync(bufferPath);
        }
        if (fs.existsSync(testAudioPath)) {
            fs.unlinkSync(testAudioPath);
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('✅ NEW TRANSCRIPTION SYSTEM TEST COMPLETE');
        console.log('='.repeat(80));
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

async function createTestAudioFile() {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(__dirname, 'temp', 'test_audio_buffer.wav');
        
        // Ensure temp directory exists
        const tempDir = path.dirname(outputPath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Create a simple test audio file
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=6',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
            '-y',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function testWhisperTranscription(audioPath) {
    return new Promise((resolve) => {
        const whisperExe = path.join(__dirname, 'whisper', 'Release', 'whisper-cli.exe');
        const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-base.bin');
        
        if (!fs.existsSync(whisperExe) || !fs.existsSync(modelPath)) {
            resolve('❌ Whisper not properly installed');
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
                    
                    if (transcription && transcription !== 'you') {
                        resolve(`✅ Valid transcription: "${transcription}"`);
                    } else if (transcription === 'you') {
                        resolve(`⚠️ Whisper returned hallucination: "you"`);
                    } else {
                        resolve(`⚠️ Empty transcription`);
                    }
                } else {
                    resolve(`❌ No transcription output file`);
                }
            } else {
                resolve(`❌ Whisper failed with code ${code}`);
            }
        });
        
        whisper.on('error', () => resolve('❌ Whisper process error'));
    });
}

// Run the test
testNewTranscription().catch(console.error);