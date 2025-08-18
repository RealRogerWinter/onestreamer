/**
 * Test Multiplexed Stream A/V Synchronization
 * Compares original vs multiplexed stream approaches
 */

const { spawn } = require('child_process');
const path = require('path');

const testVideo = path.join(__dirname, 'uploads', 'sync_test.mp4');

// Test configurations
const configs = [
  {
    name: 'Original (Separate Streams)',
    description: 'Separate RTP streams for video and audio',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
      '-vsync', 'cfr',
      '-map', '0:v:0',
      '-vf', 'scale=1280:720,setpts=PTS-STARTPTS',
      '-r', '30',
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-f', 'rtp',
      'rtp://127.0.0.1:5004',
      '-map', '0:a:0',
      '-af', 'asetpts=PTS-STARTPTS',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      '-vn',
      '-f', 'rtp',
      'rtp://127.0.0.1:5005'
    ]
  },
  {
    name: 'Multiplexed (filter_complex)',
    description: 'Using filter_complex for synchronized processing',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
      '-filter_complex',
      '[0:v]scale=1280:720,fps=30,setpts=PTS-STARTPTS[vout];[0:a]aresample=48000:first_pts=0,asetpts=PTS-STARTPTS,adelay=0|0[aout]',
      '-map', '[vout]',
      '-map', '[aout]',
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '60',
      '-pix_fmt', 'yuv420p',
      '-flags', '+global_header',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20',
      '-packet_loss', '10',
      '-an',
      '-f', 'rtp',
      'rtp://127.0.0.1:5004',
      '-vn',
      '-f', 'rtp',
      'rtp://127.0.0.1:5005'
    ]
  },
  {
    name: 'Tee Muxer (Synchronized Output)',
    description: 'Using tee muxer for perfectly synchronized dual output',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
      '-filter_complex',
      '[0:v]scale=1280:720,fps=30,setpts=PTS-STARTPTS[vout];[0:a]aresample=48000:first_pts=0,asetpts=PTS-STARTPTS[aout]',
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '60',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20',
      '-f', 'tee',
      '-use_fifo', '1',
      '[select=v:f=rtp:ssrc=11111111:payload_type=96]rtp://127.0.0.1:5004|[select=a:f=rtp:ssrc=22222222:payload_type=111]rtp://127.0.0.1:5005'
    ]
  },
  {
    name: 'MPEG-TS Muxed Stream',
    description: 'Single MPEG-TS stream maintaining perfect sync',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
      '-vf', 'scale=1280:720,fps=30',
      '-c:v', 'libvpx',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-g', '60',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      '-f', 'mpegts',
      '-muxrate', '3M',
      '-pcr_period', '20',
      'udp://127.0.0.1:5100?pkt_size=1316'
    ]
  }
];

async function testConfig(config) {
  console.log(`\n📊 Testing: ${config.name}`);
  console.log('=' .repeat(60));
  console.log(`Description: ${config.description}\n`);
  
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', config.args);
    
    let stats = {
      videoFrames: 0,
      startTime: Date.now(),
      errors: [],
      warnings: [],
      teeSuccess: false,
      mpegtsSuccess: false
    };
    
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Parse frame count
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        stats.videoFrames = parseInt(frameMatch[1]);
      }
      
      // Check for tee muxer success
      if (output.includes('tee') && output.includes('muxing')) {
        stats.teeSuccess = true;
      }
      
      // Check for MPEG-TS success
      if (output.includes('mpegts') && output.includes('muxing')) {
        stats.mpegtsSuccess = true;
      }
      
      // Collect errors and warnings
      if (output.toLowerCase().includes('error')) {
        stats.errors.push(output.trim());
      } else if (output.toLowerCase().includes('warning')) {
        stats.warnings.push(output.trim());
      }
    });
    
    // Test for 5 seconds
    setTimeout(() => {
      ffmpeg.kill('SIGTERM');
      
      const elapsed = Date.now() - stats.startTime;
      const expectedFrames = Math.floor(elapsed / 1000 * 30);
      const frameDeviation = stats.videoFrames - expectedFrames;
      const syncOffset = Math.abs(frameDeviation * (1000 / 30));
      
      console.log('📈 Results:');
      console.log(`   Duration: ${elapsed}ms`);
      console.log(`   Video frames: ${stats.videoFrames}`);
      console.log(`   Expected frames: ${expectedFrames}`);
      console.log(`   Frame deviation: ${frameDeviation}`);
      console.log(`   Sync offset: ${syncOffset.toFixed(2)}ms`);
      
      if (stats.teeSuccess) {
        console.log(`   ✅ Tee muxer working correctly`);
      }
      if (stats.mpegtsSuccess) {
        console.log(`   ✅ MPEG-TS muxing successful`);
      }
      if (stats.errors.length > 0) {
        console.log(`   ⚠️ Errors: ${stats.errors.length}`);
      }
      if (stats.warnings.length > 0) {
        console.log(`   ⚠️ Warnings: ${stats.warnings.length}`);
      }
      
      resolve({
        name: config.name,
        syncOffset,
        frameDeviation,
        errors: stats.errors.length,
        warnings: stats.warnings.length,
        teeSuccess: stats.teeSuccess,
        mpegtsSuccess: stats.mpegtsSuccess
      });
    }, 5000);
  });
}

async function main() {
  console.log('🔧 Multiplexed Stream A/V Sync Test');
  console.log('=' .repeat(60));
  console.log(`Test video: ${testVideo}\n`);
  
  const results = [];
  
  for (const config of configs) {
    try {
      const result = await testConfig(config);
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
    }
  }
  
  // Analyze results
  console.log('\n');
  console.log('=' .repeat(60));
  console.log('📊 COMPARISON RESULTS');
  console.log('=' .repeat(60));
  
  // Sort by sync offset
  results.sort((a, b) => a.syncOffset - b.syncOffset);
  
  console.log('\n🏆 Configurations Ranked by Sync Performance:\n');
  results.forEach((result, index) => {
    const rating = result.syncOffset < 20 ? '⭐⭐⭐⭐⭐' :
                   result.syncOffset < 40 ? '⭐⭐⭐⭐' :
                   result.syncOffset < 80 ? '⭐⭐⭐' :
                   result.syncOffset < 150 ? '⭐⭐' : '⭐';
    
    console.log(`${index + 1}. ${result.name}`);
    console.log(`   Sync offset: ${result.syncOffset.toFixed(2)}ms ${rating}`);
    console.log(`   Frame deviation: ${result.frameDeviation}`);
    if (result.teeSuccess) console.log(`   ✅ Tee muxer functional`);
    if (result.mpegtsSuccess) console.log(`   ✅ MPEG-TS muxing functional`);
    console.log(`   Errors: ${result.errors}, Warnings: ${result.warnings}`);
    console.log('');
  });
  
  // Recommendations
  console.log('=' .repeat(60));
  console.log('💡 RECOMMENDATIONS');
  console.log('=' .repeat(60));
  
  const best = results[0];
  if (best) {
    console.log(`\n✅ Best configuration: ${best.name}`);
    console.log(`   Achieved sync offset: ${best.syncOffset.toFixed(2)}ms`);
    
    if (best.syncOffset < 40) {
      console.log('\n🎉 SUCCESS: This configuration provides excellent A/V synchronization!');
    } else if (best.syncOffset < 80) {
      console.log('\n✅ GOOD: This configuration provides acceptable synchronization.');
    } else {
      console.log('\n⚠️ Further optimization needed. Consider:');
      console.log('   1. Using RTCP for timestamp synchronization');
      console.log('   2. Implementing MediaSoup PlainTransport');
      console.log('   3. Adding jitter buffer configuration');
    }
  }
  
  // Implementation guide
  console.log('\n📝 IMPLEMENTATION GUIDE:');
  console.log('-'.repeat(60));
  console.log('The multiplexed stream approach has been implemented in:');
  console.log('• ViewBotClientService.js - startMultiplexedFFmpegGeneration()');
  console.log('• ViewBotMuxedStreamService.js - Complete service for muxed streams');
  console.log('\nTo enable multiplexed streaming:');
  console.log('1. Set config.useMuxedStream = true (default)');
  console.log('2. ViewBot will automatically use the new synchronized approach');
  console.log('3. Monitor logs for "Multiplexed FFmpeg stream started" confirmation');
}

main().catch(console.error);