const RotationRequestQueue = require('../../../services/viewbot/RotationRequestQueue');

const ENABLED = { rotationEnabled: true, realStreamerActive: false };

describe('RotationRequestQueue', () => {
  test('rejects when rotation is disabled (nothing queued)', () => {
    const q = new RotationRequestQueue();
    const r = q.enqueue('bot-A', 'video-end', { rotationEnabled: false, realStreamerActive: false });
    expect(r).toEqual({ success: false, message: 'Rotation is disabled', queued: false });
    expect(q.length).toBe(0);
  });

  test('rejects when a real streamer is active', () => {
    const q = new RotationRequestQueue();
    const r = q.enqueue('bot-A', 'video-end', { rotationEnabled: true, realStreamerActive: true });
    expect(r).toEqual({ success: false, message: 'Real streamer is active', queued: false });
    expect(q.length).toBe(0);
  });

  test('accepts a fresh request and stamps it', () => {
    const q = new RotationRequestQueue();
    const r = q.enqueue('bot-A', 'video-end', { ...ENABLED, now: 1234 });
    expect(r).toEqual({ success: true, message: 'Rotation request queued', queued: true });
    expect(q.length).toBe(1);
    expect(q.drain()).toEqual([{ botId: 'bot-A', reason: 'video-end', timestamp: 1234 }]);
  });

  test('dedupes a second request from the same bot', () => {
    const q = new RotationRequestQueue();
    expect(q.enqueue('bot-A', 'video-end', ENABLED).queued).toBe(true);
    const dup = q.enqueue('bot-A', 'forced', ENABLED);
    expect(dup).toEqual({ success: false, message: 'Request already queued', queued: false });
    expect(q.length).toBe(1); // still just the first
  });

  test('allows distinct bots and drains them in FIFO order, clearing the queue', () => {
    const q = new RotationRequestQueue();
    q.enqueue('bot-A', 'video-end', { ...ENABLED, now: 1 });
    q.enqueue('bot-B', 'forced', { ...ENABLED, now: 2 });
    expect(q.length).toBe(2);
    const drained = q.drain();
    expect(drained.map(r => r.botId)).toEqual(['bot-A', 'bot-B']);
    expect(q.length).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  test('a bot may re-queue after the queue has been drained', () => {
    const q = new RotationRequestQueue();
    q.enqueue('bot-A', 'video-end', ENABLED);
    q.drain();
    expect(q.enqueue('bot-A', 'video-end', ENABLED).queued).toBe(true);
  });
});
