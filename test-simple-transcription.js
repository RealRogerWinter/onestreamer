// Simple test for transcription system
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function testSimpleTranscription() {
    console.log('🧪 SIMPLE TEST: Testing transcription components...');
    
    const tempDir = path.join(__dirname, 'temp', 'transcription');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Test 1: Create simple Opus file and test the conversion
    console.log('📝 Creating simple Opus file...');
    
    const simpleOpusPath = path.join(tempDir, 'simple_test.opus');
    
    // Create a simple 2-second sine wave in Opus format
    const ffmpegArgs = [
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=2',
        '-c:a', 'libopus',
        '-ar', '48000',
        '-ac', '2',
        simpleOpusPath
    ];
    
    try {
        await runFFmpeg(ffmpegArgs);
        console.log('✅ Created simple Opus file');
        
        // Test conversion using our TranscriptionService method
        console.log('📝 Testing Opus to WAV conversion using TranscriptionService...');
        const conversionResult = await testServiceConversion(simpleOpusPath);
        console.log('🎯 Conversion result:', conversionResult);
        
        // Test the OpusDecoder directly with real data
        console.log('📝 Testing OpusDecoder with real Opus data...');
        const decoderResult = await testOpusDecoder(simpleOpusPath);
        console.log('🎯 Decoder result:', decoderResult);
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
    
    // Cleanup
    try {
        if (fs.existsSync(simpleOpusPath)) fs.unlinkSync(simpleOpusPath);
    } catch (e) {}
    
    console.log('✅ SIMPLE TEST: Completed');
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args);
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
        
        ffmpeg.on('error', reject);
    });
}

async function testServiceConversion(opusPath) {
    try {
        // Read the Opus file
        const opusData = fs.readFileSync(opusPath);
        
        // Create a temporary WAV file path
        const wavPath = opusPath.replace('.opus', '_converted.wav');
        
        // Use the conversion method from TranscriptionService
        await convertOpusToWav(opusData, wavPath);
        
        if (fs.existsSync(wavPath)) {
            const wavSize = fs.statSync(wavPath).size;
            
            // Test with Whisper
            const whisperResult = await testWithWhisper(wavPath);
            
            // Cleanup
            fs.unlinkSync(wavPath);
            
            return `✅ Converted ${opusData.length} bytes Opus to ${wavSize} bytes WAV. ${whisperResult}`;
        } else {
            return '❌ Conversion failed - no WAV file created';
        }
    } catch (error) {
        return `❌ Service conversion error: ${error.message}`;
    }
}

async function convertOpusToWav(opusBuffer, outputPath) {
    return new Promise((resolve, reject) => {
        const tempOpusPath = outputPath.replace('.wav', '_temp.opus');
        
        try {
            // Write raw Opus data to temp file
            fs.writeFileSync(tempOpusPath, opusBuffer);
            
            // Use FFmpeg to convert Opus to WAV
            const ffmpegArgs = [
                '-y', // Overwrite output
                '-i', tempOpusPath,
                '-ar', '16000',  // Whisper sample rate
                '-ac', '1',      // Mono
                '-f', 'wav',
                outputPath
            ];
            
            const ffmpeg = spawn('ffmpeg', ffmpegArgs);
            
            let stderr = '';
            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            ffmpeg.on('close', (code) => {
                // Clean up temp file
                try {
                    fs.unlinkSync(tempOpusPath);
                } catch (e) {}
                
                if (code === 0 && fs.existsSync(outputPath)) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg conversion failed: ${stderr}`));
                }
            });
            
            ffmpeg.on('error', reject);
            
        } catch (error) {
            reject(error);
        }
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
                    resolve(`Whisper: "${transcription}"`);
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

async function testOpusDecoder(opusPath) {
    try {
        const OpusDecoder = require('./server/services/OpusDecoder');
        const opusDecoder = new OpusDecoder();
        
        // Read the Opus file
        const opusData = fs.readFileSync(opusPath);
        
        // Split into smaller chunks to simulate RTP packets
        const chunkSize = 100;
        const chunks = [];
        
        for (let i = 0; i < opusData.length; i += chunkSize) {
            chunks.push(opusData.slice(i, Math.min(i + chunkSize, opusData.length)));
        }
        
        console.log(`   Created ${chunks.length} chunks from ${opusData.length} bytes`);
        
        // Process through OpusDecoder
        const pcm = await opusDecoder.processRtpOpusPayloads(chunks);
        
        if (pcm && pcm.length > 0) {
            const isSilence = pcm.every(byte => byte === 0);
            
            if (isSilence) {
                return `⚠️ OpusDecoder returned ${pcm.length} bytes of silence`;
            } else {
                return `✅ OpusDecoder returned ${pcm.length} bytes of PCM data`;
            }
        } else {
            return '❌ OpusDecoder returned no data';
        }
        
    } catch (error) {
        return `❌ OpusDecoder error: ${error.message}`;
    }
}

// Run the test
testSimpleTranscription().catch(console.error);