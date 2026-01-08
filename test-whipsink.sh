#!/bin/bash

# Test whipclientsink with LiveKit
echo "Testing whipclientsink with LiveKit..."

# Create access token for the test
LIVEKIT_TOKEN=$(node -e "
const { AccessToken } = require('livekit-server-sdk');
const apiKey = 'REDACTED-LIVEKIT-API-KEY';
const apiSecret = 'REDACTED-LIVEKIT-API-SECRET';
const token = new AccessToken(apiKey, apiSecret, {
  identity: 'test-viewbot',
  ttl: '1h',
});
token.addGrant({
  roomJoin: true,
  room: 'main',
  canPublish: true,
  canSubscribe: true,
});
token.toJwt().then(console.log);
")

echo "Token: $LIVEKIT_TOKEN"

# Test pipeline based on README example
WHIP_URL="https://onestreamer.live:7880/rtc?authorization=Bearer%20${LIVEKIT_TOKEN}"

echo "Testing with video file..."
gst-launch-1.0 -e \
  uridecodebin uri=file:///root/onestreamer/server/uploads/test_10sec.mp4 ! \
  videoconvert ! video/x-raw ! queue ! \
  whipclientsink name=ws signaller::whip-endpoint="${WHIP_URL}"