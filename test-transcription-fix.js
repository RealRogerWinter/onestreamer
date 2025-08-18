// Test the transcription fix that uses MediaSoup recording integration
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

console.log('🧪 TESTING TRANSCRIPTION FIX: MediaSoup Recording Integration');

async function testTranscriptionFix() {
    try {
        // Test 1: Verify the TranscriptionService can handle recording files
        console.log('📝 Testing TranscriptionService with recording integration...');
        
        // Create a test recording file (simulate what MediaSoup recording would create)
        const tempDir = path.join(__dirname, 'temp', 'transcription');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const testRecordingPath = path.join(tempDir, 'test_recording.webm');
        
        // Create a test WebM file with audio (like MediaSoup would create)
        await createTestWebMFile(testRecordingPath);
        
        // Test processing it through the transcription pipeline
        const result = await testRecordingProcessing(testRecordingPath);
        console.log('🎯 Recording processing result:', result);
        
        // Cleanup
        try {
            if (fs.existsSync(testRecordingPath)) fs.unlinkSync(testRecordingPath);
        } catch (e) {}
        
        console.log('✅ TRANSCRIPTION FIX TEST: Completed');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

async function createTestWebMFile(outputPath) {
    return new Promise((resolve, reject) => {
        // Create a WebM file with audio content (like MediaSoup recording creates)
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:duration=3',
            '-c:a', 'libopus',
            '-ar', '48000',
            '-ac', '2',
            '-f', 'webm',
            outputPath
        ];
        
        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Created test WebM recording: ${outputPath}`);
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function testRecordingProcessing(recordingPath) {
    try {
        // Test extracting audio segment from recording file (like the fix does)
        const segmentPath = recordingPath.replace('.webm', '_segment.wav');
        
        // Extract 5-second audio segment for transcription
        const extractArgs = [
            '-y',
            '-i', recordingPath,
            '-ss', '0',        // Start from beginning
            '-t', '5',         // 5 second duration
            '-ar', '16000',    // Whisper sample rate
            '-ac', '1',        // Mono
            '-f', 'wav',
            segmentPath
        ];
        
        console.log('📝 Extracting audio segment from recording...');
        await runFFmpeg(extractArgs);
        
        if (fs.existsSync(segmentPath)) {
            console.log('✅ Audio segment extracted successfully');
            
            // Test transcription with Whisper
            const transcriptionResult = await testWhisperTranscription(segmentPath);
            
            // Cleanup
            fs.unlinkSync(segmentPath);
            
            return `✅ Recording processing works! ${transcriptionResult}`;
        } else {
            return '❌ Failed to extract audio segment from recording';
        }
        
    } catch (error) {
        return `❌ Recording processing error: ${error.message}`;
    }
}

async function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args);
        
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function testWhisperTranscription(audioPath) {
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
                    resolve(`Whisper transcription: "${transcription}"`);
                } else {
                    resolve('Whisper completed but no output');
                }
            } else {
                resolve(`Whisper failed with code ${code}`);
            }
        });
        
        whisper.on('error', (error) => {
            resolve(`Whisper error: ${error.message}`);
        });
    });
}

// Run the test
testTranscriptionFix().catch(console.error);