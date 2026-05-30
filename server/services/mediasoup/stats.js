/**
 * Pure stats shaping for MediasoupService.
 *
 * Extracted VERBATIM from MediasoupService.getStats(). Reads the live-object
 * maps (passed in by the parent, which still owns them) and reduces them to a
 * plain counts object. No mutation, no SDK calls.
 */

/**
 * @param {object} args
 * @param {string|null} args.currentStreamer active streamer socketId
 * @param {Map} args.transports socketId -> transport
 * @param {Map} args.producers socketId -> Map(kind -> producer)
 * @param {Map} args.consumers socketId -> Set(consumer)
 * @returns {{activeStreamer: (string|null), transportCount: number, producerCount: number, consumerCount: number}}
 */
function buildStats({ currentStreamer, transports, producers, consumers }) {
  const totalProducers = Array.from(producers.values()).reduce((total, producerMap) => total + producerMap.size, 0);
  return {
    activeStreamer: currentStreamer,
    transportCount: transports.size,
    producerCount: totalProducers,
    consumerCount: Array.from(consumers.values()).reduce((total, consumers) => total + consumers.size, 0),
  };
}

module.exports = { buildStats };
