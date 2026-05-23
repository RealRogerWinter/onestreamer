> Archived 2026-05-23 — historical note, not maintained. See /docs/architecture/viewbot-fleet.md for current state.

# Investigation: Client Buff Application Behavior

## Current Hypothesis
The issue might be in **what the client sends as `targetUserId`**, not in the server-side logic.

## Key Questions

### 1. What does the client send as `targetUserId`?
**Scenario A (Current Implementation)**: Client sends viewbot socket ID
- `targetUserId = "viewbot-abc123"` 
- Server should detect this and translate to synthetic user ID

**Scenario B (Potential Issue)**: Client sends current streamer's user ID  
- `targetUserId = 3` (user ID of whoever is currently streaming)
- Server would NOT detect this as viewbot and apply buff to user 3

### 2. How does the client determine the target?
The client likely:
1. Gets current streamer info from server
2. Extracts some identifier to use as target
3. Sends that identifier as `targetUserId`

**If the client is getting user ID instead of socket ID, this would explain the issue.**

## Evidence from Server Logs
From recent logs: `✅ BUFF: Applied debuff "Smoke Bomb" to user 3`

This suggests:
- `targetUserId = 3` (human user ID, not viewbot socket ID)  
- No viewbot detection was triggered
- Buff was applied directly to user 3

## Required Investigation

### Need to verify:
1. **What is the current streamer?** 
   - Socket ID: `942jTpSGmn0wiO-CAADb` (from session logs)
   - User ID mapping: `3` (from session logs)
   - Is this a viewbot or human user?

2. **What does the client send?**
   - Need to see the actual HTTP request body: `{ targetUserId: ?, itemId: ? }`
   - If `targetUserId = 3`, then the client is sending user ID (wrong)
   - If `targetUserId = "942jTpSGmn0wiO-CAADb"`, then client is sending socket ID (correct)

3. **Why isn't viewbot detection triggering?**
   - If `targetUserId = 3`, then `viewbotService.isViewbotStream(3)` returns false
   - If `targetUserId = "942jTpSGmn0wiO-CAADb"`, then detection should work

## Test Plan

### Test 1: Identify Current Streamer Type
Check if `942jTpSGmn0wiO-CAADb` is a viewbot:
```javascript
viewbotService.isViewbotStream("942jTpSGmn0wiO-CAADb")
// Should return true if it's a viewbot
```

### Test 2: Verify Client Request Data  
Add logging to see exact request body:
```javascript
console.log('🔍 CLIENT REQUEST:', JSON.stringify(req.body, null, 2));
```

### Test 3: Check Session Mapping
Verify synthetic user ID exists:
```javascript  
sessionService.getUserIdBySocketId("942jTpSGmn0wiO-CAADb")
// Should return negative synthetic user ID if properly set up
```

## Likely Root Cause
**The client is probably sending the current streamer's user ID (3) instead of the viewbot's socket ID ("942jTpSGmn0wiO-CAADb").**

This would cause:
1. No viewbot detection (because 3 is not a viewbot socket ID)
2. Buff applied to user 3 directly
3. All our viewbot logic bypassed

## Solution
If this hypothesis is correct, we need to:
1. Fix the client to send viewbot socket ID as target
2. OR add server-side logic to detect when target is current streamer and check if current streamer is viewbot