const { assertSafeUrl, isPrivateOrReservedIp } = require('../../utils/ssrfGuard');

describe('isPrivateOrReservedIp', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', 'fd12::3',
  ])('treats %s as private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  test.each(['1.2.3.4', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700::1'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  );
});

describe('assertSafeUrl', () => {
  const publicLookup = async () => [{ address: '1.2.3.4', family: 4 }];
  const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];

  test('allows a public hostname', async () => {
    await expect(assertSafeUrl('https://twitch.tv/foo', { lookup: publicLookup })).resolves.toBeUndefined();
  });

  test('allows a public IP literal (no DNS needed)', async () => {
    await expect(assertSafeUrl('http://1.2.3.4/x')).resolves.toBeUndefined();
  });

  test.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
  ])('blocks private IP literal %s', async (u) => {
    await expect(assertSafeUrl(u)).rejects.toThrow(/private or reserved/);
  });

  test('blocks localhost', async () => {
    await expect(assertSafeUrl('http://localhost:8443/')).rejects.toThrow(/localhost/);
  });

  test('blocks a non-http scheme', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/scheme/);
  });

  test('blocks a hostname that DNS-rebinds to a private address', async () => {
    await expect(assertSafeUrl('http://evil.example/', { lookup: privateLookup })).rejects.toThrow(/resolves to a private/);
  });

  test('blocks a hostname that does not resolve', async () => {
    await expect(
      assertSafeUrl('http://nope.invalid/', { lookup: async () => { throw new Error('ENOTFOUND'); } })
    ).rejects.toThrow(/did not resolve/);
  });
});
