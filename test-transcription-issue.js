// Diagnose the transcription issue with 44 seconds but 0 words
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function diagnoseTranscriptionIssue() {
    console.log('🔍 DIAGNOSING TRANSCRIPTION ISSUE: 44s duration, 0 words');
    console.log('=' .repeat(80));
    
    const SERVER_URL = 'http://localhost:8080';
    const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';
    
    try {
        // 1. Check transcription status
        console.log('\n1. CHECKING TRANSCRIPTION STATUS');
        console.log('-'.repeat(40));
        
        const statusResponse = await fetch(`${SERVER_URL}/admin/transcription/status`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (statusResponse.ok) {
            const status = await statusResponse.json();
            console.log('Current status:');
            console.log(JSON.stringify(status, null, 2));
            
            if (status.status.activeSessions && status.status.activeSessions.length > 0) {
                console.log('\n📍 Active sessions found:');
                status.status.activeSessions.forEach(session => {
                    console.log(`   Session: ${session.id}`);
                    console.log(`   Words: ${session.wordCount}, Chunks: ${session.chunkCount}`);
                    if (session.bufferStatus) {
                        console.log(`   Buffer: ${session.bufferStatus.duration}s, ${(session.bufferStatus.size / 1024).toFixed(2)}KB`);
                    }
                });
            }
        }
        
        // 2. Get transcription history to find the problematic session
        console.log('\n2. CHECKING TRANSCRIPTION HISTORY');
        console.log('-'.repeat(40));
        
        const historyResponse = await fetch(`${SERVER_URL}/api/transcriptions/history?limit=10`, {
            headers: {
                'x-admin-key': ADMIN_KEY
            }
        });
        
        if (historyResponse.ok) {
            const history = await historyResponse.json();
            console.log(`Found ${history.total} transcriptions`);
            
            // Find sessions with duration but no words
            const problematicSessions = history.transcriptions.filter(t => 
                t.duration > 0 && t.word_count === 0
            );
            
            if (problematicSessions.length > 0) {
                console.log(`\n⚠️ Found ${problematicSessions.length} sessions with duration but no words:`);
                problematicSessions.forEach(session => {
                    console.log(`   ID: ${session.id}`);
                    console.log(`   Duration: ${session.duration}s`);
                    console.log(`   Status: ${session.status}`);
                    console.log(`   Start: ${session.start_time}`);
                });
            }
        }
        
        // 3. Check for WAV files in various directories
        console.log('\n3. SEARCHING FOR AUDIO FILES');
        console.log('-'.repeat(40));
        
        const audioDirs = [
            path.join(__dirname, 'audio-buffers'),
            path.join(__dirname, 'temp', 'audio'),
            path.join(__dirname, 'temp', 'transcription'),
            path.join(__dirname, 'recordings', 'temp')
        ];
        
        for (const dir of audioDirs) {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                const wavFiles = files.filter(f => f.endsWith('.wav'));
                if (wavFiles.length > 0) {
                    console.log(`\n📁 Found WAV files in ${dir}:`);
                    wavFiles.forEach(file => {
                        const filePath = path.join(dir, file);
                        const stats = fs.statSync(filePath);
                        console.log(`   ${file}: ${(stats.size / 1024).toFixed(2)}KB`);
                        
                        // Test with Whisper if file is recent (last hour)
                        const hourAgo = Date.now() - (60 * 60 * 1000);
                        if (stats.mtimeMs > hourAgo) {
                            console.log(`      Recent file - will test with Whisper`);
                            testWithWhisper(filePath);
                        }
                    });
                }
            }
        }
        
        // 4. Test AudioBufferService directly
        console.log('\n4. TESTING AUDIO BUFFER SERVICE');
        console.log('-'.repeat(40));
        
        const AudioBufferService = require('./server/services/AudioBufferService');
        const audioBuffer = new AudioBufferService();
        
        const sessions = audioBuffer.getAllSessions();
        console.log(`AudioBufferService has ${sessions.length} sessions`);
        sessions.forEach(session => {
            console.log(`   Session ${session.id}: ${session.duration}s, ${(session.bytesWritten / 1024).toFixed(2)}KB`);
        });
        
        // 5. Check if Whisper is working
        console.log('\n5. TESTING WHISPER DIRECTLY');
        console.log('-'.repeat(40));
        
        const testAudioPath = path.join(__dirname, 'whisper', 'jfk.wav');
        if (fs.existsSync(testAudioPath)) {
            console.log('Testing with JFK sample audio...');
            const result = await testWithWhisper(testAudioPath);
            console.log(`Result: ${result}`);
        }
        
        // 6. Create a test audio file and transcribe it
        console.log('\n6. CREATING TEST AUDIO AND TRANSCRIBING');
        console.log('-'.repeat(40));
        
        const testWav = await createTestAudioWithSpeech();
        if (testWav) {
            console.log(`Created test audio: ${testWav}`);
            const testResult = await testWithWhisper(testWav);
            console.log(`Test transcription: ${testResult}`);
            
            // Clean up
            fs.unlinkSync(testWav);
        }
        
        // 7. Analyze the issue
        console.log('\n7. ANALYSIS');
        console.log('-'.repeat(40));
        console.log('Possible causes for 44s duration with 0 words:');
        console.log('1. ❌ Audio buffer contains silence or very low volume');
        console.log('2. ❌ FFmpeg is not properly capturing audio from MediaSoup');
        console.log('3. ❌ Whisper is receiving corrupted WAV files');
        console.log('4. ❌ The transcription processing interval is not triggering');
        console.log('5. ❌ Audio extraction from buffer is failing');
        
        // 8. Check if FFmpeg processes are running
        console.log('\n8. CHECKING FFMPEG PROCESSES');
        console.log('-'.repeat(40));
        
        const ffmpegCheck = await checkFFmpegProcesses();
        console.log(ffmpegCheck);
        
    } catch (error) {
        console.error('❌ Diagnosis failed:', error);
    }
}

async function testWithWhisper(audioPath) {
    return new Promise((resolve) => {
        const whisperExe = path.join(__dirname, 'whisper', 'Release', 'whisper-cli.exe');
        const modelPath = path.join(__dirname, 'whisper', 'models', 'ggml-base.bin');
        
        if (!fs.existsSync(whisperExe) || !fs.existsSync(modelPath)) {
            resolve('Whisper not found');
            return;
        }
        
        const args = [
            '-m', modelPath,
            '-f', audioPath,
            '--no-timestamps',
            '-otxt'
        ];
        
        const whisper = spawn(whisperExe, args);
        let stderr = '';
        
        whisper.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        whisper.on('close', (code) => {
            if (code === 0) {
                const txtPath = audioPath + '.txt';
                if (fs.existsSync(txtPath)) {
                    const transcription = fs.readFileSync(txtPath, 'utf8').trim();
                    fs.unlinkSync(txtPath);
                    
                    if (!transcription || transcription === '' || transcription === 'you') {
                        // Check WAV file properties
                        const stats = fs.statSync(audioPath);
                        const duration = (stats.size - 44) / (16000 * 2); // Calculate duration
                        resolve(`Empty/hallucination (file: ${(stats.size/1024).toFixed(2)}KB, ~${duration.toFixed(1)}s)`);
                    } else {
                        resolve(`Success: "${transcription.substring(0, 50)}..."`);
                    }
                } else {
                    resolve(`No output file (stderr: ${stderr.substring(0, 100)})`);
                }
            } else {
                resolve(`Whisper failed with code ${code}`);
            }
        });
        
        whisper.on('error', () => resolve('Process error'));
    });
}

async function createTestAudioWithSpeech() {
    return new Promise((resolve) => {
        const outputPath = path.join(__dirname, 'temp', 'test_speech_audio.wav');
        
        // Ensure temp directory exists
        const tempDir = path.dirname(outputPath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Create audio with varying frequencies that might be interpreted as speech
        const ffmpegArgs = [
            '-f', 'lavfi',
            '-i', 'anoisesrc=d=10:c=brown:r=16000:a=0.8',
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
                resolve(null);
            }
        });
        
        ffmpeg.on('error', () => resolve(null));
    });
}

async function checkFFmpegProcesses() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        
        // Windows command to find FFmpeg processes
        exec('tasklist | findstr ffmpeg', (error, stdout, stderr) => {
            if (error) {
                resolve('No FFmpeg processes found');
            } else {
                const lines = stdout.trim().split('\n');
                resolve(`Found ${lines.length} FFmpeg process(es):\n${stdout}`);
            }
        });
    });
}

// Run diagnosis
diagnoseTranscriptionIssue().catch(console.error);