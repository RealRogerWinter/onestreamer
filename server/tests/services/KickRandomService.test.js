const KickRandomService = require('../../services/KickRandomService');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('KickRandomService.findRandomStreamer viewer filter', () => {
  let svc;

  beforeEach(() => {
    svc = new KickRandomService();
    // Stop the second hop (per-channel playback fetch) — only the filter matters here.
    jest.spyOn(svc, 'getPlaybackUrl').mockResolvedValue({
      playback_url: 'https://example.invalid/playlist.m3u8'
    });
  });

  const mkStream = (slug, viewers) => ({
    is_live: true,
    viewer_count: viewers,
    session_title: `${slug} live`,
    categories: [{ name: 'Just Chatting' }],
    channel: { slug, user: { username: slug } }
  });

  // Regression: with the previous helper URL (no sort=desc), Kick returned
  // viewer_count=0 for every stream. The code papered over that by skipping
  // the filter whenever minViewers === 1, so the moment an operator raised
  // minViewers above 1 every Kick pick failed with "No suitable Kick streams
  // found after filtering". Now that the helper hits sort=desc and counts
  // are real, the filter is the obvious `< min || > max` form and we lock
  // its behavior so the workaround can't sneak back.
  it('drops streams below minViewers when minViewers > 1', async () => {
    jest.spyOn(svc, 'getLiveStreams').mockResolvedValue([
      mkStream('big', 1000),
      mkStream('small', 100)
    ]);

    const picked = await svc.findRandomStreamer({ minViewers: 499, maxViewers: 999999 });

    expect(picked).not.toBeNull();
    expect(picked.username).toBe('big');
  });

  it('drops zero-viewer streams when minViewers === 1', async () => {
    jest.spyOn(svc, 'getLiveStreams').mockResolvedValue([
      mkStream('alive', 5),
      mkStream('zero', 0)
    ]);

    const picked = await svc.findRandomStreamer({ minViewers: 1, maxViewers: 999999 });

    expect(picked).not.toBeNull();
    expect(picked.username).toBe('alive');
  });

  it('drops streams above maxViewers', async () => {
    jest.spyOn(svc, 'getLiveStreams').mockResolvedValue([
      mkStream('mega', 50000),
      mkStream('mid', 800)
    ]);

    const picked = await svc.findRandomStreamer({ minViewers: 1, maxViewers: 5000 });

    expect(picked).not.toBeNull();
    expect(picked.username).toBe('mid');
  });

  it('returns null when nothing passes the viewer band', async () => {
    jest.spyOn(svc, 'getLiveStreams').mockResolvedValue([
      mkStream('a', 50),
      mkStream('b', 100)
    ]);

    const picked = await svc.findRandomStreamer({ minViewers: 499, maxViewers: 999999 });

    expect(picked).toBeNull();
  });
});
