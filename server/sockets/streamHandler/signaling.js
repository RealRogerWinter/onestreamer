/**
 * StreamHandler sub-module: WebRTC signalling pass-through.
 *
 * Pure relay handlers (no services touched):
 *   - stream-offer    Streamer -> specific viewer signalling pass-through
 *                     (legacy WebRTC P2P; the modern path uses MediaSoup).
 *   - stream-answer   Viewer  -> streamer signalling pass-through.
 *   - request-stream  Viewer-side ask: relayed to the named streamer socket
 *                     as `viewer-requesting-stream`.
 *
 * In the original StreamHandler.js the registration order was:
 *   stream-offer, stream-answer, [stop-streaming], request-stream.
 * To preserve that exact `socket.on` ordering after extraction, this module
 * exposes two registration functions and the parent interleaves the
 * stop-streaming (lifecycle) registration between them.
 *
 * Handler bodies are VERBATIM from the original; pure extraction, no logic
 * change. Both take the same `(io, socket, deps)`.
 */
const logger = require('../../bootstrap/logger').child({ svc: 'StreamHandler' });

/**
 * Registers `stream-offer` and `stream-answer` (the streamer/viewer SDP
 * exchange). Must be registered BEFORE stop-streaming to match the original
 * ordering.
 */
function registerOfferAnswer(io, socket, deps) {
  // Handle streamer sending offer to specific viewer
  socket.on('stream-offer', (data) => {
    const { offer, toViewerId } = data;
    logger.info(`Streamer ${socket.id} sending offer to viewer ${toViewerId}`);

    io.to(toViewerId).emit('stream-offer', {
      offer,
      fromStreamerId: socket.id
    });
  });

  // Handle viewer sending answer back to streamer
  socket.on('stream-answer', (data) => {
    const { answer, toStreamerId } = data;
    logger.info(`Viewer ${socket.id} sending answer to streamer ${toStreamerId}`);

    io.to(toStreamerId).emit('stream-answer', {
      answer,
      fromViewerId: socket.id
    });
  });
}

/**
 * Registers `request-stream` (viewer asks the named streamer to send an
 * offer). Must be registered AFTER stop-streaming to match the original
 * ordering.
 */
function registerRequestStream(io, socket, deps) {
  // Handle viewer requesting stream from streamer
  socket.on('request-stream', (data) => {
    const { streamerId } = data;
    logger.info(`Viewer ${socket.id} requesting stream from ${streamerId}`);

    // Tell the streamer to send offer to this viewer
    io.to(streamerId).emit('viewer-requesting-stream', { viewerId: socket.id });
  });
}

module.exports = { registerOfferAnswer, registerRequestStream };
