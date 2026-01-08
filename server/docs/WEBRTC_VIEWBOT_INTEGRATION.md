# WebRTC ViewBot Integration Guide

## Overview
This guide explains how to integrate and use the new WebRTC-capable viewbots that support mobile clients.

## Architecture Comparison

### Plain RTP ViewBots (Current/Legacy)
```
GStreamer → Plain RTP → MediaSoup → Desktop Clients Only
```
- ✅ Simple and efficient
- ✅ Low resource usage
- ❌ No mobile support (no ICE/TURN)
- ❌ No NAT traversal

### WebRTC ViewBots (New)
```
Video File → Headless Chrome → WebRTC → MediaSoup → All Clients
```
- ✅ Full mobile support
- ✅ ICE/TURN/NAT traversal
- ✅ Identical to real user streams
- ❌ Higher resource usage
- ❌ Requires Puppeteer/Chrome

## Installation

### 1. Install Dependencies
```bash
cd /root/onestreamer/server
npm install puppeteer puppeteer-core
```

### 2. Install Chrome (if not using bundled Chromium)
```bash
# For Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y \
    chromium-browser \
    chromium-codecs-ffmpeg \
    chromium-codecs-ffmpeg-extra
```

## Server Integration

### 1. Add to server/index.js

```javascript
// Add near other service imports
const ViewBotManager = require('./services/ViewBotManager');
const viewBotManagerRoutes = require('./routes/viewbot-manager');

// Load configuration
const viewbotConfig = require('./config/viewbot-config.json');

// Initialize ViewBot Manager
const viewBotManager = new ViewBotManager(viewbotConfig.viewbots);

// Initialize on server start
async function initializeServices() {
  // ... existing initialization ...
  
  // Initialize ViewBot Manager
  await viewBotManager.initialize();
  console.log('✅ ViewBot Manager initialized');
  
  // Make it globally available
  global.viewBotManager = viewBotManager;
}

// Add API routes
app.use('/api/viewbot-manager', viewBotManagerRoutes(viewBotManager));

// Serve the viewbot streaming page
app.use('/viewbot-stream.html', express.static(path.join(__dirname, 'public')));

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  await viewBotManager.cleanup();
});
```

## Usage

### Enabling WebRTC ViewBots

#### Via Configuration File
Edit `/root/onestreamer/server/config/viewbot-config.json`:
```json
{
  "viewbots": {
    "useWebRTCViewBots": true
  }
}
```
Then restart the server.

#### Via API at Runtime
```bash
# Enable WebRTC mode (mobile compatible)
curl -X POST http://localhost:8080/api/viewbot-manager/toggle-mode \
  -H "Content-Type: application/json" \
  -d '{"useWebRTC": true}'

# Disable WebRTC mode (use Plain RTP)
curl -X POST http://localhost:8080/api/viewbot-manager/toggle-mode \
  -H "Content-Type: application/json" \
  -d '{"useWebRTC": false}'
```

### Managing ViewBots

#### Check Status
```bash
curl http://localhost:8080/api/viewbot-manager/status
```

#### Create and Start a ViewBot
```bash
# Create a viewbot
curl -X POST http://localhost:8080/api/viewbot-manager/create \
  -H "Content-Type: application/json" \
  -d '{"botId": "bot-1", "videoFile": "/path/to/video.mp4"}'

# Start streaming
curl -X POST http://localhost:8080/api/viewbot-manager/start/bot-1

# Stop streaming
curl -X POST http://localhost:8080/api/viewbot-manager/stop/bot-1

# Destroy viewbot
curl -X DELETE http://localhost:8080/api/viewbot-manager/bot-1
```

#### Rotation Control
```bash
# Start automatic rotation
curl -X POST http://localhost:8080/api/viewbot-manager/rotation/start

# Stop rotation
curl -X POST http://localhost:8080/api/viewbot-manager/rotation/stop
```

## Testing Mobile Compatibility

### 1. Enable WebRTC Mode
```bash
curl -X POST http://localhost:8080/api/viewbot-manager/toggle-mode \
  -d '{"useWebRTC": true}'
```

### 2. Start a ViewBot
```bash
curl -X POST http://localhost:8080/api/viewbot-manager/create \
  -d '{"botId": "mobile-test"}'
  
curl -X POST http://localhost:8080/api/viewbot-manager/start/mobile-test
```

### 3. Test on Mobile Device
1. Open Chrome/Safari on mobile device
2. Connect to 4G/5G (not WiFi)
3. Navigate to https://onestreamer.live
4. The viewbot stream should now work!

## Performance Considerations

### Resource Usage Comparison

| Metric | Plain RTP | WebRTC |
|--------|-----------|---------|
| CPU per bot | ~5-10% | ~15-25% |
| Memory per bot | ~50MB | ~200MB |
| Network overhead | Minimal | +10-15% |
| Startup time | <1s | 3-5s |
| Max concurrent | 10-20 | 3-5 |

### Recommendations

1. **For Desktop-Only Audiences**: Use Plain RTP mode
2. **For Mixed/Mobile Audiences**: Use WebRTC mode
3. **For Production**: 
   - Use dedicated server for WebRTC viewbots
   - Limit to 3-5 concurrent WebRTC viewbots
   - Monitor resource usage

## Troubleshooting

### WebRTC ViewBot Won't Start
```bash
# Check Chrome installation
which chromium-browser || which google-chrome

# Check Puppeteer can launch
node -e "require('puppeteer').launch().then(b => { console.log('OK'); b.close(); })"

# Check logs
pm2 logs onestreamer-server --lines 100 | grep -i webrtc
```

### High Resource Usage
- Reduce concurrent bots in config
- Lower video bitrate/resolution
- Use Plain RTP for desktop-only events

### Mobile Still Can't Connect
- Verify TURN server is configured
- Check firewall allows WebRTC ports
- Ensure SSL certificates are valid

## Rollback Plan

If WebRTC viewbots cause issues, instantly rollback:

```bash
# Switch back to Plain RTP mode
curl -X POST http://localhost:8080/api/viewbot-manager/toggle-mode \
  -d '{"useWebRTC": false}'

# Or edit config and restart
sed -i 's/"useWebRTCViewBots": true/"useWebRTCViewBots": false/' \
  /root/onestreamer/server/config/viewbot-config.json
  
pm2 restart onestreamer-server
```

## Benefits Summary

### WebRTC ViewBots Enable:
- ✅ **Mobile 4G/5G Support** - Works through CGNAT
- ✅ **Full NAT Traversal** - ICE/TURN/STUN support
- ✅ **Identical to Real Streams** - No special handling needed
- ✅ **Future Proof** - Standard WebRTC implementation
- ✅ **Non-Destructive** - Toggle between modes anytime

### Trade-offs:
- Higher resource usage
- Requires Chrome/Chromium
- More complex architecture
- Slightly higher latency

## Next Steps

1. Test in development environment
2. Monitor resource usage
3. Gradually migrate high-priority streams
4. Keep Plain RTP as fallback
5. Document specific use cases