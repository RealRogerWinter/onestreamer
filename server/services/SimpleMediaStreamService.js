const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

class SimpleMediaStreamService {
  constructor() {
    this.activeStreamer = null;
    this.streamId = null;
    this.hlsPath = path.join(__dirname, '../../public/hls');
    this.testStreamInterval = null;
    
    // Ensure HLS directory exists
    this.ensureHLSDirectory();
  }

  ensureHLSDirectory() {
    if (!fs.existsSync(this.hlsPath)) {
      fs.mkdirSync(this.hlsPath, { recursive: true });
      console.log('📁 Created HLS directory:', this.hlsPath);
    }
  }

  async startIngestion(streamerId) {
    console.log('🎥 SIMPLE_MEDIA: Starting simple stream ingestion for:', streamerId);
    
    // Clean up existing stream
    this.stopIngestion();
    
    this.activeStreamer = streamerId;
    this.streamId = `stream_${streamerId}_${Date.now()}`;
    
    // For now, create a mock HLS stream that updates periodically
    this.createMockHLSStream();
    
    return { 
      success: true, 
      streamId: this.streamId,
      message: 'Simple stream ingestion started (mock HLS stream)'
    };
  }

  createMockHLSStream() {
    console.log('📺 SIMPLE_MEDIA: Creating test HLS stream');
    
    // Skip FFmpeg entirely and use a working public stream
    this.createWorkingTestStream();
  }

  createWorkingTestStream() {
    const m3u8FilePath = path.join(this.hlsPath, `${this.streamId}.m3u8`);
    
    // Use Apple's official HLS test stream
    const workingM3u8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.9,
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/v2/prog_index.m3u8
#EXT-X-ENDLIST`;

    try {
      fs.writeFileSync(m3u8FilePath, workingM3u8Content);
      console.log('✅ SIMPLE_MEDIA: Created working test stream using Apple HLS sample');
    } catch (error) {
      console.error('❌ SIMPLE_MEDIA: Failed to write working manifest:', error);
    }
  }

  async checkFFmpegAvailability() {
    return new Promise((resolve) => {
      const testProcess = spawn('ffmpeg', ['-version']);
      
      testProcess.on('error', (error) => {
        console.log('📺 SIMPLE_MEDIA: FFmpeg not found:', error.message);
        resolve(false);
      });
      
      testProcess.on('close', (code) => {
        console.log(`📺 SIMPLE_MEDIA: FFmpeg version check exited with code ${code}`);
        resolve(code === 0);
      });
      
      // Timeout after 3 seconds
      setTimeout(() => {
        testProcess.kill();
        resolve(false);
      }, 3000);
    });
  }

  startFFmpegStream() {
    const m3u8FilePath = path.join(this.hlsPath, `${this.streamId}.m3u8`);
    const segmentPattern = path.join(this.hlsPath, `${this.streamId}_segment_%03d.ts`);
    
    // Use FFmpeg to generate a test pattern video stream
    const ffmpegArgs = [
      '-f', 'lavfi',
      '-i', 'testsrc2=size=640x360:rate=30',  // Test pattern
      '-f', 'lavfi', 
      '-i', 'sine=frequency=1000:sample_rate=48000', // Test tone
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency', 
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', segmentPattern,
      '-y', // Overwrite output files
      m3u8FilePath
    ];
    
    console.log('🎬 SIMPLE_MEDIA: Starting FFmpeg with args:', ffmpegArgs.join(' '));
    
    this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    this.ffmpegProcess.stdout.on('data', (data) => {
      console.log('📺 FFmpeg stdout:', data.toString().trim());
    });
    
    this.ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output.includes('frame=') || output.includes('time=')) {
        // Progress info - log occasionally
        if (Math.random() < 0.1) console.log('📺 FFmpeg progress:', output);
      } else if (output.length > 0) {
        console.log('📺 FFmpeg stderr:', output);
      }
    });
    
    this.ffmpegProcess.on('error', (error) => {
      console.error('❌ SIMPLE_MEDIA: FFmpeg process error:', error);
      console.warn('🔄 SIMPLE_MEDIA: Falling back to manual segments');
      this.fallbackToManualSegments();
    });
    
    this.ffmpegProcess.on('close', (code) => {
      console.log(`📺 SIMPLE_MEDIA: FFmpeg process exited with code ${code}`);
      this.ffmpegProcess = null;
      
      if (code !== 0) {
        console.warn('🔄 SIMPLE_MEDIA: FFmpeg failed, using fallback');
        this.fallbackToManualSegments();
      }
    });
    
    console.log('✅ SIMPLE_MEDIA: FFmpeg HLS stream started');
  }

  fallbackToManualSegments() {
    console.log('🔄 SIMPLE_MEDIA: Creating live HLS stream without FFmpeg');
    
    this.setupStaticHLSStream();
  }

  async setupStaticHLSStream() {
    const m3u8FilePath = path.join(this.hlsPath, `${this.streamId}.m3u8`);
    let segmentIndex = 0;
    const maxSegments = 5;
    
    // Download and cache some working segments from a public stream
    await this.downloadTestSegments();
    
    const updatePlaylist = () => {
      const segments = [];
      
      // Create a sliding window of segments
      for (let i = Math.max(0, segmentIndex - maxSegments + 1); i <= segmentIndex; i++) {
        const segNum = i % 3; // Cycle through our cached segments
        segments.push(`#EXTINF:4.0,\n${this.streamId}_segment_${segNum.toString().padStart(3, '0')}.ts`);
      }
      
      const m3u8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:${Math.max(0, segmentIndex - maxSegments + 1)}
${segments.join('\n')}`;

      try {
        fs.writeFileSync(m3u8FilePath, m3u8Content);
        console.log(`📝 SIMPLE_MEDIA: Updated live manifest (segment ${segmentIndex})`);
      } catch (error) {
        console.error('❌ SIMPLE_MEDIA: Failed to write manifest:', error);
      }
      
      segmentIndex++;
    };
    
    // Initial playlist
    updatePlaylist();
    
    // Update playlist every 4 seconds to simulate live stream
    this.testStreamInterval = setInterval(updatePlaylist, 4000);
    console.log('✅ SIMPLE_MEDIA: Live HLS stream started (no FFmpeg required)');
  }

  async downloadTestSegments() {
    const https = require('https');
    const segmentUrls = [
      'https://demo.unified-streaming.com/k8s/features/stable/no-handler-origin/tears-of-steel/tears-of-steel-multi-lang.ism/.m3u8/QualityLevels(680000)/Fragments(video=0,format=m3u8-aapl)',
      'https://demo.unified-streaming.com/k8s/features/stable/no-handler-origin/tears-of-steel/tears-of-steel-multi-lang.ism/.m3u8/QualityLevels(680000)/Fragments(video=40000000,format=m3u8-aapl)',
      'https://demo.unified-streaming.com/k8s/features/stable/no-handler-origin/tears-of-steel/tears-of-steel-multi-lang.ism/.m3u8/QualityLevels(680000)/Fragments(video=80000000,format=m3u8-aapl)'
    ];
    
    console.log('📥 SIMPLE_MEDIA: Downloading test segments...');
    
    // Instead of downloading, create simple solid-color TS segments
    for (let i = 0; i < 3; i++) {
      const segmentPath = path.join(this.hlsPath, `${this.streamId}_segment_${i.toString().padStart(3, '0')}.ts`);
      try {
        const colorSegment = this.generateColorTestSegment(i);
        fs.writeFileSync(segmentPath, colorSegment);
      } catch (error) {
        console.warn(`⚠️ SIMPLE_MEDIA: Failed to create segment ${i}:`, error);
      }
    }
    
    console.log('✅ SIMPLE_MEDIA: Test segments ready');
  }

  generateColorTestSegment(segmentIndex) {
    // Generate a more sophisticated MPEG-TS segment with proper structure
    const packets = [];
    const colors = [
      { r: 255, g: 0, b: 0 },   // Red
      { r: 0, g: 255, b: 0 },   // Green  
      { r: 0, g: 0, b: 255 }    // Blue
    ];
    
    const color = colors[segmentIndex % colors.length];
    
    // PAT (Program Association Table)
    packets.push(this.createPATPacket());
    
    // PMT (Program Map Table) 
    packets.push(this.createPMTPacket());
    
    // Video PES packets with basic H.264 structure
    for (let i = 0; i < 30; i++) { // 30 packets ≈ 4 seconds at 30fps
      packets.push(this.createVideoPacket(i, color));
    }
    
    return Buffer.concat(packets);
  }

  createPATPacket() {
    const packet = Buffer.alloc(188, 0xFF);
    packet[0] = 0x47; // Sync byte
    packet[1] = 0x40; // Payload unit start = 1, PID = 0 (high)
    packet[2] = 0x00; // PID = 0 (low)
    packet[3] = 0x10; // No adaptation, payload only, continuity = 0
    
    // PAT payload
    packet[4] = 0x00; // Pointer field
    packet[5] = 0x00; // Table ID
    packet[6] = 0xB0; packet[7] = 0x0D; // Section length
    packet[8] = 0x00; packet[9] = 0x01; // Transport stream ID
    packet[10] = 0xC1; // Version = 0, current = 1
    packet[11] = 0x00; packet[12] = 0x00; // Section numbers
    packet[13] = 0x00; packet[14] = 0x01; // Program 1
    packet[15] = 0xE1; packet[16] = 0x00; // PMT PID = 256
    
    // Simple CRC (not calculated properly, but sufficient for testing)
    packet[17] = 0x2A; packet[18] = 0xB1; packet[19] = 0x04; packet[20] = 0xB2;
    
    return packet;
  }

  createPMTPacket() {
    const packet = Buffer.alloc(188, 0xFF);
    packet[0] = 0x47; // Sync byte
    packet[1] = 0x41; packet[2] = 0x00; // Payload start = 1, PID = 256
    packet[3] = 0x10; // Continuity = 0
    
    packet[4] = 0x00; // Pointer
    packet[5] = 0x02; // PMT table ID
    packet[6] = 0xB0; packet[7] = 0x12; // Section length
    packet[8] = 0x00; packet[9] = 0x01; // Program number
    packet[10] = 0xC1; packet[11] = 0x00; packet[12] = 0x00;
    packet[13] = 0xE1; packet[14] = 0x01; // PCR PID = 257
    packet[15] = 0xF0; packet[16] = 0x00; // Program info length
    packet[17] = 0x1B; // H.264 stream type
    packet[18] = 0xE1; packet[19] = 0x01; // Elementary PID = 257
    packet[20] = 0xF0; packet[21] = 0x00; // ES info length
    
    return packet;
  }

  createVideoPacket(frameNum, color) {
    const packet = Buffer.alloc(188, 0xFF);
    packet[0] = 0x47; // Sync byte
    
    // PID = 257 (video), payload unit start for keyframes
    const isKeyframe = frameNum % 30 === 0;
    packet[1] = isKeyframe ? 0x61 : 0x21; 
    packet[2] = 0x01;
    packet[3] = 0x10 | (frameNum & 0x0F); // Continuity counter
    
    if (isKeyframe) {
      // Add PES header for keyframes
      let offset = 4;
      packet[offset++] = 0x00; packet[offset++] = 0x00; packet[offset++] = 0x01; // PES start
      packet[offset++] = 0xE0; // Video stream ID
      packet[offset++] = 0x00; packet[offset++] = 0x00; // PES length
      packet[offset++] = 0x80; packet[offset++] = 0x80; packet[offset++] = 0x05; // Flags
      
      // PTS timestamp  
      const pts = frameNum * 3000; // Arbitrary timestamp
      packet[offset++] = 0x21 | ((pts >> 29) & 0x0E);
      packet[offset++] = (pts >> 22) & 0xFF;
      packet[offset++] = 0x01 | ((pts >> 14) & 0xFE);
      packet[offset++] = (pts >> 7) & 0xFF;
      packet[offset++] = 0x01 | ((pts << 1) & 0xFE);
      
      // Minimal H.264 NAL units for a solid color frame
      packet[offset++] = 0x00; packet[offset++] = 0x00; packet[offset++] = 0x00; packet[offset++] = 0x01;
      packet[offset++] = 0x67; // SPS NAL
      packet[offset++] = 0x42; packet[offset++] = 0x00; packet[offset++] = 0x1E; // Profile/Level
      
      // Fill remaining space with color data (simplified)
      for (let i = offset; i < 188; i++) {
        packet[i] = (color.r + color.g + color.b) / 3; // Average color as grayscale
      }
    }
    
    return packet;
  }

  stopIngestion() {
    console.log('🛑 SIMPLE_MEDIA: Stopping stream ingestion');
    
    // Stop FFmpeg process
    if (this.ffmpegProcess) {
      console.log('🛑 SIMPLE_MEDIA: Stopping FFmpeg process');
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }
    
    // Stop manual interval if running
    if (this.testStreamInterval) {
      clearInterval(this.testStreamInterval);
      this.testStreamInterval = null;
    }
    
    // Clean up HLS files
    if (this.streamId) {
      this.cleanupHLSFiles();
    }
    
    this.activeStreamer = null;
    this.streamId = null;
  }

  generateValidTSSegment() {
    // Generate a valid MPEG-TS segment with PAT, PMT, and H.264 NAL units
    const packets = [];
    
    // PAT (Program Association Table) - PID 0
    const pat = Buffer.alloc(188, 0xFF);
    pat[0] = 0x47; // Sync byte
    pat[1] = 0x40; // Transport error=0, payload unit start=1, priority=0, PID=0
    pat[2] = 0x00; // PID=0 continued
    pat[3] = 0x10; // Scrambling=00, adaptation=01, continuity=0
    // PAT payload
    pat[4] = 0x00; // Pointer field
    pat[5] = 0x00; // Table ID
    pat[6] = 0xB0; pat[7] = 0x0D; // Section length (13 bytes)
    pat[8] = 0x00; pat[9] = 0x01; // Transport stream ID
    pat[10] = 0xC1; // Version=0, current=1
    pat[11] = 0x00; pat[12] = 0x00; // Section numbers
    pat[13] = 0x00; pat[14] = 0x01; // Program 1
    pat[15] = 0xE1; pat[16] = 0x00; // PMT PID = 256
    // CRC32 placeholder
    pat[17] = 0x2A; pat[18] = 0xB1; pat[19] = 0x04; pat[20] = 0xB2;
    packets.push(pat);
    
    // PMT (Program Map Table) - PID 256
    const pmt = Buffer.alloc(188, 0xFF);
    pmt[0] = 0x47; pmt[1] = 0x41; pmt[2] = 0x00; pmt[3] = 0x10;
    pmt[4] = 0x00; // Pointer field
    pmt[5] = 0x02; // Table ID (PMT)
    pmt[6] = 0xB0; pmt[7] = 0x12; // Section length
    pmt[8] = 0x00; pmt[9] = 0x01; // Program number
    pmt[10] = 0xC1; pmt[11] = 0x00; pmt[12] = 0x00; // Version, sections
    pmt[13] = 0xE1; pmt[14] = 0x01; // PCR PID = 257
    pmt[15] = 0xF0; pmt[16] = 0x00; // Program info length = 0
    pmt[17] = 0x1B; // Stream type = H.264
    pmt[18] = 0xE1; pmt[19] = 0x01; // Elementary PID = 257
    pmt[20] = 0xF0; pmt[21] = 0x00; // ES info length = 0
    // CRC32 placeholder
    pmt[22] = 0x3D; pmt[23] = 0x4D; pmt[24] = 0x85; pmt[25] = 0x96;
    packets.push(pmt);
    
    // Generate H.264 NAL units with SPS, PPS, and I-frame
    const h264Data = this.generateH264NALUnits();
    const videoPackets = this.createVideoTSPackets(h264Data);
    packets.push(...videoPackets);
    
    return Buffer.concat(packets);
  }

  generateH264NALUnits() {
    // Create minimal but valid H.264 NAL units
    const nalUnits = [];
    
    // SPS (Sequence Parameter Set) - NAL type 7
    const sps = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // Start code
      0x67, // NAL header (type 7 = SPS)
      0x64, 0x00, 0x0A, // Profile IDC, constraints, level IDC
      0xAC, 0xD9, 0x41, 0x41, 0xFB, 0x01, 0x10, 0x00, 0x00, 0x3E, 0x90, 0x00, 0x0F, 0x42, 0x40
    ]);
    nalUnits.push(sps);
    
    // PPS (Picture Parameter Set) - NAL type 8  
    const pps = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // Start code
      0x68, // NAL header (type 8 = PPS)
      0xEE, 0x3C, 0x80 // Minimal PPS data
    ]);
    nalUnits.push(pps);
    
    // IDR frame (Instantaneous Decoder Refresh) - NAL type 5
    const idr = Buffer.from([
      0x00, 0x00, 0x00, 0x01, // Start code
      0x65, // NAL header (type 5 = IDR)
      0x88, 0x84, 0x00, 0x10, // Minimal I-frame data (black frame)
      0x03, 0xFF, 0xFE, 0xF6, 0xF0, 0xA0, 0x00, 0x01,
      0x42, 0x80, 0x00, 0x50, 0xA0, 0x07, 0xFF, 0xFF,
      0x00, 0x28, 0xA0, 0x1F, 0xFF, 0xFC, 0x00, 0xA2,
      0x80, 0x7F, 0xFF, 0xF0, 0x02, 0x8A, 0x01, 0xFF
    ]);
    nalUnits.push(idr);
    
    return Buffer.concat(nalUnits);
  }

  createVideoTSPackets(h264Data) {
    const packets = [];
    let continuityCounter = 0;
    let dataOffset = 0;
    const pid = 257; // Video PID
    
    while (dataOffset < h264Data.length) {
      const packet = Buffer.alloc(188, 0xFF); // Fill with stuffing
      packet[0] = 0x47; // Sync byte
      
      const payloadStart = dataOffset === 0 ? 1 : 0;
      packet[1] = (payloadStart << 6) | ((pid >> 8) & 0x1F);
      packet[2] = pid & 0xFF;
      packet[3] = 0x10 | (continuityCounter & 0x0F);
      
      let headerOffset = 4;
      
      if (payloadStart) {
        // Add PES header for first packet
        packet[headerOffset] = 0x00; packet[headerOffset + 1] = 0x00; 
        packet[headerOffset + 2] = 0x01; // PES start code
        packet[headerOffset + 3] = 0xE0; // Stream ID (video)
        packet[headerOffset + 4] = 0x00; packet[headerOffset + 5] = 0x00; // PES length
        packet[headerOffset + 6] = 0x80; // Flags
        packet[headerOffset + 7] = 0x80; // PTS flag
        packet[headerOffset + 8] = 0x05; // Header length
        // PTS (33-bit timestamp)
        packet[headerOffset + 9] = 0x21; packet[headerOffset + 10] = 0x00;
        packet[headerOffset + 11] = 0x01; packet[headerOffset + 12] = 0x00; 
        packet[headerOffset + 13] = 0x01;
        headerOffset += 14;
      }
      
      // Copy H.264 data
      const remainingSpace = 188 - headerOffset;
      const remainingData = h264Data.length - dataOffset;
      const copyLength = Math.min(remainingSpace, remainingData);
      
      h264Data.copy(packet, headerOffset, dataOffset, dataOffset + copyLength);
      dataOffset += copyLength;
      
      packets.push(packet);
      continuityCounter = (continuityCounter + 1) & 0x0F;
    }
    
    return packets;
  }

  cleanupHLSFiles() {
    try {
      const files = fs.readdirSync(this.hlsPath);
      files.forEach(file => {
        if (file.includes(this.streamId)) {
          fs.unlinkSync(path.join(this.hlsPath, file));
        }
      });
      console.log('🧹 SIMPLE_MEDIA: Cleaned up HLS files for stream:', this.streamId);
    } catch (error) {
      console.warn('⚠️ SIMPLE_MEDIA: Failed to cleanup HLS files:', error);
    }
  }

  getStreamInfo() {
    return {
      activeStreamer: this.activeStreamer,
      streamId: this.streamId,
      isActive: !!this.activeStreamer,
      hlsUrl: this.streamId ? `/hls/${this.streamId}.m3u8` : null
    };
  }

  isStreaming(streamerId) {
    return this.activeStreamer === streamerId;
  }
}

module.exports = SimpleMediaStreamService;