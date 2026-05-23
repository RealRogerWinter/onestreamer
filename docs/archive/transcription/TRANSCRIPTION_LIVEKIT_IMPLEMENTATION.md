> Archived 2026-05-23 — historical note, not maintained. See /docs/features/transcription.md for current state.

# LiveKit Transcription Implementation

## Overview

The transcription service has been updated to support both MediaSoup and LiveKit backends through a non-destructive adapter pattern. This implementation preserves 100% backward compatibility with the existing MediaSoup implementation while adding LiveKit support.

## Architecture

### Key Components

1. **TranscriptionAudioAdapter** (`server/services/TranscriptionAudioAdapter.js`)
   - Provides unified interface for audio capture
   - Detects backend type (MediaSoup or LiveKit)
   - Implements backend-specific audio capture logic

2. **TranscriptionService** (`server/services/TranscriptionService.js`)
   - Updated to use TranscriptionAudioAdapter
   - Maintains all existing functionality
   - Automatically adapts based on active backend

3. **MovieBotService** (`server/services/MovieBotService.js`)
   - No changes required - works with both backends
   - Receives transcription events regardless of backend

### How It Works

#### MediaSoup Mode (Existing Implementation - Preserved)
```
Streamer Audio → MediaSoup Producer → Plain Transport → FFmpeg RTP Capture → WAV Buffer → Whisper Transcription → MovieBot
```

#### LiveKit Mode (New Implementation)
```
Streamer Audio → LiveKit Participant Track → GStreamer WebRTC Capture → WAV Buffer → Whisper Transcription → MovieBot
```

## Implementation Details

### Backend Detection

The adapter automatically detects which backend is active:

```javascript
detectBackend() {
    if (typeof this.webrtcService.getBackendType === 'function') {
        return this.webrtcService.getBackendType();
    }
    if (this.webrtcService.constructor.name === 'LiveKitService') {
        return 'livekit';
    }
    return 'mediasoup'; // default
}
```

### MediaSoup Audio Capture

Uses the existing proven implementation:
- Creates PlainTransport for RTP streaming
- Creates consumer for audio producer
- FFmpeg captures RTP stream via SDP
- Converts to 16kHz mono WAV for Whisper

### LiveKit Audio Capture

New implementation using GStreamer:
- Subscribes to audio track via LiveKit API
- Uses GStreamer `webrtcbin` to capture WebRTC stream
- Converts to 16kHz mono WAV for Whisper
- Falls back with error message if GStreamer not available

## Dependencies

### For MediaSoup (Already Available)
- FFmpeg
- mediasoup library

### For LiveKit (Required for LiveKit Audio Capture)
- GStreamer with webrtcbin plugin
- livekit-server-sdk (already installed)

### Installing GStreamer on Ubuntu/Debian

```bash
# Install GStreamer and required plugins
sudo apt-get update
sudo apt-get install -y \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-nice \
    gstreamer1.0-libav

# Verify installation
gst-inspect-1.0 webrtcbin
```

## Usage

### No Code Changes Required

The transcription service automatically adapts based on the WebRTC backend configured in `server/config/webrtc.config.js`:

```javascript
module.exports = {
  backend: process.env.WEBRTC_BACKEND || 'mediasoup', // or 'livekit'
  // ...
};
```

### Testing with MediaSoup

```bash
# Set backend to mediasoup (default)
export WEBRTC_BACKEND=mediasoup

# Start server
npm start

# Transcription will use MediaSoup audio capture
```

### Testing with LiveKit

```bash
# Ensure GStreamer is installed
gst-inspect-1.0 webrtcbin

# Set backend to livekit
export WEBRTC_BACKEND=livekit

# Start server
npm start

# Transcription will use LiveKit audio capture
```

## API Compatibility

### TranscriptionService Methods (Unchanged)

All existing methods work identically:

- `startTranscription(streamerId, options)`
- `stopTranscription(sessionId)`
- `startTimedTranscription(streamerId, duration, options)`
- Event: `transcription-chunk`
- Event: `transcription-stopped`

### MovieBotService Integration (Unchanged)

MovieBotService continues to work without modification:

```javascript
// Receives transcription events from either backend
transcriptionService.on('transcription-chunk', async (data) => {
    // Process transcription and generate bot responses
    await movieBotService.processTranscriptionWithBatching(data.text, 0);
});
```

## Error Handling

### LiveKit Without GStreamer

If GStreamer is not installed when using LiveKit backend:

```javascript
{
    success: false,
    error: 'LiveKit audio capture requires GStreamer or LiveKit Egress service',
    requiresSetup: true
}
```

### Fallback Behavior

- If LiveKit audio capture fails, error is logged
- Transcription session fails gracefully
- MovieBot will not receive transcriptions for that session
- Next transcription attempt can succeed once GStreamer is installed

## Testing

### Manual Testing

1. **With MediaSoup Backend:**
   ```bash
   export WEBRTC_BACKEND=mediasoup
   npm start
   # Start stream and enable MovieBot
   # Verify transcriptions appear in logs
   ```

2. **With LiveKit Backend:**
   ```bash
   export WEBRTC_BACKEND=livekit
   npm start
   # Start stream and enable MovieBot
   # Verify transcriptions appear in logs
   ```

### Verifying Backend Selection

Check server logs on startup:

```
🎙️ TRANSCRIPTION: Service initialized
   Platform: Unix-like
   Model: base
   Chunk duration: 5000ms
   Backend: LIVEKIT  <-- or MEDIASOUP
```

### Monitoring Audio Capture

MediaSoup mode:
```
📡 TranscriptionAudioAdapter: Creating MediaSoup audio capture
🎬 AudioBufferService: Starting FFmpeg capture
✅ AudioBufferService: Started buffering
```

LiveKit mode:
```
📡 TranscriptionAudioAdapter: Creating LiveKit audio capture
🎵 TranscriptionAudioAdapter: Starting LiveKit audio buffering
🚀 TranscriptionAudioAdapter: Starting GStreamer capture
✅ TranscriptionAudioAdapter: LiveKit audio buffering started
```

## Benefits

### Non-Destructive Implementation

- ✅ Zero changes to existing MediaSoup functionality
- ✅ All MediaSoup code paths preserved
- ✅ Backward compatible with existing deployments
- ✅ Can switch between backends without code changes

### Unified Interface

- ✅ TranscriptionService API unchanged
- ✅ MovieBotService works with both backends
- ✅ Same transcription quality and features
- ✅ Same database schema and event system

### Extensibility

- ✅ Easy to add new audio capture backends
- ✅ Adapter pattern allows for customization
- ✅ Can implement alternative capture methods

## Future Enhancements

### LiveKit Egress Service

For production LiveKit deployments, consider using LiveKit Egress service:
- More reliable than GStreamer capture
- Better performance and quality
- Official LiveKit solution
- Requires LiveKit Cloud or self-hosted Egress

### Adaptive Quality

- Automatically adjust audio sample rate based on backend
- Support multiple transcription models per backend
- Dynamic switching based on stream quality

### Caching

- Cache transcription results
- Reuse transcriptions for repeated audio segments
- Reduce Whisper processing load

## Troubleshooting

### "No audio producer available"

**Cause:** Streamer not actively streaming audio

**Solution:** Ensure streamer has started stream with audio enabled

### "LiveKit audio capture requires GStreamer"

**Cause:** GStreamer not installed or webrtcbin plugin missing

**Solution:** Install GStreamer with required plugins (see Dependencies section)

### "Failed to create audio capture"

**MediaSoup:** Check MediaSoup router is initialized
**LiveKit:** Check LiveKit room exists and participant is connected

### Transcriptions not appearing in MovieBot

**Check:**
1. MovieBot is enabled for the stream
2. Transcription service started successfully
3. Audio buffer file is being created in `audio-buffers/` directory
4. Whisper model is downloaded and accessible
5. Backend is correctly configured

## Configuration

### WebRTC Backend Selection

Edit `server/config/webrtc.config.js` or set environment variable:

```bash
# Use MediaSoup
export WEBRTC_BACKEND=mediasoup

# Use LiveKit
export WEBRTC_BACKEND=livekit
```

### LiveKit Configuration

Required LiveKit settings in `webrtc.config.js`:

```javascript
livekit: {
    host: process.env.LIVEKIT_HOST || 'localhost:7880',
    wsUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    roomName: process.env.LIVEKIT_ROOM || 'main-room'
}
```

## Files Modified

### New Files
- `server/services/TranscriptionAudioAdapter.js` - Audio capture adapter

### Modified Files
- `server/services/TranscriptionService.js` - Updated to use adapter pattern

### Unchanged Files
- `server/services/MovieBotService.js` - No changes needed
- `server/services/ChatBotService.js` - No changes needed
- `server/services/AudioBufferService.js` - Works with both backends
- All other services - No changes needed

## Migration Path

### For Existing MediaSoup Deployments

**No migration required** - System continues to work exactly as before.

### For New LiveKit Deployments

1. Install GStreamer with required plugins
2. Configure LiveKit settings in environment or config file
3. Set `WEBRTC_BACKEND=livekit`
4. Start server
5. Test transcription service

### For Hybrid Deployments

Can switch between backends by restarting server with different `WEBRTC_BACKEND` value.

## Support

For issues or questions:
1. Check server logs for detailed error messages
2. Verify backend configuration
3. Ensure all dependencies are installed
4. Test with simple stream first before complex scenarios
