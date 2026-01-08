# OneStreamer Admin Panel

## Overview

The OneStreamer Admin Panel is a comprehensive management interface for testing, debugging, and monitoring the streaming service. It provides real-time control over test streams, connection monitoring, and system diagnostics.

## Access

### Opening the Admin Panel
- **Keyboard Shortcut**: `Ctrl+Shift+A` (Windows/Linux) or `Cmd+Shift+A` (Mac)
- **Default Admin Key**: `onestreamer-admin-2024`
- **API Access**: All admin endpoints require the `x-admin-key` header

### Closing the Admin Panel
- Click the **×** button
- Press `ESC` key
- Click outside the panel (overlay)

## Features

### 🔐 Authentication
- Simple key-based authentication
- Session persistence in localStorage
- API key validation against server

### 📊 Dashboard Tab
Real-time system overview including:

#### Current Stream Status
- **Stream State**: LIVE/OFFLINE indicator
- **Stream ID**: Unique identifier for active stream
- **Stream Type**: webcam, test, screen, etc.
- **Viewer Count**: Real-time connected viewers
- **Duration**: How long current stream has been active
- **Actions**: Force end current stream

#### Test Stream Status
- **Active State**: Shows if test stream is running
- **Stream ID**: Test stream identifier
- **Content Type**: What type of test content is being generated
- **Configuration**: Resolution, frame rate, duration

#### Takeover Service
- **Cooldown Period**: Current takeover cooldown setting
- **Service Status**: Ready/blocked state

#### System Info
- **Server Time**: Current server timestamp
- **Environment**: Development/production mode
- **Version**: Application version

### 🧪 Test Stream Tab
Complete control over synthetic test streams:

#### Stream Control
- **▶️ Start Test Stream**: Begin broadcasting synthetic content
- **⏹️ Stop Test Stream**: End test stream
- **Status Indicator**: RUNNING/STOPPED with visual feedback

#### Stream Configuration
- **Content Types**:
  - **SMPTE Color Bars**: Standard test pattern
  - **Random Noise**: Static noise pattern  
  - **Color Gradient**: Smooth color transitions
  - **Scrolling Text**: Moving text with uptime info
  - **Digital Clock**: Real-time clock display

- **Resolution Options**:
  - 1920×1080 (Full HD)
  - 1280×720 (HD)
  - 854×480 (SD)
  - 640×360 (Low)

- **Frame Rate**: 10-60 FPS (adjustable)

#### Live Metrics
- **Total Frames**: Number of frames generated
- **Frame Rate**: Current FPS
- **Estimated Bitrate**: Calculated bandwidth usage
- **Resolution**: Active stream dimensions
- **Duration**: How long test stream has been running

#### Frame Preview
- **Live Frame Data**: Real-time generated frame information
- **Frame Number**: Current frame count
- **Uptime**: Stream duration in seconds
- **Pattern Details**: JSON data for current frame content

### 🔗 Connections Tab
Monitor and manage all WebSocket connections:

#### Stream Overview
- **Active Stream Status**: Yes/No indicator
- **Current Streamer**: Socket ID of active broadcaster
- **Total Viewers**: Count of connected viewers

#### Connection List
Interactive table showing:
- **Socket ID**: Unique connection identifier
- **Type**: Streamer/Viewer/Connected
- **Rooms**: Which socket rooms user has joined
- **Connected Time**: When user connected
- **Actions**: Disconnect button for each user

#### Connection Details
Click any connection to view:
- **Basic Info**: Socket ID, status, type
- **Handshake Data**: IP address, connection time
- **User Agent**: Browser/client information
- **Room Membership**: Detailed room participation
- **Actions**: Force disconnect option

### 📝 Logs Tab
Real-time activity logging:
- **System Events**: Admin actions, API calls, errors
- **Timestamps**: All logs include precise timing
- **Auto-scroll**: Latest logs appear at top
- **Clear Function**: Remove all logs
- **Persistent**: Logs survive tab switches

## API Endpoints

All admin endpoints require authentication via `x-admin-key` header.

### Dashboard
```
GET /admin/dashboard
```
Returns complete system status including all services.

### Test Stream Management
```
POST /admin/test-stream/start    # Start test stream
POST /admin/test-stream/stop     # Stop test stream
GET  /admin/test-stream/status   # Get status and metrics
POST /admin/test-stream/config   # Update configuration
GET  /admin/test-stream/frame    # Get current frame data
```

### Stream Management
```
POST /admin/clear-stream         # Force end current stream
POST /admin/force-disconnect     # Disconnect specific user
```

### Monitoring
```
GET /admin/connections           # List all WebSocket connections
```

## Configuration

### Environment Variables
```bash
ADMIN_KEY=onestreamer-admin-2024  # Admin authentication key
COOLDOWN_SECONDS=30               # Takeover cooldown period
```

### Test Stream Config
```json
{
  "content": "color-bars",    # Content type
  "width": 1280,              # Video width
  "height": 720,              # Video height  
  "frameRate": 30             # Frames per second
}
```

## Use Cases

### 🧪 Development Testing
1. Start test stream to simulate active streaming
2. Test takeover functionality without real users
3. Monitor connection behavior under load
4. Debug WebSocket communication issues

### 🔍 Production Debugging  
1. Monitor real-time connection status
2. Identify problematic users or connections
3. Force-end streams that are stuck
4. View system health metrics

### 📊 Performance Analysis
1. Track frame generation performance
2. Monitor bandwidth usage estimates
3. Analyze connection patterns
4. Test different stream configurations

### 🚨 Emergency Management
1. Quickly disconnect disruptive users
2. Clear stuck streams
3. Monitor system during issues
4. Access logs for troubleshooting

## Security Considerations

- **Admin Key Storage**: Key stored in localStorage (consider more secure alternatives for production)
- **Network Security**: Admin endpoints should be behind authentication/VPN in production
- **Session Management**: No automatic session expiry (manual logout required)
- **Audit Trail**: All admin actions are logged with timestamps

## Keyboard Shortcuts

| Shortcut | Action |
|----------|---------|
| `Ctrl+Shift+A` | Open admin panel |
| `Cmd+Shift+A` | Open admin panel (Mac) |
| `ESC` | Close admin panel |
| `Ctrl+Shift+C` | Quick access to connections tab |
| `Ctrl+Shift+T` | Quick access to test stream tab |

## Troubleshooting

### Admin Panel Won't Open
- Verify keyboard shortcut (`Ctrl+Shift+A`)
- Check browser console for JavaScript errors
- Ensure React app is loaded completely

### Authentication Failed  
- Verify admin key matches server configuration
- Check network connectivity to server
- Look for CORS issues in browser console

### Test Stream Not Starting
- Check server logs for errors
- Verify no real stream is currently active  
- Ensure adequate server resources

### Connection Data Not Loading
- Verify WebSocket connections are working
- Check server admin endpoints are accessible
- Review network connectivity

## Development

### Adding New Features
1. Update relevant service classes
2. Add API endpoints in `server/index.js`
3. Create/update React components
4. Add appropriate CSS styling
5. Write unit tests
6. Update documentation

### Testing Admin Features
```bash
# Backend tests
npm test

# Frontend tests  
cd client && npm test

# Integration testing
npm run dev
# Press Ctrl+Shift+A to test admin panel
```

The admin panel is designed to be a powerful debugging and management tool while maintaining simplicity and ease of use.