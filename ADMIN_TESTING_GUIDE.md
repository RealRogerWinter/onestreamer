# Admin Panel Testing Guide

## Quick Testing Steps

### 1. Start the Application
```bash
# Make sure ports are free, then start
npm run dev
```

### 2. Access Admin Panel
1. Open http://localhost:3000 in browser
2. Press `Ctrl+Shift+A` to open admin panel
3. Login with key: `onestreamer-admin-2024`

### 3. Test Basic Functions

#### Dashboard Tab
- ✅ Verify all service statuses show
- ✅ Check real-time updates
- ✅ Toggle auto-refresh on/off

#### Test Stream Tab  
- ✅ Start test stream → should show as active streamer
- ✅ Change content type → verify different patterns
- ✅ Adjust resolution → check metrics update
- ✅ View live frame data → should update every 2s
- ✅ Stop test stream → should clear active streamer

#### Connections Tab
- ✅ Open multiple browser tabs → should see connections
- ✅ Click connection → view details
- ✅ Disconnect user → should remove from list
- ✅ Stream overview should match dashboard

#### Logs Tab
- ✅ Admin actions should create log entries
- ✅ API errors should be logged
- ✅ Clear logs function works

### 4. API Testing (Optional)
```bash
# Test admin endpoints directly
curl -H "x-admin-key: onestreamer-admin-2024" \
     http://localhost:8080/admin/dashboard

curl -X POST -H "x-admin-key: onestreamer-admin-2024" \
     http://localhost:8080/admin/test-stream/start

curl -X POST -H "x-admin-key: onestreamer-admin-2024" \
     http://localhost:8080/admin/test-stream/stop
```

## Expected Behavior

### Test Stream Integration
- Starting test stream should:
  - ✅ Show as active stream in main UI
  - ✅ Display in dashboard as current streamer  
  - ✅ Allow normal users to see the stream
  - ✅ Block takeover attempts (with cooldown)

### Real-time Updates
- Admin panel should update automatically
- Changes in one tab reflect in other tabs
- Connection count updates in real-time
- Stream status changes immediately

### Error Handling
- Invalid admin key → proper error message
- Network errors → logged and displayed
- Invalid API calls → appropriate responses

## Troubleshooting

### Admin Panel Won't Open
1. Check browser console for errors
2. Verify `Ctrl+Shift+A` keyboard shortcut
3. Try refreshing the page

### Authentication Issues
1. Verify server is running on correct port
2. Check admin key in `.env` matches login
3. Look for CORS errors in console

### Test Stream Problems
1. Check server logs for errors
2. Verify WebSocket connection is working
3. Try stopping/starting server

This completes the comprehensive admin panel and test stream implementation!