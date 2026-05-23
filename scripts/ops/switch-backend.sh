#!/bin/bash

# OneStreamer WebRTC Backend Switcher
# Usage: ./switch-backend.sh [mediasoup|livekit]

BACKEND=$1

if [ -z "$BACKEND" ]; then
    echo "Usage: ./switch-backend.sh [mediasoup|livekit]"
    echo ""
    echo "Current backend configuration:"
    grep "WEBRTC_BACKEND" .env 2>/dev/null || echo "WEBRTC_BACKEND not set (defaults to mediasoup)"
    exit 1
fi

if [ "$BACKEND" != "mediasoup" ] && [ "$BACKEND" != "livekit" ]; then
    echo "Error: Backend must be 'mediasoup' or 'livekit'"
    exit 1
fi

echo "Switching WebRTC backend to: $BACKEND"

# Update or add WEBRTC_BACKEND in .env file
if [ -f .env ]; then
    if grep -q "WEBRTC_BACKEND=" .env; then
        # Update existing entry
        sed -i.bak "s/WEBRTC_BACKEND=.*/WEBRTC_BACKEND=$BACKEND/" .env
        echo "✅ Updated WEBRTC_BACKEND in .env"
    else
        # Add new entry
        echo "" >> .env
        echo "# WebRTC Backend Configuration" >> .env
        echo "WEBRTC_BACKEND=$BACKEND" >> .env
        echo "✅ Added WEBRTC_BACKEND to .env"
    fi
else
    # Create .env file
    echo "# WebRTC Backend Configuration" > .env
    echo "WEBRTC_BACKEND=$BACKEND" >> .env
    echo "✅ Created .env with WEBRTC_BACKEND=$BACKEND"
fi

# Add LiveKit configuration if switching to LiveKit
if [ "$BACKEND" = "livekit" ]; then
    if ! grep -q "LIVEKIT_HOST=" .env; then
        echo "" >> .env
        echo "# LiveKit Configuration" >> .env
        echo "LIVEKIT_HOST=localhost:7880" >> .env
        echo "LIVEKIT_API_KEY=devkey" >> .env
        echo "LIVEKIT_API_SECRET=secret" >> .env
        echo "LIVEKIT_WS_URL=ws://localhost:7880" >> .env
        echo "✅ Added LiveKit configuration to .env"
    fi
fi

echo ""
echo "Configuration updated successfully!"
echo "Backend set to: $BACKEND"
echo ""
echo "⚠️  IMPORTANT: You must restart the server for changes to take effect:"
echo "   pm2 restart onestreamer"
echo "   or"
echo "   npm restart"
echo ""

# Optionally show how to run LiveKit server if switching to LiveKit
if [ "$BACKEND" = "livekit" ]; then
    echo "📝 Note: To use LiveKit backend, you need to run LiveKit server:"
    echo "   docker run -d --restart unless-stopped --name livekit \\"
    echo "     -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \\"
    echo "     livekit/livekit-server --dev"
    echo ""
fi