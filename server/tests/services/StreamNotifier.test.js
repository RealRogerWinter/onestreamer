// Tests for server/services/StreamNotifier — the single emit chokepoint for
// the `stream-ended` socket event (PR 3.1).
//
// Coverage goals:
//   - Constructor contract: io is required.
//   - `REASONS` baseline pinning: every reason emitted by the 17 callsites
//     PR 3.1 collapses is present. Adding a new reason to the set is OK;
//     accidentally removing one (because a receiver in the wild may
//     discriminate on it) breaks this test.
//   - `streamEnded({ reason, … })`:
//       * emits `'stream-ended'` on io.emit with the payload including
//         `reason` plus all extras passed through.
//       * unknown reason still emits (no silent drop), but logs a warn.
//       * missing reason suppresses the emit and logs a warn (a typo'd
//         reason gets through and warns; a forgotten reason produces no
//         event at all — the latter is the safer default since a malformed
//         payload would confuse the client).
//   - `excludeSocket` option routes through `socket.broadcast.emit` instead
//     of `io.emit` — preserves the takeover semantic where the new streamer
//     must NOT process the `stream-ended` event as if their own stream
//     ended.

const StreamNotifier = require('../../services/StreamNotifier');

function makeIo() {
  return { emit: jest.fn() };
}

function makeSocket() {
  const broadcast = { emit: jest.fn() };
  return { broadcast };
}

describe('StreamNotifier', () => {
  describe('constructor', () => {
    test('requires an io argument', () => {
      expect(() => new StreamNotifier()).toThrow(/requires a Socket.IO instance/);
      expect(() => new StreamNotifier(null)).toThrow(/requires a Socket.IO instance/);
      expect(() => new StreamNotifier(undefined)).toThrow(/requires a Socket.IO instance/);
    });

    test('stores io on the instance', () => {
      const io = makeIo();
      const notifier = new StreamNotifier(io);
      expect(notifier.io).toBe(io);
    });
  });

  describe('REASONS', () => {
    // The 19 reason strings (16 emit sites worth, including the 4-way
    // expansion of `url_stream_${reason}` and `webrtc_viewbot_stopped`
    // newly added in PR 3.1 to replace the WebRTCViewBotRotation no-reason
    // emit). This list is the Phase 3 baseline — future PRs that add new
    // emit sites should ADD entries here, never remove.
    const PHASE3_BASELINE = [
      'stop_stream_request',
      'takeover',
      'user_stopped_streaming',
      'viewbot_stopped',
      'viewbot_legacy_stopped',
      'test_stream_stopped',
      'admin_clear',
      'admin_disconnect',
      'streamer_banned',
      'streamer_disconnected',
      'url_stream_source_ended',
      'url_stream_http_error',
      'url_stream_reconnect_failed',
      'url_stream_error',
      'url_stream_stopped',
      'webrtc_disconnect',
      'rotation',
      'random_rotation_starting',
      'random_rotation_stopped',
      'webrtc_viewbot_stopped',
    ];

    test('is a Set', () => {
      expect(StreamNotifier.REASONS).toBeInstanceOf(Set);
    });

    test.each(PHASE3_BASELINE)('contains the Phase 3 baseline reason %s', (reason) => {
      expect(StreamNotifier.REASONS.has(reason)).toBe(true);
    });

    test('PHASE3_BASELINE size matches REASONS size — additions to REASONS must update the baseline list', () => {
      // Strict equality is deliberate. The deletion case is already caught
      // by the test.each block above (any baseline reason removed from
      // REASONS fails its individual assertion). This test catches the
      // OTHER direction: a future PR adds a new reason to REASONS but
      // forgets to add it to PHASE3_BASELINE — without this check, the
      // baseline silently rots. Forcing a deliberate baseline update
      // keeps the surface auditable.
      expect(StreamNotifier.REASONS.size).toBe(PHASE3_BASELINE.length);
    });
  });

  describe('streamEnded()', () => {
    let io;
    let notifier;
    let warnSpy;

    beforeEach(() => {
      io = makeIo();
      notifier = new StreamNotifier(io);
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test('emits stream-ended on io.emit with reason + extras', () => {
      notifier.streamEnded({ reason: 'admin_clear', previousStreamer: 'socket-42' });

      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenCalledWith('stream-ended', {
        reason: 'admin_clear',
        previousStreamer: 'socket-42',
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('passes all extras through to the payload', () => {
      notifier.streamEnded({
        reason: 'takeover',
        previousStreamer: 'old',
        newStreamer: 'new',
        newStreamerDisplayName: 'Alice',
      });
      // No excludeSocket → uses io.emit
      expect(io.emit).toHaveBeenCalledWith('stream-ended', {
        reason: 'takeover',
        previousStreamer: 'old',
        newStreamer: 'new',
        newStreamerDisplayName: 'Alice',
      });
    });

    test('dynamic url_stream_* reasons are accepted as part of the baseline', () => {
      // The four expanded reasons from `url_stream_${reason}`.
      for (const r of ['url_stream_source_ended', 'url_stream_http_error', 'url_stream_reconnect_failed', 'url_stream_error']) {
        io.emit.mockClear();
        warnSpy.mockClear();
        notifier.streamEnded({ reason: r, streamerId: 'url-1', isUrlStream: true });
        expect(io.emit).toHaveBeenCalledWith('stream-ended', expect.objectContaining({ reason: r }));
        expect(warnSpy).not.toHaveBeenCalled();
      }
    });

    test('unknown reason still emits but logs a warn (so monitoring catches surface drift)', () => {
      notifier.streamEnded({ reason: 'a_brand_new_reason_not_in_REASONS' });

      expect(io.emit).toHaveBeenCalledWith('stream-ended', { reason: 'a_brand_new_reason_not_in_REASONS' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/unknown stream-ended reason/);
    });

    test('missing reason suppresses the emit (no malformed payload reaches clients)', () => {
      notifier.streamEnded({ previousStreamer: 'socket-1' });

      expect(io.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/without `reason`/);
    });

    test('no-args call is safe (suppresses emit)', () => {
      notifier.streamEnded();
      expect(io.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('excludeSocket routes through socket.broadcast.emit (not io.emit)', () => {
      const socket = makeSocket();
      notifier.streamEnded({
        reason: 'takeover',
        excludeSocket: socket,
        newStreamer: 'new-socket',
        newStreamerDisplayName: 'Bob',
      });

      // No io.emit — must use the broadcast variant.
      expect(io.emit).not.toHaveBeenCalled();
      expect(socket.broadcast.emit).toHaveBeenCalledTimes(1);
      expect(socket.broadcast.emit).toHaveBeenCalledWith('stream-ended', {
        reason: 'takeover',
        newStreamer: 'new-socket',
        newStreamerDisplayName: 'Bob',
      });
      // excludeSocket itself MUST NOT appear in the payload (it's a control
      // flag, not a wire-format field).
      expect(socket.broadcast.emit.mock.calls[0][1]).not.toHaveProperty('excludeSocket');
    });

    test('payload does not contain a stray excludeSocket key even when excludeSocket is undefined', () => {
      notifier.streamEnded({ reason: 'viewbot_stopped', excludeSocket: undefined });
      expect(io.emit).toHaveBeenCalledWith('stream-ended', { reason: 'viewbot_stopped' });
    });
  });
});
