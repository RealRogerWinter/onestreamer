> Archived 2026-05-23 — historical note, not maintained. See /docs/features/streaming-and-takeover.md for current state.

# Stream Switching Reliability Improvement Plan

## Executive Summary

After thorough analysis of the codebase, I've identified several reliability issues in the stream switching mechanism that cause:
- Unnecessary disconnections when no stream switch occurred
- Browser refreshes required due to stuck states
- Race conditions during stream transitions

This plan provides minimal, targeted fixes to improve reliability while preserving the existing architecture.

---

## Issues Identified

### Issue 1: Duplicate `currentStreamer` State (HIGH PRIORITY)
**Location:** `StreamService.js` and `MediasoupService.js` both track `currentStreamer`

**Problem:**
```javascript
// StreamService.js:3
this.currentStreamer = null;

// MediasoupService (via mediasoupService.currentStreamer)
mediasoupService.currentStreamer = socket.id;  // Set separately in index.js:6411
```

Two separate sources of truth can become desynchronized, especially during:
- Anonymous streamer connections
- Takeover scenarios
- Error recovery

**Evidence:** The fallback code in `StreamService.js:56-62` explicitly handles this desync:
```javascript
if (!hasActiveStream && global.mediasoupService) {
  const mediasoupStreamer = global.mediasoupService.currentStreamer;
  if (mediasoupStreamer) {
    console.log(`Warning: Using MediaSoup fallback for stream status`);
```

**Fix:** Consolidate to single source of truth in StreamService.

---

### Issue 2: Excessive `stream-ready` Processing (HIGH PRIORITY)
**Location:** `WebRTCViewer.tsx:1039-1209` - `handleStreamReady()`

**Problem:** The client-side handler reinitializes the entire connection even when already connected to the same stream. While there's a check at line 1056:
```typescript
if (currentStreamIdRef.current === data.newStreamId && isConnected && switchState === 'idle') {
  console.log(`Already connected and playing stream...`);
  return;
}
```

This check is bypassed when:
- `switchState` is not 'idle' (could be 'switching' from a previous operation)
- `isConnected` temporarily becomes false during normal operation
- Multiple rapid `stream-ready` events are received

**Fix:** Add server-side deduplication + strengthen client-side guards.

---

### Issue 3: Transport Recreation Race Condition (MEDIUM PRIORITY)
**Location:** `MediasoupClient.ts:1383-1468` - `attemptConsumeTrack()`

**Problem:** Race condition between transport state check and actual consume:
```typescript
// Line 1385-1398: Check transport state
if (!this.recvTransport || this.recvTransport.closed) {
  throw new Error(`No receive transport available`);
}
// ... more checks ...

// Line 1473: Transport could close BETWEEN check and this call
consumer = await this.recvTransport.consume({...});
```

**Fix:** Add atomic operation wrapper with transport state lock.

---

### Issue 4: Health Check Triggering Unnecessary Reconnections (MEDIUM PRIORITY)
**Location:** `MediasoupClient.ts:164-218` - `performHealthCheck()`

**Problem:** A single failed health check immediately triggers reconnection logic:
```typescript
} catch (error) {
  console.warn('Health check failed:', error);
  this.handleConnectionError(error as Error);  // Triggers reconnection
}
```

Network glitches or server load can cause transient health check failures that don't indicate actual connection problems.

**Fix:** Add consecutive failure threshold before triggering reconnection.

---

### Issue 5: `stream-ready` Emitted Multiple Times for Same Stream (LOW PRIORITY)
**Location:** `server/index.js` multiple locations

**Problem:** `stream-ready` can be emitted from multiple code paths:
- Line 2353: `verifyTracksAndEmitStreamReady()`
- Line 2378: Fallback emit if verification fails
- Line 6629: ViewBot stream ready
- Line 7427: ViewBot stream ready handler

No server-side tracking of which stream-ready was last emitted.

**Fix:** Add lastEmittedStreamId tracking to prevent duplicate emissions.

---

### Issue 6: Stuck `switching` State After Timeout (LOW PRIORITY)
**Location:** `WebRTCViewer.tsx:291-295`

**Problem:** If initialization gets stuck, the clearing of stuck states doesn't fully reset all refs:
```typescript
if (switchState === 'switching' || switchState === 'retrying') {
  console.log('Clearing stuck state...');
  setSwitchState('idle');
  setError(null);
  // currentStreamIdRef.current NOT cleared - can cause issues
}
```

**Fix:** Also clear `currentStreamIdRef` when clearing stuck states.

---

## Implementation Plan

### Phase 1: Server-Side Fixes (Minimal Changes)

#### 1.1 Consolidate `currentStreamer` Tracking

**File:** `/root/onestreamer/server/services/StreamService.js`

Add MediasoupService sync in setStreamer/clearStreamer:
```javascript
setStreamer(socketId, streamType = 'webcam') {
  this.currentStreamer = socketId;
  this.streamType = streamType;
  this.streamStartTime = Date.now();
  this.viewers.delete(socketId);

  // SYNC: Keep MediasoupService in sync
  if (global.mediasoupService) {
    global.mediasoupService.currentStreamer = socketId;
  }
}

clearStreamer() {
  const previousStreamer = this.currentStreamer;
  this.currentStreamer = null;
  this.streamType = null;
  this.streamStartTime = null;

  // SYNC: Keep MediasoupService in sync
  if (global.mediasoupService) {
    global.mediasoupService.currentStreamer = null;
  }

  if (previousStreamer) {
    this.viewers.add(previousStreamer);
  }
  return previousStreamer;
}
```

#### 1.2 Add Server-Side `stream-ready` Deduplication

**File:** `/root/onestreamer/server/index.js`

Add tracking variable and modify emit function:
```javascript
// Near top of file, after other service declarations
let lastEmittedStreamReady = { streamerId: null, timestamp: 0 };

// Modify verifyTracksAndEmitStreamReady to check before emit:
const emitStreamReady = (streamerId, data) => {
  const now = Date.now();
  // Prevent duplicate emission within 2 seconds for same streamer
  if (lastEmittedStreamReady.streamerId === streamerId &&
      (now - lastEmittedStreamReady.timestamp) < 2000) {
    console.log(`Skipping duplicate stream-ready for ${streamerId}`);
    return;
  }

  lastEmittedStreamReady = { streamerId, timestamp: now };
  io.emit('stream-ready', data);
};
```

---

### Phase 2: Client-Side Fixes (Minimal Changes)

#### 2.1 Strengthen `stream-ready` Guard in WebRTCViewer

**File:** `/root/onestreamer/client/src/services/WebRTCViewer.tsx`

Enhance the handleStreamReady check (around line 1054):
```typescript
const handleStreamReady = async (data: {...}) => {
  // CRITICAL: Comprehensive deduplication
  // Skip if: same stream + connected OR same stream + currently switching to it
  const isSameStream = currentStreamIdRef.current === data.newStreamId;
  const isAlreadyConnected = isConnected && switchState === 'idle';
  const isCurrentlySwitchingToThis = isSameStream &&
    (switchState === 'switching' || switchState === 'retrying');

  if (isSameStream && (isAlreadyConnected || isCurrentlySwitchingToThis)) {
    console.log(`Ignoring duplicate stream-ready for ${data.newStreamId}`);
    return;
  }
  // ... rest of handler
};
```

#### 2.2 Add Health Check Failure Threshold

**File:** `/root/onestreamer/client/src/services/MediasoupClient.ts`

Add counter and modify health check (near line 36):
```typescript
private healthCheckFailures: number = 0;
private readonly healthCheckFailureThreshold: number = 3;

// Modify performHealthCheck catch block:
} catch (error) {
  this.healthCheckFailures++;
  console.warn(`Health check failed (${this.healthCheckFailures}/${this.healthCheckFailureThreshold}):`, error);

  // Only trigger reconnection after consecutive failures
  if (this.healthCheckFailures >= this.healthCheckFailureThreshold) {
    this.healthCheckFailures = 0;
    this.handleConnectionError(error as Error);
  }
}

// Reset counter on success (around line 207):
if (this.reconnectionAttempts > 0) {
  this.reconnectionAttempts = 0;
  this.reconnectionDelay = 1000;
}
this.healthCheckFailures = 0;  // ADD THIS LINE
```

#### 2.3 Add Transport State Lock for Consume Operations

**File:** `/root/onestreamer/client/src/services/MediasoupClient.ts`

Add lock mechanism (near line 24):
```typescript
private consumeLock: boolean = false;

// Modify attemptConsumeTrack (around line 1383):
private async attemptConsumeTrack(kind: 'video' | 'audio', attempt: number): Promise<MediaStream | null> {
  // Acquire lock to prevent race conditions
  if (this.consumeLock) {
    console.log(`Consume lock held, waiting...`);
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this.consumeLock) {
      throw new Error('Consume operation already in progress');
    }
  }

  this.consumeLock = true;
  try {
    // ... existing validation and consume logic ...
  } finally {
    this.consumeLock = false;
  }
}
```

#### 2.4 Clear Stream ID Reference When Clearing Stuck State

**File:** `/root/onestreamer/client/src/components/WebRTCViewer.tsx`

Modify stuck state clearing (around line 291):
```typescript
// Clear any stuck states
if (switchState === 'switching' || switchState === 'retrying') {
  console.log('Clearing stuck state...');
  setSwitchState('idle');
  setError(null);
  // Also clear stream reference to allow fresh connection
  currentStreamIdRef.current = null;  // ADD THIS LINE
}
```

---

## Testing Checklist

After implementing fixes, verify:

1. **No Unnecessary Disconnects:**
   - [ ] Stream plays continuously without the streamer changing
   - [ ] Health check failures don't cause disconnects (simulate with network throttle)
   - [ ] Multiple rapid `stream-ready` events don't cause reconnects

2. **Seamless Stream Switching:**
   - [ ] Takeover from one streamer to another works smoothly
   - [ ] Viewer receives new stream within 3 seconds of switch
   - [ ] No "refresh required" situations

3. **Recovery from Failures:**
   - [ ] Temporary network issues recover automatically
   - [ ] Stuck states clear after reasonable timeout
   - [ ] Fallback mode activates when primary fails

4. **State Consistency:**
   - [ ] StreamService and MediasoupService currentStreamer stay in sync
   - [ ] Client streamIdRef matches server's current streamer

---

## Implementation Order

1. **Issue 1** (currentStreamer sync) - Critical for preventing desync issues
2. **Issue 2** (stream-ready dedup) - Prevents most unnecessary reconnections
3. **Issue 4** (health check threshold) - Reduces false-positive disconnects
4. **Issue 3** (consume lock) - Prevents race conditions
5. **Issue 6** (stuck state clearing) - Improves recovery
6. **Issue 5** (server-side dedup) - Additional safety net

---

## Risk Assessment

| Fix | Risk Level | Rollback Complexity |
|-----|------------|---------------------|
| 1.1 currentStreamer sync | Low | Easy - remove sync calls |
| 1.2 server stream-ready dedup | Low | Easy - remove check |
| 2.1 client stream-ready guard | Low | Easy - revert condition |
| 2.2 health check threshold | Low | Easy - set threshold to 1 |
| 2.3 consume lock | Medium | Easy - remove lock |
| 2.4 stuck state clearing | Low | Easy - remove line |

All fixes are additive guards that can be easily removed if issues arise.
