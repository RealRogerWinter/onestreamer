// Maps a resolution label to getUserMedia width/height constraints.
// Extracted from the four byte-identical inline copies in WebRTCStreamer.tsx
// (replaceVideoTrack, updateStoredCameraVideo, updateCameraForPiP, startStreaming).
export function resolutionConstraints(resolution: string): {
  width: { ideal: number };
  height: { ideal: number };
} {
  switch (resolution) {
    case '480p':
      return { width: { ideal: 854 }, height: { ideal: 480 } };
    case '720p':
      return { width: { ideal: 1280 }, height: { ideal: 720 } };
    default:
      return { width: { ideal: 1280 }, height: { ideal: 720 } };
  }
}
