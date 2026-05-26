/**
 * PR 2.5b — GameStreamService threads the streamGeneration counter
 * through its custom-payload stream-status emits.
 *
 * Why this test exists: the game-mode start/stop emits at
 * GameStreamService.js don't go through streamService.getStreamStatus(),
 * so the monotonic counter that the client uses for drop-by-stale
 * doesn't get included automatically. PR 2.5b threads streamService into
 * the ctor and bumps + includes the counter on each emit; this test
 * pins that behavior so a future refactor doesn't silently strip it.
 *
 * Sibling: the client-side drop-by-counter check at
 * `client/src/App.tsx` (replaces the old 10-second takeoverTargetRef
 * lock). Server-side counter authority lives in StreamService — see
 * `server/tests/StreamService.test.js` "streamGeneration".
 */

const GameStreamService = require('../../services/game/GameStreamService');
const StreamService = require('../../services/StreamService');

function makeIo() {
  const emitted = [];
  return {
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    _emitted: emitted,
  };
}

function makeGameService() {
  const listeners = {};
  return {
    on: (event, fn) => { (listeners[event] ||= []).push(fn); },
    start: jest.fn().mockResolvedValue({ success: true }),
    stop: jest.fn().mockResolvedValue({ success: true }),
    getStatus: () => ({ active: false }),
    _listeners: listeners,
  };
}

describe('GameStreamService — streamGeneration on stream-status emits (PR 2.5b)', () => {
  test('startGameStream() bumps the generation and includes it in the emit payload', async () => {
    const io = makeIo();
    const gameService = makeGameService();
    const streamService = new StreamService();
    const svc = new GameStreamService(io, gameService, null, streamService);

    // Establish a non-zero baseline so the bump is observable as +1.
    streamService.setStreamer('socket-A');
    streamService.setStreamer('socket-B');
    expect(streamService.getStreamGeneration()).toBe(2);

    await svc.startGameStream(/* adminUserId */ 99);

    expect(streamService.getStreamGeneration()).toBe(3);
    expect(io._emitted).toHaveLength(1);
    expect(io._emitted[0]).toEqual({
      event: 'stream-status',
      payload: {
        hasActiveStream: true,
        streamerId: svc.GAME_STREAM_ID,
        streamType: 'game',
        isGameMode: true,
        startedBy: 99,
        streamGeneration: 3,
      },
    });
  });

  test('stopGameStream() bumps the generation and includes it in the emit payload', async () => {
    const io = makeIo();
    const gameService = makeGameService();
    const streamService = new StreamService();
    const svc = new GameStreamService(io, gameService, null, streamService);

    // Activate first so stopGameStream's guard doesn't short-circuit.
    await svc.startGameStream(99);
    const genAfterStart = streamService.getStreamGeneration();

    await svc.stopGameStream(99);

    expect(streamService.getStreamGeneration()).toBe(genAfterStart + 1);
    const stopEmit = io._emitted[io._emitted.length - 1];
    expect(stopEmit.event).toBe('stream-status');
    expect(stopEmit.payload).toEqual({
      hasActiveStream: false,
      streamerId: null,
      streamType: null,
      isGameMode: false,
      streamGeneration: genAfterStart + 1,
    });
  });

  test('omits streamGeneration when no streamService is provided (back-compat)', async () => {
    // Bare construction — no 4th arg. The emit must not include the
    // field at all (vs. including it as undefined), so the client
    // back-compat path that treats "missing" as "accept" still fires.
    const io = makeIo();
    const gameService = makeGameService();
    const svc = new GameStreamService(io, gameService, null);

    await svc.startGameStream(99);

    expect(io._emitted[0].payload).not.toHaveProperty('streamGeneration');
  });
});
