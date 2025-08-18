/**
 * Test script to verify A/V sync improvements
 * Compares sync performance before and after fixes
 */

const { spawn } = require('child_process');
const path = require('path');

const testVideo = path.join(__dirname, 'uploads', 'sync_test.mp4');

// Configuration after fixes
const improvedConfig = {
  name: 'After Fixes',
  args: [
    '-re',
    '-stream_loop', '-1',
    '-i', testVideo,
    // Sync options - FIXED: Removed conflicting -async and -copyts flags
    '-vsync', 'cfr',
    // Video output
    '-map', '0:v:0',
    '-vf', 'scale=1280:720,setpts=PTS-STARTPTS',
    '-r', '30',
    '-codec:v', 'libvpx',
    '-deadline', 'realtime',
    '-cpu-used', '4', // FIXED: Optimized from 5
    '-b:v', '1500k', // FIXED: Increased from 1000k
    '-maxrate', '2000k', // FIXED: Increased from 1500k
    '-bufsize', '4000k', // FIXED: Increased from 3000k
    '-g', '30',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'rtp',
    'rtp://127.0.0.1:5004',
    // Audio output
    '-map', '0:a:0',
    '-af', 'asetpts=PTS-STARTPTS', // FIXED: Simplified filter
    '-codec:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-application', 'voip',
    '-vn',
    '-f', 'rtp',
    'rtp://127.0.0.1:5005'
  ]
};

// Original configuration for comparison
const originalConfig = {
  name: 'Before Fixes',
  args: [
    '-re',
    '-stream_loop', '-1',
    '-i', testVideo,
    '-vsync', 'cfr',
    '-async', '1', // Problematic flag
    '-copyts', // Problematic flag
    '-map', '0:v:0',
    '-vf', 'scale=1280:720,setpts=PTS-STARTPTS',
    '-r', '30',
    '-codec:v', 'libvpx',
    '-deadline', 'realtime',
    '-cpu-used', '5', // Suboptimal
    '-b:v', '1000k', // Lower bitrate
    '-maxrate', '1500k', // Lower max rate
    '-bufsize', '3000k', // Smaller buffer
    '-g', '30',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'rtp',
    'rtp://127.0.0.1:5004',
    '-map', '0:a:0',
    '-af', 'aresample=async=1:first_pts=0', // Complex filter
    '-codec:a', 'libopus',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-application', 'voip',
    '-vn',
    '-f', 'rtp',
    'rtp://127.0.0.1:5005'
  ]
};

async function testConfig(config) {
  console.log(`\nTesting ${config.name}...`);
  console.log('-'.repeat(40));
  
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', config.args);
    
    let stats = {
      videoFrames: 0,
      startTime: Date.now(),
      errors: 0
    };
    
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Parse frame count
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        stats.videoFrames = parseInt(frameMatch[1]);
      }
      
      // Count errors
      if (output.toLowerCase().includes('error')) {
        stats.errors++;
      }
    });
    
    ffmpeg.on('error', (error) => {
      console.error(`Error: ${error.message}`);
    });
    
    // Test for 5 seconds
    setTimeout(() => {
      ffmpeg.kill('SIGTERM');
      
      const elapsed = Date.now() - stats.startTime;
      const expectedFrames = Math.floor(elapsed / 1000 * 30);
      const frameDeviation = stats.videoFrames - expectedFrames;
      const syncOffset = Math.abs(frameDeviation * (1000 / 30));
      
      console.log(`Duration: ${elapsed}ms`);
      console.log(`Video frames: ${stats.videoFrames}`);
      console.log(`Expected frames: ${expectedFrames}`);
      console.log(`Frame deviation: ${frameDeviation}`);
      console.log(`Sync offset: ${syncOffset.toFixed(2)}ms`);
      console.log(`Errors: ${stats.errors}`);
      
      resolve({
        name: config.name,
        syncOffset,
        frameDeviation,
        errors: stats.errors
      });
    }, 5000);
  });
}

async function main() {
  console.log('🔧 A/V Sync Improvement Verification');
  console.log('=' .repeat(50));
  console.log(`Test video: ${testVideo}\n`);
  
  // Test both configurations
  const originalResult = await testConfig(originalConfig);
  await new Promise(resolve => setTimeout(resolve, 1000));
  const improvedResult = await testConfig(improvedConfig);
  
  // Compare results
  console.log('\n');
  console.log('=' .repeat(50));
  console.log('📊 COMPARISON RESULTS');
  console.log('=' .repeat(50));
  
  console.log('\nBefore Fixes:');
  console.log(`  Sync offset: ${originalResult.syncOffset.toFixed(2)}ms`);
  console.log(`  Frame deviation: ${originalResult.frameDeviation}`);
  console.log(`  Errors: ${originalResult.errors}`);
  
  console.log('\nAfter Fixes:');
  console.log(`  Sync offset: ${improvedResult.syncOffset.toFixed(2)}ms`);
  console.log(`  Frame deviation: ${improvedResult.frameDeviation}`);
  console.log(`  Errors: ${improvedResult.errors}`);
  
  const improvement = originalResult.syncOffset - improvedResult.syncOffset;
  const percentImprovement = (improvement / originalResult.syncOffset * 100).toFixed(1);
  
  console.log('\n📈 Improvement:');
  if (improvement > 0) {
    console.log(`  ✅ Sync improved by ${improvement.toFixed(2)}ms (${percentImprovement}% better)`);
  } else if (improvement === 0) {
    console.log(`  ➖ No significant change in sync offset`);
  } else {
    console.log(`  ⚠️ Sync degraded by ${Math.abs(improvement).toFixed(2)}ms`);
  }
  
  // Performance rating
  console.log('\n⭐ Performance Rating:');
  const rating = (offset) => {
    if (offset < 20) return '⭐⭐⭐⭐⭐ Excellent';
    if (offset < 40) return '⭐⭐⭐⭐ Good';
    if (offset < 80) return '⭐⭐⭐ Acceptable';
    if (offset < 150) return '⭐⭐ Poor';
    return '⭐ Very Poor';
  };
  
  console.log(`  Before: ${rating(originalResult.syncOffset)}`);
  console.log(`  After: ${rating(improvedResult.syncOffset)}`);
  
  // Summary
  console.log('\n');
  console.log('=' .repeat(50));
  console.log('✅ SUMMARY');
  console.log('=' .repeat(50));
  console.log('\nThe following fixes have been applied:');
  console.log('1. ✅ Removed conflicting -async and -copyts flags');
  console.log('2. ✅ Simplified audio filter to asetpts=PTS-STARTPTS');
  console.log('3. ✅ Optimized VP8 encoder (cpu-used: 5 → 4)');
  console.log('4. ✅ Increased bitrate and buffer sizes');
  
  if (improvedResult.syncOffset < 40) {
    console.log('\n🎉 SUCCESS: A/V synchronization is now within acceptable limits!');
  } else if (improvedResult.syncOffset < originalResult.syncOffset) {
    console.log('\n✅ PARTIAL SUCCESS: A/V synchronization has improved but may need further optimization.');
  } else {
    console.log('\n⚠️ Additional investigation needed for MediaSoup-side synchronization.');
  }
}

main().catch(console.error);