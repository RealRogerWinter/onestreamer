# ViewBot Shutdown Fix

## Problem
ViewBot services were not shutting down cleanly when the server stopped, causing GStreamer audio and video tracks to continue playing and occasionally leading to sync issues.

## Root Causes

1. **Incomplete ViewbotService cleanup**: The server's shutdown handler only called `viewbotService.cleanup()` when `viewbotService.viewbotProcess` existed, missing the WebRTC service cleanup in other cases.

2. **Missing ViewBotClientService cleanup**: The ViewBotClientService wasn't properly cleaning up its internal GStreamerService or destroying all bot instances during shutdown.

3. **No unified cleanup method**: ViewBotClientService lacked a comprehensive cleanup method for server shutdown.

## Solution

### Changes Made

1. **server/index.js (lines 4783-4790)**:
   - Changed to always call `viewbotService.cleanup()` if the service exists
   - This ensures WebRTC services are properly stopped even when no FFmpeg process is running

2. **server/index.js (lines 4743-4747)**:
   - Simplified to call new unified `viewBotClientService.cleanup()` method
   - Ensures all ViewBot clients and GStreamer processes are properly terminated

3. **server/services/ViewBotClientService.js (lines 720-744)**:
   - Added comprehensive `cleanup()` method that:
     - Stops ViewBot rotation timer
     - Stops auto-validation timer
     - Calls `gstreamerService.stopAll()` to terminate all GStreamer processes
     - Destroys all bot instances

4. **server/services/ViewBotClientService.js (line 703)**:
   - Enhanced `destroyAllBots()` to stop rotation before destroying bots

## Testing

Use the provided test script to verify the fix:

```bash
node test-viewbot-shutdown.js
```

This script will:
1. Start the server
2. Create and start a ViewBot with GStreamer
3. Send a shutdown signal
4. Verify all GStreamer processes are terminated

## Expected Behavior

After these changes:
- All ViewBot-related processes (GStreamer, FFmpeg) terminate cleanly on server shutdown
- No orphaned audio/video tracks continue playing
- Sync issues from lingering processes are eliminated
- Clean server restarts without process conflicts

## Files Modified

1. `server/index.js` - Enhanced shutdown handler
2. `server/services/ViewBotClientService.js` - Added cleanup method
3. `test-viewbot-shutdown.js` - Test script (new file)
4. `VIEWBOT_SHUTDOWN_FIX.md` - This documentation (new file)