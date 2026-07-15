// Tests for the CH5 fix (audit, Plan 06): anonymous chat identities are now
// derived deterministically from hash(persisted salt + IP) instead of a
// random pick, so a chat-service restart regenerates the SAME username for
// the same IP — and moderation bans, which are persisted by USERNAME in the
// JSON store, keep holding across restarts instead of being silently voided.

const fs = require('fs');
const os = require('os');
const path = require('path');

const createSocketHandlers = require('../../core/socketHandlers');
const createModerationService = require('../../moderation/moderationService');

function fakeAnonSocket(ip = '203.0.113.50', id = 'sock_anon_1') {
  const emitted = [];
  return {
    id,
    handshake: {
      auth: {},
      headers: {},
      address: ip,
      query: {},
    },
    conn: { remoteAddress: ip },
    request: { connection: { remoteAddress: ip } },
    emitted,
    emit(event, payload) { emitted.push({ event, payload }); },
    disconnect: jest.fn(),
    on: jest.fn(),
  };
}

function buildHandlers({ moderationService }) {
  // Fresh in-memory maps per instance — simulating what a process restart
  // wipes (ipToUser is the in-memory IP -> identity cache).
  const connectedUsers = new Map();
  const ipToUser = new Map();
  const axios = {
    get: jest.fn(async () => { throw new Error('not used'); }),
    post: jest.fn(async () => ({ data: { success: true } })),
  };
  const handlers = createSocketHandlers({
    io: { emit: jest.fn() },
    profanityFilter: { isClean: () => true },
    moderationService,
    commandParser: { parse: jest.fn() },
    adminCommands: {},
    connectedUsers,
    ipToUser,
    chatMessages: [],
    MAX_CHAT_HISTORY: 100,
    formatTime: () => '12:00',
    verifyToken: jest.fn(() => null),
    sendAdminResponse: jest.fn(),
    MAIN_SERVER_URL: 'https://main.test:8443',
    axios,
    getAxiosConfig: (extra = {}) => extra,
    uuidv4: () => 'uuid-1',
  });
  return { handlers, connectedUsers, ipToUser };
}

function assignedUsername(socket) {
  const evt = socket.emitted.find((e) => e.event === 'user-assigned');
  return evt ? evt.payload : null;
}

describe('CH5: deterministic anonymous identity across restarts', () => {
  let tmpDir;
  let storePath;
  let logSpy;
  let errSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-anon-test-'));
    storePath = path.join(tmpDir, 'moderation_data.json');
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('same IP gets the same username + color across a simulated restart', async () => {
    const ip = '203.0.113.77';

    // "Process 1"
    const mod1 = createModerationService({ moderationDataPath: storePath });
    const { handlers: h1 } = buildHandlers({ moderationService: mod1 });
    const s1 = fakeAnonSocket(ip, 'sock_run1');
    await h1.register(s1);
    const first = assignedUsername(s1);
    expect(first).not.toBeNull();
    // Display format preserved: Animal + 1..9999.
    expect(first.username).toMatch(/^[A-Z][a-z]+[1-9][0-9]{0,3}$/);
    expect(first.color).toMatch(/^#[0-9A-F]{6}$/i);

    // "Process 2": brand-new service instances + empty ipToUser Map, only
    // the on-disk store directory (moderation JSON + salt sibling) survives.
    const mod2 = createModerationService({ moderationDataPath: storePath });
    const { handlers: h2 } = buildHandlers({ moderationService: mod2 });
    const s2 = fakeAnonSocket(ip, 'sock_run2');
    await h2.register(s2);
    const second = assignedUsername(s2);

    expect(second.username).toBe(first.username);
    expect(second.color).toBe(first.color);
  });

  test('the salt is persisted as a sibling of the moderation store', async () => {
    const mod = createModerationService({ moderationDataPath: storePath });
    const { handlers } = buildHandlers({ moderationService: mod });
    await handlers.register(fakeAnonSocket());
    expect(fs.existsSync(`${storePath}.salt`)).toBe(true);
    const salt = fs.readFileSync(`${storePath}.salt`, 'utf8').trim();
    expect(salt.length).toBeGreaterThanOrEqual(16);
  });

  test('a persisted username-ban on an anonymous viewer still holds after restart', async () => {
    const ip = '203.0.113.88';

    // Run 1: viewer connects, gets a derived name, then gets banned (the
    // moderation store persists the ban by username).
    const mod1 = createModerationService({ moderationDataPath: storePath });
    const { handlers: h1 } = buildHandlers({ moderationService: mod1 });
    const s1 = fakeAnonSocket(ip, 'sock_prewipe');
    await h1.register(s1);
    const banned = assignedUsername(s1).username;
    mod1.bannedUsers.add(banned);
    mod1.saveModerationData();

    // Run 2 (restart): fresh instances load the persisted ban; the same IP
    // must derive the same username and be rejected at connect.
    const mod2 = createModerationService({ moderationDataPath: storePath });
    mod2.loadModerationData();
    const { handlers: h2 } = buildHandlers({ moderationService: mod2 });
    const s2 = fakeAnonSocket(ip, 'sock_postwipe');
    await h2.register(s2);

    const events = s2.emitted.map((e) => e.event);
    expect(events).toContain('banned');
    expect(events).not.toContain('user-assigned');
    expect(s2.disconnect).toHaveBeenCalledWith(true);
  });

  test('different IPs get different identities (no shared-name regression)', async () => {
    const mod = createModerationService({ moderationDataPath: storePath });
    const { handlers } = buildHandlers({ moderationService: mod });
    const a = fakeAnonSocket('203.0.113.10', 'sock_a');
    const b = fakeAnonSocket('203.0.113.11', 'sock_b');
    await handlers.register(a);
    await handlers.register(b);
    expect(assignedUsername(a).username).not.toBe(assignedUsername(b).username);
  });

  test('moderation service without getAnonSalt (older stubs) falls back to an ephemeral salt', async () => {
    const { handlers } = buildHandlers({
      moderationService: {
        isUserBanned: () => false,
        isUserTimedOut: () => false,
        timeoutUsers: new Map(),
      },
    });
    const s = fakeAnonSocket('203.0.113.99', 'sock_fallback');
    await handlers.register(s);
    const assigned = assignedUsername(s);
    expect(assigned).not.toBeNull();
    expect(assigned.username).toMatch(/^[A-Z][a-z]+[1-9][0-9]{0,3}$/);
  });
});
