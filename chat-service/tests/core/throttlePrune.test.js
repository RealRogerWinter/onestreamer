// Tests for the CH6 fix (audit, Plan 06) in chat-service/core/
// socketHandlers.js: the per-user throttle Maps (userLastMessage /
// userMessageHistory) grew forever — nothing ever deleted an entry, so
// every username that ever chatted stayed resident until process exit.
// Because the Maps are keyed by USERNAME (shared across sockets: same
// anonymous IP in two tabs, one account on two devices), the fix is an
// age-based sweep rather than per-disconnect deletes: entries whose newest
// activity is older than the 30s duplicate window — the longest window
// either gate reads — are pruned, so the sweep can never change a gating
// decision.

const createSocketHandlers = require('../../core/socketHandlers');

function buildHandlers() {
  return createSocketHandlers({
    io: { emit: jest.fn() },
    profanityFilter: { isClean: () => true },
    moderationService: {
      isUserBanned: () => false,
      isUserTimedOut: () => false,
      timeoutUsers: new Map(),
    },
    commandParser: { parse: jest.fn() },
    adminCommands: {},
    connectedUsers: new Map(),
    ipToUser: new Map(),
    chatMessages: [],
    MAX_CHAT_HISTORY: 100,
    formatTime: () => '12:00',
    verifyToken: () => null,
    sendAdminResponse: jest.fn(),
    MAIN_SERVER_URL: 'https://main.test:8443',
    axios: { get: jest.fn(), post: jest.fn(async () => ({ data: {} })) },
    getAxiosConfig: (extra = {}) => extra,
    uuidv4: () => 'uuid-1',
  });
}

describe('CH6: throttle Maps are pruned by an age-based sweep', () => {
  test('entries older than the duplicate window are removed; fresh ones kept', () => {
    const handlers = buildHandlers();
    const now = Date.now();

    // Stale user: last activity 5 minutes ago.
    handlers.userLastMessage.set('OldUser', now - 5 * 60 * 1000);
    handlers.userMessageHistory.set('OldUser', [
      { message: 'hello', timestamp: now - 5 * 60 * 1000 },
    ]);
    // Fresh user: active 2 seconds ago (still inside both gate windows).
    handlers.userLastMessage.set('FreshUser', now - 2000);
    handlers.userMessageHistory.set('FreshUser', [
      { message: 'hi', timestamp: now - 2000 },
    ]);

    handlers.pruneThrottleState(now);

    expect(handlers.userLastMessage.has('OldUser')).toBe(false);
    expect(handlers.userMessageHistory.has('OldUser')).toBe(false);
    expect(handlers.userLastMessage.has('FreshUser')).toBe(true);
    expect(handlers.userMessageHistory.has('FreshUser')).toBe(true);
  });

  test('mixed-age history keeps only the in-window messages', () => {
    const handlers = buildHandlers();
    const now = Date.now();

    handlers.userMessageHistory.set('MixedUser', [
      { message: 'ancient', timestamp: now - 10 * 60 * 1000 },
      { message: 'recent', timestamp: now - 5000 },
    ]);

    handlers.pruneThrottleState(now);

    const history = handlers.userMessageHistory.get('MixedUser');
    expect(history).toHaveLength(1);
    expect(history[0].message).toBe('recent');
  });

  test('a user right at the rate-limit boundary is not prematurely pruned', () => {
    const handlers = buildHandlers();
    const now = Date.now();

    // 4s ago: still rate-limited (5s window) — pruning this entry would
    // wrongly reset the cooldown. The sweep retains anything younger than
    // the 30s duplicate window, which strictly contains the 5s rate window.
    handlers.userLastMessage.set('RateLimited', now - 4000);
    handlers.pruneThrottleState(now);
    expect(handlers.userLastMessage.has('RateLimited')).toBe(true);

    // 29.9s ago: rate limit long expired but the duplicate window is still
    // open — must also be retained.
    handlers.userLastMessage.set('DupWindow', now - 29900);
    handlers.userMessageHistory.set('DupWindow', [
      { message: 'same msg', timestamp: now - 29900 },
    ]);
    handlers.pruneThrottleState(now);
    expect(handlers.userMessageHistory.get('DupWindow')).toHaveLength(1);
  });

  test('the periodic sweep timer exists and is unref\'d (audit B6 posture)', () => {
    jest.useFakeTimers();
    try {
      const handlers = buildHandlers();
      const now = Date.now();
      handlers.userLastMessage.set('OldUser', now - 5 * 60 * 1000);
      handlers.userMessageHistory.set('OldUser', [
        { message: 'hello', timestamp: now - 5 * 60 * 1000 },
      ]);

      expect(handlers._throttleSweepTimer).toBeDefined();

      // Advancing past the 60s sweep interval runs the prune automatically.
      jest.advanceTimersByTime(61 * 1000);
      expect(handlers.userLastMessage.has('OldUser')).toBe(false);
      expect(handlers.userMessageHistory.has('OldUser')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
