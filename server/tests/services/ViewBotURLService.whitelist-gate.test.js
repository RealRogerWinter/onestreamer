/**
 * Tests for the ViewBotURLService whitelist gate (ADR-0010, PR-W2 / Phase 1).
 *
 * Scope is narrow on purpose: we test `_checkWhitelistGate` and the new
 * `_extractLoginFromUrl` helper in isolation, plus the `setWhitelistService`
 * setter. The full startURLStream flow is not exercised here — it's a 150+
 * line method that orchestrates streamlink, FFmpeg, MediaSoup/LiveKit, etc.,
 * and mocking all of that for one gate check is heavier than the gate is
 * worth. A live smoke test on the running host covers the integration.
 */

const ViewBotURLService = require('../../services/ViewBotURLService');

function makeStubWhitelist(result) {
  return {
    checkAllowed: jest.fn(() => result),
  };
}

describe('ViewBotURLService — whitelist gate (PR-W2)', () => {
  let svc;

  beforeEach(() => {
    svc = new ViewBotURLService();
  });

  describe('setWhitelistService', () => {
    test('stores the service and logs', () => {
      const stub = makeStubWhitelist({ allowed: true });
      svc.setWhitelistService(stub);
      expect(svc.whitelistService).toBe(stub);
    });
  });

  describe('_extractLoginFromUrl', () => {
    test('extracts and lowercases a Twitch login', () => {
      const out = svc._extractLoginFromUrl('https://www.twitch.tv/CohhCarnage', 'twitch');
      expect(out).toBe('cohhcarnage');
    });

    test('extracts and lowercases a Kick slug', () => {
      const out = svc._extractLoginFromUrl('https://kick.com/Mustafa_Go', 'kick');
      expect(out).toBe('mustafa_go');
    });

    test('returns null when URL platform does not match expected platform', () => {
      const out = svc._extractLoginFromUrl('https://www.twitch.tv/anyone', 'kick');
      expect(out).toBeNull();
    });

    test('returns null for unparseable URL', () => {
      const out = svc._extractLoginFromUrl('not a url', 'twitch');
      expect(out).toBeNull();
    });

    test('returns null for empty input', () => {
      expect(svc._extractLoginFromUrl('', 'twitch')).toBeNull();
      expect(svc._extractLoginFromUrl('https://twitch.tv/x', null)).toBeNull();
    });
  });

  describe('_checkWhitelistGate', () => {
    test('passes through when no whitelistService is wired (Phase 0 default)', () => {
      const result = svc._checkWhitelistGate('https://twitch.tv/anyone', {
        platform: 'twitch',
        title: 'Live',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('service_unset');
    });

    test('passes through for non-gated platforms (YouTube, Facebook, etc.)', () => {
      svc.setWhitelistService(makeStubWhitelist({ allowed: false, reason: 'should_not_be_called' }));
      const result = svc._checkWhitelistGate('https://www.youtube.com/watch?v=abc', {
        platform: 'youtube',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('platform_not_gated');
      expect(svc.whitelistService.checkAllowed).not.toHaveBeenCalled();
    });

    test('delegates to whitelistService for Twitch with full snapshot shape', () => {
      const stub = makeStubWhitelist({ allowed: true, reason: 'streamer_allowed' });
      svc.setWhitelistService(stub);
      const result = svc._checkWhitelistGate('https://twitch.tv/COhhCarnage', {
        platform: 'twitch',
      });
      expect(result.allowed).toBe(true);
      // Exact shape — every field passed explicitly as null. If a future
      // refactor drops one, WhitelistService.checkAllowed will silently
      // destructure undefined, and the missing pin here will flag the
      // contract drift.
      expect(stub.checkAllowed).toHaveBeenCalledWith({
        platform: 'twitch',
        login: 'cohhcarnage',
        currentGameName: null,
        isMature: null,
        ccls: null,
        hasMatureContent: null,
      });
    });

    test('delegates to whitelistService for Kick', () => {
      const stub = makeStubWhitelist({ allowed: false, reason: 'not_on_whitelist', gateThatBlocked: 'whitelist_miss' });
      svc.setWhitelistService(stub);
      const result = svc._checkWhitelistGate('https://kick.com/unknown_kick_streamer', {
        platform: 'kick',
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('whitelist_miss');
      expect(stub.checkAllowed).toHaveBeenCalledWith(expect.objectContaining({
        platform: 'kick',
        login: 'unknown_kick_streamer',
      }));
    });

    test('handles missing validation gracefully', () => {
      svc.setWhitelistService(makeStubWhitelist({ allowed: false }));
      const result = svc._checkWhitelistGate('https://twitch.tv/x', null);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('platform_not_gated');
    });

    test('handles URL with unrecognized platform tag', () => {
      svc.setWhitelistService(makeStubWhitelist({ allowed: false }));
      const result = svc._checkWhitelistGate('https://twitch.tv/x', {
        platform: 'mixer',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('platform_not_gated');
    });
  });
});
