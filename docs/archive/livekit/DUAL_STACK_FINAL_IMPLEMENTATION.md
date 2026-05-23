> Archived 2026-05-23 — historical note, not maintained. See /docs/architecture/adr/0003-livekit-dual-stack-rollback.md for current state.

# OneStreamer Dual-Stack WebRTC Implementation (Final)

## Overview

A non-destructive dual-stack WebRTC implementation that allows OneStreamer to switch between MediaSoup and LiveKit backends without breaking existing functionality.

## Key Features

### 1. **Non-Destructive Implementation**
- MediaSoup works exactly as before when adapter is disabled
- No changes to existing code paths
- Optional activation via environment variable

### 2. **Seamless Backend Switching**
- Switch between MediaSoup and LiveKit with configuration change
- All APIs remain compatible regardless of backend
- Proxy pattern ensures 100% method compatibility

### 3. **Graceful Fallback**
- If LiveKit fails to initialize, falls back to MediaSoup
- No service interruption

## Architecture

```
                    ┌─────────────────────┐
                    │   Client/Browser    │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   OneStreamer API   │
                    └──────────┬──────────┘
                               │
                ┌──────────────▼──────────────┐
                │  USE_WEBRTC_ADAPTER=true?   │
                └──────┬───────────────┬──────┘
                       │               │
                    NO │               │ YES
                       │               │
            ┌──────────▼────┐   ┌─────▼──────────┐
            │  MediaSoup    │   │ WebRTCAdapterV2│
            │   (Direct)    │   │    (Proxy)     │
            └───────────────┘   └─────┬──────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │  WEBRTC_BACKEND=?         │
                        └────┬──────────────┬───────┘
                             │              │
                    mediasoup│              │livekit
                             │              │
                  ┌──────────▼──┐   ┌──────▼───────┐
                  │ MediaSoup   │   │   LiveKit    │
                  │  Service     │   │   Service    │
                  └─────────────┘   └──────────────┘
```

## Configuration

### Environment Variables

```bash
# Enable/disable the adapter
USE_WEBRTC_ADAPTER=true|false  # Default: false

# Select backend when adapter is enabled
WEBRTC_BACKEND=mediasoup|livekit  # Default: mediasoup

# LiveKit configuration (when using LiveKit)
LIVEKIT_HOST=localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_WS_URL=ws://localhost:7880
```

## Usage

### Method 1: Using the Helper Script

```bash
# Enable adapter with MediaSoup
./enable-dual-stack.sh enable mediasoup

# Enable adapter with LiveKit
./enable-dual-stack.sh enable livekit

# Disable adapter (use direct MediaSoup)
./enable-dual-stack.sh disable

# Check current status
./enable-dual-stack.sh status

# Test configuration
./enable-dual-stack.sh test
```

### Method 2: Manual Configuration

```bash
# Use direct MediaSoup (default)
pm2 restart onestreamer-server

# Use adapter with MediaSoup
USE_WEBRTC_ADAPTER=true WEBRTC_BACKEND=mediasoup pm2 restart onestreamer-server --update-env

# Use adapter with LiveKit
USE_WEBRTC_ADAPTER=true WEBRTC_BACKEND=livekit pm2 restart onestreamer-server --update-env
```

### Method 3: Via .env File

```bash
# Edit .env file
echo "USE_WEBRTC_ADAPTER=true" >> .env
echo "WEBRTC_BACKEND=livekit" >> .env

# Restart with updated environment
pm2 restart onestreamer-server --update-env
```

## API Endpoints

### Backend Information
```bash
GET /api/webrtc/backend

# Response (adapter disabled):
{
  "backend": "mediasoup",
  "adapterEnabled": false,
  "message": "Backend switching not available. Set USE_WEBRTC_ADAPTER=true to enable."
}

# Response (adapter enabled):
{
  "backend": "mediasoup|livekit",
  "adapterEnabled": true,
  "info": {
    "type": "mediasoup|livekit",
    "backend": "MediasoupService|LiveKitService"
  },
  "stats": { ... }
}
```

### Admin Configuration Check
```bash
GET /api/admin/webrtc/config
Headers: x-admin-key: <admin_key>

# Response:
{
  "adapterEnabled": true|false,
  "currentBackend": "mediasoup|livekit",
  "availableBackends": ["mediasoup", "livekit"],
  "environmentVariables": { ... }
}
```

## Testing

### 1. Test Direct MediaSoup (Default)
```bash
# Disable adapter
./enable-dual-stack.sh disable

# Test endpoints
curl http://localhost:8080/api/mediasoup/stats
curl http://localhost:8080/api/mediasoup/router-capabilities
```

### 2. Test MediaSoup Through Adapter
```bash
# Enable adapter with MediaSoup
./enable-dual-stack.sh enable mediasoup

# Test same endpoints work
curl http://localhost:8080/api/mediasoup/stats
curl http://localhost:8080/api/webrtc/backend
```

### 3. Test LiveKit Backend
```bash
# Start LiveKit server (required)
docker run -d -p 7880:7880 livekit/livekit-server --dev

# Enable adapter with LiveKit
./enable-dual-stack.sh enable livekit

# Test endpoints
curl http://localhost:8080/api/webrtc/backend
```

## Implementation Details

### WebRTCAdapterV2 (Proxy Pattern)
- Uses JavaScript Proxy to intercept all property access and method calls
- Forwards everything to the actual backend service
- Adds adapter-specific methods without breaking compatibility
- No need to manually implement every MediaSoup method

### Conditional Loading
- Server checks `USE_WEBRTC_ADAPTER` environment variable at startup
- If `false` or not set: Uses MediaSoupService directly
- If `true`: Uses WebRTCAdapterV2 which loads the configured backend

### Backend Services
- **MediasoupService**: Original, unchanged implementation
- **LiveKitService**: New implementation with MediaSoup-compatible API
- Both implement the same interface for core WebRTC operations

## Files

### Core Files
- `/server/services/WebRTCAdapterV2.js` - Proxy-based adapter
- `/server/services/LiveKitService.js` - LiveKit implementation
- `/server/config/webrtc.config.js` - Configuration

### Helper Scripts
- `/enable-dual-stack.sh` - Easy switching script
- `/test-adapter-basic.js` - Basic adapter test

### Modified Files
- `/server/index.js` - Added conditional adapter loading (lines 543-561)

## Troubleshooting

### Issue: Server doesn't start with adapter
**Solution**: Check logs with `pm2 logs onestreamer-server`

### Issue: LiveKit backend fails
**Solution**: Ensure LiveKit server is running on port 7880

### Issue: Can't switch backends
**Solution**: Ensure `USE_WEBRTC_ADAPTER=true` is set

### Issue: API returns "not available"
**Solution**: Adapter is not enabled, set `USE_WEBRTC_ADAPTER=true`

## Migration Path

### Phase 1: Testing (Current)
- Run with adapter disabled (default)
- Test with adapter + MediaSoup
- Test with adapter + LiveKit in development

### Phase 2: Gradual Rollout
- Enable adapter for specific users
- Monitor performance metrics
- Compare MediaSoup vs LiveKit

### Phase 3: Production
- Choose optimal backend based on testing
- Deploy chosen configuration
- Keep adapter for future flexibility

## Benefits

1. **Zero Risk**: Existing MediaSoup functionality unchanged
2. **Flexibility**: Switch backends without code changes
3. **Future Proof**: Easy to add new WebRTC implementations
4. **Testing**: Can A/B test different backends
5. **Fallback**: Automatic fallback if LiveKit unavailable

## Conclusion

This implementation provides a safe, non-destructive path to WebRTC backend flexibility. The system maintains 100% backward compatibility while enabling modern WebRTC solutions like LiveKit when needed.