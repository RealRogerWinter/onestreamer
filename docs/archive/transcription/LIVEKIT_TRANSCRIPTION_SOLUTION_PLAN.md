> Archived 2026-05-23 — historical note, not maintained. See /docs/features/transcription.md for current state.

# LiveKit Transcription Solution - Comprehensive Technical Plan

## Executive Summary

**Problem:** MovieBots don't receive transcriptions in LiveKit mode because GStreamer webrtcbin is incompatible with LiveKit's WebRTC signaling protocol.

**Root Cause Analysis:**
- ViewBots publish to LiveKit via RTMP → LiveKit Ingress Service → LiveKit Room
- Transcription attempts to subscribe via GStreamer webrtcbin (FAILS)
- LiveKit Egress service not available in self-hosted setup
- No server-side audio track subscription implemented

**Proposed Solution:** Capture audio from RTMP streams before LiveKit Ingress processing using FFmpeg

## Architecture Discovery

### Current LiveKit Infrastructure

```
ViewBot (GStreamer)
    ↓ RTMP stream
LiveKit Ingress (port 1935) - Docker container
    ↓ WebRTC tracks
LiveKit Server (port 7882)
    ↓ WebRTC subscription
Browser Clients + ViewBots
```

### Key Findings

1. **LiveKit Ingress Service Running**
   - Docker container: `livekit/ingress:latest`
   - RTMP port: 1935
   - Process: `ingress --config /etc/ingress.yaml`
   - Active ingress handler processes visible in `ps aux`

2. **RTMP Stream Pattern**
   - URL: `rtmp://127.0.0.1:1935/live/STREAM_KEY`
   - Example: `rtmp://127.0.0.1:1935/live/3duUvhgPnn7x`
   - Each viewbot gets unique stream key
   - Stream contains both audio and video

3. **Ingress API Available**
   - `RoomServiceClient.listIngress()` - list all ingress streams
   - `RoomServiceClient.listIngress({ roomName })` - filter by room
   - Returns IngressInfo with stream_key, url, status

4. **Existing MediaSoup Transcription Works**
   - Uses PlainTransport + RTP capture
   - FFmpeg converts RTP → WAV → Whisper
   - MovieBot receives transcription events

## Solution Architecture

### **Option 1: RTMP Stream Interception (RECOMMENDED)**

**Concept:** Tap into RTMP streams before they reach LiveKit Ingress

**Advantages:**
- ✅ No additional LiveKit infrastructure needed
- ✅ Works with existing ingress setup
- ✅ Simple FFmpeg-based implementation
- ✅ Direct access to audio stream
- ✅ No WebRTC complexity

**Implementation Flow:**
```
1. MovieBot requests transcription for streamerId
2. TranscriptionService queries listIngress() API
3. Find ingress for current streamer/room
4. Extract stream_key from IngressInfo
5. FFmpeg pulls from rtmp://127.0.0.1:1935/live/{stream_key}
6. Convert to 16kHz mono WAV
7. Whisper transcribes
8. MovieBot receives transcription events
```

**Technical Details:**
```javascript
// 1. Query active ingress
const ingressList = await roomClient.listIngress({
  roomName: 'onestreamer-main'
});

// 2. Find ingress for current participant
const ingress = ingressList.find(i =>
  i.participantIdentity.includes(streamerId) ||
  i.state.status === 'ENDPOINT_PUBLISHING'
);

// 3. Extract stream key
const streamKey = ingress.streamKey;
const rtmpUrl = `rtmp://127.0.0.1:1935/live/${streamKey}`;

// 4. FFmpeg capture
ffmpeg -i ${rtmpUrl} \
  -vn \                          # No video
  -ar 16000 \                    # 16kHz for Whisper
  -ac 1 \                        # Mono
  -f wav \                       # WAV output
  output.wav
```

**Code Changes Required:**
1. Update `TranscriptionAudioAdapter.createLiveKitAudioCapture()`
   - Add `listIngress()` call
   - Extract stream key
   - Return RTMP URL info

2. Update `TranscriptionAudioAdapter.startLiveKitAudioBuffering()`
   - Replace GStreamer webrtcbin command
   - Use FFmpeg with RTMP input
   - Keep existing WAV output logic

3. No changes needed to:
   - MovieBotService
   - TranscriptionService core logic
   - Whisper processing
   - Event emission

### **Option 2: LiveKit Server-Side Participant SDK**

**Concept:** Use `@livekit/rtc-node` to subscribe as server participant

**Advantages:**
- ✅ Official LiveKit solution
- ✅ Native WebRTC subscription
- ✅ Future-proof for LiveKit updates

**Disadvantages:**
- ❌ Requires installing new package (`@livekit/rtc-node`)
- ❌ More complex implementation
- ❌ Requires handling WebRTC audio frames
- ❌ Need to pipe audio to FFmpeg or write WAV manually

**Not recommended** due to complexity vs Option 1

### **Option 3: LiveKit Egress Service**

**Concept:** Deploy LiveKit Egress service for track recording

**Advantages:**
- ✅ Official LiveKit recording solution
- ✅ Production-grade

**Disadvantages:**
- ❌ Requires deploying another Docker container
- ❌ Additional infrastructure complexity
- ❌ Overkill for transcription use case

**Not recommended** - too much overhead

## Detailed Implementation Plan - Option 1 (RECOMMENDED)

### Phase 1: Ingress Discovery (2 hours)

**File:** `server/services/TranscriptionAudioAdapter.js`

**Method:** `createLiveKitAudioCapture()`

```javascript
async createLiveKitAudioCapture(sessionId, streamerId) {
    // 1. Get LiveKit config
    const config = require('../config/webrtc.config').livekit;

    // 2. Create room client
    const roomClient = new RoomServiceClient(...);

    // 3. List active ingress streams
    const ingressList = await roomClient.listIngress({
        roomName: config.roomName
    });

    // 4. Find ingress for this participant
    // Try multiple matching strategies:
    // - Exact participant identity match
    // - Participant identity contains streamerId
    // - Most recently active ingress (fallback)

    const ingress = ingressList.find(i =>
        i.participantIdentity === streamerId ||
        i.participantIdentity.includes(streamerId) ||
        (i.state && i.state.status === 'ENDPOINT_PUBLISHING')
    );

    if (!ingress) {
        return {
            success: false,
            error: 'No active ingress found for streamer'
        };
    }

    // 5. Extract stream information
    const streamKey = ingress.streamKey;
    const rtmpUrl = `rtmp://127.0.0.1:1935/live/${streamKey}`;

    console.log(`✅ Found RTMP stream: ${rtmpUrl}`);
    console.log(`   Ingress ID: ${ingress.ingressId}`);
    console.log(`   Participant: ${ingress.participantIdentity}`);

    return {
        success: true,
        captureType: 'livekit-rtmp',
        rtmpUrl: rtmpUrl,
        ingressId: ingress.ingressId,
        streamKey: streamKey,
        participantIdentity: ingress.participantIdentity,
        // Compatibility placeholders
        transport: { id: 'rtmp-transport', closed: false },
        consumer: { id: 'rtmp-consumer', paused: false }
    };
}
```

### Phase 2: RTMP Audio Capture (2 hours)

**File:** `server/services/TranscriptionAudioAdapter.js`

**Method:** `startLiveKitAudioBuffering()`

```javascript
async startLiveKitAudioBuffering(session, captureInfo, audioBufferService) {
    console.log(`🎵 Starting RTMP audio capture for ${session.id}`);

    const bufferDir = path.join(__dirname, '..', '..', 'audio-buffers');
    const bufferFile = path.join(bufferDir, `${session.id}.wav`);

    // Ensure directory exists
    if (!fs.existsSync(bufferDir)) {
        fs.mkdirSync(bufferDir, { recursive: true });
    }

    const rtmpUrl = captureInfo.rtmpUrl;

    console.log(`📡 Capturing from RTMP: ${rtmpUrl}`);

    // FFmpeg command to capture audio from RTMP stream
    const ffmpegArgs = [
        '-i', rtmpUrl,              // Input: RTMP stream
        '-vn',                      // No video
        '-ar', '16000',             // Sample rate: 16kHz (Whisper compatible)
        '-ac', '1',                 // Channels: mono
        '-acodec', 'pcm_s16le',     // Audio codec: 16-bit PCM
        '-f', 'wav',                // Format: WAV
        '-y',                       // Overwrite output
        bufferFile
    ];

    console.log(`🎬 FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    let errorOutput = '';

    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        errorOutput += msg;

        // Log errors but not progress updates
        if (msg.includes('ERROR') || msg.includes('error')) {
            console.error(`❌ FFmpeg error: ${msg.trim()}`);
        }

        // Detect successful connection
        if (msg.includes('Stream #0') || msg.includes('Input #0')) {
            console.log(`✅ Connected to RTMP stream`);
        }
    });

    ffmpegProcess.on('error', (error) => {
        console.error(`❌ FFmpeg process error:`, error);
    });

    ffmpegProcess.on('exit', (code, signal) => {
        console.log(`🎬 FFmpeg exited: code=${code}, signal=${signal}`);
    });

    // Wait to verify FFmpeg started successfully
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check if process is still running
    if (ffmpegProcess.exitCode !== null) {
        return {
            success: false,
            error: `FFmpeg exited immediately: ${errorOutput}`
        };
    }

    // Store process info
    session.audioProcess = ffmpegProcess;
    session.bufferFile = bufferFile;
    session.rtmpUrl = rtmpUrl;

    console.log(`✅ RTMP audio capture started`);
    console.log(`   Output: ${bufferFile}`);

    return {
        success: true,
        bufferFile: bufferFile,
        process: ffmpegProcess
    };
}
```

### Phase 3: Update Audio Buffering Router (1 hour)

**File:** `server/services/TranscriptionAudioAdapter.js`

**Method:** `startAudioBuffering()`

```javascript
async startAudioBuffering(session, captureInfo, audioBufferService) {
    if (captureInfo.captureType === 'mediasoup-rtp') {
        // MediaSoup: Use existing AudioBufferService
        return await audioBufferService.startBuffering(
            session.id,
            captureInfo.transport,
            captureInfo.consumer,
            captureInfo.ffmpegRtpPort,
            captureInfo.ffmpegRtcpPort
        );
    } else if (captureInfo.captureType === 'livekit-rtmp') {
        // LiveKit: Use RTMP capture
        return await this.startLiveKitAudioBuffering(
            session,
            captureInfo,
            audioBufferService
        );
    } else if (captureInfo.captureType === 'livekit-subscribe') {
        // Legacy GStreamer attempt (will fail, kept for fallback logging)
        return await this.startLiveKitAudioBuffering(
            session,
            captureInfo,
            audioBufferService
        );
    }

    throw new Error(`Unsupported capture type: ${captureInfo.captureType}`);
}
```

### Phase 4: Cleanup Handler (30 minutes)

**File:** `server/services/TranscriptionAudioAdapter.js`

**Method:** `cleanup()`

```javascript
async cleanup(session) {
    console.log(`🧹 Cleaning up transcription session ${session.id}`);

    // Stop FFmpeg process (works for both RTMP and RTP)
    if (session.audioProcess) {
        try {
            session.audioProcess.kill('SIGTERM');
            console.log(`✅ Stopped audio capture process`);
        } catch (error) {
            console.error(`⚠️ Error stopping process:`, error);
        }
    }

    // Close MediaSoup transport/consumer if present
    if (session.transport && typeof session.transport.close === 'function') {
        try {
            if (!session.transport.closed) {
                session.transport.close();
            }
        } catch (error) {
            console.error(`⚠️ Error closing transport:`, error);
        }
    }

    if (session.consumer && typeof session.consumer.close === 'function') {
        try {
            if (!session.consumer.closed) {
                session.consumer.close();
            }
        } catch (error) {
            console.error(`⚠️ Error closing consumer:`, error);
        }
    }
}
```

## Testing Plan

### Unit Testing

1. **Test Ingress Discovery**
   ```bash
   # Manually test listIngress API
   node -e "
   const { RoomServiceClient } = require('livekit-server-sdk');
   const client = new RoomServiceClient('http://127.0.0.1:7882', 'devkey', 'secret');
   client.listIngress({ roomName: 'onestreamer-main' })
     .then(list => console.log(JSON.stringify(list, null, 2)));
   "
   ```

2. **Test RTMP Capture**
   ```bash
   # Manual FFmpeg test with known stream key
   ffmpeg -i rtmp://127.0.0.1:1935/live/STREAM_KEY \
     -vn -ar 16000 -ac 1 -f wav -y /tmp/test.wav
   ```

3. **Test WAV File Quality**
   ```bash
   # Verify WAV file properties
   ffprobe /tmp/test.wav
   # Should show: 16000 Hz, mono, pcm_s16le
   ```

### Integration Testing

1. **Test with Active ViewBot**
   - Start viewbot
   - Enable MovieBot
   - Wait for transcription attempt
   - Check logs for "Found RTMP stream"
   - Check logs for "Connected to RTMP stream"
   - Verify WAV file created with non-zero size
   - Verify Whisper transcription completes
   - Verify MovieBot receives transcription

2. **Test Error Handling**
   - No active streamer → Should fail gracefully
   - Stream ends mid-capture → Should cleanup properly
   - Invalid stream key → Should return error

### End-to-End Testing

1. Start viewbot streaming
2. Enable MovieBot via UI
3. Monitor logs:
   ```bash
   pm2 logs onestreamer-server --lines 0 | grep -E "TRANSCRIPTION|RTMP|FFmpeg|MovieBot.*comment"
   ```
4. Expected output:
   ```
   ✅ Found RTMP stream: rtmp://127.0.0.1:1935/live/xxxxx
   📡 Capturing from RTMP: rtmp://127.0.0.1:1935/live/xxxxx
   ✅ Connected to RTMP stream
   ✅ RTMP audio capture started
   📝 TRANSCRIPTION: Transcription completed (X words)
   🎬 MovieBotService: Processing transcription
   ✅ MovieBotService: Bot generated comment: "..."
   ```

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| RTMP stream lag | Medium | Low | Use buffer in FFmpeg (-rtbufsize) |
| Stream key mismatch | Low | Medium | Fallback to first active ingress |
| FFmpeg failure | Low | Medium | Proper error logging and cleanup |
| Ingress API changes | Low | High | Version lock livekit-server-sdk |
| Multiple concurrent transcriptions | Medium | Medium | Track active sessions, prevent duplicates |

## Rollback Plan

If solution fails:
1. Code is non-destructive - MediaSoup untouched
2. Simply set `WEBRTC_BACKEND=mediasoup`
3. Restart server
4. MediaSoup transcription resumes immediately

## Performance Considerations

### Resource Usage
- FFmpeg RTMP capture: ~5-10 MB RAM per session
- Similar to current MediaSoup RTP capture
- No additional CPU overhead

### Scalability
- Can handle multiple concurrent transcriptions
- Each gets separate FFmpeg process
- Limited by available RTMP stream bandwidth

## Timeline Estimate

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Ingress Discovery | 2 hours | None |
| Phase 2: RTMP Capture | 2 hours | Phase 1 |
| Phase 3: Router Update | 1 hour | Phase 2 |
| Phase 4: Cleanup | 30 min | Phase 3 |
| Testing | 2 hours | All phases |
| **Total** | **7.5 hours** | |

## Success Criteria

1. ✅ Transcription starts when MovieBot enabled (LiveKit mode)
2. ✅ Audio buffer WAV files created with >0 bytes
3. ✅ Whisper successfully transcribes audio
4. ✅ MovieBots receive transcription events
5. ✅ MovieBots generate comments based on transcriptions
6. ✅ Comments appear in chat
7. ✅ MediaSoup mode unchanged and functional
8. ✅ No new external dependencies required
9. ✅ Clean error handling and logging
10. ✅ Proper cleanup on session end

## Alternative Considered (Why Not Chosen)

### WHEP Pull Protocol
- Not well supported yet
- No simple FFmpeg integration
- Requires additional signaling infrastructure

### LiveKit Client SDK in Node.js
- Browser-focused, requires polyfills
- WebRTC stack in Node.js is complex
- Audio frame handling requires custom WAV writing

### Direct WebRTC Subscription
- Would need to implement WebRTC stack
- ICE/DTLS negotiation complexity
- RTMP solution is simpler and proven

## Conclusion

**Recommended Approach:** Option 1 - RTMP Stream Interception

**Rationale:**
- Leverages existing infrastructure (LiveKit Ingress)
- Simple FFmpeg-based implementation
- No new dependencies
- Proven technology stack
- Direct path from audio source
- Non-destructive to MediaSoup implementation

**Expected Outcome:**
MovieBots will successfully receive and respond to transcriptions in LiveKit mode, achieving feature parity with MediaSoup mode.

## Questions for Review

1. Should we add rate limiting for ingress API calls?
2. Should we cache ingress list results (TTL)?
3. How should we handle multiple ingress for same room (choose most recent)?
4. Should we add metrics/monitoring for RTMP capture?
5. Should we implement automatic retry on RTMP connection failure?

---

**Prepared by:** Claude Code
**Date:** 2025-10-06
**Status:** Awaiting approval before implementation
