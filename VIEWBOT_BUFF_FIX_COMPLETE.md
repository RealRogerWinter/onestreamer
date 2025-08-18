# Complete Viewbot Buff/Debuff Fix

## Problems Fixed

### Issue 1: Buffs applied to user instead of viewbot
**Problem**: When using buff/debuff items on viewbots, the effects were applied to the user who used the item instead of the viewbot.

**Root Cause**: Viewbots didn't have user IDs in the session system that the buff system could recognize.

**Solution**: 
1. Created synthetic negative user IDs for viewbots when they start streaming
2. Mapped viewbot socket IDs to synthetic user IDs using `sessionService.linkUserToSocket()`
3. Added viewbot detection logic to translate socket IDs to synthetic user IDs in both socket and HTTP handlers

### Issue 2: Buffs broadcast to all viewers instead of being isolated
**Problem**: When buffs were applied to viewbots, they were broadcast to all connected viewers, causing effects to appear for everyone.

**Root Cause**: The buff system had multiple `io.emit()` calls that broadcast to ALL users regardless of target type.

**Solution**: 
1. Modified all broadcast logic to check if target is a viewbot (negative user ID)
2. Skip all broadcasts for viewbot targets while maintaining internal buff functionality
3. Added conditional broadcasting in `BuffDebuffService` and route handlers

## Files Modified

### 1. `server/index.js`
- **Lines 805-811, 2015-2021**: Added synthetic user ID creation and mapping when viewbots start
- **Lines 881-883, 919-921**: Added synthetic user mapping cleanup when viewbots stop  
- **Lines 2451-2461**: Added viewbot detection and translation in socket handler
- **Lines 2474-2483**: Added conditional broadcasting to skip viewbot targets
- **Lines 173-174**: Added viewbotService and sessionService to app.locals

### 2. `server/services/BuffDebuffService.js`
- **Line 67**: Added `skipBroadcasts` parameter to `applyBuff()` method
- **Lines 123-153**: Modified broadcast logic to respect `skipBroadcasts` flag
- **Lines 274-308**: Modified `removeBuff()` to skip broadcasts for viewbots (negative user IDs)
- **Lines 403-438**: Modified `updateBuffDurations()` to skip broadcasts for viewbots

### 3. `server/services/ItemService.js`
- **Lines 439-447**: Added viewbot detection logic to pass `skipBroadcasts = true` for negative user IDs

### 4. `server/routes/buffs.js`
- **Lines 77, 89-101**: Added viewbot detection and translation logic to HTTP route handler

## How The Fix Works

### Viewbot Detection
- Viewbots are identified by socket IDs that start with "viewbot-" using `viewbotService.isViewbotStream()`
- Synthetic user IDs are negative integers generated from the viewbot's stream ID hash
- Human users have positive user IDs

### Target Translation Process
1. Client sends `targetUserId` (could be human user ID or viewbot socket ID)
2. Server checks if `targetUserId` is a viewbot using `viewbotService.isViewbotStream()`
3. If viewbot: translate socket ID to synthetic user ID using `sessionService.getUserIdBySocketId()`
4. Apply buff to the correct target (synthetic user ID for viewbots, regular user ID for humans)

### Broadcast Isolation
- Before broadcasts: check if `userId >= 0` (human) or `userId < 0` (viewbot)
- Human users: normal broadcasts sent to all relevant sockets
- Viewbots: all broadcasts skipped, buffs work internally but silently

## Result
- ✅ Buffs applied to viewbots now correctly target the viewbot (via synthetic user ID)
- ✅ Buffs applied to viewbots no longer broadcast to other viewers
- ✅ Buffs applied to human users work exactly as before
- ✅ Viewbot internal buff logic works correctly (duration countdown, effects, etc.)
- ✅ Complete isolation between viewbot and human user buff systems
- ✅ No breaking changes to existing functionality

## Testing
The fix handles both socket-based and HTTP API-based buff applications, ensuring complete coverage regardless of how the client applies buffs to viewbots.