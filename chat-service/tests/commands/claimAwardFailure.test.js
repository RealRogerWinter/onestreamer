// Tests for the CH4 fix (audit, Plan 06) in chat-service/commands/
// commandParser.js: when the award-points call fails after a user claimed,
// the parser used to only reset `.claimedBy = null`. The claim-event expiry
// timer skips cleanup when `.claimedBy` is set at fire time, so a failure
// landing after (or racing) expiry left a stale activeClaimEvent forever —
// startClaimEvent() then refused to start every future event. Both failure
// paths (main-server success:false, and axios throw) must now clear the
// event via clearActiveClaim() so future /claim events still fire.

const createClaimEventService = require('../../claims/claimEventService');
const createCommandParser = require('../../commands/commandParser');

function voteStub() {
  // The !claim branch never touches the vote services; the parser only
  // destructures them (missing props destructure to undefined harmlessly)
  // and reads `state` for the mutual-exclusion guard map.
  return { state: { active: null, lastEndTime: 0, lastPassed: false } };
}

function buildHarness({ awardResponse, awardRejects = false } = {}) {
  const chatMessages = [];
  const io = { emit: jest.fn() };
  const formatTime = () => '12:00';

  const claimEventService = createClaimEventService({
    io,
    chatMessages,
    MAX_CHAT_HISTORY: 100,
    formatTime,
  });

  const axios = {
    post: jest.fn(async () => {
      if (awardRejects) throw new Error('main server down');
      return { data: awardResponse };
    }),
    get: jest.fn(async () => ({ data: {} })),
  };
  const sendAdminResponse = jest.fn();

  const parser = createCommandParser({
    io,
    chatMessages,
    MAX_CHAT_HISTORY: 100,
    formatTime,
    getUniqueViewerCount: () => 5,
    axios,
    MAIN_SERVER_URL: 'https://main.test:8443',
    getAxiosConfig: (extra = {}) => extra,
    sendAdminResponse,
    claimEventService,
    voteServices: {
      skipVote: voteStub(),
      swapVote: voteStub(),
      extendVote: voteStub(),
      reduceVote: voteStub(),
      lockVote: voteStub(),
      unlockVote: voteStub(),
    },
    voteCooldowns: {},
  });

  const user = {
    username: 'Alice',
    isAuthenticated: true,
    authenticatedUserId: 42,
    ip: '10.0.0.1',
  };
  const socket = { id: 'sock_1', handshake: { auth: {} }, emit: jest.fn() };

  return { parser, claimEventService, axios, sendAdminResponse, user, socket };
}

describe('CH4: claim event cleared on award failure', () => {
  let logSpy;
  let errSpy;
  beforeEach(() => {
    jest.useFakeTimers();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('main server responds success:false → event cleared, next event can start', async () => {
    const { parser, claimEventService, user, socket } = buildHarness({
      awardResponse: { success: false, error: 'insufficient house funds' },
    });
    expect(claimEventService.startClaimEvent(true)).toBe(true);
    const code = claimEventService.getActiveClaim().code;

    await parser.parse('claim', [code], user, socket);

    // The stale event must be gone entirely, not just have claimedBy reset.
    expect(claimEventService.getActiveClaim()).toBeNull();
    // And a future claim event is no longer blocked.
    expect(claimEventService.startClaimEvent(true)).toBe(true);
  });

  test('award call throws → event cleared, next event can start', async () => {
    const { parser, claimEventService, user, socket } = buildHarness({
      awardRejects: true,
    });
    expect(claimEventService.startClaimEvent(true)).toBe(true);
    const code = claimEventService.getActiveClaim().code;

    await parser.parse('claim', [code], user, socket);

    expect(claimEventService.getActiveClaim()).toBeNull();
    expect(claimEventService.startClaimEvent(true)).toBe(true);
  });

  test('failure racing the expiry timer no longer wedges the claim subsystem', async () => {
    const { parser, claimEventService, user, socket } = buildHarness({
      awardRejects: true,
    });
    claimEventService.startClaimEvent(true);
    const active = claimEventService.getActiveClaim();

    // Simulate the pre-fix wedge scenario: the user claims (claimedBy set),
    // the 60s expiry fires while the award call is in flight — it sees
    // claimedBy set and does nothing (and never fires again).
    active.claimedBy = user.username;
    jest.advanceTimersByTime(61 * 1000);
    expect(claimEventService.getActiveClaim()).not.toBeNull();
    active.claimedBy = null; // hand the claim back to the parser flow

    await parser.parse('claim', [active.code], user, socket);

    // With the fix the failed award clears the event, so the subsystem
    // is not permanently stuck.
    expect(claimEventService.getActiveClaim()).toBeNull();
    expect(claimEventService.startClaimEvent(true)).toBe(true);
  });

  test('successful award still clears the event (behavior unchanged)', async () => {
    const { parser, claimEventService, user, socket } = buildHarness({
      awardResponse: { success: true, newBalance: 1234 },
    });
    claimEventService.startClaimEvent(true);
    const code = claimEventService.getActiveClaim().code;

    await parser.parse('claim', [code], user, socket);

    expect(claimEventService.getActiveClaim()).toBeNull();
    expect(claimEventService.startClaimEvent(true)).toBe(true);
  });
});
