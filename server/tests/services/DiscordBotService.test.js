// Unit tests for DiscordBotService — the optional Discord live-announcement bot.
//
// No network: every test injects a fake discord.js Client via `opts.client`, so
// start() skips login() and announce() posts through the fake channel. The
// real discord.js module is never loaded (the lazy require in _buildClient is
// only reached when no client is injected).

const DiscordBotService = require('../../services/DiscordBotService');

// Minimal fake of the discord.js Client surface the service touches:
//   client.on(...)                  — error handler attach
//   client.channels.cache.get(id)   — fast path
//   client.channels.fetch(id)       — fallback
//   channel.send({ embeds })        — the post
//   client.destroy()                — shutdown
function makeFakeClient({ channel, fetchChannel } = {}) {
  const sent = [];
  const realChannel = channel === undefined
    ? { send: jest.fn(async (payload) => { sent.push(payload); return { id: 'msg-1' }; }) }
    : channel;
  const client = {
    _events: {},
    sent,
    destroyed: false,
    on: jest.fn(),
    channels: {
      cache: { get: jest.fn(() => realChannel) },
      fetch: jest.fn(async () => (fetchChannel !== undefined ? fetchChannel : realChannel)),
    },
    destroy: jest.fn(async function () { client.destroyed = true; }),
  };
  return client;
}

const ENABLED_OPTS = { token: 'test-token', channelId: '123', siteUrl: 'https://example.test' };

describe('DiscordBotService — enablement', () => {
  test('is disabled when token is missing', () => {
    const svc = new DiscordBotService({ channelId: '123' });
    expect(svc.isEnabled()).toBe(false);
  });

  test('is disabled when channelId is missing', () => {
    const svc = new DiscordBotService({ token: 'x' });
    expect(svc.isEnabled()).toBe(false);
  });

  test('is enabled when both token and channelId are present', () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    expect(svc.isEnabled()).toBe(true);
  });

  test('disabled service is an inert no-op: announce returns null, never sends', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ channelId: '123', client }); // no token
    const result = await svc.announceStreamLive({ displayName: 'alice', userId: 1 });
    expect(result).toBeNull();
    expect(client.channels.cache.get).not.toHaveBeenCalled();
  });

  test('disabled service start() resolves without building/logging a client', async () => {
    const svc = new DiscordBotService({});
    await expect(svc.start()).resolves.toBeUndefined();
    expect(svc.ready).toBe(false);
  });
});

describe('DiscordBotService — start()', () => {
  test('with an injected client, start() marks ready and does NOT call login', async () => {
    const client = makeFakeClient();
    client.login = jest.fn();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();
    expect(svc.ready).toBe(true);
    expect(client.login).not.toHaveBeenCalled();
    expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  test('start() is idempotent — setup runs only once across repeated calls', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await Promise.all([svc.start(), svc.start(), svc.start()]);
    // The error-handler attach happens once per setup run; one attach proves
    // the body executed a single time despite three start() calls.
    expect(client.on).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordBotService — announceStreamLive()', () => {
  test('posts an embed to the channel and returns true', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();

    const result = await svc.announceStreamLive({ displayName: 'alice', userId: 7 });

    expect(result).toBe(true);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toHaveProperty('embeds');
    expect(client.sent[0].embeds[0].title).toContain('alice');
  });

  test('ensures startup on first use even if start() was not called explicitly', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    // No explicit start() — announce should self-start.
    const result = await svc.announceStreamLive({ displayName: 'bob', userId: 9 });
    expect(result).toBe(true);
    expect(svc.ready).toBe(true);
  });

  test('falls back to channels.fetch when the cache misses', async () => {
    const fetched = { send: jest.fn(async () => ({ id: 'm' })) };
    const client = makeFakeClient({ channel: null, fetchChannel: fetched });
    client.channels.cache.get = jest.fn(() => undefined); // cache miss
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();

    const result = await svc.announceStreamLive({ displayName: 'cara', userId: 3 });
    expect(result).toBe(true);
    expect(client.channels.fetch).toHaveBeenCalledWith('123');
    expect(fetched.send).toHaveBeenCalledTimes(1);
  });

  test('returns null (no throw) when the channel cannot be resolved', async () => {
    const client = makeFakeClient({ channel: null, fetchChannel: null });
    client.channels.cache.get = jest.fn(() => undefined);
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();

    await expect(svc.announceStreamLive({ displayName: 'x', userId: 1 })).resolves.toBeNull();
  });

  test('swallows channel.send failures (returns null, does not throw)', async () => {
    const channel = { send: jest.fn(async () => { throw new Error('discord 500'); }) };
    const client = makeFakeClient({ channel });
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();

    await expect(svc.announceStreamLive({ displayName: 'x', userId: 1 })).resolves.toBeNull();
  });

  test('a failed send does NOT record a dedupe stamp, so the next announce still fires', async () => {
    let calls = 0;
    const channel = {
      send: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return { id: 'm' };
      }),
    };
    const client = makeFakeClient({ channel });
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();

    expect(await svc.announceStreamLive({ displayName: 'x', userId: 1 })).toBeNull();
    expect(await svc.announceStreamLive({ displayName: 'x', userId: 1 })).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });
});

describe('DiscordBotService — dedupe / cooldown', () => {
  test('suppresses a repeat announce for the same userId within the cooldown', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client, cooldownMs: 60_000 });
    await svc.start();

    expect(await svc.announceStreamLive({ displayName: 'alice', userId: 5 })).toBe(true);
    expect(await svc.announceStreamLive({ displayName: 'alice', userId: 5 })).toBeNull();
    expect(client.sent).toHaveLength(1);
  });

  test('different streamers are announced independently', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client, cooldownMs: 60_000 });
    await svc.start();

    expect(await svc.announceStreamLive({ displayName: 'alice', userId: 5 })).toBe(true);
    expect(await svc.announceStreamLive({ displayName: 'bob', userId: 6 })).toBe(true);
    expect(client.sent).toHaveLength(2);
  });

  test('anonymous streamers dedupe by display name', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client, cooldownMs: 60_000 });
    await svc.start();

    expect(await svc.announceStreamLive({ displayName: 'Guest-42', userId: null })).toBe(true);
    expect(await svc.announceStreamLive({ displayName: 'guest-42', userId: null })).toBeNull(); // case-insensitive
    expect(client.sent).toHaveLength(1);
  });

  test('re-announces once the cooldown has elapsed', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client, cooldownMs: 0 });
    await svc.start();

    expect(await svc.announceStreamLive({ displayName: 'alice', userId: 5 })).toBe(true);
    expect(await svc.announceStreamLive({ displayName: 'alice', userId: 5 })).toBe(true);
    expect(client.sent).toHaveLength(2);
  });
});

describe('DiscordBotService — buildEmbed()', () => {
  test('fresh stream uses the "is now LIVE" verb and links to the site', () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    const embed = svc.buildEmbed({ displayName: 'alice', userId: 1, isTakeover: false });

    expect(embed.title).toBe('🔴 alice is now LIVE!');
    expect(embed.url).toBe('https://example.test');
    expect(embed.color).toBe(0xED4245);
    expect(embed.fields.find((f) => f.value.includes('example.test'))).toBeDefined();
  });

  test('takeover uses the "took over" verb', () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    const embed = svc.buildEmbed({ displayName: 'alice', isTakeover: true });
    expect(embed.title).toContain('took over');
  });

  test('registered vs guest is reflected in a field', () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    const reg = svc.buildEmbed({ displayName: 'alice', userId: 1 });
    const guest = svc.buildEmbed({ displayName: 'Guest-1', userId: null });
    expect(JSON.stringify(reg.fields)).toContain('Registered');
    expect(JSON.stringify(guest.fields)).toContain('Guest');
  });

  test('includes a stream-title field only when a title is supplied', () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    const withTitle = svc.buildEmbed({ displayName: 'alice', title: 'speedrun night' });
    const without = svc.buildEmbed({ displayName: 'alice' });
    expect(JSON.stringify(withTitle.fields)).toContain('speedrun night');
    expect(withTitle.fields.length).toBe(without.fields.length + 1);
  });

  test('falls back to a generic name when displayName is absent', () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    expect(svc.buildEmbed({}).title).toContain('A streamer');
  });
});

describe('DiscordBotService — stop()', () => {
  test('destroys the underlying client and clears ready', async () => {
    const client = makeFakeClient();
    const svc = new DiscordBotService({ ...ENABLED_OPTS, client });
    await svc.start();
    await svc.stop();
    expect(client.destroy).toHaveBeenCalled();
    expect(svc.ready).toBe(false);
  });

  test('stop() is safe to call when never started', async () => {
    const svc = new DiscordBotService(ENABLED_OPTS);
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});
