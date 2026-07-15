// Tests for the CH7 fix (audit, Plan 06) in chat-service/votes/voteService.js:
// the vote requirement used to be frozen at vote start (computed from the
// viewer count when the vote began), so viewers leaving mid-vote made the
// vote unpassable — and the failed vote then imposed a cooldown on the
// remaining viewers. end() now recomputes against the LIVE viewer count and
// takes min(startRequirement, liveRequirement): a vote can only get EASIER
// as viewers leave, never harder mid-flight.

const createVoteService = require('../../votes/voteService');

function buildVote({ initialViewers = 10 } = {}) {
  const chatMessages = [];
  let viewers = initialViewers;
  const onPassed = jest.fn();
  const onFailed = jest.fn();
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
      onPassed,
      onFailed,
    },
  });
  return { svc, onPassed, onFailed, setViewers: (n) => { viewers = n; } };
}

describe('voteService live threshold at tally (CH7)', () => {
  let logSpy;
  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
  });

  test('viewers leaving mid-vote lowers the requirement: 10 → 4 viewers, 3 votes pass', async () => {
    const { svc, onPassed, onFailed, setViewers } = buildVote({ initialViewers: 10 });
    // Start: ceil(10 * 0.5) = 5 required.
    svc.start({ ip: '10.0.0.1', username: 'Alice', authenticatedUserId: 1 });
    expect(svc.state.active.requiredVotes).toBe(5);
    svc.register({ ip: '10.0.0.2', username: 'Bob', authenticatedUserId: 2 });
    svc.register({ ip: '10.0.0.3', username: 'Cara', authenticatedUserId: 3 });
    expect(svc.state.active.voters.size).toBe(3);

    // Six viewers leave before the window ends: live requirement is
    // max(ceil(4 * 0.5), 2) = 2, min(5, 2) = 2 → the 3 votes now pass.
    setViewers(4);
    await svc.end();

    expect(onFailed).not.toHaveBeenCalled();
    expect(onPassed).toHaveBeenCalledTimes(1);
    expect(onPassed.mock.calls[0][0]).toMatchObject({
      passed: true,
      voteCount: 3,
      requiredVotes: 2,
    });
    expect(svc.state.lastPassed).toBe(true);
  });

  test('viewers arriving mid-vote can NOT raise the bar above the start requirement', async () => {
    const { svc, onPassed, setViewers } = buildVote({ initialViewers: 4 });
    // Start: max(ceil(4 * 0.5), 2) = 2 required.
    svc.start({ ip: '10.0.0.1', username: 'Alice', authenticatedUserId: 1 });
    expect(svc.state.active.requiredVotes).toBe(2);
    // Crowd influx mid-vote: live requirement would be ceil(100 * 0.5) = 50,
    // but min(start, live) pins the bar at the announced 2.
    setViewers(100);
    svc.register({ ip: '10.0.0.2', username: 'Bob', authenticatedUserId: 2 });
    await svc.end(); // no-op — register() already ended the vote at 2/2

    expect(onPassed).toHaveBeenCalledTimes(1);
    expect(onPassed.mock.calls[0][0]).toMatchObject({ requiredVotes: 2 });
  });

  test('vote still fails when votes are below both the start and live requirements', async () => {
    const { svc, onPassed, onFailed } = buildVote({ initialViewers: 10 });
    svc.start({ ip: '10.0.0.1', username: 'Alice', authenticatedUserId: 1 });
    svc.register({ ip: '10.0.0.2', username: 'Bob', authenticatedUserId: 2 });
    // Viewer count unchanged (10): requirement stays 5, 2 votes fail.
    await svc.end();

    expect(onPassed).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toMatchObject({ voteCount: 2, requiredVotes: 5 });
    expect(svc.state.lastPassed).toBe(false);
  });

  test('live requirement never drops below minRequiredVotes even if everyone leaves', async () => {
    const { svc, onPassed, onFailed, setViewers } = buildVote({ initialViewers: 10 });
    svc.start({ ip: '10.0.0.1', username: 'Alice', authenticatedUserId: 1 });
    // Only the initiator voted; everyone else leaves entirely.
    setViewers(0);
    await svc.end();

    // min(5, max(0, 2)) = 2 — a single vote still fails.
    expect(onPassed).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toMatchObject({ voteCount: 1, requiredVotes: 2 });
  });
});
