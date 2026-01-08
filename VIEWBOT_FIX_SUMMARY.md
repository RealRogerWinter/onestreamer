# ViewBot Rotation Fix Summary

## Problem Identified
The ViewBot rotation system was broken due to multiple issues:

1. **Missing global.io reference**: SimpleViewBotMediaSoup couldn't emit Socket.IO events because `global.io` was never set
2. **Duplicate stream-ready emissions**: Events were being emitted from multiple places causing timing issues
3. **Incorrect event timing**: stream-ready was emitted before GStreamer actually started streaming
4. **Missing global service references**: global.streamService and global.streamManager were not set

## Fixes Applied

### 1. Set Global References (index.js:7000-7004)
```javascript
// CRITICAL FIX: Set global objects so SimpleViewBotMediaSoup can emit events and manage streams
global.io = io;
global.streamService = streamService;
global.streamManager = streamService;  // streamManager and streamService are same
```

### 2. Moved stream-ready Event Emission (SimpleViewBotMediaSoup.js:195-207)
- Moved stream-ready emission from `createProducers()` to `startBot()` 
- Event now emits AFTER GStreamer pipeline starts successfully
- Ensures clients receive the event when stream is actually ready

### 3. Removed Duplicate Emissions (SimpleViewBotMediaSoup.js:431-432)
- Removed duplicate stream-ready emissions from createProducers
- Disabled duplicate emission in rotateToNextBot (line 121)
- Single source of truth for event emission

## Current Status

### Working ✅
- Bot rotation occurs (bots stop and new ones are selected)
- GStreamer pipelines start successfully
- MediaSoup producers are created
- Transport connections established
- Stream ending/ended events are emitted properly

### Partially Working ⚠️
- Stream-ready events are now properly configured but may need additional testing
- Bot selection from cooldown pool works but may need tuning

### Still Issues ❌
- Some timing issues with rapid rotation may still exist
- Duplicate stream-ending events being sent (minor issue)

## Testing Commands

1. Check rotation status:
```bash
curl -k -H "x-admin-key: ***REMOVED-ADMIN-KEY***" https://127.0.0.1:8443/admin/simple-rotation/status 2>/dev/null | python3 -m json.tool
```

2. Force rotation:
```bash
curl -k -X POST -H "x-admin-key: ***REMOVED-ADMIN-KEY***" https://127.0.0.1:8443/admin/simple-rotation/force 2>/dev/null
```

3. Monitor events:
```bash
node test-stream-events.js
```

## Next Steps

1. **Test with actual client**: Open https://onestreamer.live in browser to verify streams are viewable
2. **Monitor for stability**: Let rotation run for extended period to check for memory leaks or process issues
3. **Fine-tune timing**: Adjust rotation intervals and cooldown periods as needed
4. **Clean up old ViewBot system**: Once SimpleViewBotMediaSoup is stable, remove legacy ViewbotService code

## Configuration

Current rotation settings in SimpleViewBotMediaSoup:
- Min rotation interval: 2 minutes
- Max rotation interval: 5 minutes  
- Cooldown duration: 15 minutes
- 6 bots available (5 MP4 files + 1 test pattern)

## Important Files Modified

1. `/root/onestreamer/server/index.js` - Added global references
2. `/root/onestreamer/server/services/SimpleViewBotMediaSoup.js` - Fixed event emission timing
3. No database changes required - using existing viewbot tables

## Verification

To verify the fix is working:
1. Server should show: "✅ GLOBAL OBJECTS: Set global.io and global.streamService for event emission"
2. Rotation should show bot with hasGStreamer: true
3. Stream-ready events should be emitted after each rotation
4. Frontend at https://onestreamer.live should display the stream

## Troubleshooting

If rotation still doesn't work:
1. Check GStreamer is installed: `which gst-launch-1.0`
2. Verify MP4 files exist: `ls /root/onestreamer/server/uploads/*.mp4`
3. Check server logs: `pm2 logs onestreamer-server --lines 100`
4. Ensure ports 8080, 8443 are not blocked
5. Verify MediaSoup is initialized: Check for "✅ MEDIASOUP: Initialization completed" in logs