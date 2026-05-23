#!/bin/bash

# OneStreamer Dual-Stack WebRTC Enabler
# This script enables/disables the WebRTC adapter and switches backends

ACTION=$1
BACKEND=$2

show_help() {
    echo "OneStreamer Dual-Stack WebRTC Control"
    echo "====================================="
    echo ""
    echo "Usage:"
    echo "  ./enable-dual-stack.sh enable [mediasoup|livekit]  - Enable adapter with specified backend"
    echo "  ./enable-dual-stack.sh disable                      - Disable adapter (use direct MediaSoup)"
    echo "  ./enable-dual-stack.sh status                       - Show current configuration"
    echo "  ./enable-dual-stack.sh test                         - Test current configuration"
    echo ""
    echo "Examples:"
    echo "  ./enable-dual-stack.sh enable mediasoup   # Enable adapter with MediaSoup"
    echo "  ./enable-dual-stack.sh enable livekit     # Enable adapter with LiveKit"
    echo "  ./enable-dual-stack.sh disable            # Disable adapter, use direct MediaSoup"
    echo ""
}

check_status() {
    echo "Checking WebRTC configuration..."
    echo ""
    
    # Check environment variables
    echo "Environment Variables:"
    echo "  USE_WEBRTC_ADAPTER: ${USE_WEBRTC_ADAPTER:-not set}"
    echo "  WEBRTC_BACKEND: ${WEBRTC_BACKEND:-not set}"
    echo ""
    
    # Check server status
    if curl -s http://localhost:8080/api/webrtc/backend > /dev/null 2>&1; then
        echo "Server Status:"
        curl -s http://localhost:8080/api/webrtc/backend | python3 -m json.tool
    else
        echo "Server is not responding"
    fi
}

test_config() {
    echo "Testing WebRTC configuration..."
    echo ""
    
    # Test MediaSoup stats endpoint
    echo "1. MediaSoup Stats Endpoint:"
    curl -s http://localhost:8080/api/mediasoup/stats | python3 -m json.tool | head -5
    echo ""
    
    # Test backend info
    echo "2. Backend Info:"
    curl -s http://localhost:8080/api/webrtc/backend | python3 -m json.tool
    echo ""
    
    # Test router capabilities
    echo "3. Router Capabilities:"
    curl -s http://localhost:8080/api/mediasoup/router-capabilities | python3 -m json.tool | head -10
}

case "$ACTION" in
    enable)
        if [ -z "$BACKEND" ]; then
            echo "Error: Backend must be specified (mediasoup or livekit)"
            exit 1
        fi
        
        if [ "$BACKEND" != "mediasoup" ] && [ "$BACKEND" != "livekit" ]; then
            echo "Error: Backend must be 'mediasoup' or 'livekit'"
            exit 1
        fi
        
        echo "Enabling WebRTC adapter with $BACKEND backend..."
        
        # Update .env file if it exists
        if [ -f .env ]; then
            # Remove old entries
            sed -i.bak '/USE_WEBRTC_ADAPTER=/d' .env 2>/dev/null
            sed -i.bak '/WEBRTC_BACKEND=/d' .env 2>/dev/null
            
            # Add new entries
            echo "" >> .env
            echo "# WebRTC Dual-Stack Configuration" >> .env
            echo "USE_WEBRTC_ADAPTER=true" >> .env
            echo "WEBRTC_BACKEND=$BACKEND" >> .env
            echo "✅ Updated .env file"
        fi
        
        # Restart with new configuration
        echo "Restarting server with adapter enabled..."
        USE_WEBRTC_ADAPTER=true WEBRTC_BACKEND=$BACKEND pm2 restart onestreamer-server --update-env
        
        echo ""
        echo "✅ WebRTC adapter enabled with $BACKEND backend"
        echo "⏳ Waiting for server to start..."
        sleep 5
        
        test_config
        ;;
        
    disable)
        echo "Disabling WebRTC adapter (using direct MediaSoup)..."
        
        # Update .env file if it exists
        if [ -f .env ]; then
            sed -i.bak '/USE_WEBRTC_ADAPTER=/d' .env 2>/dev/null
            sed -i.bak '/WEBRTC_BACKEND=/d' .env 2>/dev/null
            echo "✅ Updated .env file"
        fi
        
        # Restart without adapter
        echo "Restarting server without adapter..."
        USE_WEBRTC_ADAPTER=false pm2 restart onestreamer-server --update-env
        
        echo ""
        echo "✅ WebRTC adapter disabled - using direct MediaSoup"
        echo "⏳ Waiting for server to start..."
        sleep 5
        
        test_config
        ;;
        
    status)
        check_status
        ;;
        
    test)
        test_config
        ;;
        
    *)
        show_help
        ;;
esac