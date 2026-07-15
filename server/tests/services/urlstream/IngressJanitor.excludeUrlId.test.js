/**
 * Tests for IngressJanitor.cleanupAll viewbot-filter excludeUrlId guard
 * (audit Plan 06 V5).
 *
 * The url-stream ingress filter honored excludeUrlId, but the viewbot filter
 * did not — so when the NEW stream's ingress name happened to contain
 * 'viewbot', cleanupAll deleted it seconds after it started (the
 * "stream dies seconds after starting" crash-loop). These tests pin the
 * excludeUrlId guard on both filters.
 */

const mockDeleteIngress = jest.fn(async () => {});
const mockListIngress = jest.fn(async () => []);
const mockListParticipants = jest.fn(async () => []);
const mockRemoveParticipant = jest.fn(async () => {});

jest.mock('livekit-server-sdk', () => ({
  IngressClient: jest.fn().mockImplementation(() => ({
    listIngress: mockListIngress,
    deleteIngress: mockDeleteIngress,
  })),
  RoomServiceClient: jest.fn().mockImplementation(() => ({
    listParticipants: mockListParticipants,
    removeParticipant: mockRemoveParticipant,
  })),
}));

// Never let cleanupAll's safety-net pkill touch real processes in tests
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, cb) => cb && cb(new Error('disabled in tests'))),
}));

const IngressJanitor = require('../../../services/urlstream/IngressJanitor');

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function makeOwner() {
  return {
    livekitService: {
      config: {
        host: 'http://localhost:7882',
        apiKey: 'key',
        apiSecret: 'secret',
        roomName: 'onestreamer-main',
      },
    },
    activeStreams: new Map(),
    _stopProcesses: jest.fn(async () => {}),
  };
}

const NEW_URL_ID = 'url-stream-abc123';

// The new stream's ingress — its NAME contains 'viewbot' (e.g. the source was
// a viewbot-relayed URL), which used to get it caught by the viewbot filter.
const newStreamIngress = {
  ingressId: 'IN_new',
  participantIdentity: NEW_URL_ID,
  name: `URL Stream ${NEW_URL_ID} viewbot-relay`,
};

// A genuinely stale viewbot ingress that must always be cleaned up.
const staleViewbotIngress = {
  ingressId: 'IN_stale_viewbot',
  participantIdentity: 'viewbot-77',
  name: 'viewbot-77',
};

describe('IngressJanitor.cleanupAll viewbot-filter excludeUrlId guard (V5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListIngress.mockResolvedValue([newStreamIngress, staleViewbotIngress]);
    mockListParticipants.mockResolvedValue([]);
  });

  test('with excludeUrlId set, the new stream\'s viewbot-named ingress survives cleanup', async () => {
    const janitor = new IngressJanitor(makeOwner(), silentLogger);

    await janitor.cleanupAll(NEW_URL_ID);

    const deletedIds = mockDeleteIngress.mock.calls.map(([id]) => id);
    expect(deletedIds).not.toContain('IN_new');
    // The genuinely stale viewbot ingress is still collected
    expect(deletedIds).toContain('IN_stale_viewbot');
  });

  test('without exclusion, the viewbot-named ingress is collected', async () => {
    const janitor = new IngressJanitor(makeOwner(), silentLogger);

    await janitor.cleanupAll();

    const deletedIds = mockDeleteIngress.mock.calls.map(([id]) => id);
    expect(deletedIds).toContain('IN_new');
    expect(deletedIds).toContain('IN_stale_viewbot');
  });

  test('excludeUrlId also preserves an ingress matched by participantIdentity alone', async () => {
    mockListIngress.mockResolvedValue([
      {
        ingressId: 'IN_ident',
        participantIdentity: NEW_URL_ID,
        name: 'viewbot source relay', // viewbot match, no urlId in the name
      },
    ]);
    const janitor = new IngressJanitor(makeOwner(), silentLogger);

    await janitor.cleanupAll(NEW_URL_ID);

    expect(mockDeleteIngress).not.toHaveBeenCalled();
  });
});
