/**
 * Tests for StreamReconnector.refreshKickTokenAndRestart (audit Plan 06 V2).
 *
 * The Kick 403 token-refresh restart used to write
 * `streamEntry.streamInfo = { mode, url }`, but the restart pipeline
 * (_startLiveKitStream) reads `streamInfo.pipeMode` / `streamInfo.streamUrl`
 * — so every refresh attempt restarted FFmpeg with an undefined input URL
 * and the whole Kick token-recovery feature was dead. These tests pin the
 * writer to the reader's field contract.
 */

const StreamReconnector = require('../../services/urlstream/StreamReconnector');

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function makeOwner({ playbackUrl = 'https://kick.example/fresh.m3u8' } = {}) {
  const owner = {
    activeStreams: new Map(),
    kickService: {
      getPlaybackUrl: jest.fn(async () => ({ playback_url: playbackUrl })),
    },
    livekitService: {},
    _stopProcesses: jest.fn(async () => {}),
    _teardownIngress: jest.fn(async () => {}),
    _startPipeline: jest.fn(async () => {}),
    _registerAsCurrentStreamer: jest.fn(),
  };
  return owner;
}

function makeStreamEntry() {
  return {
    sourceUrl: 'https://kick.example/stale.m3u8',
    kickUsername: 'somekickuser',
    platform: 'kick',
    tokenRefreshAttempts: 0,
    maxTokenRefreshAttempts: 3,
    status: 'streaming',
    processes: [],
    ingressInfo: { ingressId: 'IN_old' },
    streamInfo: {
      success: true,
      streamUrl: 'https://kick.example/stale.m3u8',
      platform: 'kick',
      tool: 'direct',
      quality: 'best',
      pipeMode: false,
      isHLS: true,
    },
  };
}

describe('StreamReconnector.refreshKickTokenAndRestart (V2)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function runRefresh(owner, entry) {
    owner.activeStreams.set('url-stream-1', entry);
    const reconnector = new StreamReconnector(owner, silentLogger);
    const promise = reconnector.refreshKickTokenAndRestart('url-stream-1', entry);
    await jest.runAllTimersAsync();
    return promise;
  }

  test('writes streamInfo with the pipeMode/streamUrl field names the restart pipeline reads', async () => {
    const owner = makeOwner({ playbackUrl: 'https://kick.example/fresh.m3u8' });
    const entry = makeStreamEntry();

    const result = await runRefresh(owner, entry);

    expect(result).toBe(true);
    // The reader contract (_startLiveKitStream): pipeMode picks the branch,
    // streamUrl is the FFmpeg input in direct mode.
    expect(entry.streamInfo.pipeMode).toBe(false);
    expect(entry.streamInfo.streamUrl).toBe('https://kick.example/fresh.m3u8');
    expect(entry.streamInfo.isHLS).toBe(true);
    // Platform metadata from the original streamInfo is preserved.
    expect(entry.streamInfo.platform).toBe('kick');
    // The dead legacy field names must not come back.
    expect(entry.streamInfo.mode).toBeUndefined();
    expect(entry.streamInfo.url).toBeUndefined();

    expect(entry.sourceUrl).toBe('https://kick.example/fresh.m3u8');
    expect(owner._startPipeline).toHaveBeenCalledWith('url-stream-1', entry);
    expect(owner._registerAsCurrentStreamer).toHaveBeenCalled();
    expect(entry.status).toBe('streaming');
  });

  test('restart failure returns false (falls through to stream end) without re-registering', async () => {
    const owner = makeOwner();
    owner._startPipeline.mockRejectedValue(new Error('ffmpeg died'));
    const entry = makeStreamEntry();

    const result = await runRefresh(owner, entry);

    expect(result).toBe(false);
    expect(owner._registerAsCurrentStreamer).not.toHaveBeenCalled();
  });

  test('missing fresh playback URL returns false without touching processes', async () => {
    const owner = makeOwner();
    owner.kickService.getPlaybackUrl.mockResolvedValue(null);
    const entry = makeStreamEntry();

    const result = await runRefresh(owner, entry);

    expect(result).toBe(false);
    expect(owner._stopProcesses).not.toHaveBeenCalled();
    expect(owner._startPipeline).not.toHaveBeenCalled();
  });

  test('aborts when the stream was removed during the refresh delay', async () => {
    const owner = makeOwner();
    const entry = makeStreamEntry();
    // Simulate the stream being stopped while the 500ms settle delay runs.
    owner._stopProcesses.mockImplementation(async () => {
      owner.activeStreams.delete('url-stream-1');
    });

    const result = await runRefresh(owner, entry);

    expect(result).toBe(false);
    expect(owner._startPipeline).not.toHaveBeenCalled();
  });
});
