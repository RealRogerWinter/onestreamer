const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function setupWhisper() {
    console.log('🚀 Setting up Whisper.cpp for transcription...');
    
    const whisperDir = path.join(__dirname, 'whisper');
    const modelsDir = path.join(whisperDir, 'models');
    
    // Create directories
    if (!fs.existsSync(whisperDir)) {
        fs.mkdirSync(whisperDir, { recursive: true });
    }
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }
    
    console.log('📁 Created whisper directories');
    
    // Check if we're on Windows
    const isWindows = process.platform === 'win32';
    
    if (isWindows) {
        console.log('🪟 Windows detected - downloading pre-built whisper binaries...');
        
        // For Windows, we'll use a pre-built binary or alternative approach
        console.log('⚠️  For Windows, please follow these steps:');
        console.log('1. Download whisper.cpp Windows binary from: https://github.com/ggerganov/whisper.cpp/releases');
        console.log('2. Extract to the "whisper" directory');
        console.log('3. Or use WSL/Docker for Linux environment');
        console.log('\n📦 Downloading the base model instead...');
        
        // Download the base model directly
        const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
        const modelPath = path.join(modelsDir, 'ggml-base.bin');
        
        if (!fs.existsSync(modelPath)) {
            console.log('⬇️  Downloading base model (142 MB)...');
            try {
                await downloadFile(modelUrl, modelPath);
                console.log('✅ Model downloaded successfully');
            } catch (error) {
                console.error('❌ Failed to download model:', error);
                console.log('\n📝 Manual download instructions:');
                console.log(`1. Download from: ${modelUrl}`);
                console.log(`2. Save to: ${modelPath}`);
            }
        } else {
            console.log('✅ Model already exists');
        }
        
        // For Windows, we'll use a Node.js implementation as fallback
        console.log('\n🔧 Setting up Node.js-based transcription as fallback...');
        console.log('Installing @xenova/transformers for Whisper support...');
        
        try {
            await execAsync('npm install @xenova/transformers');
            console.log('✅ Node.js Whisper alternative installed');
        } catch (error) {
            console.log('⚠️  Could not install @xenova/transformers');
        }
        
    } else {
        console.log('🐧 Unix-like system detected - building whisper.cpp from source...');
        
        // Clone whisper.cpp if not exists
        const whisperRepoPath = path.join(whisperDir, 'whisper.cpp');
        if (!fs.existsSync(whisperRepoPath)) {
            console.log('📥 Cloning whisper.cpp repository...');
            try {
                await execAsync(`git clone https://github.com/ggerganov/whisper.cpp.git ${whisperRepoPath}`);
                console.log('✅ Repository cloned');
            } catch (error) {
                console.error('❌ Failed to clone repository:', error);
                return;
            }
        }
        
        // Build whisper.cpp
        console.log('🔨 Building whisper.cpp...');
        try {
            await execAsync('make', { cwd: whisperRepoPath });
            console.log('✅ Build completed');
        } catch (error) {
            console.error('❌ Build failed:', error);
            console.log('Please ensure you have build tools installed (gcc, make)');
        }
        
        // Download model
        console.log('📦 Downloading base model...');
        try {
            await execAsync('./models/download-ggml-model.sh base', { cwd: whisperRepoPath });
            console.log('✅ Model downloaded');
        } catch (error) {
            console.log('⚠️  Model download script failed, trying direct download...');
            const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
            const modelPath = path.join(modelsDir, 'ggml-base.bin');
            await downloadFile(modelUrl, modelPath);
            console.log('✅ Model downloaded directly');
        }
    }
    
    console.log('\n✨ Whisper setup complete!');
    console.log('📝 Note: The transcription service will use the appropriate method based on your platform.');
}

// Run setup
setupWhisper().catch(console.error);