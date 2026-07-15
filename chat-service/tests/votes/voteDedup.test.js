// Tests for the CH2 vote-dedup fix (audit, Plan 06) in
// chat-service/votes/voteService.js: voters are deduped by authenticated
// user id when present ('u:<id>'), else by IP ('ip:<ip>') — so a logged-in
// user cannot double-vote from two devices/IPs, and (paired with the
// last-XFF-hop IP parse) a single anonymous client cannot mint unlimited
// voter identities via header spoofing.

const createVoteService = require('../../votes/voteService');

function buildVote({ viewers = 10 } = {}) {
  const chatMessages = [];
  const svc = createVoteService({
    io: { emit: jest.fn() },
    chatMessages,
    MAX_CHAT_HISTORY: 100,
    formatTime: () => '12:00',
    getUniqueViewerCount: () => viewers,
    config: {
      kind: 'skip',
      idPrefix: 'streambot_skip',
      color: '#FF0000',
      command: '!next',
      actionVerb: 'skip',
      threshold: 0.5,
      minRequiredVotes: 2,
      duration: 2 * 60 * 1000,
      tracksPassed: true,
      announceStart: jest.fn(),
      onPassed: jest.fn(),
      onFailed: jest.fn(),
    },
  });
  return svc;
}

describe('voteService dedup key (CH2)', () => {
  let logSpy;
  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
  });

  test('same authenticated user from two different IPs counts ONCE', () => {
    const svc = buildVote();
    svc.start({ ip: '10.0.0.1', username: 'Alice', authenticatedUserId: 42 });
    expect(svc.state.active.voters.size).toBe(1);

    // Same account, different device/IP, different display name even.
    const again = svc.register({ ip: '10.0.0.2', username: 'Alice', authenticatedUserId: 42 });
    expect(again).toBe(false);
    expect(svc.state.active.voters.size).toBe(1);
    svc.clearTimers();
  });

  test('two anonymous users with distinct IPs count twice; same IP counts once', () => {
    const svc = buildVote({ viewers: 20 }); // required = 10, no early end
    svc.start({ ip: '10.0.0.1', username: 'Lion1' });

    expect(svc.register({ ip: '10.0.0.2', username: 'Tiger2' })).toBe(true);
    expect(svc.state.active.voters.size).toBe(2);

    // Anonymous re-vote from the same (last-hop) IP is deduped even though
    // the username differs.
    expect(svc.register({ ip: '10.0.0.2', username: 'Bear3' })).toBe(false);
    expect(svc.state.active.voters.size).toBe(2);
    svc.clearTimers();
  });

  test('authenticated and anonymous keys do not collide', () => {
    const svc = buildVote({ viewers: 20 });
    // Contrived collision attempt: anonymous "IP" that looks like a user key.
    svc.start({ ip: '7', username: 'Lion1' }); // key ip:7
    expect(svc.register({ ip: '10.0.0.9', username: 'Carol', authenticatedUserId: 7 })).toBe(true); // key u:7
    expect(svc.state.active.voters.size).toBe(2);
    svc.clearTimers();
  });

  test('threshold still ends the vote early when reached by distinct voters', async () => {
    const svc = buildVote({ viewers: 4 }); // required = max(2, 2) = 2
    svc.start({ ip: '10.0.0.1', username: 'Alice', authenticatedUserId: 1 });
    expect(svc.register({ ip: '10.0.0.1', username: 'Bob', authenticatedUserId: 2 })).toBe(true); // same IP, different account
    // end() flipped state synchronously before the async onPassed.
    expect(svc.state.active).toBeNull();
    expect(svc.state.lastPassed).toBe(true);
  });
});
