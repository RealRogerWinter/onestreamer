/**
 * GStreamer ViewBot Diagnostic Test
 * Tests the GStreamer pipeline and MediaSoup RTP integration
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class GStreamerDiagnostic {
  constructor() {
    this.gstreamerPath = 'C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin\\gst-launch-1.0.exe';
  }

  /**
   * Test 1: Basic GStreamer installation
   */
  async testGStreamerInstallation() {
    console.log('\n=== TEST 1: GStreamer Installation ===');
    
    return new Promise((resolve) => {
      const proc = spawn(this.gstreamerPath, ['--version'], {
        windowsHide: true
      });
      
      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('✅ GStreamer installed successfully');
          console.log(output.split('\n')[0]);
          resolve(true);
        } else {
          console.log('❌ GStreamer not found or error');
          resolve(false);
        }
      });
    });
  }

  /**
   * Test 2: Test pattern generation
   */
  async testTestPattern() {
    console.log('\n=== TEST 2: Test Pattern Generation ===');
    
    const pipeline = [
      'videotestsrc pattern=smpte num-buffers=100',
      '! video/x-raw,width=640,height=480,framerate=30/1',
      '! fakesink'
    ].join(' ');
    
    return new Promise((resolve) => {
      console.log('Running pipeline:', pipeline);
      
      const proc = spawn(this.gstreamerPath, ['-v', pipeline], {
        windowsHide: true
      });
      
      let hasOutput = false;
      
      proc.stderr.on('data', (data) => {
        const output = data.toString();
        if (!hasOutput && output.includes('PLAYING')) {
          hasOutput = true;
          console.log('✅ Test pattern generation working');
        }
      });
      
      proc.on('close', (code) => {
        if (code === 0 && hasOutput) {
          console.log('✅ Pipeline completed successfully');
          resolve(true);
        } else {
          console.log('❌ Pipeline failed');
          resolve(false);
        }
      });
    });
  }

  /**
   * Test 3: VP8 encoding capability
   */
  async testVP8Encoding() {
    console.log('\n=== TEST 3: VP8 Encoding ===');
    
    const pipeline = [
      'videotestsrc num-buffers=50',
      '! video/x-raw,width=640,height=480,framerate=30/1',
      '! vp8enc',
      '! fakesink'
    ].join(' ');
    
    return new Promise((resolve) => {
      console.log('Testing VP8 encoder...');
      
      const proc = spawn(this.gstreamerPath, [pipeline], {
        windowsHide: true
      });
      
      let hasError = false;
      
      proc.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('ERROR') || output.includes('not found')) {
          hasError = true;
          console.log('❌ VP8 encoder error:', output);
        }
      });
      
      proc.on('close', (code) => {
        if (code === 0 && !hasError) {
          console.log('✅ VP8 encoding working');
          resolve(true);
        } else {
          console.log('❌ VP8 encoder not available');
          resolve(false);
        }
      });
    });
  }

  /**
   * Test 4: RTP payload test
   */
  async testRTPPayload() {
    console.log('\n=== TEST 4: RTP Payload ===');
    
    const videoPort = 5004;
    const audioPort = 5006;
    
    const pipeline = [
      // Video branch
      'videotestsrc pattern=smpte num-buffers=100',
      '! video/x-raw,width=640,height=480,framerate=30/1',
      '! vp8enc deadline=1 cpu-used=8',
      '! rtpvp8pay ssrc=12345678 pt=96',
      `! udpsink host=127.0.0.1 port=${videoPort} sync=false`,
      
      // Audio branch
      'audiotestsrc wave=sine freq=440 num-buffers=100',
      '! audio/x-raw,rate=48000,channels=2',
      '! opusenc',
      '! rtpopuspay ssrc=87654321 pt=111',
      `! udpsink host=127.0.0.1 port=${audioPort} sync=false`
    ].join(' ');
    
    return new Promise((resolve) => {
      console.log(`Sending RTP to ports ${videoPort} (video) and ${audioPort} (audio)...`);
      
      const proc = spawn(this.gstreamerPath, [pipeline], {
        windowsHide: true
      });
      
      let pipelineStarted = false;
      
      proc.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('PLAYING') && !pipelineStarted) {
          pipelineStarted = true;
          console.log('✅ RTP pipeline started');
        }
        if (output.includes('ERROR')) {
          console.log('❌ RTP error:', output);
        }
      });
      
      proc.on('close', (code) => {
        if (code === 0 && pipelineStarted) {
          console.log('✅ RTP payload test completed');
          resolve(true);
        } else {
          console.log('❌ RTP payload test failed');
          resolve(false);
        }
      });
    });
  }

  /**
   * Test 5: Video file decoding (if test file exists)
   */
  async testVideoFileDecoding() {
    console.log('\n=== TEST 5: Video File Decoding ===');
    
    // Look for a test video file
    const testFiles = [
      'C:\\onestreamer\\uploads\\test.mp4',
      'C:\\onestreamer\\test-video.mp4',
      'C:\\Users\\Public\\Videos\\Sample Videos\\Wildlife.wmv'
    ];
    
    let testFile = null;
    for (const file of testFiles) {
      if (fs.existsSync(file)) {
        testFile = file;
        break;
      }
    }
    
    if (!testFile) {
      console.log('⚠️ No test video file found, skipping');
      return null;
    }
    
    console.log(`Testing with file: ${testFile}`);
    const normalizedPath = testFile.replace(/\\/g, '/');
    
    const pipeline = [
      `uridecodebin uri=file:///${normalizedPath} name=decoder`,
      'decoder.',
      '! queue',
      '! videoconvert',
      '! videoscale',
      '! video/x-raw,width=640,height=480',
      '! fakesink',
      'decoder.',
      '! queue',
      '! audioconvert',
      '! fakesink'
    ].join(' ');
    
    return new Promise((resolve) => {
      const proc = spawn(this.gstreamerPath, ['-v', pipeline], {
        windowsHide: true
      });
      
      let hasVideo = false;
      let hasAudio = false;
      
      proc.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('video/x-raw')) {
          hasVideo = true;
        }
        if (output.includes('audio/x-raw')) {
          hasAudio = true;
        }
        if (output.includes('ERROR')) {
          console.log('❌ Decoding error:', output);
        }
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ File decoded successfully (Video: ${hasVideo}, Audio: ${hasAudio})`);
          resolve(true);
        } else {
          console.log('❌ File decoding failed');
          resolve(false);
        }
      });
    });
  }

  /**
   * Test 6: Full pipeline simulation
   */
  async testFullPipeline() {
    console.log('\n=== TEST 6: Full Pipeline Simulation ===');
    
    const videoPort = 40000;
    const audioPort = 40002;
    
    console.log(`Simulating full ViewBot pipeline to ports ${videoPort}/${audioPort}...`);
    
    const pipeline = [
      // Use test source
      'videotestsrc pattern=ball name=vsrc',
      '! video/x-raw,width=1280,height=720,framerate=30/1',
      '! queue max-size-buffers=0 max-size-time=0',
      '! videoconvert',
      '! vp8enc deadline=1 cpu-used=8 error-resilient=1 target-bitrate=1500000',
      `! rtpvp8pay ssrc=${Math.floor(Math.random() * 0xFFFFFFFF)} pt=96 mtu=1200`,
      `! udpsink host=127.0.0.1 port=${videoPort} sync=false async=false`,
      
      // Audio test source
      'audiotestsrc wave=sine freq=440',
      '! audio/x-raw,rate=48000,channels=2',
      '! queue max-size-buffers=0 max-size-time=0',
      '! audioconvert',
      '! opusenc bitrate=128000',
      `! rtpopuspay ssrc=${Math.floor(Math.random() * 0xFFFFFFFF)} pt=111 mtu=1200`,
      `! udpsink host=127.0.0.1 port=${audioPort} sync=false async=false`
    ].join(' ');
    
    return new Promise((resolve) => {
      const proc = spawn(this.gstreamerPath, ['-v', pipeline], {
        windowsHide: true
      });
      
      let startTime = Date.now();
      let packetsDetected = false;
      
      const timeout = setTimeout(() => {
        proc.kill();
        console.log('✅ Pipeline ran for 3 seconds successfully');
        resolve(true);
      }, 3000);
      
      proc.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('PLAYING')) {
          console.log('✅ Pipeline is PLAYING');
        }
        if (output.includes('running_time') && !packetsDetected) {
          packetsDetected = true;
          console.log('✅ RTP packets being generated');
        }
        if (output.includes('ERROR')) {
          console.log('❌ Pipeline error:', output);
          clearTimeout(timeout);
          proc.kill();
          resolve(false);
        }
      });
      
      proc.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    console.log('🔬 GStreamer ViewBot Diagnostic Test');
    console.log('=====================================');
    
    const results = [];
    
    // Test 1: Installation
    results.push(await this.testGStreamerInstallation());
    
    // Test 2: Test pattern
    results.push(await this.testTestPattern());
    
    // Test 3: VP8 encoding
    results.push(await this.testVP8Encoding());
    
    // Test 4: RTP payload
    results.push(await this.testRTPPayload());
    
    // Test 5: Video file (optional)
    const fileTest = await this.testVideoFileDecoding();
    if (fileTest !== null) {
      results.push(fileTest);
    }
    
    // Test 6: Full pipeline
    results.push(await this.testFullPipeline());
    
    // Summary
    console.log('\n=== DIAGNOSTIC SUMMARY ===');
    const passed = results.filter(r => r === true).length;
    const total = results.length;
    
    console.log(`Tests passed: ${passed}/${total}`);
    
    if (passed === total) {
      console.log('✅ All tests passed! GStreamer is properly configured.');
      console.log('\nIf video still doesn\'t play, the issue is likely:');
      console.log('1. MediaSoup PlainTransport not receiving RTP packets');
      console.log('2. SSRC mismatch between GStreamer and MediaSoup');
      console.log('3. Codec parameters not matching');
      console.log('4. Port binding issues');
    } else {
      console.log('⚠️ Some tests failed. Please check:');
      if (!results[0]) console.log('- GStreamer installation');
      if (!results[2]) console.log('- VP8 codec plugin installation');
      if (!results[3]) console.log('- RTP/network configuration');
    }
  }
}

// Run diagnostic
async function main() {
  const diagnostic = new GStreamerDiagnostic();
  await diagnostic.runAllTests();
  process.exit(0);
}

main().catch(console.error);