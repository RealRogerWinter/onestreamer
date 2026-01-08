/**
 * Test FFmpeg RTP streaming capability
 * This tests if FFmpeg can properly generate and send RTP packets
 */

const { spawn } = require('child_process');
const dgram = require('dgram');

// Create a UDP server to receive RTP packets
const rtpServer = dgram.createSocket('udp4');
const TEST_PORT = 55555;

let packetCount = 0;
let lastPacketTime = Date.now();

rtpServer.on('message', (msg, rinfo) => {
  packetCount++;
  const now = Date.now();
  
  // Parse RTP header (first 12 bytes minimum)
  if (msg.length >= 12) {
    const version = (msg[0] >> 6) & 0x03;
    const padding = (msg[0] >> 5) & 0x01;
    const extension = (msg[0] >> 4) & 0x01;
    const csrcCount = msg[0] & 0x0F;
    const marker = (msg[1] >> 7) & 0x01;
    const payloadType = msg[1] & 0x7F;
    const sequenceNumber = (msg[2] << 8) | msg[3];
    const timestamp = (msg[4] << 24) | (msg[5] << 16) | (msg[6] << 8) | msg[7];
    const ssrc = (msg[8] << 24) | (msg[9] << 16) | (msg[10] << 8) | msg[11];
    
    if (packetCount === 1 || packetCount % 30 === 0) {
      console.log(`📦 RTP Packet #${packetCount}:`);
      console.log(`   Version: ${version}, PT: ${payloadType}, Seq: ${sequenceNumber}`);
      console.log(`   SSRC: ${ssrc}, Timestamp: ${timestamp}`);
      console.log(`   Size: ${msg.length} bytes, From: ${rinfo.address}:${rinfo.port}`);
    }
  }
  
  lastPacketTime = now;
});

rtpServer.on('error', (err) => {
  console.error('❌ RTP Server error:', err);
  rtpServer.close();
});

rtpServer.bind(TEST_PORT, '127.0.0.1', () => {
  console.log(`🎧 RTP test server listening on 127.0.0.1:${TEST_PORT}`);
  console.log('📺 Starting FFmpeg test stream...\n');
  
  // Test with H264 first (more universally supported)
  testH264Stream();
});

function testH264Stream() {
  console.log('🎬 Testing H264 RTP stream...');
  
  const ffmpegArgs = [
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x480:rate=30',
    '-t', '5', // Run for 5 seconds
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-x264opts', 'keyint=30:min-keyint=30',
    '-f', 'rtp',
    '-payload_type', '96',
    `rtp://127.0.0.1:${TEST_PORT}`
  ];
  
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  
  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.includes('SDP:')) {
      console.log('📝 FFmpeg SDP output detected');
    }
    if (output.includes('error')) {
      console.error('❌ FFmpeg error:', output);
    }
  });
  
  ffmpeg.on('close', (code) => {
    console.log(`\n✅ H264 test completed with code ${code}`);
    console.log(`📊 Received ${packetCount} RTP packets`);
    
    if (packetCount > 0) {
      console.log('✅ H264 RTP streaming works!\n');
      // Reset for VP8 test
      packetCount = 0;
      setTimeout(() => testVP8Stream(), 1000);
    } else {
      console.log('❌ No RTP packets received for H264\n');
      process.exit(1);
    }
  });
}

function testVP8Stream() {
  console.log('🎬 Testing VP8 RTP stream...');
  
  const ffmpegArgs = [
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x480:rate=30',
    '-t', '5', // Run for 5 seconds
    '-c:v', 'libvpx',
    '-deadline', 'realtime',
    '-cpu-used', '5',
    '-f', 'rtp',
    '-payload_type', '96',
    `rtp://127.0.0.1:${TEST_PORT}`
  ];
  
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  
  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.includes('SDP:')) {
      console.log('📝 FFmpeg SDP output detected');
    }
    if (output.includes('error')) {
      console.error('❌ FFmpeg error:', output);
    }
  });
  
  ffmpeg.on('close', (code) => {
    console.log(`\n✅ VP8 test completed with code ${code}`);
    console.log(`📊 Received ${packetCount} RTP packets`);
    
    if (packetCount > 0) {
      console.log('✅ VP8 RTP streaming works!');
    } else {
      console.log('❌ No RTP packets received for VP8');
      console.log('\n⚠️ VP8 may not be available in your FFmpeg build');
      console.log('Try installing FFmpeg with VP8 support:');
      console.log('  Windows: Download full build from https://www.gyan.dev/ffmpeg/builds/');
    }
    
    // Clean up
    rtpServer.close();
    process.exit(packetCount > 0 ? 0 : 1);
  });
}

// Timeout handler
setTimeout(() => {
  console.log('\n⏱️ Test timeout - no packets received in 10 seconds');
  rtpServer.close();
  process.exit(1);
}, 10000);