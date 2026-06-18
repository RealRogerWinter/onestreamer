import { CSSProperties } from 'react';

/**
 * Inline style for the broadcaster's local <video> preview element.
 *
 * The streamer sees themselves un-mirrored (as viewers do). `objectFit: 'contain'`
 * shows the full frame without cropping.
 *
 * On non-iOS we promote the element to a GPU compositing layer (`translateZ(0)` +
 * `backface-visibility: hidden`) as a Chrome-mobile rendering optimization. On iOS
 * Safari that same promotion makes WebKit fit `object-fit: contain` against the
 * layer's backing store instead of the element box, painting the preview in a
 * wrong-sized, offset, cropped rectangle (WebKit bug 229792 / Apple FB 709099) —
 * the same defect that affects the viewer's <video class="webrtc-video">. So on
 * iOS we omit the hint entirely. This element shares the `webrtc-video` class, so
 * it is also covered by the iOS `@supports` guard in WebRTCViewer.css, but the
 * inline hint would otherwise win over that rule — hence we gate it here too.
 */
export const getWebrtcVideoStyle = (isIOS: boolean): CSSProperties => ({
  width: '100%',
  height: '100%',
  backgroundColor: '#000',
  objectFit: 'contain', // Show the full frame without cropping
  // Non-iOS only: hardware-acceleration hint (no mirror). Omitted on iOS to
  // avoid the WebKit composited object-fit cropping bug described above.
  ...(isIOS
    ? {}
    : {
        WebkitTransform: 'translateZ(0)',
        WebkitBackfaceVisibility: 'hidden',
        backfaceVisibility: 'hidden',
      }),
});
