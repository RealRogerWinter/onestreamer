> Archived 2026-05-23 — historical note, not maintained. See /docs/architecture/viewbot-fleet.md for current state.

# ViewBot System Diagnosis Report

## 🔴 Critical Finding
The ViewBot rotation system has been identified with a fundamental architectural issue:

### Root Cause Analysis

1. **Event Flow Differential**
   - **Real Users**: Connect via Socket.IO → Emit `mediasoup:produce` → Server handles producer creation → Emits `stream-ready`
   - **ViewBots**: Create producers directly via MediaSoup API → No Socket.IO event → No `stream-ready` emission

2. **Current State**
   - SimpleViewBotMediaSoup rotation is running but failing silently
   - ViewBots rotate (mediasoup-bot-1, etc.) but fail to emit stream-ready
   - GStreamer processes start but immediately stop
   - No stream-ready events are being received by clients

3. **Why The Fix Hasn't Worked**
   - The fix attempted to emit stream-ready directly from SimpleViewBotMediaSoup
   - However, ViewBots don't have proper Socket.IO connections
   - They're creating MediaSoup producers in isolation without the full streaming context
   - The timeout (504) occurs because rotation waits for confirmation that never comes

## 🎯 The Real Solution

ViewBots need to simulate real user behavior completely:

### Option 1: Full Client Simulation (Recommended)
```javascript
// ViewBots should connect as actual Socket.IO clients
const socket = io(SERVER_URL);
socket.emit('mediasoup:produce', producerData);
// This triggers the exact same flow as real users
```

### Option 2: Manual Event Triggering
```javascript
// Manually trigger the producer event handler
// This requires simulating the socket context
```

## 📊 Current System Status

- **Rotation**: Enabled but failing
- **Current Bot**: mediasoup-bot-1
- **GStreamer**: Not running (starts then stops)
- **Producers**: Not created properly
- **Stream-Ready Events**: 0 (never emitted)

## 🔧 Why Previous Fixes Failed

1. **Adding global.io**: ✅ Necessary but not sufficient
2. **Emitting from createProducers**: ❌ Wrong context - no proper stream setup
3. **Fixing syntax errors**: ✅ Resolved crashes but not the core issue
4. **Adding debugging**: ✅ Helpful but shows the emission never happens

## 🚨 The Missing Link

ViewBots are missing the entire Socket.IO handshake that real users perform:
1. Socket connection establishment
2. User authentication/session
3. Stream takeover approval
4. Transport creation via Socket.IO
5. Producer creation via Socket.IO events
6. Stream-ready emission

SimpleViewBotMediaSoup bypasses ALL of this, creating a parallel system that never properly integrates.

## 💡 Recommended Fix

### Immediate Solution
Make ViewBots connect as real Socket.IO clients:
1. Create actual socket connections
2. Go through the normal streaming flow
3. Let the existing code handle everything

### Alternative Solution
Add a special handler for ViewBot producers:
1. Detect when SimpleViewBotMediaSoup creates producers
2. Manually trigger the same notification logic
3. Ensure all required state is set

## 📝 Next Steps

1. **Option A**: Rewrite ViewBots to use Socket.IO clients (proper fix)
2. **Option B**: Add ViewBot detection in MediaSoup service and emit events
3. **Option C**: Create a bridge between SimpleViewBotMediaSoup and the notification system

## 🎬 Test Commands

```bash
# Check rotation status
curl -k -H "x-admin-key: ***REMOVED-ADMIN-KEY***" https://127.0.0.1:8443/admin/simple-rotation/status

# Monitor events
node debug-rotation-live.js

# Force rotation
curl -k -X POST -H "x-admin-key: ***REMOVED-ADMIN-KEY***" https://127.0.0.1:8443/admin/simple-rotation/force
```

## ⚠️ Important Notes

- The 504 timeout is caused by the rotation waiting for stream-ready that never comes
- GStreamer stops because it's likely waiting for confirmation
- The entire ViewBot system is architecturally incompatible with the streaming flow
- Real users work perfectly, proving the system itself is functional

## 🎯 Success Criteria

ViewBots will be fixed when:
1. `stream-ready` events are emitted after rotation
2. GStreamer processes stay running
3. Frontend at https://onestreamer.live shows the stream
4. Rotation occurs smoothly without timeouts