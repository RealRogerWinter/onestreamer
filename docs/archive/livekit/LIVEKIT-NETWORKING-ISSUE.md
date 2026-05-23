> Archived 2026-05-23 — historical note, not maintained. See /docs/architecture/adr/0003-livekit-dual-stack-rollback.md for current state.

# LiveKit Networking Configuration Issue

## Problem
LiveKit WebSocket connections from browser clients are failing because:
1. The client is trying to connect to `ws://localhost:7880` which doesn't work from the browser
2. LiveKit doesn't support path-based routing (like `/livekit`) by default
3. LiveKit requires direct WebSocket connections to its server

## Current Status
- **Backend**: Switched back to MediaSoup for stability
- **LiveKit Server**: Still running on port 7880 (local only)
- **Client**: Has dual-stack support ready but needs proper LiveKit URLs

## Solutions Required

### Option 1: Direct Port Exposure (Recommended for LiveKit)
```bash
# Open port 7880 for LiveKit WebSocket
ufw allow 7880/tcp

# Update LiveKit configuration to use SSL
# Create LiveKit config with SSL certificates
cat > livekit-config-ssl.yaml << EOF
port: 7880
rtc:
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
keys:
  devkey: secret
ssl:
  cert: /etc/letsencrypt/live/onestreamer.live/fullchain.pem
  key: /etc/letsencrypt/live/onestreamer.live/privkey.pem
EOF

# Update .env to use wss://onestreamer.live:7880
LIVEKIT_WS_URL=wss://onestreamer.live:7880
```

### Option 2: Use LiveKit Cloud (Simplest)
Instead of self-hosting, use LiveKit Cloud:
1. Sign up at livekit.io
2. Get cloud URL and credentials
3. Update configuration:
```bash
LIVEKIT_HOST=your-project.livekit.cloud
LIVEKIT_WS_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

### Option 3: Subdomain with Reverse Proxy
Create a subdomain specifically for LiveKit:
```nginx
# livekit.onestreamer.live
server {
    listen 443 ssl http2;
    server_name livekit.onestreamer.live;
    
    ssl_certificate /etc/letsencrypt/live/onestreamer.live/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/onestreamer.live/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
        proxy_buffering off;
    }
}
```

## Why Current Setup Doesn't Work
1. **Path-based routing**: LiveKit expects to be at the root path `/`, not `/livekit`
2. **Protocol mismatch**: Browser blocks mixed content (https page connecting to ws://)
3. **localhost reference**: Browser can't connect to server's localhost

## Current Working Solution
The dual-stack implementation is complete and works perfectly with MediaSoup. LiveKit support is ready but requires one of the networking solutions above to be implemented.

## Commands to Switch Backends
```bash
# Use MediaSoup (currently active, working)
./enable-dual-stack.sh enable mediasoup

# Use LiveKit (requires networking fix)
./enable-dual-stack.sh enable livekit

# Check status
./enable-dual-stack.sh status
```

## Recommendation
Stay with MediaSoup for now as it's working perfectly. Implement LiveKit when you need its specific features like:
- Built-in recording
- Simulcast
- Better mobile SDK support
- Cloud scaling

The dual-stack implementation allows easy switching once the networking is configured properly.