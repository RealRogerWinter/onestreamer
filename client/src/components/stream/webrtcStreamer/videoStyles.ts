import { CSSProperties } from 'react';

/**
 * Inline style for the broadcaster's local <video> preview element.
 *
 * Extracted verbatim from WebRTCStreamer. Pure constant — no media logic.
 * The streamer sees themselves un-mirrored (as viewers do); the WebkitTransform
 * forces hardware acceleration without flipping. objectFit: 'contain' shows the
 * full frame without cropping.
 */
export const webrtcVideoStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  backgroundColor: '#000',
  objectFit: 'contain', // Changed to contain to show full frame without cropping
  // Removed horizontal flip - streamer now sees themselves as viewers see them
  // Mobile Chrome specific fixes
  WebkitTransform: 'translateZ(0)', // Force hardware acceleration without mirror
  WebkitBackfaceVisibility: 'hidden',
  backfaceVisibility: 'hidden',
};
