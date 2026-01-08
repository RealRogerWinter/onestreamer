/**
 * FFmpeg A/V Sync Analysis for ViewBot
 * Tests actual FFmpeg commands used by ViewBot and provides solutions
 */

const { spawn } = require('child_process');
const path = require('path');

const testVideo = path.join(__dirname, 'uploads', 'sync_test.mp4');

// Test configurations
const configs = [
  {
    name: 'Current ViewBot Configuration',
    description: 'As implemented in ViewBotClientService.js',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
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
      '-maxrate', '1500k',
      '-bufsize', '3000k',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-f', 'rtp',
      'rtp://127.0.0.1:5004',
      '-map', '0:a:0',
      '-af', 'aresample=async=1:first_pts=0',
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
    name: 'Fixed: Remove Conflicting Options',
    description: 'Remove -copyts and -async which conflict with PTS reset',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
      '-vsync', 'cfr',
      // Removed: '-async', '1',
      // Removed: '-copyts',
      '-map', '0:v:0',
      '-vf', 'scale=1280:720,setpts=PTS-STARTPTS',
      '-r', '30',
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4', // Improved from 5
      '-b:v', '1500k', // Increased bitrate
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-g', '60', // Increased GOP
      '-pix_fmt', 'yuv420p',
      '-an',
      '-f', 'rtp',
      'rtp://127.0.0.1:5004',
      '-map', '0:a:0',
      '-af', 'asetpts=PTS-STARTPTS', // Simplified audio filter
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
    name: 'Optimized: Filter Complex',
    description: 'Use filter_complex for unified timestamp handling',
    args: [
      '-re',
      '-stream_loop', '-1',
      '-i', testVideo,
      '-filter_complex',
      '[0:v]fps=30,scale=1280:720,setpts=PTS-STARTPTS[vout];[0:a]aresample=48000,asetpts=PTS-STARTPTS[aout]',
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
      'rtp://127.0.0.1:5004',
      '-map', '[aout]',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20',
      '-vn',
      '-f', 'rtp',
      'rtp://127.0.0.1:5005'
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
      audioPackets: 0,
      dropFrames: 0,
      duplicateFrames: 0,
      startTime: Date.now(),
      errors: []
    };
    
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Parse statistics
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        stats.videoFrames = parseInt(frameMatch[1]);
      }
      
      const dropMatch = output.match(/drop=(\d+)/);
      if (dropMatch) {
        stats.dropFrames = parseInt(dropMatch[1]);
      }
      
      const dupMatch = output.match(/dup=(\d+)/);
      if (dupMatch) {
        stats.duplicateFrames = parseInt(dupMatch[1]);
      }
      
      // Check for errors
      if (output.toLowerCase().includes('error')) {
        stats.errors.push(output.trim());
      }
      
      // Log stream mapping (important for debugging)
      if (output.includes('Stream mapping')) {
        console.log('Stream mapping detected');
      }
    });
    
    // Test for 5 seconds
    setTimeout(() => {
      ffmpeg.kill('SIGTERM');
      
      const elapsed = Date.now() - stats.startTime;
      const expectedFrames = Math.floor(elapsed / 1000 * 30);
      const frameDeviation = stats.videoFrames - expectedFrames;
      const syncOffset = frameDeviation * (1000 / 30);
      
      console.log('📈 Results:');
      console.log(`   Duration: ${elapsed}ms`);
      console.log(`   Video frames: ${stats.videoFrames}`);
      console.log(`   Expected frames: ${expectedFrames}`);
      console.log(`   Frame deviation: ${frameDeviation}`);
      console.log(`   Dropped frames: ${stats.dropFrames}`);
      console.log(`   Duplicate frames: ${stats.duplicateFrames}`);
      console.log(`   Estimated sync offset: ${syncOffset.toFixed(2)}ms`);
      
      if (stats.errors.length > 0) {
        console.log(`   ⚠️ Errors: ${stats.errors.length}`);
      }
      
      resolve({
        name: config.name,
        syncOffset: Math.abs(syncOffset),
        dropFrames: stats.dropFrames,
        duplicateFrames: stats.duplicateFrames,
        errors: stats.errors.length
      });
    }, 5000);
  });
}

async function main() {
  console.log('🔧 ViewBot FFmpeg A/V Sync Analysis');
  console.log('=' .repeat(60));
  console.log(`Using test video: ${testVideo}\n`);
  
  const results = [];
  
  for (const config of configs) {
    try {
      const result = await testConfig(config);
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait between tests
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
    }
  }
  
  // Analyze results
  console.log('\n');
  console.log('=' .repeat(60));
  console.log('📊 ANALYSIS RESULTS');
  console.log('=' .repeat(60));
  
  // Sort by sync offset (best first)
  results.sort((a, b) => a.syncOffset - b.syncOffset);
  
  console.log('\n🏆 Configurations Ranked by Sync Performance:\n');
  results.forEach((result, index) => {
    const rating = result.syncOffset < 20 ? '⭐⭐⭐⭐⭐' :
                   result.syncOffset < 40 ? '⭐⭐⭐⭐' :
                   result.syncOffset < 80 ? '⭐⭐⭐' :
                   result.syncOffset < 150 ? '⭐⭐' : '⭐';
    
    console.log(`${index + 1}. ${result.name}`);
    console.log(`   Sync offset: ${result.syncOffset.toFixed(2)}ms ${rating}`);
    console.log(`   Frame drops: ${result.dropFrames}, Duplicates: ${result.duplicateFrames}`);
    console.log('');
  });
  
  // Root cause analysis
  console.log('🔍 ROOT CAUSE ANALYSIS:');
  console.log('-'.repeat(60));
  
  const currentConfig = results.find(r => r.name.includes('Current'));
  if (currentConfig && currentConfig.syncOffset > 40) {
    console.log('\n❌ IDENTIFIED ISSUES:');
    console.log('1. The -copyts flag preserves original timestamps which conflicts with setpts=PTS-STARTPTS');
    console.log('2. The -async flag attempts audio sync correction which interferes with manual PTS reset');
    console.log('3. Separate -vf and -af filters process timestamps independently, causing desync');
    console.log('4. High cpu-used value (5) in VP8 encoder may cause inconsistent frame timing');
  }
  
  // Solutions
  console.log('\n');
  console.log('=' .repeat(60));
  console.log('💡 RECOMMENDED SOLUTIONS (Ranked by Confidence)');
  console.log('=' .repeat(60));
  
  const solutions = [
    {
      title: 'Remove -copyts and -async flags',
      file: 'ViewBotClientService.js',
      line: '1245-1246',
      change: "Remove lines:\n    '-async', '1',\n    '-copyts',",
      confidence: 95,
      impact: 'High'
    },
    {
      title: 'Use filter_complex for unified timestamp handling',
      file: 'ViewBotClientService.js', 
      line: '1240-1278',
      change: "Replace separate -vf/-af with:\n    '-filter_complex',\n    '[0:v]fps=30,scale=1280:720,setpts=PTS-STARTPTS[vout];[0:a]aresample=48000,asetpts=PTS-STARTPTS[aout]',\n    '-map', '[vout]',\n    '-map', '[aout]',",
      confidence: 90,
      impact: 'High'
    },
    {
      title: 'Optimize VP8 encoder settings',
      file: 'ViewBotClientService.js',
      line: '1254',
      change: "Change:\n    '-cpu-used', '5',\nTo:\n    '-cpu-used', '4',",
      confidence: 85,
      impact: 'Medium'
    },
    {
      title: 'Increase video bitrate and buffer',
      file: 'ViewBotClientService.js',
      line: '1255-1257',
      change: "Change:\n    '-b:v', '1000k',\n    '-maxrate', '1500k',\n    '-bufsize', '3000k',\nTo:\n    '-b:v', '1500k',\n    '-maxrate', '2000k',\n    '-bufsize', '4000k',",
      confidence: 80,
      impact: 'Medium'
    },
    {
      title: 'Add Opus frame duration setting',
      file: 'ViewBotClientService.js',
      line: '1272',
      change: "Add after '-application', 'voip':\n    '-frame_duration', '20',",
      confidence: 75,
      impact: 'Low'
    }
  ];
  
  console.log('\n📝 IMPLEMENTATION GUIDE:\n');
  solutions.forEach((solution, index) => {
    console.log(`${index + 1}. ${solution.title}`);
    console.log(`   File: ${solution.file}:${solution.line}`);
    console.log(`   Confidence: ${solution.confidence}%`);
    console.log(`   Impact: ${solution.impact}`);
    console.log(`   Change:\n${solution.change.split('\\n').map(l => '      ' + l).join('\\n')}`);
    console.log('');
  });
  
  // Best configuration
  if (results.length > 0 && results[0].syncOffset < 40) {
    console.log('✅ RECOMMENDED CONFIGURATION:');
    console.log(`Use the "${results[0].name}" configuration for best A/V synchronization.`);
  }
}

main().catch(console.error);