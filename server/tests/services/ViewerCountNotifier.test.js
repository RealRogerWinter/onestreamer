// Tests for server/services/ViewerCountNotifier — single emit chokepoint
// for the `viewer-count-update` socket event (PR 3.2).
//
// Coverage:
//   - Constructor contract: io and sessionService both required.
//   - broadcast() reads from sessionService.getUniqueViewerCount() and
//     emits io.emit('viewer-count-update', <that-value>) — pins both the
//     source-of-truth (the right helper) and the wire shape.
//   - The count helper is invoked once per broadcast() (no caching, no
//     side effects); the production helper is cheap (Map iteration) so
//     no need for memoisation, but a future "optimisation" that adds one
//     would change the freshness contract and break this test.

const ViewerCountNotifier = require('../../services/ViewerCountNotifier');

function makeIo() {
  return { emit: jest.fn() };
}

function makeSessionService(count = 0) {
  return { getUniqueViewerCount: jest.fn(() => count) };
}

describe('ViewerCountNotifier', () => {
  describe('constructor', () => {
    test('requires an io argument', () => {
      expect(() => new ViewerCountNotifier()).toThrow(/requires a Socket.IO/);
      expect(() => new ViewerCountNotifier(null, makeSessionService())).toThrow(/requires a Socket.IO/);
    });

    test('requires a sessionService argument', () => {
      expect(() => new ViewerCountNotifier(makeIo())).toThrow(/requires a SessionService/);
      expect(() => new ViewerCountNotifier(makeIo(), null)).toThrow(/requires a SessionService/);
    });

    test('stores both deps on the instance', () => {
      const io = makeIo();
      const sessionService = makeSessionService();
      const notifier = new ViewerCountNotifier(io, sessionService);
      expect(notifier.io).toBe(io);
      expect(notifier.sessionService).toBe(sessionService);
    });
  });

  describe('broadcast()', () => {
    test('emits viewer-count-update with the value returned by sessionService.getUniqueViewerCount', () => {
      const io = makeIo();
      const sessionService = makeSessionService(7);
      const notifier = new ViewerCountNotifier(io, sessionService);

      notifier.broadcast();

      expect(sessionService.getUniqueViewerCount).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenCalledWith('viewer-count-update', 7);
    });

    test('re-reads the count on each broadcast (no caching)', () => {
      // The 13 callsites this PR replaces all called getUniqueViewerCount()
      // fresh at the emit site. A future "optimisation" that caches the
      // count inside the notifier would silently make stale counts visible
      // to clients; pin the fresh-read contract.
      const io = makeIo();
      let n = 3;
      const sessionService = { getUniqueViewerCount: jest.fn(() => n) };
      const notifier = new ViewerCountNotifier(io, sessionService);

      notifier.broadcast();
      n = 5;
      notifier.broadcast();

      expect(sessionService.getUniqueViewerCount).toHaveBeenCalledTimes(2);
      expect(io.emit).toHaveBeenNthCalledWith(1, 'viewer-count-update', 3);
      expect(io.emit).toHaveBeenNthCalledWith(2, 'viewer-count-update', 5);
    });

    test('passes zero through (does not no-op when no viewers connected)', () => {
      // Important: a viewer-count-update of 0 is meaningful — it tells the
      // client to clear its viewer indicator. A "skip if zero" optimisation
      // would create a class of stuck-counter bugs.
      const io = makeIo();
      const sessionService = makeSessionService(0);
      const notifier = new ViewerCountNotifier(io, sessionService);

      notifier.broadcast();

      expect(io.emit).toHaveBeenCalledWith('viewer-count-update', 0);
    });
  });
});
