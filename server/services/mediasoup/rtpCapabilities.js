/**
 * Pure RTP-capability shaping for MediasoupService.
 *
 * Extracted VERBATIM from MediasoupService.getRouterRtpCapabilities(). This is
 * a pure transformation of a router's rtpCapabilities object — it does not
 * touch any live mediasoup objects or the service's maps. The logger is passed
 * in so the exact debug/warn output of the original is preserved.
 *
 * CRITICAL iOS FIX: Reorder codecs for iOS/Safari to prefer H264 Baseline.
 */

/**
 * @param {object} capabilities router.rtpCapabilities
 * @param {boolean} preferH264 when true, reorder/filter for iOS Safari
 * @param {object} logger logger with debug()/warn()
 * @returns {object} capabilities (possibly a reordered shallow copy)
 */
function optimizeRtpCapabilities(capabilities, preferH264, logger) {
  // CRITICAL iOS FIX: Reorder codecs for iOS/Safari to prefer H264 Baseline
  if (preferH264 && capabilities.codecs) {
    logger.debug('📱 MEDIASOUP: Optimizing RTP capabilities for iOS Safari');

    const codecs = [...capabilities.codecs];
    const videoCodecs = codecs.filter(c => c.kind === 'video');
    const audioCodecs = codecs.filter(c => c.kind === 'audio');

    // Find H264 Baseline (42e01f) - iOS Safari's preferred codec
    const h264Baseline = videoCodecs.find(c =>
      c.mimeType?.toLowerCase() === 'video/h264' &&
      c.parameters?.['profile-level-id'] === '42e01f'
    );

    if (h264Baseline) {
      logger.debug('✅ MEDIASOUP: Found H264 Baseline codec for iOS');

      // Put audio codecs first, then H264 Baseline ONLY for iOS
      // This simplifies codec negotiation and prevents iOS confusion
      const optimizedCodecs = [
        ...audioCodecs,
        h264Baseline,
        // Only include Main profile as fallback, skip High profile and VP8/VP9
        ...videoCodecs.filter(c =>
          c.mimeType?.toLowerCase() === 'video/h264' &&
          c.parameters?.['profile-level-id'] === '4d0032'
        )
      ];

      return {
        ...capabilities,
        codecs: optimizedCodecs
      };
    } else {
      logger.warn('⚠️ MEDIASOUP: H264 Baseline codec not found for iOS');
    }
  }

  return capabilities;
}

module.exports = { optimizeRtpCapabilities };
