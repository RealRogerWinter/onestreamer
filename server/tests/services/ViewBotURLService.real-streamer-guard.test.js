/**
 * Tests for the V3 real-streamer standdown guards (audit Plan 06 V3).
 *
 * The URL-relay real-streamer gate used to be check-once at startURLStream
 * entry; every restart path (reconnect, Kick token refresh, ready-poll
 * broadcast) re-registered unconditionally, so a takeover landing mid-flight
 * was silently overwritten and the relay botted over the human. These tests
 * pin the write-time re-check in _registerAsCurrentStreamer, the shared
 * _supersededByRealStreamer classifier, and the standdown behavior of the
 * reconnect / Kick-refresh / viewer-broadcast paths.
 */

const ViewBotURLService = require('../../services/ViewBotURLService');
const StreamReconnector = require('../../services/urlstream/StreamReconnector');
const ViewerNotifier = require('../../services/urlstream/ViewerNotifier');

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function makeStreamService({ current = null, takeover = false } = {}) {
  return {
    takeoverInProgress: takeover,
    getCurrentStreamer: jest.fn(() => current),
    setStreamer: jest.fn(),
    clearStreamer: jest.fn(),
  };
}

describe('ViewBotURLService._supersededByRealStreamer (V3)', () => {
  let svc;

  beforeEach(() => {
    svc = new ViewBotURLService();
  });

  test('null when no streamService is wired', () => {
    expect(svc._supersededByRealStreamer('url-stream-1')).toBeNull();
  });

  test('null when nobody is streaming', () => {
    svc.setStreamService(makeStreamService({ current: null }));
    expect(svc._supersededByRealStreamer('url-stream-1')).toBeNull();
  });

  test('null when the current streamer is this stream itself', () => {
    svc.setStreamService(makeStreamService({ current: 'url-stream-1' }));
    expect(svc._supersededByRealStreamer('url-stream-1')).toBeNull();
  });

  test.each(['viewbot-77', 'bot-42', 'url-stream-999'])(
    'null when the current streamer is bot-like (%s)',
    (current) => {
      svc.setStreamService(makeStreamService({ current }));
      expect(svc._supersededByRealStreamer('url-stream-1')).toBeNull();
    }
  );

  test('reason when a real human socket is the current streamer', () => {
    svc.setStreamService(makeStreamService({ current: 'AbCdEf123socket' }));
    expect(svc._supersededByRealStreamer('url-stream-1')).toMatch(/real streamer/);
  });

  test('reason when a takeover critical section is running (ADR-0033)', () => {
    svc.setStreamService(makeStreamService({ current: null, takeover: true }));
    expect(svc._supersededByRealStreamer('url-stream-1')).toBe('takeover in progress');
  });
});

describe('ViewBotURLService._registerAsCurrentStreamer (V3 write-time re-check)', () => {
  let svc;

  beforeEach(() => {
    svc = new ViewBotURLService();
    delete global.webrtcService;
  });

  afterEach(() => {
    delete global.webrtcService;
  });

  test('registers and returns true when unchallenged', () => {
    const streamService = makeStreamService({ current: null });
    svc.setStreamService(streamService);
    global.webrtcService = { currentStreamer: null };

    const ok = svc._registerAsCurrentStreamer('url-stream-1');

    expect(ok).toBe(true);
    expect(streamService.setStreamer).toHaveBeenCalledWith('url-stream-1');
    expect(global.webrtcService.currentStreamer).toBe('url-stream-1');
  });

  test('refuses (returns false, writes nothing) when a human is streaming', () => {
    const streamService = makeStreamService({ current: 'humanSocketId1' });
    svc.setStreamService(streamService);
    global.webrtcService = { currentStreamer: 'humanSocketId1' };

    const ok = svc._registerAsCurrentStreamer('url-stream-1');

    expect(ok).toBe(false);
    expect(streamService.setStreamer).not.toHaveBeenCalled();
    expect(global.webrtcService.currentStreamer).toBe('humanSocketId1');
  });

  test('refuses while a takeover is in progress', () => {
    const streamService = makeStreamService({ current: null, takeover: true });
    svc.setStreamService(streamService);

    expect(svc._registerAsCurrentStreamer('url-stream-1')).toBe(false);
    expect(streamService.setStreamer).not.toHaveBeenCalled();
  });

  test('re-registration of the current url stream itself still works', () => {
    const streamService = makeStreamService({ current: 'url-stream-1' });
    svc.setStreamService(streamService);

    expect(svc._registerAsCurrentStreamer('url-stream-1')).toBe(true);
    expect(streamService.setStreamer).toHaveBeenCalledWith('url-stream-1');
  });
});

describe('StreamReconnector standdown paths (V3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeOwner({ superseded = null } = {}) {
    return {
      activeStreams: new Map(),
      _reconnecting: false,
      _startingStream: false,
      io: { emit: jest.fn() },
      kickService: {
        getPlaybackUrl: jest.fn(async () => ({ playback_url: 'https://kick.example/fresh.m3u8' })),
      },
      livekitService: {},
      streamService: null,
      streamNotifier: null,
      _supersededByRealStreamer: jest.fn(() => superseded),
      _stopProcesses: jest.fn(async () => {}),
      _teardownIngress: jest.fn(async () => {}),
      _startPipeline: jest.fn(async () => {}),
      _registerAsCurrentStreamer: jest.fn(() => true),
      _resumeViewBots: jest.fn(async () => {}),
      emit: jest.fn(),
    };
  }

  function makeEntry(overrides = {}) {
    return {
      sourceUrl: 'https://example.com/live',
      platform: 'twitch',
      kickUsername: null,
      status: 'streaming',
      processes: [],
      autoReconnect: true,
      reconnectAttempts: 0,
      maxReconnectAttempts: 3,
      tokenRefreshAttempts: 0,
      maxTokenRefreshAttempts: 5,
      ingressInfo: null,
      streamInfo: { pipeMode: false, streamUrl: 'https://example.com/live.m3u8' },
      ...overrides,
    };
  }

  test('reconnect stands down (ends stream, no restart) when superseded during backoff', async () => {
    const owner = makeOwner({ superseded: 'real streamer humanSocket is active' });
    const entry = makeEntry();
    owner.activeStreams.set('url-stream-1', entry);
    const rec = new StreamReconnector(owner, silentLogger);
    const endSpy = jest.spyOn(rec, 'handleStreamEnd');

    const p = rec.handleStreamError('url-stream-1', 'ffmpeg', new Error('boom'));
    await jest.runAllTimersAsync();
    await p;

    expect(owner._startPipeline).not.toHaveBeenCalled();
    expect(endSpy).toHaveBeenCalledWith('url-stream-1', 'superseded_by_real_streamer');
  });

  test('reconnect tears back down when re-registration is refused after restart', async () => {
    const owner = makeOwner({ superseded: null });
    owner._registerAsCurrentStreamer.mockReturnValue(false);
    const entry = makeEntry();
    owner.activeStreams.set('url-stream-1', entry);
    const rec = new StreamReconnector(owner, silentLogger);
    const endSpy = jest.spyOn(rec, 'handleStreamEnd');

    const p = rec.handleStreamError('url-stream-1', 'ffmpeg', new Error('boom'));
    await jest.runAllTimersAsync();
    await p;

    expect(owner._startPipeline).toHaveBeenCalled();
    expect(endSpy).toHaveBeenCalledWith('url-stream-1', 'superseded_by_real_streamer');
    expect(owner.io.emit).not.toHaveBeenCalledWith('stream-reconnected', expect.anything());
  });

  test('reconnect proceeds normally when not superseded', async () => {
    const owner = makeOwner({ superseded: null });
    const entry = makeEntry();
    owner.activeStreams.set('url-stream-1', entry);
    const rec = new StreamReconnector(owner, silentLogger);

    const p = rec.handleStreamError('url-stream-1', 'ffmpeg', new Error('boom'));
    await jest.runAllTimersAsync();
    await p;

    expect(owner._startPipeline).toHaveBeenCalled();
    expect(owner.io.emit).toHaveBeenCalledWith('stream-reconnected', expect.objectContaining({
      streamerId: 'url-stream-1',
    }));
  });

  test('Kick refresh refuses at entry when superseded', async () => {
    const owner = makeOwner({ superseded: 'takeover in progress' });
    const entry = makeEntry({ platform: 'kick', kickUsername: 'someuser' });
    owner.activeStreams.set('url-stream-1', entry);
    const rec = new StreamReconnector(owner, silentLogger);

    const result = await rec.refreshKickTokenAndRestart('url-stream-1', entry);

    expect(result).toBe(false);
    expect(owner.kickService.getPlaybackUrl).not.toHaveBeenCalled();
    expect(owner._stopProcesses).not.toHaveBeenCalled();
    expect(entry.tokenRefreshAttempts).toBe(0);
  });

  test('Kick refresh returns false when re-registration is refused post-restart', async () => {
    const owner = makeOwner({ superseded: null });
    owner._registerAsCurrentStreamer.mockReturnValue(false);
    const entry = makeEntry({ platform: 'kick', kickUsername: 'someuser' });
    owner.activeStreams.set('url-stream-1', entry);
    const rec = new StreamReconnector(owner, silentLogger);

    const p = rec.refreshKickTokenAndRestart('url-stream-1', entry);
    await jest.runAllTimersAsync();
    const result = await p;

    expect(owner._startPipeline).toHaveBeenCalled();
    expect(result).toBe(false);
  });
});

describe('ViewerNotifier.broadcastNewStreamer (V3)', () => {
  function makeOwner() {
    return {
      io: { emit: jest.fn() },
      activeStreams: new Map(),
      _registerAsCurrentStreamer: jest.fn(() => true),
    };
  }

  const validation = { platform: 'twitch', title: 'Some Stream' };

  test('skips entirely when the stream is no longer active (stopped mid-poll)', () => {
    const owner = makeOwner();
    const notifier = new ViewerNotifier(owner, silentLogger);

    notifier.broadcastNewStreamer('url-stream-1', { displayName: 'X' }, validation);

    expect(owner._registerAsCurrentStreamer).not.toHaveBeenCalled();
    expect(owner.io.emit).not.toHaveBeenCalled();
  });

  test('skips the viewer broadcast when registration is refused', () => {
    const owner = makeOwner();
    owner.activeStreams.set('url-stream-1', {});
    owner._registerAsCurrentStreamer.mockReturnValue(false);
    const notifier = new ViewerNotifier(owner, silentLogger);

    notifier.broadcastNewStreamer('url-stream-1', { displayName: 'X' }, validation);

    expect(owner.io.emit).not.toHaveBeenCalled();
  });

  test('broadcasts when registered', () => {
    const owner = makeOwner();
    owner.activeStreams.set('url-stream-1', {});
    const notifier = new ViewerNotifier(owner, silentLogger);

    notifier.broadcastNewStreamer('url-stream-1', { displayName: 'X' }, validation);

    expect(owner.io.emit).toHaveBeenCalledWith('new-streamer', expect.anything());
    expect(owner.io.emit).toHaveBeenCalledWith('stream-started', expect.objectContaining({
      streamerId: 'url-stream-1',
    }));
  });
});
