/**
 * Tests for the URLStreamHealthService stale-stream watchdog (audit Plan 06 V6).
 *
 * The updateFFmpegProgress creation branch built the health object WITHOUT
 * streamStartTime (the _checkStreamHealth creation branch set it), so
 * `now - (health.streamStartTime || now)` was 0 forever, the startup grace
 * period never ended, and 'stream-stale' never fired for streams whose health
 * entry was seeded by FFmpeg progress. These tests pin streamStartTime on
 * both creation paths and the stale emit past the grace period.
 */

jest.mock('../../bootstrap/logger', () => ({
  child: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const URLStreamHealthService = require('../../services/URLStreamHealthService');

function makeUrlService() {
  return {
    getStreamStatus: jest.fn(() => ({
      urlId: 'url-stream-1',
      sourceUrl: 'https://twitch.tv/somestreamer',
      status: 'streaming',
    })),
    getAllStreams: jest.fn(() => []),
    extractorService: {
      validateStream: jest.fn(async () => ({ isLive: true, title: 'Test stream' })),
    },
  };
}

describe('URLStreamHealthService stale watchdog via updateFFmpegProgress (V6)', () => {
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new URLStreamHealthService(makeUrlService());
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
  });

  test('updateFFmpegProgress creation branch sets streamStartTime', () => {
    service.updateFFmpegProgress('url-stream-1', { frame: 10, fps: 30, bitrate: '4000kbits/s' });

    const health = service.healthData.get('url-stream-1');
    expect(health).toBeDefined();
    expect(health.streamStartTime).toBe(Date.now());
  });

  test('stale detection fires after grace period with no progress', async () => {
    const onStale = jest.fn();
    service.on('stream-stale', onStale);

    // Health entry seeded by FFmpeg progress (the previously-broken path)
    service.updateFFmpegProgress('url-stream-1', { frame: 10 });

    // Past staleThreshold (60s) but inside startupGracePeriod (90s): no emit yet
    jest.advanceTimersByTime(70000);
    await service._checkStreamHealth('url-stream-1');
    expect(onStale).not.toHaveBeenCalled();
    expect(service.healthData.get('url-stream-1').ffmpegStatus).toBe('starting');

    // Past the grace period with still no progress: stale must fire
    jest.advanceTimersByTime(30000); // total 100s since start
    await service._checkStreamHealth('url-stream-1');
    expect(onStale).toHaveBeenCalledWith({ urlId: 'url-stream-1' });
    expect(service.healthData.get('url-stream-1').ffmpegStatus).toBe('stale');
  });

  test('no stale emit while FFmpeg keeps reporting progress', async () => {
    const onStale = jest.fn();
    service.on('stream-stale', onStale);

    service.updateFFmpegProgress('url-stream-1', { frame: 10 });

    jest.advanceTimersByTime(100000);
    service.updateFFmpegProgress('url-stream-1', { frame: 3000 }); // fresh progress
    jest.advanceTimersByTime(30000); // 30s < 60s staleThreshold

    await service._checkStreamHealth('url-stream-1');
    expect(onStale).not.toHaveBeenCalled();
    expect(service.healthData.get('url-stream-1').ffmpegStatus).toBe('active');
  });
});
