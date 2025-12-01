#!/bin/bash
# Start LiveKit Egress container

# Stop and remove existing container if it exists
docker stop livekit-egress 2>/dev/null
docker rm livekit-egress 2>/dev/null

# Start new container
docker run -d \
  --name livekit-egress \
  --restart unless-stopped \
  --network host \
  -e EGRESS_CONFIG_FILE=/etc/egress.yaml \
  -v /root/onestreamer/egress-config.yaml:/etc/egress.yaml:ro \
  -v /root/onestreamer/egress-recordings:/out \
  --cap-add SYS_ADMIN \
  livekit/egress:latest

echo "LiveKit Egress started"
docker ps | grep egress
