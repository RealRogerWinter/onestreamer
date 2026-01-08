# Viewbot Buff Isolation Fix

## Problem
When using buff/debuff items on viewbots, the effects were incorrectly broadcast to all viewers instead of being isolated to just the viewbot.

## Root Cause
The buff system had several broadcast points that used `io.emit()` to send updates to ALL connected users:
1. `BuffDebuffService.applyBuff()` - Line 125 & 131: Broadcasting buff-applied and user-buff-update to all users
2. `BuffDebuffService.removeBuff()` - Line 276 & 286: Broadcasting buff-expired and user-buff-update to all users  
3. `BuffDebuffService.updateBuffDurations()` - Line 407: Broadcasting periodic buff updates to all users
4. `server/index.js` apply-buff-item handler - Line 2475: Broadcasting user-buff-update to all users

## Solution Implemented

### 1. Synthetic User ID Detection
- Viewbots use negative synthetic user IDs (created from viewbot stream ID hash)
- Regular users have positive user IDs
- This allows easy identification: `userId < 0` = viewbot, `userId >= 0` = human user

### 2. Conditional Broadcasting
Modified all broadcast points to check if the target is a viewbot:

**BuffDebuffService.js:**
- Added `skipBroadcasts` parameter to `applyBuff()` method
- Modified broadcast logic to respect `skipBroadcasts` flag
- Added user ID checks in `removeBuff()` and `updateBuffDurations()` to skip broadcasts for negative user IDs

**ItemService.js:**
- Modified `applyBuffDebuffItem()` to detect viewbot targets and pass `skipBroadcasts = true`

**server/index.js:**
- Modified apply-buff-item handler to skip broadcasts for viewbot targets

### 3. Logging for Debugging
Added console logs when broadcasts are skipped for viewbots:
- "🎭 BUFF: Skipping broadcast for viewbot user [ID] - buffs applied silently"
- "🎭 BUFF: Skipped all broadcasts for user [ID] (viewbot)"
- "🎭 BUFF: Skipped broadcasts for viewbot user [ID] buff removal"

## Result
- ✅ Buffs applied to viewbots no longer affect other viewers
- ✅ Buffs applied to human users still broadcast normally  
- ✅ Viewbots still receive and process buffs internally (duration countdown, etc.)
- ✅ No breaking changes to existing functionality

## Testing
To test this fix:
1. Start a viewbot
2. Apply a buff/debuff item to the viewbot
3. Verify that other viewers don't receive the buff effect
4. Verify that the viewbot's internal buff state is updated correctly

The fix ensures complete isolation between viewbot buffs and human user buffs while maintaining full functionality.