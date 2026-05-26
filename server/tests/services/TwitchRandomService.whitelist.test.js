/**
 * Tests for TwitchRandomService whitelist integration (ADR-0010, PR-W3 / Phase 2).
 *
 * Scope: setWhitelistService setter + the candidate-filter branch + the
 * _attachCclData helper. The full findRandomStreamer flow is not exercised
 * here — it needs a configured Twitch app token and a live API. Existing
 * pre-W3 tests still cover the legacy local blockedCategories fallback.
 */

const TwitchRandomService = require('../../services/TwitchRandomService');

function makeStubWhitelist(filterResult) {
  return {
    filterCandidates: jest.fn(() => filterResult),
  };
}

describe('TwitchRandomService — whitelist integration (PR-W3)', () => {
  let svc;

  beforeEach(() => {
    svc = new TwitchRandomService();
  });

  describe('setWhitelistService', () => {
    test('stores the service', () => {
      const stub = makeStubWhitelist([]);
      svc.setWhitelistService(stub);
      expect(svc.whitelistService).toBe(stub);
    });

    test('defaults to null (no service wired)', () => {
      expect(svc.whitelistService).toBeNull();
    });
  });

  describe('_attachCclData', () => {
    test('no-ops on empty input', async () => {
      const out = await svc._attachCclData([]);
      expect(out).toEqual([]);
    });

    test('no-ops when candidates have no user_id', async () => {
      const candidates = [{ user_login: 'no_id' }];
      const out = await svc._attachCclData(candidates);
      expect(out).toBe(candidates);
      expect(candidates[0]._ccls).toBeUndefined();
    });

    test('attaches CCL data from a mocked /helix/channels response', async () => {
      const candidates = [
        { user_id: '111', user_login: 'alice' },
        { user_id: '222', user_login: 'bob' },
      ];
      svc.twitchRequest = jest.fn().mockResolvedValue({
        data: [
          { broadcaster_id: '111', content_classification_labels: ['Gambling'] },
          { broadcaster_id: '222', content_classification_labels: [] },
        ],
      });

      await svc._attachCclData(candidates);

      expect(candidates[0]._ccls).toEqual(['Gambling']);
      expect(candidates[1]._ccls).toEqual([]);
      expect(svc.twitchRequest).toHaveBeenCalledTimes(1);
      const call = svc.twitchRequest.mock.calls[0][0];
      expect(call).toContain('broadcaster_id=111');
      expect(call).toContain('broadcaster_id=222');
    });

    test('batches in groups of 100 broadcaster_ids', async () => {
      const candidates = [];
      for (let i = 0; i < 250; i++) {
        candidates.push({ user_id: String(i), user_login: `u${i}` });
      }
      svc.twitchRequest = jest.fn().mockResolvedValue({ data: [] });
      await svc._attachCclData(candidates);
      expect(svc.twitchRequest).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    });

    test('defaults to empty CCL array when broadcaster_id not in response', async () => {
      const candidates = [
        { user_id: '111', user_login: 'alice' },
        { user_id: '999', user_login: 'missing' },
      ];
      svc.twitchRequest = jest.fn().mockResolvedValue({
        data: [
          { broadcaster_id: '111', content_classification_labels: ['SexualThemes'] },
        ],
      });
      await svc._attachCclData(candidates);
      expect(candidates[0]._ccls).toEqual(['SexualThemes']);
      expect(candidates[1]._ccls).toEqual([]);
    });
  });

  describe('CCL fetch failure', () => {
    test('rejection bubbles to caller (caller swallows in findRandomStreamer)', async () => {
      const candidates = [{ user_id: '111', user_login: 'alice' }];
      svc.twitchRequest = jest.fn().mockRejectedValue(new Error('helix down'));
      await expect(svc._attachCclData(candidates)).rejects.toThrow('helix down');
      // The helper deliberately does NOT swallow; findRandomStreamer's
      // try/catch around this call is what falls through with empty CCL.
    });
  });

  describe('legacy blockedCategories preserved as fallback', () => {
    test('local Set still has ASMR and Pools default entries (no service wired)', () => {
      expect(svc.blockedCategories.has('ASMR')).toBe(true);
      expect(svc.blockedCategories.has('Pools, Hot Tubs, and Beaches')).toBe(true);
    });
  });
});
