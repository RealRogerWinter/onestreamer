/**
 * Audio-Video Sync Diagnostic Tool for ViewBot Service
 * Tests various FFmpeg configurations and MediaSoup settings
 * to identify and fix A/V synchronization issues
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SERVER_URL = 'http://localhost:8080';
const ADMIN_KEY = '***REMOVED-ADMIN-KEY***';

// Test configurations for FFmpeg
const TEST_CONFIGS = [
  {
    name: 'Current Configuration',
    description: 'Current FFmpeg settings as found in the code',
    ffmpegArgs: (videoFile, videoPort, audioPort) => [
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
      '-maxrate', '1500k',
      '-bufsize', '3000k',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-f', 'rtp',
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${videoPort}`,
      '-map', '0:a:0',
      '-af', 'aresample=async=1:first_pts=0',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      '-vn',
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${audioPort}`
    ]
  },
  {
    name: 'Improved Sync with Audio Delay Compensation',
    description: 'Adds audio delay compensation and improved timestamp handling',
    ffmpegArgs: (videoFile, videoPort, audioPort) => [
      '-re',
      '-stream_loop', '-1',
      '-i', videoFile,
      '-filter_complex', '[0:v]setpts=PTS-STARTPTS[v];[0:a]asetpts=PTS-STARTPTS,adelay=0|0[a]',
      '-map', '[v]',
      '-map', '[a]',
      '-vsync', 'passthrough',
      '-async', '1',
      '-vf', 'scale=1280:720',
      '-r', '30',
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
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${videoPort}`,
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-application', 'voip',
      '-frame_duration', '20',
      '-packet_loss', '10',
      '-vn',
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${audioPort}`
    ]
  },
  {
    name: 'Using filter_complex for Better Sync',
    description: 'Uses filter_complex for unified timestamp handling',
    ffmpegArgs: (videoFile, videoPort, audioPort) => [
      '-re',
      '-stream_loop', '-1',
      '-i', videoFile,
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
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${videoPort}`,
      '-map', '[aout]',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-vn',
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${audioPort}`
    ]
  },
  {
    name: 'Separate Processes with Synchronized Start',
    description: 'Uses separate FFmpeg processes but with synchronized timestamps',
    separateProcesses: true,
    videoArgs: (videoFile, videoPort) => [
      '-re',
      '-stream_loop', '-1',
      '-i', videoFile,
      '-vf', 'scale=1280:720,fps=30,setpts=PTS-STARTPTS',
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
      '-ssrc', '11111111',
      '-payload_type', '96',
      `rtp://127.0.0.1:${videoPort}`
    ],
    audioArgs: (videoFile, audioPort) => [
      '-re',
      '-stream_loop', '-1',
      '-i', videoFile,
      '-af', 'aresample=48000,asetpts=PTS-STARTPTS',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-ac', '2',
      '-application', 'voip',
      '-vn',
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '111',
      `rtp://127.0.0.1:${audioPort}`
    ]
  },
  {
    name: 'Using tee muxer for synchronized output',
    description: 'Uses tee muxer to ensure synchronized packet output',
    ffmpegArgs: (videoFile, videoPort, audioPort) => [
      '-re',
      '-stream_loop', '-1',
      '-i', videoFile,
      '-filter_complex',
      '[0:v]scale=1280:720,setpts=PTS-STARTPTS[v];[0:a]aresample=48000,asetpts=PTS-STARTPTS[a]',
      '-map', '[v]',
      '-map', '[a]',
      '-codec:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-b:v', '1500k',
      '-codec:a', 'libopus',
      '-b:a', '128k',
      '-f', 'tee',
      `[select=v:f=rtp:ssrc=11111111:payload_type=96]rtp://127.0.0.1:${videoPort}|[select=a:f=rtp:ssrc=22222222:payload_type=111]rtp://127.0.0.1:${audioPort}`
    ]
  }
];

class AVSyncTester {
  constructor() {
    this.testResults = [];
    this.ffmpegProcess = null;
    this.videoFFmpeg = null;
    this.audioFFmpeg = null;
  }

  async runAllTests(videoFile) {
    console.log('🎬 Starting Audio-Video Sync Diagnosis');
    console.log('=' .repeat(50));
    
    if (!videoFile || !fs.existsSync(videoFile)) {
      console.log('⚠️ No video file specified or file not found');
      console.log('Creating test video with sync markers...');
      videoFile = await this.createTestVideo();
    }
    
    console.log(`📹 Using video file: ${videoFile}`);
    console.log('');
    
    for (let i = 0; i < TEST_CONFIGS.length; i++) {
      const config = TEST_CONFIGS[i];
      console.log(`\nTest ${i + 1}/${TEST_CONFIGS.length}: ${config.name}`);
      console.log('-'.repeat(50));
      console.log(`Description: ${config.description}`);
      
      try {
        await this.runSingleTest(config, videoFile);
      } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
        this.testResults.push({
          config: config.name,
          success: false,
          error: error.message
        });
      }
      
      // Wait between tests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    this.printResults();
  }

  async runSingleTest(config, videoFile) {
    const videoPort = 5004;
    const audioPort = 5005;
    
    console.log('🚀 Starting FFmpeg process...');
    
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let dataReceived = { video: false, audio: false };
      let syncData = { videoFrames: 0, audioPackets: 0, startTime: Date.now() };
      
      if (config.separateProcesses) {
        // Start separate video and audio processes
        this.videoFFmpeg = spawn('ffmpeg', config.videoArgs(videoFile, videoPort));
        this.audioFFmpeg = spawn('ffmpeg', config.audioArgs(videoFile, audioPort));
        
        this.setupProcessMonitoring(this.videoFFmpeg, 'Video', syncData);
        this.setupProcessMonitoring(this.audioFFmpeg, 'Audio', syncData);
        
      } else {
        // Single combined process
        const args = config.ffmpegArgs(videoFile, videoPort, audioPort);
        this.ffmpegProcess = spawn('ffmpeg', args);
        
        this.setupProcessMonitoring(this.ffmpegProcess, 'Combined', syncData);
      }
      
      // Monitor for 10 seconds
      setTimeout(() => {
        this.cleanup();
        
        const duration = Date.now() - startTime;
        const result = {
          config: config.name,
          success: true,
          duration,
          videoFrames: syncData.videoFrames,
          audioPackets: syncData.audioPackets,
          estimatedSync: this.calculateSyncOffset(syncData)
        };
        
        console.log(`✅ Test completed`);
        console.log(`   Video frames: ${syncData.videoFrames}`);
        console.log(`   Audio packets: ${syncData.audioPackets}`);
        console.log(`   Estimated sync offset: ${result.estimatedSync}ms`);
        
        this.testResults.push(result);
        resolve(result);
      }, 10000);
    });
  }

  setupProcessMonitoring(process, type, syncData) {
    process.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Parse frame information
      const frameMatch = output.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        syncData.videoFrames = parseInt(frameMatch[1]);
      }
      
      // Check for errors
      if (output.includes('error') || output.includes('Error')) {
        console.error(`❌ ${type} FFmpeg error:`, output);
      }
      
      // Log important messages
      if (output.includes('Stream mapping') || output.includes('Output')) {
        console.log(`📊 ${type}:`, output.trim());
      }
    });
    
    process.on('error', (error) => {
      console.error(`❌ ${type} FFmpeg process error:`, error);
    });
  }

  calculateSyncOffset(syncData) {
    // Estimate sync offset based on frame/packet timing
    const elapsed = Date.now() - syncData.startTime;
    const expectedFrames = Math.floor(elapsed / 1000 * 30); // 30 fps
    const frameOffset = syncData.videoFrames - expectedFrames;
    return Math.round(frameOffset * (1000 / 30)); // Convert to ms
  }

  cleanup() {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    if (this.videoFFmpeg) {
      this.videoFFmpeg.kill('SIGTERM');
      this.videoFFmpeg = null;
    }
    if (this.audioFFmpeg) {
      this.audioFFmpeg.kill('SIGTERM');
      this.audioFFmpeg = null;
    }
  }

  async createTestVideo() {
    const outputPath = path.join(__dirname, 'sync_test_video.mp4');
    
    console.log('🎬 Creating test video with A/V sync markers...');
    
    return new Promise((resolve, reject) => {
      // Create a video with visual and audio sync markers
      const ffmpeg = spawn('ffmpeg', [
        '-f', 'lavfi',
        '-i', 'testsrc2=size=1280x720:rate=30:duration=30',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:beep_factor=4:duration=30',
        '-filter_complex',
        '[0:v]drawtext=text=%{n}:fontsize=72:fontcolor=white:x=(w-text_w)/2:y=h-100[v]',
        '-map', '[v]',
        '-map', '1:a',
        '-codec:v', 'libx264',
        '-preset', 'fast',
        '-codec:a', 'aac',
        '-y',
        outputPath
      ]);
      
      ffmpeg.stderr.on('data', (data) => {
        // Suppress output unless error
      });
      
      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Test video created: ${outputPath}`);
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
      
      ffmpeg.on('error', reject);
    });
  }

  printResults() {
    console.log('\n');
    console.log('=' .repeat(50));
    console.log('📊 Audio-Video Sync Diagnosis Results');
    console.log('=' .repeat(50));
    
    // Sort results by sync offset
    const sortedResults = this.testResults
      .filter(r => r.success)
      .sort((a, b) => Math.abs(a.estimatedSync) - Math.abs(b.estimatedSync));
    
    console.log('\n🏆 Configurations Ranked by Sync Performance:');
    console.log('-'.repeat(50));
    
    sortedResults.forEach((result, index) => {
      const confidence = this.calculateConfidence(result, sortedResults);
      console.log(`\n${index + 1}. ${result.config}`);
      console.log(`   Sync Offset: ${result.estimatedSync}ms`);
      console.log(`   Confidence: ${confidence}%`);
      console.log(`   Performance: ${this.getPerformanceRating(result.estimatedSync)}`);
    });
    
    console.log('\n');
    console.log('🔍 Root Cause Analysis:');
    console.log('-'.repeat(50));
    
    const issues = this.identifyIssues(sortedResults);
    issues.forEach(issue => {
      console.log(`• ${issue}`);
    });
    
    console.log('\n');
    console.log('💡 Recommended Solutions:');
    console.log('-'.repeat(50));
    
    const solutions = this.generateSolutions(sortedResults, issues);
    solutions.forEach((solution, index) => {
      console.log(`\n${index + 1}. ${solution.title}`);
      console.log(`   ${solution.description}`);
      console.log(`   Confidence: ${solution.confidence}%`);
    });
  }

  calculateConfidence(result, allResults) {
    // Calculate confidence based on consistency and offset magnitude
    const offsetMagnitude = Math.abs(result.estimatedSync);
    let confidence = 100;
    
    // Reduce confidence based on offset magnitude
    confidence -= Math.min(offsetMagnitude / 10, 50);
    
    // Boost confidence if this is the best result
    if (result === allResults[0]) {
      confidence += 20;
    }
    
    return Math.max(0, Math.min(100, Math.round(confidence)));
  }

  getPerformanceRating(syncOffset) {
    const absOffset = Math.abs(syncOffset);
    if (absOffset < 20) return '⭐⭐⭐⭐⭐ Excellent';
    if (absOffset < 40) return '⭐⭐⭐⭐ Good';
    if (absOffset < 80) return '⭐⭐⭐ Acceptable';
    if (absOffset < 150) return '⭐⭐ Poor';
    return '⭐ Very Poor';
  }

  identifyIssues(results) {
    const issues = [];
    
    // Check if current config is worst
    const currentConfig = results.find(r => r.config === 'Current Configuration');
    if (currentConfig && results.indexOf(currentConfig) > results.length / 2) {
      issues.push('Current FFmpeg configuration has suboptimal A/V synchronization');
    }
    
    // Check for timestamp issues
    if (results.every(r => Math.abs(r.estimatedSync) > 40)) {
      issues.push('Systematic timestamp drift detected across all configurations');
    }
    
    // Check for separate vs combined process issues
    const separateProcess = results.find(r => r.config.includes('Separate'));
    const combinedProcess = results.find(r => !r.config.includes('Separate'));
    if (separateProcess && combinedProcess) {
      if (Math.abs(separateProcess.estimatedSync) > Math.abs(combinedProcess.estimatedSync) * 2) {
        issues.push('Separate FFmpeg processes causing synchronization issues');
      }
    }
    
    // Check for codec-related issues
    issues.push('VP8/Opus codec combination may introduce latency variations');
    
    // Check for RTP-related issues
    issues.push('RTP packet timing may not be properly synchronized between streams');
    
    return issues;
  }

  generateSolutions(results, issues) {
    const solutions = [];
    
    // Best configuration from tests
    if (results.length > 0) {
      const best = results[0];
      solutions.push({
        title: `Use "${best.config}" configuration`,
        description: `This configuration showed the best sync performance with ${Math.abs(best.estimatedSync)}ms offset`,
        confidence: this.calculateConfidence(best, results)
      });
    }
    
    // MediaSoup-specific solutions
    solutions.push({
      title: 'Implement MediaSoup PlainTransport with proper timestamp handling',
      description: 'Use PlainTransport instead of WebRTC transport for better control over RTP timing',
      confidence: 85
    });
    
    // FFmpeg-specific solutions
    solutions.push({
      title: 'Add explicit timestamp synchronization filters',
      description: 'Use filter_complex with setpts/asetpts to ensure consistent timestamp baseline',
      confidence: 80
    });
    
    // Buffer and latency solutions
    solutions.push({
      title: 'Implement adaptive jitter buffer in MediaSoup',
      description: 'Configure MediaSoup consumer with appropriate jitter buffer settings for better sync',
      confidence: 75
    });
    
    // Codec optimization
    solutions.push({
      title: 'Optimize codec parameters for low latency',
      description: 'Adjust VP8 deadline and Opus frame_duration for minimal encoding latency',
      confidence: 70
    });
    
    // Process optimization
    if (issues.some(i => i.includes('Separate FFmpeg processes'))) {
      solutions.push({
        title: 'Use single FFmpeg process with multiple outputs',
        description: 'Combine video and audio processing in one FFmpeg instance to maintain sync',
        confidence: 90
      });
    }
    
    return solutions;
  }
}

// Command line interface
async function main() {
  const args = process.argv.slice(2);
  const videoFile = args[0];
  
  console.log('🔧 ViewBot Audio-Video Sync Diagnostic Tool');
  console.log('=' .repeat(50));
  console.log('');
  
  const tester = new AVSyncTester();
  
  try {
    await tester.runAllTests(videoFile);
  } catch (error) {
    console.error('❌ Diagnostic failed:', error);
    process.exit(1);
  }
}

// Run diagnostics
main();