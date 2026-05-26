/**
 * Tests for RandomStreamRotationService whitelist fan-out (PR-W3 / Phase 2).
 *
 * Scope: setWhitelistService delegates to both inner services. The rotation
 * loop itself is covered by other test files; this verifies the wire-up.
 */

const RandomStreamRotationService = require('../../services/RandomStreamRotationService');

describe('RandomStreamRotationService — whitelist fan-out (PR-W3)', () => {
  test('setWhitelistService delegates to both Twitch and Kick services', () => {
    const svc = new RandomStreamRotationService();
    const stubWhitelist = { filterCandidates: jest.fn() };

    svc.twitchService.setWhitelistService = jest.fn();
    svc.kickService.setWhitelistService = jest.fn();

    svc.setWhitelistService(stubWhitelist);

    expect(svc.whitelistService).toBe(stubWhitelist);
    expect(svc.twitchService.setWhitelistService).toHaveBeenCalledWith(stubWhitelist);
    expect(svc.kickService.setWhitelistService).toHaveBeenCalledWith(stubWhitelist);
  });

  test('does not throw when inner services lack the setter (defensive)', () => {
    const svc = new RandomStreamRotationService();
    delete svc.twitchService.setWhitelistService;
    delete svc.kickService.setWhitelistService;
    expect(() => svc.setWhitelistService({})).not.toThrow();
  });
});
