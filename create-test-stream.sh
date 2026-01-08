#!/bin/bash

# Create a test video stream using FFmpeg with a simple test pattern
# This will generate a video with sound that can be streamed

echo "🎬 Creating test media stream..."

# Kill any existing test streams
pkill -f "ffmpeg.*test_pattern" 2>/dev/null

# Start FFmpeg to generate test pattern with audio
ffmpeg -f lavfi -i testsrc=duration=3600:size=1280x720:rate=30 \
       -f lavfi -i sine=frequency=440:duration=3600 \
       -c:v libx264 -preset ultrafast -tune zerolatency \
       -c:a aac -b:a 128k \
       -f mpegts udp://127.0.0.1:5000 &

echo "✅ Test stream started on UDP port 5000"
echo "📡 Stream will run for 1 hour with test pattern video and sine wave audio"