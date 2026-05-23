> Archived 2026-05-23 — historical note, not maintained. See /docs/ for current state.

# Manual ViewBot Test Instructions

## Step 1: Start the Server
```bash
npm start
```

## Step 2: Test ViewBot via Admin Panel
1. Open browser to: http://localhost:3000
2. Open Developer Console (F12)
3. Go to Network tab or Console tab
4. In another tab, make this request:

```javascript
fetch('http://localhost:8080/admin/viewbot-client/create-streamer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-key': 'your-secret-admin-key-123'
  },
  body: JSON.stringify({
    config: {
      contentType: 'testPattern',
      testPattern: 'color-bars',
      width: 1280,
      height: 720,
      frameRate: 30,
      autoStart: true
    }
  })
})
.then(r => r.json())
.then(console.log)
```

## Step 3: Check Results
1. **Server Console**: Should show ViewBot creation and FFmpeg start
2. **Browser Console**: Should show WebRTC connection and media consumption 
3. **Video Element**: Should show test pattern instead of black screen

## Expected Server Log Output:
```
🤖 ViewBot viewbot-xxx: Creating plain RTP transport for video...
📡 SERVER: Plain RTP transport created for ViewBot xxx video
📡 SERVER: Transport listening for RTP on port xxxx
✅ SERVER: ViewBot xxx video producer created
🔌 SERVER: ViewBot xxx video transport tuple updated
🎬 SERVER: Notifying viewers about ViewBot stream
```

## Expected Browser Console:
```
📺 WEBRTC: Starting WebRTC viewer...
✅ MEDIASOUP CLIENT: Successfully consumed video on attempt 1
✅ MEDIASOUP CLIENT: Media stream ready with 2 live tracks
✅ WEBRTC: Stream consumption successful with 2 tracks
```

## Success Criteria:
- ✅ ViewBot creates successfully
- ✅ FFmpeg starts without errors  
- ✅ Transport receives RTP packets
- ✅ Viewers see test pattern video
- ✅ No "Track video muted" messages
- ✅ No black screen or "Connecting..." state