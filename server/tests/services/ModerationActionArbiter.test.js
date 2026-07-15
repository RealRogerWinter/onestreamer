// Tests for server/services/ModerationActionArbiter — turns a fully-
// classified moderation event into a ban / blocklist / skip action
// (PR-M3 of ADR-0013).
//
// Coverage:
//   - Constructor required-dep validation.
//   - Stale-session check downgrades to admin_review without acting.
//   - enforce=false downgrades to admin_review without acting.
//   - webcam branch: bans the authenticated user, calls notifier banner,
//     requests rotation. Anonymous streamers skip the ban write. The result
//     carries banned_user_id (audit M5) so ModerationService can persist it.
//   - url-relay branch: adds whitelist block entry, calls rotation. When the
//     event carries no external identity, resolves it from the live relay
//     via viewBotURLService (audit M3); when nothing resolves or the block
//     write fails, downgrades to admin_review instead of claiming auto_skip
//     (fail-honest, audit M3).
//   - viewbot / unknown branch: no action.

const ModerationActionArbiter = require('../../services/ModerationActionArbiter');

function makeDeps(overrides = {}) {
  return {
    userRepository: {
      banFromStreaming: jest.fn(async () => ({ changes: 1 })),
    },
    sessionService: {
      getUserIdBySocketId: jest.fn(() => 42),
    },
    streamService: {
      getStreamGeneration: jest.fn(() => 5),
    },
    randomStreamRotationService: {
      _rotateToNewStream: jest.fn(async () => ({ success: true })),
    },
    whitelistService: {
      addEntry: jest.fn(async () => ({ id: 9, value: 'badguy' })),
    },
    moderationNotifier: {
      streamerBanner: jest.fn(),
    },
    enforce: true,
    ...overrides,
  };
}

describe('ModerationActionArbiter.constructor', () => {
  test('requires userRepository', () => {
    expect(() => new ModerationActionArbiter({})).toThrow(/userRepository/);
  });
  test('requires sessionService', () => {
    expect(() => new ModerationActionArbiter({ userRepository: {} })).toThrow(/sessionService/);
  });
  test('requires streamService', () => {
    expect(() => new ModerationActionArbiter({ userRepository: {}, sessionService: {} })).toThrow(/streamService/);
  });
  test('requires moderationNotifier', () => {
    expect(() => new ModerationActionArbiter({
      userRepository: {}, sessionService: {}, streamService: {},
    })).toThrow(/moderationNotifier/);
  });
});

describe('ModerationActionArbiter.arbitrate stale-session', () => {
  test('downgrades to admin_review when event session != current generation', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 1,
      stream_session_id: '3', // event captured gen=3
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toContain('stale_session');
    expect(deps.userRepository.banFromStreaming).not.toHaveBeenCalled();
  });

  test('proceeds when session matches', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 1,
      stream_session_id: '5',
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('auto_ban');
    expect(deps.userRepository.banFromStreaming).toHaveBeenCalled();
  });
});

describe('ModerationActionArbiter.arbitrate enforce flag', () => {
  test('enforce=false downgrades to admin_review even when session matches', async () => {
    const deps = makeDeps({ enforce: false });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 1,
      stream_session_id: '5',
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toBe('enforce_off');
    expect(deps.userRepository.banFromStreaming).not.toHaveBeenCalled();
  });
});

describe('ModerationActionArbiter.arbitrate webcam', () => {
  test('bans authenticated user, calls banner, requests rotation', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 7,
      stream_session_id: '5',
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('auto_ban');
    expect(deps.userRepository.banFromStreaming).toHaveBeenCalledWith(42, 'ai-moderation');
    expect(deps.moderationNotifier.streamerBanner).toHaveBeenCalledWith(expect.objectContaining({
      socketId: 'sock_a',
      appealUrl: expect.stringContaining('7'),
    }));
    expect(deps.randomStreamRotationService._rotateToNewStream).toHaveBeenCalled();
    expect(r.action_taken).toMatch(/banned:42/);
    expect(r.action_taken).toMatch(/rotation=rotated/);
  });

  test('anonymous streamer skips ban write but still rotates and notifies', async () => {
    const deps = makeDeps({
      sessionService: { getUserIdBySocketId: jest.fn(() => null) },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 8,
      stream_session_id: '5',
      streamer_id: 'sock_anon',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('auto_ban');
    expect(deps.userRepository.banFromStreaming).not.toHaveBeenCalled();
    expect(deps.moderationNotifier.streamerBanner).toHaveBeenCalled();
    expect(deps.randomStreamRotationService._rotateToNewStream).toHaveBeenCalled();
    expect(r.action_taken).toMatch(/anonymous_streamer/);
  });

  test('rotation failure is logged but does not crash', async () => {
    const deps = makeDeps({
      randomStreamRotationService: {
        _rotateToNewStream: jest.fn(async () => ({ success: false, error: 'no_platforms' })),
      },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 9,
      stream_session_id: '5',
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('auto_ban');
    expect(r.action_taken).toMatch(/rotation=rotation_failed/);
  });

  test('ban write failure surfaces in action_taken but rotation still runs', async () => {
    const deps = makeDeps({
      userRepository: {
        banFromStreaming: jest.fn(async () => { throw new Error('disk full'); }),
      },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 10,
      stream_session_id: '5',
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.action_taken).toMatch(/ban_error:disk full/);
    expect(deps.randomStreamRotationService._rotateToNewStream).toHaveBeenCalled();
  });
});

describe('ModerationActionArbiter.arbitrate url-relay', () => {
  test('inserts whitelist block entry and rotates', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 11,
      stream_session_id: '5',
      streamer_id: null,
      stream_type: 'url-relay',
      external_platform: 'twitch',
      external_login: 'badguy',
      external_user_id: '12345',
    });
    expect(r.final_decision).toBe('auto_skip');
    expect(deps.whitelistService.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'twitch',
        entry_type: 'streamer',
        value: 'badguy',
        list: 'block',
      }),
      'ai-moderator'
    );
    expect(deps.randomStreamRotationService._rotateToNewStream).toHaveBeenCalled();
    expect(r.action_taken).toMatch(/blocked:twitch:badguy/);
  });

  test('UNIQUE violation on the block list is treated as a no-op success', async () => {
    const deps = makeDeps({
      whitelistService: {
        addEntry: jest.fn(async () => { throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'); }),
      },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 12,
      stream_session_id: '5',
      stream_type: 'url-relay',
      external_platform: 'kick',
      external_login: 'baddude',
    });
    expect(r.action_taken).toMatch(/already_blocked:kick:baddude/);
    expect(r.final_decision).toBe('auto_skip');
  });

  test('missing platform / login with no live-relay resolution → fail-honest admin_review (M3)', async () => {
    const deps = makeDeps(); // no viewBotURLService wired
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 13,
      stream_session_id: '5',
      stream_type: 'url-relay',
      external_platform: null,
      external_login: null,
    });
    // Fail-honest: previously this recorded final_decision 'auto_skip' as
    // if the block had happened.
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toMatch(/url_relay_block_unresolved/);
    expect(deps.whitelistService.addEntry).not.toHaveBeenCalled();
    // The relay is still rotated away even though it could not be blocked.
    expect(deps.randomStreamRotationService._rotateToNewStream).toHaveBeenCalled();
  });

  test('M3: missing external identity resolved from the LIVE relay via viewBotURLService → block lands, auto_skip', async () => {
    const deps = makeDeps({
      viewBotURLService: {
        getActiveURLStream: jest.fn(() => ({
          urlId: 'url-stream-123',
          platform: 'twitch',
          sourceUrl: 'https://twitch.tv/badguy',
        })),
        _extractLoginFromUrl: jest.fn(() => 'badguy'),
      },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 16,
      stream_session_id: '5',
      stream_type: 'url-relay',
      external_platform: null,
      external_login: null,
    });
    expect(deps.viewBotURLService.getActiveURLStream).toHaveBeenCalled();
    expect(deps.viewBotURLService._extractLoginFromUrl).toHaveBeenCalledWith('https://twitch.tv/badguy', 'twitch');
    expect(deps.whitelistService.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'twitch', value: 'badguy', list: 'block' }),
      'ai-moderator'
    );
    expect(r.final_decision).toBe('auto_skip');
    expect(r.action_taken).toMatch(/blocked:twitch:badguy/);
  });

  test('M3: event-supplied identity wins over the live relay (no unnecessary resolution)', async () => {
    const deps = makeDeps({
      viewBotURLService: {
        getActiveURLStream: jest.fn(() => ({ platform: 'kick', sourceUrl: 'https://kick.com/other' })),
        _extractLoginFromUrl: jest.fn(() => 'other'),
      },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 17,
      stream_session_id: '5',
      stream_type: 'url-relay',
      external_platform: 'twitch',
      external_login: 'badguy',
    });
    expect(deps.viewBotURLService.getActiveURLStream).not.toHaveBeenCalled();
    expect(r.final_decision).toBe('auto_skip');
    expect(r.action_taken).toMatch(/blocked:twitch:badguy/);
  });

  test('M3: no active relay at action time → admin_review, not auto_skip', async () => {
    const deps = makeDeps({
      viewBotURLService: { getActiveURLStream: jest.fn(() => null), _extractLoginFromUrl: jest.fn() },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 18,
      stream_session_id: '5',
      stream_type: 'url-relay',
      external_platform: null,
      external_login: null,
    });
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toMatch(/url_relay_block_unresolved/);
  });

  test('M3: block WRITE failure (non-UNIQUE) is fail-honest admin_review', async () => {
    const deps = makeDeps({
      whitelistService: {
        addEntry: jest.fn(async () => { throw new Error('disk full'); }),
      },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 19,
      stream_session_id: '5',
      stream_type: 'url-relay',
      external_platform: 'twitch',
      external_login: 'badguy',
    });
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toMatch(/block_error:disk full/);
  });
});

describe('ModerationActionArbiter M5: banned_user_id in the webcam result', () => {
  test('resolved user → banned_user_id carries the numeric id', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 20,
      stream_session_id: '5',
      streamer_id: 'sock_a',
      stream_type: 'webcam',
    });
    expect(r.final_decision).toBe('auto_ban');
    expect(r.banned_user_id).toBe(42);
  });

  test('anonymous streamer → banned_user_id null', async () => {
    const deps = makeDeps({
      sessionService: { getUserIdBySocketId: jest.fn(() => null) },
    });
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 21,
      stream_session_id: '5',
      streamer_id: 'sock_anon',
      stream_type: 'webcam',
    });
    expect(r.banned_user_id).toBeNull();
  });
});

describe('ModerationActionArbiter.arbitrate viewbot / unknown', () => {
  test('viewbot stream_type returns no_action', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 14,
      stream_session_id: '5',
      stream_type: 'viewbot',
    });
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toMatch(/no_action_for_stream_type:viewbot/);
    expect(deps.userRepository.banFromStreaming).not.toHaveBeenCalled();
    expect(deps.whitelistService.addEntry).not.toHaveBeenCalled();
  });

  test('unknown stream_type returns no_action with unknown tag', async () => {
    const deps = makeDeps();
    const arb = new ModerationActionArbiter(deps);
    const r = await arb.arbitrate({
      id: 15,
      stream_session_id: '5',
      stream_type: 'something-new',
    });
    expect(r.final_decision).toBe('admin_review');
    expect(r.action_taken).toMatch(/no_action_for_stream_type/);
  });
});
