/**
 * L1 — streamer health-check TOCTOU guard.
 *
 * The health-check tick snapshots (currentStreamer, streamGeneration), then
 * awaits a LiveKit listParticipants RPC. A takeover can land during that
 * await; clearStaleStreamer must then SKIP the clear (compare-and-clear via
 * StreamService.clearStreamerIfCurrent) instead of killing the freshly-
 * installed healthy stream and broadcasting a false stream-ended.
 */

process.env.TURN_SECRET = process.env.TURN_SECRET || 'test-secret';

jest.mock('livekit-server-sdk', () => ({
  Room: class Room {},
  RoomServiceClient: class RoomServiceClient {},
  AccessToken: class AccessToken {},
  WebhookReceiver: class WebhookReceiver {},
}));

jest.mock('../../config/webrtc.config', () => ({
  livekit: {
    roomName: 'test-room',
    url: 'wss://test',
    apiKey: 'k',
    apiSecret: 's',
  },
}));

const LiveKitService = require('../../services/LiveKitService');
const StreamService = require('../../services/StreamService');

describe('LiveKitService streamer health check (L1)', () => {
  let livekitService;
  let streamService;
  let io;
  let streamNotifier;

  /** Arm streamer `id` and age it past the 30s grace period. */
  function armAgedStreamer(id) {
    streamService.setStreamer(id, 'webcam');
    streamService.streamStartTime = Date.now() - 60_000;
  }

  /** Returns a deferred the test resolves to complete listParticipants. */
  function holdListParticipants() {
    let resolve;
    const gate = new Promise((r) => { resolve = r; });
    livekitService.roomClient = {
      listParticipants: jest.fn(() => gate),
    };
    return { resolve };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    livekitService = new LiveKitService();
    streamService = new StreamService();
    io = { emit: jest.fn() };
    streamNotifier = { streamEnded: jest.fn() };
    livekitService.setStreamNotifier(streamNotifier);
  });

  afterEach(() => {
    livekitService.stopStreamerHealthCheck();
    jest.useRealTimers();
  });

  test('TOCTOU regression: takeover during the listParticipants await is NOT clobbered', async () => {
    armAgedStreamer('streamer-A');
    livekitService.currentStreamer = 'streamer-A';
    const { resolve } = holdListParticipants();

    livekitService.startStreamerHealthCheck(streamService, io, 1000);
    await jest.advanceTimersByTimeAsync(1001); // tick fires, awaits the RPC

    // Takeover lands mid-await.
    streamService.setStreamer('streamer-B', 'webcam');
    livekitService.currentStreamer = 'streamer-B';

    // RPC resolves: streamer-A is (legitimately) absent from the room.
    resolve([]);
    await jest.advanceTimersByTimeAsync(0); // let the tick's microtasks settle

    expect(streamService.getCurrentStreamer()).toBe('streamer-B');
    expect(livekitService.currentStreamer).toBe('streamer-B');
    expect(streamNotifier.streamEnded).not.toHaveBeenCalled();
    const streamUpdate = io.emit.mock.calls.find((c) => c[0] === 'stream-update');
    expect(streamUpdate).toBeUndefined();
  });

  test('genuinely stale streamer is still cleared (not_in_room)', async () => {
    armAgedStreamer('streamer-A');
    livekitService.currentStreamer = 'streamer-A';
    const { resolve } = holdListParticipants();

    livekitService.startStreamerHealthCheck(streamService, io, 1000);
    await jest.advanceTimersByTimeAsync(1001);

    resolve([]); // no takeover happened; streamer really is gone
    await jest.advanceTimersByTimeAsync(0);

    expect(streamService.getCurrentStreamer()).toBe(null);
    expect(livekitService.currentStreamer).toBe(null);
    expect(streamNotifier.streamEnded).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'webrtc_disconnect' })
    );
    const streamUpdate = io.emit.mock.calls.find((c) => c[0] === 'stream-update');
    expect(streamUpdate).toBeDefined();
    expect(streamUpdate[1]).toEqual({ hasActiveStream: false, streamerId: null });
  });

  test('no_tracks branch respects the generation guard too', async () => {
    armAgedStreamer('streamer-A');
    livekitService.currentStreamer = 'streamer-A';
    const { resolve } = holdListParticipants();

    livekitService.startStreamerHealthCheck(streamService, io, 1000);
    await jest.advanceTimersByTimeAsync(1001);

    // Generation drifts mid-await without an identity change (e.g. a
    // GameStreamService emit bumped it).
    streamService.bumpStreamGeneration();

    resolve([{ identity: 'streamer-A', tracks: [] }]); // present, no tracks
    await jest.advanceTimersByTimeAsync(0);

    expect(streamService.getCurrentStreamer()).toBe('streamer-A');
    expect(streamNotifier.streamEnded).not.toHaveBeenCalled();
  });

  test('clearStaleStreamer returns false on guard miss and true on success', async () => {
    streamService.setStreamer('streamer-A');
    const gen = streamService.getStreamGeneration();
    streamService.setStreamer('streamer-B'); // supersede

    const missed = await livekitService.clearStaleStreamer(streamService, io, 'streamer-A', 'not_in_room', gen);
    expect(missed).toBe(false);
    expect(streamService.getCurrentStreamer()).toBe('streamer-B');

    const gen2 = streamService.getStreamGeneration();
    const cleared = await livekitService.clearStaleStreamer(streamService, io, 'streamer-B', 'no_tracks', gen2);
    expect(cleared).toBe(true);
    expect(streamService.getCurrentStreamer()).toBe(null);
  });
});
