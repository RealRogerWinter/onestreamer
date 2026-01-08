/**
 * Test GStreamer Pipeline for Visual FX
 */

const { spawn } = require('child_process');

const gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';

// Test ports
const extractPorts = {
    video: 50037,
    audio: 50159
};

const injectPorts = {
    video: 50058,
    audio: 50062
};

// Build the potato pipeline
const pipeline = [
    // Video input from MediaSoup
    `udpsrc port=${extractPorts.video} caps="application/x-rtp,media=video,encoding-name=VP8,payload=96"`,
    '! rtpvp8depay',
    '! vp8dec',
    
    // Potato degradation: scale down, reduce quality
    '! videoscale',
    '! video/x-raw,width=320,height=240',  // Ultra low resolution
    '! videoconvert',
    '! videorate',
    '! video/x-raw,framerate=10/1',  // Low framerate
    
    // Re-encode with very low bitrate - ALL PROPERTIES ON ONE LINE
    '! vp8enc deadline=1 cpu-used=16 target-bitrate=30000 min-quantizer=50 max-quantizer=63',
    
    // Send back to MediaSoup
    '! rtpvp8pay ssrc=12345678 pt=96',
    `! udpsink host=127.0.0.1 port=${injectPorts.video}`,
    
    // Audio passthrough with quality reduction
    `udpsrc port=${extractPorts.audio} caps="application/x-rtp,media=audio,encoding-name=OPUS,payload=111"`,
    '! rtpopusdepay',
    '! opusdec',
    '! audioconvert',
    '! audioresample',
    '! audio/x-raw,rate=8000,channels=1',  // Phone quality
    '! opusenc bitrate=8000',  // 8kbps
    '! rtpopuspay ssrc=87654321 pt=111',
    `! udpsink host=127.0.0.1 port=${injectPorts.audio}`
];

console.log('Testing GStreamer Pipeline:');
console.log('Command:', `gst-launch-1.0 ${pipeline.join(' ')}`);
console.log('\nStarting pipeline...\n');

// For Windows with spaces in path, we need to quote the path and use shell
const fullCommand = `"${gstreamerPath}" ${pipeline.join(' ')}`;
const process = spawn(fullCommand, [], {
    shell: true,  // REQUIRED for Windows
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe']
});

process.stdout.on('data', (data) => {
    console.log('STDOUT:', data.toString());
});

process.stderr.on('data', (data) => {
    const message = data.toString();
    if (message.includes('ERROR') || message.includes('erroneous pipeline') || message.includes('syntax error')) {
        console.error('❌ PIPELINE ERROR:', message);
    } else if (message.includes('WARNING')) {
        console.warn('⚠️ WARNING:', message);
    } else {
        console.log('STDERR:', message);
    }
});

process.on('error', (error) => {
    console.error('❌ SPAWN ERROR:', error);
});

process.on('exit', (code) => {
    console.log(`\nPipeline exited with code ${code}`);
    if (code === 0) {
        console.log('✅ Pipeline syntax is valid!');
    } else {
        console.log('❌ Pipeline has errors');
    }
});

// Give it 5 seconds then kill it
setTimeout(() => {
    console.log('\nStopping test pipeline...');
    process.kill();
}, 5000);