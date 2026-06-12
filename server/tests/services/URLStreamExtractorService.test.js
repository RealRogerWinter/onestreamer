const URLStreamExtractorService = require('../../services/URLStreamExtractorService');
const { streamlinkQualitySelector } = URLStreamExtractorService;

describe('streamlinkQualitySelector', () => {
  test('expands a resolution into a descending fallback chain ending in worst', () => {
    expect(streamlinkQualitySelector('720p')).toBe(
      '720p60,720p30,720p,480p60,480p30,480p,360p60,360p30,360p,160p60,160p30,160p,worst'
    );
  });

  test('respects the requested height as the ceiling', () => {
    expect(streamlinkQualitySelector('480p')).toMatch(/^480p60,/);
    expect(streamlinkQualitySelector('480p')).not.toMatch(/720|1080/);
  });

  test('non-resolution qualities pass through verbatim', () => {
    expect(streamlinkQualitySelector('best')).toBe('best');
    expect(streamlinkQualitySelector('worst')).toBe('worst');
    expect(streamlinkQualitySelector('audio_only')).toBe('audio_only');
  });
});

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('URLStreamExtractorService.getStreamURL', () => {
  let svc;

  beforeEach(() => {
    svc = new URLStreamExtractorService();
  });

  describe('Twitch', () => {
    // Regression: streamlink's Twitch plugin acquires a client-integrity token
    // by launching a non-headless Chromium (twitch.py hardcodes headless=False).
    // On a headless host with no DISPLAY this fails. We avoid streamlink for
    // Twitch entirely and resolve the m3u8 via yt-dlp instead.
    it('resolves an HLS URL via yt-dlp and skips streamlink pipe mode', async () => {
      const fakeM3u8 = 'https://usw.playlist.ttvnw.net/v1/playlist/FAKE.m3u8';
      const spy = jest.spyOn(svc, '_getYtdlpURL').mockResolvedValue(fakeM3u8);

      const result = await svc.getStreamURL('https://twitch.tv/somechannel', 'best');

      expect(spy).toHaveBeenCalledWith('https://twitch.tv/somechannel', 'best');
      expect(result).toMatchObject({
        success: true,
        streamUrl: fakeM3u8,
        platform: 'twitch',
        tool: 'yt-dlp',
        pipeMode: false,
        isHLS: true
      });
    });

    it('surfaces a clear error when yt-dlp cannot resolve the m3u8', async () => {
      jest.spyOn(svc, '_getYtdlpURL').mockRejectedValue(new Error('channel offline'));

      await expect(
        svc.getStreamURL('https://twitch.tv/somechannel', 'best')
      ).rejects.toThrow(/Failed to resolve Twitch stream URL: channel offline/);
    });
  });

  describe('other live platforms still pipe through streamlink', () => {
    it.each(['youtube', 'kick', 'facebook'])('keeps pipe mode for %s', async (platform) => {
      const urls = {
        youtube: 'https://www.youtube.com/watch?v=abc',
        kick: 'https://kick.com/somechannel',
        facebook: 'https://www.facebook.com/page/videos/123/'
      };

      const result = await svc.getStreamURL(urls[platform], 'best');

      expect(result.pipeMode).toBe(true);
      expect(result.tool).toBe('streamlink');
      expect(result.platform).toBe(platform);
    });
  });

  describe('direct HLS URLs bypass all extractors', () => {
    it('returns the URL unchanged for .m3u8 inputs', async () => {
      const m3u8 = 'https://kick-hls.example.com/live/playlist.m3u8?token=abc';
      const result = await svc.getStreamURL(m3u8, 'best');

      expect(result).toMatchObject({
        success: true,
        streamUrl: m3u8,
        tool: 'direct',
        pipeMode: false,
        isHLS: true
      });
    });
  });
});
