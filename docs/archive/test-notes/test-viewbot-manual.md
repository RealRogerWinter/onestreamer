> Archived 2026-05-23 — historical note, not maintained. See /docs/ for current state.

# Manual ViewBot Testing Instructions

## Problem Diagnosis
The ViewBot service is creating WebRTC tracks but they're not visible to viewers because:
1. WebRTC ViewBot creates local peer connection but doesn't produce to MediaSoup
2. Clients expect to consume from MediaSoup but there are no producers
3. The test-pattern-stream event now tells clients to generate local patterns

## Testing Steps

### 1. Start the Server
```bash
cd C:\onestreamer
npm start
```

### 2. Open Browser
Navigate to: http://localhost:8080

### 3. Start ViewBot from Admin Panel
1. Open Admin Panel (use admin key)
2. Click "Start ViewBot" 
3. Select pattern: Color Bars
4. Resolution: 1280x720
5. Frame rate: 30

### 4. Check Browser Console
Look for these messages:
- `🎨 WEBRTC: Test pattern stream requested`
- `📺 Generating test pattern: color-bars`

### 5. What Should Happen
- Viewers should see locally generated test pattern
- Pattern updates in real-time
- No MediaSoup connection needed

## Current Implementation Status

### ✅ Working:
- ViewBot WebRTC service creates synchronized A/V tracks
- Server registers ViewBot as current streamer
- test-pattern-stream event is emitted to clients
- Client-side test pattern generation

### ❌ Not Working:
- ViewBot WebRTC tracks are not produced to MediaSoup
- Clients cannot consume ViewBot via normal MediaSoup flow
- Need fallback to local pattern generation

## Solution Options

### Option A: Local Pattern Generation (Current)
- Server tells clients to generate patterns locally
- No real media streaming
- Works but not true streaming

### Option B: MediaSoup PlainTransport (Recommended)
- Create PlainTransport in MediaSoup
- Pipe ViewBot WebRTC tracks to PlainTransport
- Clients consume normally via MediaSoup

### Option C: Direct WebRTC to MediaSoup
- Create MediaSoup Producer from ViewBot tracks
- Requires RTP parameters from WebRTC
- More complex integration

## Files to Check
- `/server/services/ViewbotService.js` - Main ViewBot service
- `/server/services/ViewBotWebRTCService.js` - WebRTC track generation
- `/client/src/components/WebRTCViewer.tsx` - Client viewer with test pattern handler
- `/server/index.js` - Event emission for ViewBot streams