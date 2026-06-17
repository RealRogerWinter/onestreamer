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
    
    const whisperDir = path.join(__dirname, '..', '..', 'whisper');
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
        
        // Windows has no Node.js transcription fallback; whisper.cpp (built on the
        // Unix branch below) is the real transcription engine.
        console.log('\n⚠️  Windows: build whisper.cpp via WSL/Unix for transcription support.');
        
    } else {
        console.log('🐧 Unix-like system detected - building whisper.cpp from source...');
        
        // Pin the exact commit (must match Dockerfile's WHISPER_CPP_SHA). git tags
        // are mutable and `master` drifts — an unpinned clone can pull a build that
        // changes the CLI flags / output format that WhisperRunner.js parses.
        const WHISPER_CPP_SHA = '8a9ad7844d6e2a10cddf4b92de4089d7ac2b14a9';

        // Clone whisper.cpp if not exists
        const whisperRepoPath = path.join(whisperDir, 'whisper.cpp');
        if (!fs.existsSync(path.join(whisperRepoPath, '.git'))) {
            console.log('📥 Cloning whisper.cpp repository...');
            try {
                await execAsync(`git -c advice.detachedHead=false clone https://github.com/ggerganov/whisper.cpp.git ${whisperRepoPath}`);
                await execAsync(`git -C ${whisperRepoPath} checkout -q ${WHISPER_CPP_SHA}`);
                console.log(`✅ Repository cloned @ ${WHISPER_CPP_SHA.slice(0, 12)}`);
            } catch (error) {
                console.error('❌ Failed to clone repository:', error);
                return;
            }
        }

        // Build whisper.cpp.
        //
        // This MUST mirror the Dockerfile builder stage, for two reasons:
        //   1. AVX-512 OFF — the legacy `make` build (and cmake's default
        //      GGML_NATIVE) bakes in whatever instruction sets the BUILD host
        //      advertises. A binary built on an AVX-512 machine then SIGILLs
        //      ("Illegal instruction") the moment it starts inference on an
        //      AVX2-only host (e.g. AMD EPYC-Milan). Disabling -DGGML_AVX512*
        //      keeps the binary runnable on any x86-64 with AVX2.
        //   2. STATIC (-DBUILD_SHARED_LIBS=OFF) — newer whisper.cpp defaults to
        //      shared libs, so `main` would dynamically link libwhisper.so.1 /
        //      libggml*.so. A self-contained binary avoids "cannot open shared
        //      object file" at runtime.
        // The CLI lives at whisper.cpp/main (per WhisperRunner.js); newer
        // whisper.cpp builds the `whisper-cli` target, which we copy to `main`.
        console.log('🔨 Building whisper.cpp (static, AVX2-only)...');
        try {
            const buildDir = path.join(whisperRepoPath, 'build');
            await execAsync(
                `cmake -S ${whisperRepoPath} -B ${buildDir} -DCMAKE_BUILD_TYPE=Release ` +
                '-DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF ' +
                '-DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF'
            );
            await execAsync(`cmake --build ${buildDir} -j --target whisper-cli`);
            fs.copyFileSync(path.join(buildDir, 'bin', 'whisper-cli'), path.join(whisperRepoPath, 'main'));
            console.log('✅ Build completed');
        } catch (error) {
            console.error('❌ Build failed:', error);
            console.log('Please ensure you have build tools installed (gcc, g++, cmake, make)');
            return;
        }

        // Download model into whisper/models (where WhisperRunner.js looks —
        // NOT whisper/whisper.cpp/models).
        console.log('📦 Downloading base model...');
        const modelPath = path.join(modelsDir, 'ggml-base.bin');
        if (fs.existsSync(modelPath)) {
            console.log('✅ Model already exists');
        } else {
            try {
                const modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
                await downloadFile(modelUrl, modelPath);
                console.log('✅ Model downloaded');
            } catch (error) {
                console.error('❌ Failed to download model:', error);
                console.log(`   Download manually from https://huggingface.co/ggerganov/whisper.cpp and save to ${modelPath}`);
            }
        }
    }
    
    console.log('\n✨ Whisper setup complete!');
    console.log('📝 Note: The transcription service will use the appropriate method based on your platform.');
}

// Run setup
setupWhisper().catch(console.error);