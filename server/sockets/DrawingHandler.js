/**
 * DrawingHandler
 *
 * Registers the three real-time drawing-broadcast events.
 * Per-connection registration, called from inside `io.on('connection', ...)`.
 *
 * Handlers (logic byte-equivalent to the original inline versions in
 * server/index.js):
 *   - drawing-path-complete  Final committed path; broadcast to all other
 *                            sockets as `drawing-path-broadcast`.
 *   - drawing-path-start     Stroke-start signal; broadcast as
 *                            `drawing-start-broadcast` to all other sockets.
 *   - drawing-path-update    In-flight segment update; broadcast as
 *                            `drawing-segment-broadcast` to all other sockets.
 *
 * The "to all other sockets" wording matters — each path uses
 * `socket.broadcast.emit` (not `io.emit`) so the sender doesn't see its own
 * echo. The Canvas drawing client relies on that asymmetry to keep the
 * local stroke render path authoritative for the originator.
 *
 * No deps bag: every handler is a pure socket-relay with no service touch.
 * The signature is `(io, socket)` — the other `register*Handler` modules
 * destructure from a third `deps` arg, but adding an always-undefined `_deps`
 * here just to mirror the shape would be dead weight (review feedback on PR
 * 4.1). The call site in server/index.js correspondingly passes only
 * `(io, socket)`.
 */
const logger = require('../bootstrap/logger').child({ svc: 'DrawingHandler' });

module.exports = function registerDrawingHandler(io, socket) {
  // Drawing path broadcast handler
  socket.on('drawing-path-complete', (data) => {
    logger.info({ socketId: socket.id }, '✏️ DRAWING: Received drawing path from client');
    // Broadcast to all other clients (not back to sender)
    socket.broadcast.emit('drawing-path-broadcast', data);
  });

  // Real-time drawing start broadcast handler
  socket.on('drawing-path-start', (data) => {
    // Broadcast to all other clients (not back to sender) for real-time updates
    socket.broadcast.emit('drawing-start-broadcast', data);
  });

  // Real-time drawing segment broadcast handler
  socket.on('drawing-path-update', (data) => {
    // Broadcast to all other clients (not back to sender) for real-time updates
    socket.broadcast.emit('drawing-segment-broadcast', data);
  });
};
