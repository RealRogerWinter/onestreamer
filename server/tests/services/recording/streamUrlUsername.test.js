const { usernameFromStreamUrl } = require('../../../services/recording/streamUrlUsername');

describe('usernameFromStreamUrl', () => {
  test('null/empty input returns null', () => {
    expect(usernameFromStreamUrl(null)).toBeNull();
    expect(usernameFromStreamUrl('')).toBeNull();
  });

  test('twitch URLs (with/without www, scheme)', () => {
    expect(usernameFromStreamUrl('https://twitch.tv/cohh')).toBe('cohh');
    expect(usernameFromStreamUrl('https://www.twitch.tv/Cohh_Carnage')).toBe('Cohh_Carnage');
    expect(usernameFromStreamUrl('twitch.tv/someone')).toBe('someone');
  });

  test('kick URLs (allow hyphens)', () => {
    expect(usernameFromStreamUrl('https://kick.com/xqc')).toBe('xqc');
    expect(usernameFromStreamUrl('https://www.kick.com/some-streamer')).toBe('some-streamer');
  });

  test('youtube @handle', () => {
    expect(usernameFromStreamUrl('https://youtube.com/@MrBeast')).toBe('MrBeast');
  });

  test('IVS / CDN playback URLs return null', () => {
    expect(usernameFromStreamUrl('https://abc.live-video.net/api/video/v1/x.m3u8')).toBeNull();
    expect(usernameFromStreamUrl('https://playback.something.com/stream.m3u8')).toBeNull();
  });

  test('generic last-path-segment fallback, rejecting file-like segments', () => {
    expect(usernameFromStreamUrl('https://example.com/channels/coolperson')).toBe('coolperson');
    expect(usernameFromStreamUrl('https://example.com/path/stream.m3u8')).toBeNull();
  });

  test('non-URL garbage returns null without throwing', () => {
    expect(usernameFromStreamUrl('not a url at all')).toBeNull();
  });
});
