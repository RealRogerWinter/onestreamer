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

  describe('language field plumbing', () => {
    test('findRandomStreamer passes stream.language through to filterCandidates', async () => {
      // Stub the Python helper bridge and the post-pick playback-URL fetch.
      svc.getLiveStreams = jest.fn().mockResolvedValue([
        {
          is_live: true,
          viewer_count: 100,
          channel: { slug: 'alice' },
          categories: [{ name: 'Minecraft' }],
          session_title: 'EN stream',
          language: 'en',
        },
        {
          is_live: true,
          viewer_count: 200,
          channel: { slug: 'bob' },
          categories: [{ name: 'Minecraft' }],
          session_title: 'PT stream',
          language: 'pt',
        },
      ]);
      svc.getPlaybackUrl = jest.fn().mockResolvedValue({
        playback_url: 'https://example.com/x.m3u8',
      });

      const filterCandidates = jest.fn((_, shaped) => shaped);
      svc.setWhitelistService({ filterCandidates });

      await svc.findRandomStreamer();

      expect(filterCandidates).toHaveBeenCalledTimes(1);
      const [platform, shaped] = filterCandidates.mock.calls[0];
      expect(platform).toBe('kick');
      const langs = shaped.map((s) => s.language).sort();
      expect(langs).toEqual(['en', 'pt']);
    });

    test('shape falls back to channel.language when top-level missing', async () => {
      svc.getLiveStreams = jest.fn().mockResolvedValue([
        {
          is_live: true,
          viewer_count: 100,
          channel: { slug: 'alice', language: 'en' },
          categories: [{ name: 'Minecraft' }],
        },
      ]);
      svc.getPlaybackUrl = jest.fn().mockResolvedValue({
        playback_url: 'https://example.com/x.m3u8',
      });

      const filterCandidates = jest.fn((_, shaped) => shaped);
      svc.setWhitelistService({ filterCandidates });

      await svc.findRandomStreamer();
      const [, shaped] = filterCandidates.mock.calls[0];
      expect(shaped[0].language).toBe('en');
    });

    test('getCurrentStreamSnapshot returns language when present', async () => {
      svc.getChannelInfo = jest.fn().mockResolvedValue({
        slug: 'alice',
        livestream: {
          categories: [{ name: 'Minecraft' }],
          is_mature: false,
          language: 'en',
        },
      });
      const snap = await svc.getCurrentStreamSnapshot('alice');
      expect(snap).toBeTruthy();
      expect(snap.language).toBe('en');
    });

    test('getCurrentStreamSnapshot returns null language when no signal', async () => {
      svc.getChannelInfo = jest.fn().mockResolvedValue({
        slug: 'alice',
        livestream: {
          categories: [{ name: 'Minecraft' }],
          is_mature: false,
        },
      });
      const snap = await svc.getCurrentStreamSnapshot('alice');
      expect(snap).toBeTruthy();
      expect(snap.language).toBeNull();
    });
  });
});
