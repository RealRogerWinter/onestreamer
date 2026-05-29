// Pending-rotation request queue for ViewBotClientService. Encapsulates the
// queue array + the enqueue guard/dedup logic (extracted verbatim from
// queueRotationRequest). The processing lock/timer and the actual rotation
// execution stay in the service — this only owns request storage + admission.
//
// enqueue returns { success, message, queued }: `queued` is true only when a
// request was actually added (the caller uses it to decide whether to start the
// processing timer). Optional logger preserves the original debug lines.

class RotationRequestQueue {
  constructor({ logger = null } = {}) {
    this.logger = logger;
    this.items = []; // { botId, reason, timestamp }
  }

  get length() {
    return this.items.length;
  }

  enqueue(botId, reason, { rotationEnabled, realStreamerActive, now = Date.now() } = {}) {
    if (!rotationEnabled) {
      this.logger?.debug(`🔄 Rotation request from ${botId} ignored - rotation disabled`);
      return { success: false, message: 'Rotation is disabled', queued: false };
    }

    if (realStreamerActive) {
      this.logger?.debug(`🔄 Rotation request from ${botId} ignored - real streamer active`);
      return { success: false, message: 'Real streamer is active', queued: false };
    }

    if (this.items.find(req => req.botId === botId)) {
      this.logger?.debug(`⏳ ViewBot ${botId}: Rotation request already queued`);
      return { success: false, message: 'Request already queued', queued: false };
    }

    this.items.push({ botId, reason, timestamp: now });
    this.logger?.debug(`📥 Queued rotation request from ${botId} (${reason}). Queue size: ${this.items.length}`);
    return { success: true, message: 'Rotation request queued', queued: true };
  }

  // Return a snapshot of all requests and clear the queue.
  drain() {
    const items = [...this.items];
    this.items = [];
    return items;
  }
}

module.exports = RotationRequestQueue;
