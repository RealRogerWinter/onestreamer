# OneStreamer Debugging Guide

## Issues Fixed

### 1. ✅ Viewer Stream Display
**Problem**: Viewers saw black screen with red "LIVE" indicator
**Root Cause**: WebRTC signaling was incorrect - single peer connection can't broadcast to multiple viewers
**Solution**: 
- Implemented proper one-to-many WebRTC architecture
- Streamer creates separate peer connections for each viewer
- Added proper offer/answer/ICE candidate exchange
- Added console logging for debugging

### 2. ✅ Test Stream Display  
**Problem**: Admin panel test streams weren't visible
**Root Cause**: No actual video content was generated for test streams
**Solution**:
- Added canvas-based test stream generation
- Implemented SMPTE color bars with moving text
- Added real-time timestamp display
- Integrated with existing stream architecture

### 3. ✅ Audio Level Visualization
**Added Feature**: Real-time audio level monitoring for streamers
**Implementation**:
- Web Audio API integration with microphone input
- Animated dB meter with color-coded levels (green/yellow/red)
- Real-time visualization showing microphone is working
- Clean cleanup when stopping stream

## New WebRTC Architecture

### Signaling Flow
```
1. Viewer joins → emit('join-as-viewer')
2. Streamer starts → emit('streaming-approved') 
3. Viewer requests stream → emit('request-stream', {streamerId})
4. Server notifies streamer → emit('viewer-requesting-stream', {viewerId})
5. Streamer sends offer → emit('stream-offer', {offer, toViewerId})
6. Viewer receives offer → emit('stream-offer', {offer, fromStreamerId})
7. Viewer sends answer → emit('stream-answer', {answer, toStreamerId})
8. Streamer receives answer → emit('stream-answer', {answer, fromViewerId})
9. ICE candidates exchanged → emit('ice-candidate', {candidate, toSocketId})
```

### Key Changes Made

#### Client-Side (App.tsx)
- ✅ Added proper WebRTC peer connection handling
- ✅ Implemented audio analysis with Web Audio API
- ✅ Added canvas-based test stream rendering
- ✅ Fixed viewer stream request flow
- ✅ Added comprehensive error handling and logging

#### Server-Side (index.js)  
- ✅ Updated WebSocket handlers for proper signaling
- ✅ Added viewer stream request routing
- ✅ Implemented per-viewer offer/answer handling
- ✅ Fixed ICE candidate relay between peers

#### UI Components
- ✅ Added audio level meter to StreamViewer
- ✅ Enhanced test stream visualization
- ✅ Added proper loading states

## Testing Instructions

### 1. Basic Functionality Test
```bash
# Start the application
npm run dev

# Open http://localhost:3000 in first tab
# Click "Start Streaming" and allow camera/mic access
# Should see your video + audio level meter

# Open http://localhost:3000 in second tab (or incognito)
# Should automatically see the stream from first tab
```

### 2. Test Stream Functionality
```bash
# Press Ctrl+Shift+A to open admin panel
# Login with: onestreamer-admin-2024
# Go to "Test Stream" tab
# Click "Start Test Stream"
# Should see color bars with moving text in main view
```

### 3. Audio Level Testing  
```bash
# Start streaming
# Speak into microphone
# Should see green bar moving in audio level meter
# Loud sounds should turn yellow/red
```

### 4. Multi-Viewer Test
```bash
# Tab 1: Start streaming
# Tab 2: Should see stream automatically  
# Tab 3: Should also see same stream
# Close Tab 1: Stream should end for all viewers
```

## Debugging Console Messages

### Expected Console Output

#### Streamer Tab:
```
Stream started, waiting for viewers...
Viewer requesting stream: [viewer-socket-id]
Sent offer to viewer: [viewer-socket-id]  
Connection state: connecting
ICE connection state: checking
Connection state: connected
ICE connection state: connected
```

#### Viewer Tab:
```  
Requesting stream from: [streamer-socket-id]
Received stream offer from: [streamer-socket-id]
Received remote stream: [MediaStream object]
Connection state: connecting  
ICE connection state: checking
Connection state: connected
ICE connection state: connected
```

### Troubleshooting Common Issues

#### No Video in Viewer Tab
1. Check browser console for WebRTC errors
2. Verify both tabs are on same domain (no mixed localhost/127.0.0.1)
3. Check if camera permission was granted in streamer tab
4. Look for ICE connection failures (firewall/network issues)

#### Audio Level Not Working
1. Ensure microphone permission granted
2. Check if Web Audio API is supported (modern browsers only)
3. Verify audio track is present in MediaStream
4. Test with different microphone if available

#### Test Stream Not Visible
1. Check admin panel login (correct key)
2. Verify test stream started successfully in admin panel
3. Look for canvas rendering errors in console
4. Check if test stream is marked as active streamer

## Network Requirements

### Firewall Considerations
- **STUN servers**: Must allow outbound connections to:
  - stun.l.google.com:19302
  - stun1.l.google.com:19302
- **WebSocket**: Port 8080 (configurable)
- **HTTPS**: Required for camera access in production

### Browser Support
- **Chrome/Edge**: Full support ✅
- **Firefox**: Full support ✅  
- **Safari**: Limited WebRTC support ⚠️
- **Mobile browsers**: Basic support ✅

## Performance Considerations

### Bandwidth Usage (per viewer)
- **720p stream**: ~1-2 Mbps
- **1080p stream**: ~2-4 Mbps  
- **Audio**: ~64-128 kbps

### Server Resources
- **CPU**: Minimal (signaling only)
- **Memory**: ~1MB per connection
- **Network**: WebSocket messages only

The streaming is peer-to-peer, so server doesn't relay video data.

## Production Deployment Notes

### Required Environment Variables
```bash
PORT=8080
ADMIN_KEY=your-secure-admin-key  
COOLDOWN_SECONDS=30
```

### HTTPS Requirements
- Camera/microphone access requires HTTPS in production
- Use proper SSL certificates
- Configure reverse proxy (nginx/Apache) if needed

### Scaling Considerations
- Current architecture: 1 streamer → many viewers
- For multiple concurrent streams, need stream routing logic
- Consider using a TURN server for NAT traversal in corporate networks

This implementation should resolve all the streaming issues you encountered!