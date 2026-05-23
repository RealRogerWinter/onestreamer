> Archived 2026-05-23 — historical note, not maintained. See /docs/features/points-and-economy.md for current state.

# CRITICAL POINTS SYSTEM ANALYSIS

## THE REQUIREMENT
1. Display the user's TOTAL points
2. Update the display when points are added
3. That's it. Simple.

## CURRENT SYSTEM FLOW

### 1. DATABASE STRUCTURE
- Table: `user_stats`
- Fields:
  - `total_stream_time` (seconds)
  - `total_view_time` (seconds) 
  - `chat_message_count` (count)
  - `points` (calculated field? or stored?)

### 2. POINTS CALCULATION
Location: `server/services/AccountService.js::calculatePoints()`
```javascript
calculatePoints(streamTimeSeconds, viewTimeSeconds, chatMessages = 0) {
    const streamMinutes = streamTimeSeconds / 60;
    const viewMinutes = viewTimeSeconds / 60;
    
    const STREAM_MULTIPLIER = 10;  // 10 points per minute streaming
    const VIEW_MULTIPLIER = 2;     // 2 points per minute viewing  
    const CHAT_MULTIPLIER = 5;     // 5 points per chat message
    
    return Math.floor((streamMinutes * STREAM_MULTIPLIER) + (viewMinutes * VIEW_MULTIPLIER) + (chatMessages * CHAT_MULTIPLIER));
}
```

### 3. POINTS FETCHING ON LOGIN
Location: `client/src/App.tsx::fetchUserPoints()`
```javascript
// Fetches from /api/auth/me endpoint
const response = await fetch(`${process.env.REACT_APP_SERVER_URL}/api/auth/me`);
const data = await response.json();
const points = data.stats?.points || 0;
setUserPoints(points);
```

Location: `server/routes/auth.js` - `/me` endpoint
```javascript
// Calculates points from stats
points = authService.accountService.calculatePoints(
    stats.total_stream_time || 0,
    stats.total_view_time || 0,
    stats.chat_message_count || 0
);
```

### 4. REAL-TIME UPDATES
Location: `server/services/TimeTrackingService.js::sendRealTimeUpdate()`
- Broadcasts `time-stats-update` event every 25 seconds
- Includes calculated points based on current stats

Location: `client/src/App.tsx` - Socket listeners
```javascript
socket.on('time-stats-update', (data) => {
    if (data.points !== undefined) {
        setUserPoints((prevPoints) => {
            // ... floating points logic
            return data.points;
        });
    }
});
```

### 5. DISPLAY
Location: `client/src/App.tsx`
```javascript
<AnimatedNumber value={userPoints} />
```

## POTENTIAL ISSUES

### Issue 1: Points Not Stored in Database
- Points are CALCULATED each time from time/chat stats
- If calculation formula changes, all points change
- No persistent "points" field?

### Issue 2: Session Time vs Total Time Confusion
- `sendRealTimeUpdate()` adds current session time to total
- But does it save to database incrementally?
- Could be showing session points instead of total

### Issue 3: Initial Load Problem
- `fetchUserPoints()` might fail or return wrong data
- Component might initialize with 0 before fetch completes

### Issue 4: Socket Update Filtering
- Updates filtered by userId on client
- Could be filtering out valid updates

## DEBUGGING STEPS

1. Check what's actually in the database
2. Check what /api/auth/me returns
3. Check what socket events are sending
4. Check what React state contains
5. Check what AnimatedNumber displays