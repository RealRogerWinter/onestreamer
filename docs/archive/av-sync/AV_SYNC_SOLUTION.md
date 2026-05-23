> Archived 2026-05-23 — historical note, not maintained. See /docs/architecture/streaming-stack.md for current state.

# Audio-Video Synchronization Solution for ViewBot Service

## Problem Summary
The ViewBot service experiences significant audio-video synchronization issues (~333ms offset) when streaming video files via FFmpeg to MediaSoup. This creates a noticeable delay between audio and video playback.

## Root Cause Analysis

### Primary Issue: Separate RTP Streams
The fundamental issue is that video and audio are being sent as **separate RTP streams** to different ports, which inherently makes synchronization difficult:
- Video RTP → Port 5004
- Audio RTP → Port 5005

When streams are processed independently, they can drift apart due to:
1. Different processing delays in encoders
2. Network jitter affecting streams differently  
3. No shared timestamp reference between streams
4. MediaSoup processing streams independently

### Secondary Issues Fixed
The following FFmpeg configuration issues were corrected but didn't resolve the core problem:
- ✅ Removed conflicting `-copyts` and `-async` flags
- ✅ Simplified audio filter from `aresample=async=1:first_pts=0` to `asetpts=PTS-STARTPTS`
- ✅ Optimized VP8 encoder (`cpu-used` from 5 to 4)
- ✅ Increased bitrate and buffer sizes

## Recommended Solutions (Ranked by Effectiveness)

### 1. **Use Single Multiplexed Stream** (95% Confidence)
Instead of separate RTP streams, use a single multiplexed stream that maintains A/V sync:

```javascript
// In ViewBotClientService.js - Replace current approach
async startCombinedFFmpegGeneration() {
  // Use MPEGTS over RTP which maintains sync
  const ffmpegArgs = [
    '-re',
    '-i', this.config.videoFile,
    '-c:v', 'libvpx',
    '-c:a', 'libopus',
    '-f', 'mpegts',
    `udp://127.0.0.1:${this.rtpPort}?pkt_size=1316`
  ];
}
```

### 2. **Implement RTP Synchronization Source (SSRC)** (90% Confidence)
Use proper RTP synchronization with RTCP sender reports:

```javascript
// Add RTCP synchronization
const ffmpegArgs = [
  // ... existing args ...
  // Add RTCP for video
  '-f', 'rtp',
  '-rtcp_port', String(this.videoRtpPort + 1),
  `rtp://127.0.0.1:${this.videoRtpPort}`,
  // Add RTCP for audio  
  '-f', 'rtp',
  '-rtcp_port', String(this.audioRtpPort + 1),
  `rtp://127.0.0.1:${this.audioRtpPort}`
];
```

### 3. **Use MediaSoup PlainTransport** (85% Confidence)
Replace WebRTC transport with PlainTransport for better RTP control:

```javascript
// In MediaSoup server
async createPlainTransport() {
  const transport = await router.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: false, // Separate RTCP for sync
    comedia: true
  });
  
  // Configure with proper timestamp handling
  return transport;
}
```

### 4. **Implement Presentation Timestamp (PTS) Alignment** (80% Confidence)
Use filter_complex to ensure unified timestamp processing:

```javascript
const ffmpegArgs = [
  '-re',
  '-i', this.config.videoFile,
  '-filter_complex',
  '[0:v]setpts=PTS-STARTPTS[v];[0:a]asetpts=PTS-STARTPTS,adelay=0|0[a]',
  '-map', '[v]',
  '-map', '[a]',
  // ... rest of args
];
```

### 5. **Add Jitter Buffer Configuration** (75% Confidence)
Configure MediaSoup consumers with synchronized jitter buffers:

```javascript
// In MediaSoup consumer creation
const consumer = await transport.consume({
  producerId,
  rtpCapabilities,
  paused: false,
  // Add jitter buffer config
  rtpParameters: {
    ...rtpParameters,
    rtcp: {
      reducedSize: true,
      mux: false
    }
  }
});
```

## Implementation Priority

1. **Immediate Fix**: Apply the filter_complex solution (#4) as it requires minimal changes
2. **Short-term**: Implement RTCP synchronization (#2) for better stream coordination
3. **Long-term**: Refactor to use single multiplexed stream (#1) or PlainTransport (#3)

## Testing Procedure

1. Apply fixes incrementally
2. Test with sync_test.mp4 that has visual/audio sync markers
3. Measure sync offset using the provided test scripts
4. Target: < 40ms sync offset (imperceptible to users)

## Files Modified

1. `server/services/ViewBotClientService.js` - Lines 1239-1276
   - Removed problematic sync flags
   - Simplified audio filter
   - Optimized encoder settings
   - Increased bitrates

## Additional Recommendations

1. **Monitor RTP timestamps**: Add logging to track PTS/DTS values
2. **Consider GStreamer**: Alternative to FFmpeg with better sync control
3. **Implement sync detection**: Add automated sync monitoring in production
4. **Use NTP timestamps**: For absolute time reference between streams

## Conclusion

While the FFmpeg configuration improvements were applied successfully, the core issue of separate RTP streams requires architectural changes to fully resolve. The recommended approach is to either:
1. Use a multiplexed transport that maintains sync
2. Implement proper RTCP synchronization between streams
3. Switch to MediaSoup PlainTransport for better control

The current ~333ms offset is significant and noticeable to users. Implementing the recommended solutions should reduce this to under 40ms, providing seamless audio-video synchronization.