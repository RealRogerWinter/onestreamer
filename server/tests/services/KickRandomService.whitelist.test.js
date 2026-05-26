/**
 * Tests for KickRandomService whitelist integration (ADR-0010, PR-W3 / Phase 2).
 *
 * Scope: setWhitelistService setter + the candidate-filter branch shape.
 * The full findRandomStreamer end-to-end runs a Python subprocess and is
 * covered by the existing KickRandomService.test.js for the legacy path.
 */

const KickRandomService = require('../../services/KickRandomService');

describe('KickRandomService — whitelist integration (PR-W3)', () => {
  let svc;

  beforeEach(() => {
    svc = new KickRandomService();
  });

  describe('setWhitelistService', () => {
    test('stores the service', () => {
      const stub = { filterCandidates: jest.fn() };
      svc.setWhitelistService(stub);
      expect(svc.whitelistService).toBe(stub);
    });

    test('defaults to null', () => {
      expect(svc.whitelistService).toBeNull();
    });
  });

  describe('legacy blockedCategories preserved as fallback', () => {
    test('local Set still has ASMR and Pools default entries', () => {
      expect(svc.blockedCategories.has('ASMR')).toBe(true);
      expect(svc.blockedCategories.has('Pools, Hot Tubs, and Beaches')).toBe(true);
    });
  });
});
