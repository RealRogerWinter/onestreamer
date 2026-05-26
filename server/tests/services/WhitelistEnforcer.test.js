/**
 * Tests for WhitelistEnforcer (ADR-0010, PR-W4 / Phase 3 — drift enforcement).
 *
 * Scope is the `_tick` decision logic. The setInterval/clearInterval lifecycle
 * is trivial and exercised by the start/stop tests.
 */

const WhitelistEnforcer = require('../../services/WhitelistEnforcer');

function makeDeps(overrides = {}) {
  const viewBotURLService = {
    getActiveURLStream: jest.fn(() => null),
    stopURLStream: jest.fn().mockResolvedValue({ success: true }),
    extractorService: {
      extractIdentifier: jest.fn((url) => {
        const m = url && url.match(/(?:twitch\.tv|kick\.com)\/([^\/?#]+)/i);
        return m ? { platform: url.includes('twitch') ? 'twitch' : 'kick', identifier: m[1] } : null;
      }),
    },
  };
  const whitelistService = {
    isStillAllowed: jest.fn(() => ({ allowed: true, reason: 'ok' })),
    logAudit: jest.fn().mockResolvedValue({}),
    chooseFallback: jest.fn(() => null),
  };
  const twitchService = {
    getCurrentStreamSnapshot: jest.fn().mockResolvedValue(null),
  };
  const kickService = {
    getCurrentStreamSnapshot: jest.fn().mockResolvedValue(null),
  };
  const io = { emit: jest.fn() };
  return {
    viewBotURLService,
    whitelistService,
    twitchService,
    kickService,
    io,
    ...overrides,
  };
}

describe('WhitelistEnforcer', () => {
  describe('start/stop', () => {
    test('start() with missing deps no-ops with a warning', () => {
      const deps = makeDeps();
      const e = new WhitelistEnforcer({ ...deps, whitelistService: null });
      e.start();
      expect(e._timer).toBeNull();
    });

    test('start() then stop() leaves no timer', () => {
      const deps = makeDeps();
      const e = new WhitelistEnforcer(deps);
      e.start({ intervalSeconds: 60 });
      expect(e._timer).not.toBeNull();
      e.stop();
      expect(e._timer).toBeNull();
    });
  });

  describe('_tick', () => {
    test('no active stream → skipped', async () => {
      const deps = makeDeps();
      const e = new WhitelistEnforcer(deps);
      const result = await e._tick();
      expect(result).toEqual({ skipped: 'no_active_stream' });
      expect(deps.viewBotURLService.stopURLStream).not.toHaveBeenCalled();
    });

    test('YouTube relay → skipped (not gated)', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u1', sourceUrl: 'https://youtube.com/watch?v=x', platform: 'youtube',
      });
      const e = new WhitelistEnforcer(deps);
      const result = await e._tick();
      expect(result.skipped).toBe('platform_not_gated');
      expect(deps.viewBotURLService.stopURLStream).not.toHaveBeenCalled();
    });

    test('whitelisted streamer still in policy → no-op', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u1', sourceUrl: 'https://twitch.tv/cohhcarnage', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue({
        platform: 'twitch', login: 'cohhcarnage', currentGameName: 'Minecraft', isMature: false, ccls: [],
      });
      deps.whitelistService.isStillAllowed.mockReturnValue({ allowed: true, reason: 'streamer_allowed' });
      const e = new WhitelistEnforcer(deps);
      const result = await e._tick();
      expect(result.ok).toBe(true);
      expect(deps.viewBotURLService.stopURLStream).not.toHaveBeenCalled();
      expect(deps.io.emit).not.toHaveBeenCalled();
    });

    test('streamer drifted to non-whitelisted category → stops + audits + emits', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-drift', sourceUrl: 'https://twitch.tv/cohhcarnage', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue({
        platform: 'twitch', login: 'cohhcarnage', currentGameName: 'Slots', isMature: false, ccls: ['Gambling'],
      });
      deps.whitelistService.isStillAllowed.mockReturnValue({
        allowed: false, reason: 'category_blocked:Slots', gateThatBlocked: 'blacklist_category',
      });
      const e = new WhitelistEnforcer(deps);
      const result = await e._tick();

      expect(result.stopped).toBe(true);
      expect(result.gateThatBlocked).toBe('blacklist_category');
      expect(deps.viewBotURLService.stopURLStream).toHaveBeenCalledWith('u-drift');
      expect(deps.whitelistService.logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'drift_block', platform: 'twitch', value: 'cohhcarnage',
      }));
      expect(deps.io.emit).toHaveBeenCalledWith('whitelist-drift-stop', expect.objectContaining({
        urlId: 'u-drift',
        login: 'cohhcarnage',
        platform: 'twitch',
        reason: 'category_blocked:Slots',
        gateThatBlocked: 'blacklist_category',
      }));
    });

    test('snapshot fetch failure once → skipped, no stop', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-fail', sourceUrl: 'https://twitch.tv/x', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue(null);
      const e = new WhitelistEnforcer(deps);
      const result = await e._tick();
      expect(result.skipped).toBe('snapshot_failed_first');
      expect(deps.viewBotURLService.stopURLStream).not.toHaveBeenCalled();
    });

    test('snapshot fetch failure inside 3-minute window → still skipped', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-fail2', sourceUrl: 'https://twitch.tv/x', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue(null);
      const e = new WhitelistEnforcer(deps);
      // First failure marks the timer
      await e._tick();
      // Second failure 5 seconds later — still within tolerance
      const result = await e._tick();
      expect(result.skipped).toBe('snapshot_failed_recent');
      expect(deps.viewBotURLService.stopURLStream).not.toHaveBeenCalled();
    });

    test('snapshot fetch failure beyond 3-minute window → stop on the safe side', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-out', sourceUrl: 'https://twitch.tv/x', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue(null);
      const e = new WhitelistEnforcer(deps);
      // Seed the first failure timer >3min in the past
      e._lastSnapshotFailureAt.set('u-out', Date.now() - (4 * 60 * 1000));
      const result = await e._tick();
      expect(result.stopped).toBe(true);
      expect(result.reason).toBe('platform_degraded_extended');
      expect(deps.viewBotURLService.stopURLStream).toHaveBeenCalledWith('u-out');
    });

    test('snapshot success after failure clears the failure timer', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-recover', sourceUrl: 'https://twitch.tv/x', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          platform: 'twitch', login: 'x', currentGameName: 'Minecraft', isMature: false, ccls: [],
        });
      deps.whitelistService.isStillAllowed.mockReturnValue({ allowed: true });
      const e = new WhitelistEnforcer(deps);
      await e._tick();  // first failure, timer set
      expect(e._lastSnapshotFailureAt.has('u-recover')).toBe(true);
      const result = await e._tick();  // success → timer cleared
      expect(result.ok).toBe(true);
      expect(e._lastSnapshotFailureAt.has('u-recover')).toBe(false);
    });

    test('audit row includes stopSucceeded flag (post-review fix)', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-audit', sourceUrl: 'https://twitch.tv/x', platform: 'twitch',
      });
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue({
        platform: 'twitch', login: 'x', currentGameName: 'Slots', isMature: false, ccls: [],
      });
      deps.whitelistService.isStillAllowed.mockReturnValue({
        allowed: false, reason: 'category_blocked:Slots', gateThatBlocked: 'blacklist_category',
      });
      const e = new WhitelistEnforcer(deps);
      await e._tick();
      const auditCall = deps.whitelistService.logAudit.mock.calls[0][0];
      const context = JSON.parse(auditCall.context);
      expect(context.stopSucceeded).toBe(true);
    });

    test('socket event still fires when stopURLStream throws', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-stop-fail', sourceUrl: 'https://twitch.tv/x', platform: 'twitch',
      });
      deps.viewBotURLService.stopURLStream.mockRejectedValue(new Error('teardown busy'));
      deps.twitchService.getCurrentStreamSnapshot.mockResolvedValue({
        platform: 'twitch', login: 'x', currentGameName: 'Slots', isMature: false, ccls: [],
      });
      deps.whitelistService.isStillAllowed.mockReturnValue({
        allowed: false, reason: 'category_blocked:Slots', gateThatBlocked: 'blacklist_category',
      });
      const e = new WhitelistEnforcer(deps);
      await e._tick();
      expect(deps.io.emit).toHaveBeenCalledWith('whitelist-drift-stop', expect.objectContaining({
        stopSucceeded: false,
      }));
    });

    test('Kick path uses kickService', async () => {
      const deps = makeDeps();
      deps.viewBotURLService.getActiveURLStream.mockReturnValue({
        urlId: 'u-kick', sourceUrl: 'https://kick.com/mustafa_go', platform: 'kick',
      });
      deps.kickService.getCurrentStreamSnapshot.mockResolvedValue({
        platform: 'kick', login: 'mustafa_go', currentGameName: 'Minecraft', hasMatureContent: false,
      });
      deps.whitelistService.isStillAllowed.mockReturnValue({ allowed: true });
      const e = new WhitelistEnforcer(deps);
      const result = await e._tick();
      expect(result.ok).toBe(true);
      expect(deps.kickService.getCurrentStreamSnapshot).toHaveBeenCalledWith('mustafa_go');
      expect(deps.twitchService.getCurrentStreamSnapshot).not.toHaveBeenCalled();
    });
  });
});
