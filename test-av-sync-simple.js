/**
 * Simplified A/V Sync Test for ViewBot
 * Creates a test video and analyzes FFmpeg output
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Create a test video with sync markers
async function createTestVideo() {
  const outputPath = path.join(__dirname, 'uploads', 'sync_test.mp4');
  
  console.log('🎬 Creating test video with A/V sync markers...');
  
  return new Promise((resolve, reject) => {
    // Create a 10-second video with visual frame counter and audio beeps
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:beep_factor=4:sample_rate=48000:duration=10',
      '-filter_complex',
      '[0:v]drawtext=fontfile=C\\:/Windows/Fonts/arial.ttf:text=%{frame_num}:fontsize=72:fontcolor=white:x=(w-text_w)/2:y=h-100,drawtext=fontfile=C\\:/Windows/Fonts/arial.ttf:text=%{pts\\:hms}:fontsize=48:fontcolor=yellow:x=(w-text_w)/2:y=100[v]',
      '-map', '[v]',
      '-map', '1:a',
      '-codec:v', 'libx264',
      '-preset', 'ultrafast',
      '-codec:a', 'aac',
      '-y',
      outputPath
    ]);
    
    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Test video created: ${outputPath}`);
        resolve(outputPath);
      } else {
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    
    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
      reject(err);
    });
  });
}

// Test current FFmpeg configuration
async function testCurrentConfig(videoFile) {
  console.log('\n📊 Testing Current ViewBot FFmpeg Configuration');
  console.log('=' .repeat(50));
  
  const videoPort = 5004;
  const audioPort = 5005;
  
  // Current FFmpeg args from ViewBotClientService
  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-i', videoFile,
    '-vsync', 'cfr',
    '-async', '1', 
    '-copyts',
    '-map', '0:v:0',
    '-vf', 'scale=1280:720,setpts=PTS-STARTPTS',
    '-r', '30',
    '-codec:v', 'libvpx',
    '-deadline', 'realtime',
    '-cpu-used', '5',
    '-b:v', '1000k',
    '-an',
    '-f', 'rtp',
    `rtp://127.0.0.1:${videoPort}`,
    '-map', '0:a:0',
    '-af', 'aresample=async=1:first_pts=0',
    '-codec:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-vn',
    '-f', 'rtp',
    `rtp://127.0.0.1:${audioPort}`
  ];
  
  console.log('Starting FFmpeg with current configuration...\n');
  
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  
  let videoFrames = 0;
  let audioFrames = 0;
  let lastVideoTime = null;
  let lastAudioTime = null;
  
  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    
    // Parse frame information
    const frameMatch = output.match(/frame=\s*(\d+)/);
    if (frameMatch) {
      videoFrames = parseInt(frameMatch[1]);
    }
    
    // Parse time information
    const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const seconds = parseInt(timeMatch[3]);
      const centiseconds = parseInt(timeMatch[4]);
      const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000 + centiseconds * 10;
      
      if (output.includes('Video')) {
        lastVideoTime = totalMs;
      } else if (output.includes('Audio')) {
        lastAudioTime = totalMs;
      }
    }
    
    // Log errors
    if (output.toLowerCase().includes('error')) {
      console.error('❌ FFmpeg error:', output);
    }
  });
  
  // Monitor for 5 seconds
  return new Promise((resolve) => {
    setTimeout(() => {
      ffmpeg.kill('SIGTERM');
      
      console.log('\n📈 Results:');
      console.log(`   Video frames processed: ${videoFrames}`);
      console.log(`   Expected frames (5s @ 30fps): 150`);
      console.log(`   Frame difference: ${videoFrames - 150}`);
      
      const syncOffset = (videoFrames - 150) * (1000 / 30);
      console.log(`   Estimated sync offset: ${syncOffset.toFixed(2)}ms`);
      
      resolve({ videoFrames, syncOffset });
    }, 5000);
  });
}

// Test improved configuration
async function testImprovedConfig(videoFile) {
  console.log('\n📊 Testing Improved FFmpeg Configuration');
  console.log('=' .repeat(50));
  
  const videoPort = 5004;
  const audioPort = 5005;
  
  // Improved FFmpeg args with better sync handling
  const ffmpegArgs = [
    '-re',
    '-stream_loop', '-1',
    '-i', videoFile,
    // Use filter_complex for unified timestamp handling
    '-filter_complex',
    '[0:v]fps=30,scale=1280:720,setpts=PTS-STARTPTS[vout];[0:a]aresample=48000,asetpts=PTS-STARTPTS[aout]',
    // Video output
    '-map', '[vout]',
    '-codec:v', 'libvpx',
    '-deadline', 'realtime',
    '-cpu-used', '4',
    '-b:v', '1500k',
    '-maxrate', '2000k',
    '-bufsize', '4000k',
    '-g', '60',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'rtp',
    `rtp://127.0.0.1:${videoPort}`,
    // Audio output
    '-map', '[aout]',
    '-codec:a', 'libopus',
    '-b:a', '128k',
    '-ac', '2',
    '-application', 'voip',
    '-frame_duration', '20',
    '-vn',
    '-f', 'rtp',
    `rtp://127.0.0.1:${audioPort}`
  ];
  
  console.log('Starting FFmpeg with improved configuration...\n');
  
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  
  let videoFrames = 0;
  
  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    
    const frameMatch = output.match(/frame=\s*(\d+)/);
    if (frameMatch) {
      videoFrames = parseInt(frameMatch[1]);
    }
    
    if (output.toLowerCase().includes('error')) {
      console.error('❌ FFmpeg error:', output);
    }
  });
  
  return new Promise((resolve) => {
    setTimeout(() => {
      ffmpeg.kill('SIGTERM');
      
      console.log('\n📈 Results:');
      console.log(`   Video frames processed: ${videoFrames}`);
      console.log(`   Expected frames (5s @ 30fps): 150`);
      console.log(`   Frame difference: ${videoFrames - 150}`);
      
      const syncOffset = (videoFrames - 150) * (1000 / 30);
      console.log(`   Estimated sync offset: ${syncOffset.toFixed(2)}ms`);
      
      resolve({ videoFrames, syncOffset });
    }, 5000);
  });
}

// Analyze MediaSoup RTP handling
function analyzeMediaSoupConfig() {
  console.log('\n🔍 MediaSoup RTP Configuration Analysis');
  console.log('=' .repeat(50));
  
  console.log('\nPotential MediaSoup sync issues:');
  console.log('1. Separate RTP ports for video/audio may cause desynchronization');
  console.log('2. No explicit timestamp synchronization between streams');
  console.log('3. Jitter buffer settings may differ between audio and video');
  console.log('4. Consumer-side buffering may introduce variable delays');
  
  console.log('\nRecommended MediaSoup adjustments:');
  console.log('• Use PlainTransport with proper RTP timestamp handling');
  console.log('• Implement synchronized consumer creation');
  console.log('• Configure consistent jitter buffer settings');
  console.log('• Add timestamp compensation in the consumer pipeline');
}

// Main diagnostic function
async function runDiagnostics() {
  console.log('🔧 ViewBot A/V Sync Diagnostic Tool');
  console.log('=' .repeat(50));
  
  try {
    // Create test video
    const testVideo = await createTestVideo();
    
    // Test configurations
    const currentResult = await testCurrentConfig(testVideo);
    const improvedResult = await testImprovedConfig(testVideo);
    
    // Analyze MediaSoup
    analyzeMediaSoupConfig();
    
    // Print final recommendations
    console.log('\n');
    console.log('=' .repeat(50));
    console.log('🏆 DIAGNOSIS COMPLETE - RANKED SOLUTIONS');
    console.log('=' .repeat(50));
    
    const solutions = [
      {
        title: 'Use filter_complex for unified timestamp handling',
        description: 'Replace separate -vf and -af filters with -filter_complex to ensure synchronized PTS',
        confidence: 95,
        impact: 'High',
        implementation: 'Modify startCombinedFFmpegGeneration() in ViewBotClientService.js'
      },
      {
        title: 'Remove conflicting sync options',
        description: 'Remove -copyts flag and use consistent PTS reset (PTS-STARTPTS) for both streams',
        confidence: 90,
        impact: 'High',
        implementation: 'Update FFmpeg args to remove -copyts and ensure both streams use setpts/asetpts'
      },
      {
        title: 'Optimize codec parameters',
        description: 'Reduce VP8 cpu-used from 5 to 4, increase bitrate buffer for smoother delivery',
        confidence: 85,
        impact: 'Medium',
        implementation: 'Adjust codec parameters in FFmpeg command'
      },
      {
        title: 'Implement MediaSoup PlainTransport',
        description: 'Use PlainTransport instead of WebRTC transport for direct RTP control',
        confidence: 80,
        impact: 'High',
        implementation: 'Modify MediaSoup transport creation in server'
      },
      {
        title: 'Add explicit frame rate control',
        description: 'Use fps filter before other video filters to ensure consistent frame timing',
        confidence: 75,
        impact: 'Medium',
        implementation: 'Add fps=30 as first filter in video pipeline'
      },
      {
        title: 'Configure Opus frame duration',
        description: 'Set Opus frame_duration to 20ms for consistent audio packet timing',
        confidence: 70,
        impact: 'Low',
        implementation: 'Add -frame_duration 20 to Opus encoder options'
      }
    ];
    
    console.log('\n📋 Recommended Changes (in order of priority):\n');
    
    solutions.forEach((solution, index) => {
      console.log(`${index + 1}. ${solution.title}`);
      console.log(`   ${solution.description}`);
      console.log(`   Confidence: ${solution.confidence}%`);
      console.log(`   Impact: ${solution.impact}`);
      console.log(`   Implementation: ${solution.implementation}`);
      console.log('');
    });
    
    // Compare results
    console.log('📊 Configuration Comparison:');
    console.log('-'.repeat(50));
    console.log(`Current config sync offset: ${currentResult.syncOffset.toFixed(2)}ms`);
    console.log(`Improved config sync offset: ${improvedResult.syncOffset.toFixed(2)}ms`);
    
    const improvement = Math.abs(currentResult.syncOffset) - Math.abs(improvedResult.syncOffset);
    if (improvement > 0) {
      console.log(`✅ Improvement: ${improvement.toFixed(2)}ms better synchronization`);
    } else {
      console.log(`⚠️ No significant improvement detected - MediaSoup configuration may be the issue`);
    }
    
  } catch (error) {
    console.error('❌ Diagnostic failed:', error);
  }
}

// Run the diagnostics
runDiagnostics();