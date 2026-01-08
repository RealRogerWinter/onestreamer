const fs = require('fs');
const path = require('path');

/**
 * Creates an SDP file for FFmpeg that tells it exactly how to send RTP
 * This ensures FFmpeg formats the RTP packets correctly for MediaSoup
 */
function createViewBotSDP(videoPort, audioPort, videoSSRC, audioSSRC) {
  const sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=ViewBot Stream
c=IN IP4 127.0.0.1
t=0 0
m=video ${videoPort} RTP/AVP 96
a=rtpmap:96 VP8/90000
a=ssrc:${videoSSRC} cname:viewbot
a=ssrc:${videoSSRC} msid:viewbot video
a=ssrc:${videoSSRC} mslabel:viewbot
a=ssrc:${videoSSRC} label:video
a=sendonly
m=audio ${audioPort} RTP/AVP 111  
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=ssrc:${audioSSRC} cname:viewbot
a=ssrc:${audioSSRC} msid:viewbot audio
a=ssrc:${audioSSRC} mslabel:viewbot
a=ssrc:${audioSSRC} label:audio
a=sendonly
`;

  // Ensure temp directory exists
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const sdpPath = path.join(tempDir, `viewbot_${Date.now()}.sdp`);
  fs.writeFileSync(sdpPath, sdp);
  
  return { sdpPath, sdp, videoSSRC, audioSSRC };
}

module.exports = { createViewBotSDP };