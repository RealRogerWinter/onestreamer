# Real-Time Stream Transcription Guide

## Overview
The OneStreamer platform now includes a powerful real-time transcription feature that can convert audio from live streams into text using local, free transcription technology powered by Whisper.

## Features
- ✅ **Real-time transcription** - Processes audio in 5-second chunks with minimal latency
- ✅ **100% Free** - Uses local Whisper models, no API costs
- ✅ **Privacy-focused** - Audio never leaves your server
- ✅ **Multiple language support** - Supports 99+ languages
- ✅ **WebSocket integration** - Live updates via Socket.IO
- ✅ **Database persistence** - Full transcript history
- ✅ **Configurable models** - Choose between tiny, base, small, medium, or large models

## Architecture

### Audio Processing Pipeline
```
MediaSoup Audio Stream
    ↓
Plain Transport (RTP)
    ↓
FFmpeg (Opus → PCM 16kHz)
    ↓
Audio Buffer (5-30s chunks)
    ↓
Whisper Processing
    ↓
Text Output → WebSocket Events
```

## Setup Instructions

### 1. Install Dependencies
```bash
# Run the setup script to download Whisper models
node setup-whisper.js

# Run database migrations
node server/migrations/setup-transcription-tables.js
```

### 2. Whisper Model Selection
Models are stored in `whisper/models/`:
- **tiny** (~39 MB) - Fastest, lowest accuracy
- **base** (~142 MB) - Good balance (recommended)
- **small** (~466 MB) - Better accuracy
- **medium** (~1.5 GB) - High accuracy
- **large** (~2.9 GB) - Best accuracy, slowest

### 3. Platform-Specific Setup

#### Windows
- The system uses `@xenova/transformers` as a fallback
- For better performance, consider using WSL2 or Docker
- Pre-built binaries available at: https://github.com/ggerganov/whisper.cpp/releases

#### Linux/macOS
- Build whisper.cpp from source (automatic with setup script)
- Requires: gcc, make, cmake

## API Endpoints

### Start Transcription
```http
POST /admin/transcription/start
Headers: x-admin-key: YOUR_ADMIN_KEY
Body: {
  "streamerId": "socket-id-of-streamer",
  "options": {
    "model": "base",
    "language": "en"  // or "auto" for detection
  }
}
```

### Stop Transcription
```http
POST /admin/transcription/stop/:sessionId
Headers: x-admin-key: YOUR_ADMIN_KEY
```

### Get Transcription
```http
GET /api/transcription/:sessionId
Headers: Authorization: Bearer YOUR_JWT_TOKEN
```

### Get Active Transcriptions
```http
GET /api/transcriptions/active
Headers: Authorization: Bearer YOUR_JWT_TOKEN
```

### Configure Transcription
```http
POST /admin/transcription/config
Headers: x-admin-key: YOUR_ADMIN_KEY
Body: {
  "enable": true,
  "model": "base",
  "language": "en"
}
```

### Get Transcription Status
```http
GET /admin/transcription/status
Headers: x-admin-key: YOUR_ADMIN_KEY
```

## WebSocket Events

### Client → Server
```javascript
// Start transcription
socket.emit('start-transcription', {
  streamerId: 'streamer-socket-id',
  options: { model: 'base', language: 'en' }
});

// Stop transcription
socket.emit('stop-transcription', {
  sessionId: 'transcription-session-id'
});
```

### Server → Client
```javascript
// Transcription started
socket.on('transcription-started', (data) => {
  console.log('Session ID:', data.sessionId);
  console.log('Streamer:', data.streamerId);
});

// Real-time transcription updates
socket.on('transcription-update', (data) => {
  console.log('Chunk:', data.chunkNumber);
  console.log('Text:', data.text);
  console.log('Words:', data.wordCount);
});

// Transcription stopped
socket.on('transcription-stopped', (data) => {
  console.log('Duration:', data.duration);
  console.log('Total words:', data.wordCount);
});
```

## Testing

### 1. Test API Connection
```bash
node test-transcription.js
```

### 2. Manual Testing Flow
1. Start the server: `npm run dev`
2. Start a stream (use admin panel or test stream)
3. Start transcription via API or WebSocket
4. Monitor console for transcription output
5. Stop transcription when done

### 3. Check Transcription Output
Transcripts are stored in:
- Database: `transcriptions` and `transcription_chunks` tables
- Real-time: Via WebSocket events
- API: GET `/api/transcription/:sessionId`

## Configuration

### Service Configuration (TranscriptionService.js)
```javascript
config = {
  enableTranscription: false,  // Global enable/disable
  model: 'base',               // Whisper model size
  language: 'en',              // Target language or 'auto'
  chunkDuration: 5000,         // Process 5-second chunks
  overlapDuration: 500,        // 0.5s overlap for context
  maxBufferSize: 30000,        // 30s maximum buffer
}
```

### Performance Tuning
- **Chunk Duration**: Shorter = lower latency, longer = better context
- **Model Selection**: Larger models = better accuracy but slower
- **Thread Count**: Adjust in whisper args for CPU usage

## Troubleshooting

### No Audio Detected
- Check if stream has audio producer: `mediasoupService.producers.get(streamerId)`
- Verify FFmpeg is installed: `ffmpeg -version`
- Check audio transport creation in logs

### Poor Transcription Quality
- Try a larger model (small or medium)
- Ensure good audio quality from source
- Check language setting matches audio

### High CPU Usage
- Use smaller model (tiny or base)
- Increase chunk duration
- Reduce concurrent transcriptions

### Windows-Specific Issues
- Install Visual C++ Redistributables
- Use WSL2 for better performance
- Check Windows Defender isn't blocking

## Database Schema

### transcriptions
- `id`: Session ID
- `stream_id`: Associated stream
- `streamer_id`: User ID of streamer
- `start_time`, `end_time`: Session duration
- `language`, `model`: Configuration used
- `word_count`: Total words transcribed
- `status`: active/completed/failed

### transcription_chunks
- `transcription_id`: Parent session
- `chunk_number`: Sequential chunk ID
- `text`: Transcribed text
- `timestamp`: When processed
- `word_count`: Words in chunk

## Resource Requirements

### CPU Usage (per active transcription)
- Tiny: ~10-20% of 1 core
- Base: ~20-40% of 1 core
- Small: ~40-60% of 1 core
- Medium: ~60-100% of 1 core
- Large: ~100-200% of 1 core

### Memory Usage
- Service overhead: ~100MB
- Per transcription: 200-500MB
- Model loaded: 50MB-3GB (depending on size)

### Disk Space
- Models: 50MB-3GB
- Temp audio files: ~1MB per minute
- Database: ~1KB per minute of transcript

## Future Enhancements
- [ ] Speaker diarization (identify different speakers)
- [ ] Punctuation enhancement
- [ ] Real-time translation
- [ ] Subtitle file generation (SRT/VTT)
- [ ] Keyword highlighting
- [ ] Sentiment analysis
- [ ] Custom vocabulary support
- [ ] GPU acceleration support

## Support
For issues or questions:
1. Check server logs for detailed error messages
2. Verify all dependencies are installed
3. Test with the provided test script
4. Check WebSocket connection status

## License
This transcription feature uses OpenAI's Whisper model (MIT License) via the whisper.cpp implementation.