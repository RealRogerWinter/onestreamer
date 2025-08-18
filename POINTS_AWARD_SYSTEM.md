# HOW POINTS ARE CURRENTLY AWARDED

## 1. POINT VALUES (from AccountService.js)
```javascript
const STREAM_MULTIPLIER = 10;  // 10 points per minute streaming
const VIEW_MULTIPLIER = 2;     // 2 points per minute viewing  
const CHAT_MULTIPLIER = 5;     // 5 points per chat message
```

## 2. WHEN POINTS ARE AWARDED

### A. STREAMING POINTS
**Location**: `TimeTrackingService.js`

1. **During Stream (Every 25 seconds)**:
   - `sendRealTimeUpdate()` is called every 25 seconds
   - Adds 25 seconds to database
   - Points are recalculated: `(total_stream_time / 60) * 10`
   - Example: 25 seconds = 0.417 minutes = 4.17 points (rounds to 4)

2. **When Stream Ends**:
   - `endStreamingSession()` is called
   - Adds remaining session time to database
   - Points are recalculated with new total

**Rate**: ~10 points per minute of streaming

### B. VIEWING POINTS  
**Location**: `TimeTrackingService.js`

1. **During Viewing (Every 25 seconds)**:
   - `sendRealTimeUpdate()` is called every 25 seconds
   - Adds 25 seconds to database
   - Points are recalculated: `(total_view_time / 60) * 2`
   - Example: 25 seconds = 0.417 minutes = 0.83 points (rounds to 0)

2. **When Viewing Ends**:
   - `endViewingSession()` is called
   - Adds remaining session time to database (only if > 5 seconds)
   - Points are recalculated with new total

**Rate**: ~2 points per minute of viewing

### C. CHAT POINTS
**Location**: `TimeTrackingService.js::trackChatMessage()`

1. **Per Message**:
   - Increments `chat_message_count` by 1
   - Points are recalculated: `chat_message_count * 5`
   - Immediate update (not batched)

**Rate**: 5 points per chat message

## 3. THE FLOW

### Real-Time Updates (Every 25 seconds)
```
1. TimeTrackingService::sendRealTimeUpdate() runs
2. Calls AccountService::updateUserStats() with time increment
3. AccountService automatically calls calculateAndUpdatePoints()
4. New total points are calculated and stored in database
5. Socket event 'time-stats-update' is sent with new total
6. Client receives and displays new total
```

### Session End
```
1. TimeTrackingService::endStreamingSession/endViewingSession() 
2. Adds total session time to database
3. AccountService::calculateAndUpdatePoints() runs
4. Points are updated in database
```

### Chat Message
```
1. TimeTrackingService::trackChatMessage()
2. Increments chat_message_count
3. AccountService::calculateAndUpdatePoints() runs  
4. Socket event 'time-stats-update' sent with new total
```

## 4. ACTUAL RATES

Based on the current code:

| Activity | Points | Time to earn 100 points |
|----------|--------|-------------------------|
| Streaming | 10/min | 10 minutes |
| Viewing | 2/min | 50 minutes |
| Chatting | 5/msg | 20 messages |

## 5. DATABASE STORAGE

Points are stored in `user_stats` table:
- `total_stream_time` (seconds)
- `total_view_time` (seconds)  
- `chat_message_count` (count)
- `points` (calculated total)

The `points` field is recalculated every time any of the other fields change.

## 6. ISSUES WITH CURRENT SYSTEM

1. **Viewing points are very low** - Only 2 points per minute means you need to watch for 50 minutes to get 100 points

2. **25-second updates for viewing** - Since 25 seconds = 0.417 minutes × 2 = 0.83 points, this rounds to 0, so viewing might not show point increases every update

3. **Points are recalculated every time** - This ensures consistency but adds computation overhead

## 7. TO GET 1 MILLION POINTS

At current rates, you would need:
- 100,000 minutes of streaming (1,667 hours) OR
- 500,000 minutes of viewing (8,333 hours) OR  
- 200,000 chat messages OR
- Some combination of all three