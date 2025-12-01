// Test GStreamer pipeline startup timing with silent audio
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get first video file from uploads
const uploadsDir = path.join(__dirname, 'server', 'uploads');
const videoFiles = fs.readdirSync(uploadsDir)
  .filter(file => file.endsWith('.mp4') || file.endsWith('.webm'))
  .map(file => path.join(uploadsDir, file));

if (videoFiles.length === 0) {
  console.error('❌ No video files found');
  process.exit(1);
}

const videoFile = videoFiles[0];
console.log(`🎥 Testing with video: ${path.basename(videoFile)}`);

const rtmpUrl = 'rtmp://127.0.0.1:1935/test/test-stream';
const videoBitrate = 2500;
const audioBitrate = 128;

// GStreamer pipeline with silent audio
const pipelineCmd = `filesrc location="${videoFile}" ! qtdemux name=d ` +
  `d.video_0 ! queue ! decodebin ! videoconvert ! video/x-raw,format=I420 ! ` +
  `x264enc bitrate=${videoBitrate} speed-preset=ultrafast tune=zerolatency key-int-max=15 ! ` +
  `video/x-h264,profile=baseline ! h264parse ! video/x-h264,stream-format=avc ! ` +
  `queue ! mux.video ` +
  `audiotestsrc wave=silence ! audio/x-raw,rate=48000,channels=2 ! voaacenc bitrate=${audioBitrate * 1000} ! ` +
  `queue ! mux.audio ` +
  `flvmux name=mux streamable=true ! fakesink`;

console.log(`🎬 Starting GStreamer pipeline...`);
const startTime = Date.now();

const proc = spawn('sh', ['-c', `gst-launch-1.0 -v ${pipelineCmd}`], {
  stdio: ['ignore', 'pipe', 'pipe']
});

let started = false;
let timeout;

const handleOutput = (data) => {
  const output = data.toString();

  if (output.includes('ERROR')) {
    console.error(`❌ GStreamer ERROR:`, output.trim());
    if (!started) {
      proc.kill();
      process.exit(1);
    }
  } else if (output.includes('WARNING')) {
    console.warn(`⚠️ GStreamer WARNING:`, output.trim());
  } else if (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED')) {
    if (!started) {
      started = true;
      const duration = Date.now() - startTime;
      console.log(`✅ GStreamer started successfully in ${duration}ms`);
      clearTimeout(timeout);
      proc.kill();
      process.exit(0);
    }
  }
};

proc.stdout.on('data', handleOutput);
proc.stderr.on('data', handleOutput);

proc.on('error', (error) => {
  console.error(`❌ GStreamer error:`, error);
  process.exit(1);
});

timeout = setTimeout(() => {
  if (!started) {
    console.error(`❌ GStreamer startup timeout (10 seconds)`);
    proc.kill();
    process.exit(1);
  }
}, 10000);
