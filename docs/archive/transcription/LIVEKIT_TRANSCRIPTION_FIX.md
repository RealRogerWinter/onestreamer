> Archived 2026-05-23 — historical note, not maintained. See /docs/features/transcription.md for current state.

# LiveKit Transcription Fix - Investigation & Resolution

## Problem Identified

MovieBots were not responding to transcriptions when LiveKit mode was enabled.

## Root Cause

The `TranscriptionAudioAdapter` was using incorrect track type comparisons. LiveKit uses **numeric track types** (0, 1, 2) while the code was checking for **string values** ('AUDIO', 'VIDEO', 'DATA').

### LiveKit Track Type Enum
- `Type 0` = AUDIO
- `Type 1` = VIDEO
- `Type 2` = DATA

### The Bug
```javascript
// ❌ INCORRECT - This never matched!
const audioTrack = tracks.find(t => t.type === 'AUDIO');

// ✅ CORRECT - Using numeric type
const TRACK_TYPE_AUDIO = 0;
const audioTrack = tracks.find(t => t.type === TRACK_TYPE_AUDIO);
```

## Investigation Steps

1. **Server Restart Required** - Discovered the server was running old code (started at 00:29, changes made at 00:34)
2. **Backend Detection** - Confirmed LiveKit backend was active: `Backend: LIVEKIT`
3. **Error Analysis** - Found "No audio producer found" errors in logs
4. **LiveKit Room Inspection** - Created test script that revealed track type mismatch
5. **Fix Applied** - Updated `TranscriptionAudioAdapter.js` to use numeric track types

## Files Modified

### 1. `server/services/TranscriptionAudioAdapter.js`
**Lines Changed:** 167-188

**Before:**
```javascript
const streamerParticipant = participants.find(p =>
    p.identity === streamerId ||
    (p.tracks && p.tracks.some(t => t.type === 'AUDIO'))  // ❌ Wrong!
);

const audioTrack = streamerParticipant.tracks?.find(t => t.type === 'AUDIO');  // ❌ Wrong!
```

**After:**
```javascript
// LiveKit track types are numbers: AUDIO=0, VIDEO=1, DATA=2
const TRACK_TYPE_AUDIO = 0;
const TRACK_TYPE_VIDEO = 1;

const streamerParticipant = participants.find(p =>
    p.identity === streamerId ||
    (p.tracks && p.tracks.some(t => t.type === TRACK_TYPE_AUDIO))  // ✅ Correct!
);

const audioTrack = streamerParticipant.tracks?.find(t => t.type === TRACK_TYPE_AUDIO);  // ✅ Correct!
```

## Testing

### Test Script Created
`test-transcription-livekit.js` - Diagnoses LiveKit room and track configuration

**Usage:**
```bash
cd /root/onestreamer
node test-transcription-livekit.js
```

**Expected Output (After Fix):**
```
✅ Found 2 participants in room "onestreamer-main"
🎤 Participants with audio: 2
   viewbot-089cc47d: 1 audio track(s)
     - TR_AMWqMCnc9AJR6Q (active)
   viewbot-0a519f2f: 1 audio track(s)
     - TR_AMF6V9xKisfVta (active)
✅ Audio tracks available for transcription
```

### Verification Steps

1. **Check Backend Selection:**
```bash
pm2 logs onestreamer-server | grep "Backend: LIVEKIT"
```

2. **Verify Adapter Initialization:**
```bash
pm2 logs onestreamer-server | grep "TranscriptionAudioAdapter"
# Should show: "Initialized with LIVEKIT backend"
```

3. **Test Audio Track Detection:**
```bash
node test-transcription-livekit.js
# Should show participants with audio
```

4. **Monitor Transcription Attempts:**
```bash
pm2 logs onestreamer-server --lines 0 | grep "TRANSCRIPTION"
```

## How to Test MovieBot with Transcriptions

### Prerequisites
1. LiveKit server running
2. Active stream with audio
3. MovieBot enabled
4. GStreamer installed (required for LiveKit audio capture)

### Enable MovieBot
Via UI or API:
```bash
curl -X POST http://localhost:8080/api/moviebot/enable \
  -H "Content-Type: application/json" \
  -d '{"streamerId": "YOUR_STREAMER_ID"}'
```

### Expected Flow
1. **Stream starts** → LiveKit participant joins with audio track
2. **MovieBot enabled** → Starts periodic transcription attempts
3. **Audio capture** → GStreamer captures WebRTC audio
4. **Transcription** → Whisper processes audio
5. **Event emitted** → `transcription-chunk` event fired
6. **MovieBot processes** → Generates comment based on transcription
7. **Bot responds** → Message sent to chat

### Monitoring
```bash
# Watch transcription and MovieBot activity
pm2 logs onestreamer-server --lines 0 | grep -E "TRANSCRIPTION|MovieBot.*comment|AudioAdapter"
```

### Expected Log Messages (Successful Flow)

```
🎙️ TranscriptionAudioAdapter: Initialized with LIVEKIT backend
🎙️ TRANSCRIPTION: Service initialized
   Backend: LIVEKIT
📡 TranscriptionAudioAdapter: Creating LiveKit audio capture
✅ Found LiveKit audio track: TR_xxxxx from viewbot-xxxxx
🎵 TranscriptionAudioAdapter: Starting LiveKit audio buffering
🚀 TranscriptionAudioAdapter: Starting GStreamer capture
✅ TranscriptionAudioAdapter: LiveKit audio buffering started
📝 TRANSCRIPTION: Transcription completed (45 words)
🎬 MovieBotService: Processing transcription with batching
🤖 ChatBotService: Sending delayed prompt to bot: BotName
✅ MovieBotService: Bot BotName generated comment: "..."
```

## Current Limitations

### GStreamer Requirement
LiveKit audio capture requires GStreamer with `webrtcbin` support:

```bash
sudo apt-get install -y \
    gstreamer1.0-tools \
    gstreamer1.0-nice \
    gstreamer1.0-plugins-bad
```

### Fallback Behavior
If GStreamer is not available:
```
❌ LiveKit audio capture requires GStreamer or LiveKit Egress service
   Please install GStreamer with webrtcbin support.
```

### Alternative (Future)
For production, consider using LiveKit Egress service instead of GStreamer:
- More reliable
- Better performance
- Official LiveKit solution

## Status

✅ **Bug Fixed** - Track type comparison now uses numeric values
✅ **Server Restarted** - Running updated code
✅ **Audio Detection Working** - Test script confirms audio tracks found
⏳ **End-to-End Testing** - Requires active stream + MovieBot enabled

## Next Steps for Full Verification

1. Start a real stream (not just viewbot)
2. Enable MovieBot via UI or API
3. Monitor logs for transcription events
4. Verify bot responses appear in chat
5. Check that bots reference transcribed audio in their messages

## Summary

The transcription service is now correctly detecting LiveKit audio tracks. The issue was a simple type mismatch (string vs. number) that prevented audio track detection. With this fix, the TranscriptionService should now work identically in both MediaSoup and LiveKit modes.

**Impact:** MovieBots can now receive and respond to transcriptions in LiveKit mode, maintaining feature parity with MediaSoup mode.

**Backward Compatibility:** ✅ MediaSoup mode unchanged and fully functional
**Forward Compatibility:** ✅ LiveKit mode now operational (pending GStreamer installation)
