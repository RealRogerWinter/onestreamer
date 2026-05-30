/**
 * Characterization net for MediasoupService — the core MediaSoup SFU.
 *
 * This service manages mediasoup workers/routers/transports/producers/consumers
 * and the maps of live objects. It has no prior test coverage. This suite PINS
 * the current observable behavior before any conservative decomposition of the
 * SAFE, PURE pieces (codec/RTP-capability config builders, transport-options
 * builders) into server/services/mediasoup/. The RISKY lifecycle core (worker/
 * router/transport/producer/consumer creation + the live-object maps) is NOT
 * decomposed; this net exists so that any pure extraction stays provably green.
 *
 * It is written to pass against the CURRENT service and must remain UNCHANGED
 * across the decomposition commit.
 *
 * Strategy:
 *   - The service requires ../bootstrap/logger at require-time; we jest.mock it.
 *   - The `mediasoup` package is jest.mock'd. `createWorker` returns a fake
 *     worker whose `createRouter` returns a fake router whose
 *     `createWebRtcTransport` returns a fake transport, etc. Each fake records
 *     the args it was called with so we can pin the config the service passes.
 *   - The constructor calls startPeriodicCleanup() which installs a real
 *     setInterval; we use jest fake timers so no real timer leaks and the
 *     internal 50ms cleanup delay in createWebRtcTransport is driven manually.
 *
 * Pins: construction state, initialize() worker+router config, RTP-capability
 * shaping (iOS H264 reorder), transport creation + map update + return shape,
 * connectTransport, produce/createProducer map mutation + currentStreamer,
 * consume/createConsumer, getter/stats shapes, cleanup removal, error paths.
 */

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

// --- mediasoup fake SDK -----------------------------------------------------
// The fake factories are defined at module scope for use directly inside tests
// (e.g. overriding createWorker per-test). The jest.mock factory below is
// self-contained (no out-of-scope refs) and simply delegates to a `mock`-
// prefixed holder that jest permits referencing from a hoisted factory.

function makeFakeTransport(overrides = {}) {
  const t = {
    id: overrides.id || 'transport-1',
    closed: false,
    iceParameters: { usernameFragment: 'uf', password: 'pw' },
    iceCandidates: [{ foundation: 'f1' }],
    dtlsParameters: { role: 'auto', fingerprints: [] },
    _handlers: {},
    on: jest.fn(function (ev, cb) { this._handlers[ev] = cb; }),
    connect: jest.fn(async () => {}),
    restartIce: jest.fn(async () => ({ usernameFragment: 'uf2', password: 'pw2' })),
    produce: jest.fn(async ({ kind, appData }) => makeFakeProducer({ kind, appData })),
    consume: jest.fn(async ({ producerId }) => makeFakeConsumer({ producerId })),
    close: jest.fn(function () { this.closed = true; }),
    ...overrides,
  };
  return t;
}

let producerSeq = 0;
function makeFakeProducer(overrides = {}) {
  producerSeq += 1;
  return {
    id: overrides.id || `producer-${producerSeq}`,
    kind: overrides.kind || 'video',
    closed: false,
    paused: false,
    appData: overrides.appData || {},
    rtpParameters: { mid: '0' },
    _handlers: {},
    on: jest.fn(function (ev, cb) { this._handlers[ev] = cb; }),
    close: jest.fn(function () { this.closed = true; }),
    ...overrides,
  };
}

let consumerSeq = 0;
function makeFakeConsumer(overrides = {}) {
  consumerSeq += 1;
  return {
    id: overrides.id || `consumer-${consumerSeq}`,
    kind: overrides.kind || 'video',
    closed: false,
    paused: true,
    producerPaused: false,
    type: 'simple',
    rtpParameters: { codecs: [] },
    producerId: overrides.producerId,
    _handlers: {},
    on: jest.fn(function (ev, cb) { this._handlers[ev] = cb; }),
    resume: jest.fn(async () => {}),
    requestKeyFrame: jest.fn(async () => {}),
    close: jest.fn(function () { this.closed = true; }),
    ...overrides,
  };
}

function makeFakeRouter() {
  return {
    rtpCapabilities: {
      codecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000 },
        { kind: 'video', mimeType: 'video/H264', parameters: { 'profile-level-id': '42e01f' } },
        { kind: 'video', mimeType: 'video/H264', parameters: { 'profile-level-id': '4d0032' } },
        { kind: 'video', mimeType: 'video/VP8' },
      ],
      headerExtensions: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
    },
    createWebRtcTransport: jest.fn(async () => makeFakeTransport()),
    canConsume: jest.fn(() => true),
  };
}

function makeFakeWorker() {
  return {
    closed: false,
    _handlers: {},
    on: jest.fn(function (ev, cb) { this._handlers[ev] = cb; }),
    createRouter: jest.fn(async () => makeFakeRouter()),
  };
}

// Self-contained mock factory (hoisted by jest; must not reference out-of-scope
// vars). It exposes a single createWorker jest.fn that tests configure in
// beforeEach via the module-scope factories above.
jest.mock('mediasoup', () => ({ createWorker: jest.fn() }));

const mediasoup = require('mediasoup');
const MediasoupService = require('../../services/MediasoupService');

// Build a fully-initialized service whose router/transport are inspectable.
async function makeInitializedService() {
  const svc = new MediasoupService();
  await svc.initialize();
  return svc;
}

beforeEach(() => {
  jest.clearAllMocks();
  mediasoup.createWorker.mockImplementation(async () => makeFakeWorker());
});

describe('MediasoupService — construction', () => {
  test('constructor initializes empty maps, null worker/router, and config constants', () => {
    jest.useFakeTimers();
    const svc = new MediasoupService();

    expect(svc.worker).toBeNull();
    expect(svc.router).toBeNull();
    expect(svc.transports).toBeInstanceOf(Map);
    expect(svc.producers).toBeInstanceOf(Map);
    expect(svc.consumers).toBeInstanceOf(Map);
    expect(svc.transports.size).toBe(0);
    expect(svc.currentStreamer).toBeNull();
    expect(svc.maxTransports).toBe(200);
    expect(svc.maxProducersPerUser).toBe(10);
    expect(svc.maxConsumersPerUser).toBe(20);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('transportOptions defaults pin announced-IP and bitrate ceiling', () => {
    jest.useFakeTimers();
    const svc = new MediasoupService();

    expect(svc.transportOptions.enableUdp).toBe(true);
    expect(svc.transportOptions.enableTcp).toBe(true);
    expect(svc.transportOptions.preferUdp).toBe(true);
    expect(svc.transportOptions.enableSctp).toBe(false);
    expect(svc.transportOptions.maxIncomingBitrate).toBe(1500000);
    expect(svc.transportOptions.listenIps[0].ip).toBe('0.0.0.0');

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('constructor installs a periodic cleanup interval', () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setInterval');
    // eslint-disable-next-line no-new
    new MediasoupService();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(30000);

    spy.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — initialize()', () => {
  test('creates a worker with the pinned rtc port range and a router with mediaCodecs', async () => {
    jest.useFakeTimers();
    const svc = new MediasoupService();
    await svc.initialize();

    expect(mediasoup.createWorker).toHaveBeenCalledTimes(1);
    const workerCfg = mediasoup.createWorker.mock.calls[0][0];
    expect(workerCfg.rtcMinPort).toBe(50000);
    expect(workerCfg.rtcMaxPort).toBe(50199);

    expect(svc.worker).not.toBeNull();
    expect(svc.worker.createRouter).toHaveBeenCalledTimes(1);
    const routerCfg = svc.worker.createRouter.mock.calls[0][0];
    const mimeTypes = routerCfg.mediaCodecs.map((c) => c.mimeType);
    expect(mimeTypes).toContain('audio/opus');
    expect(mimeTypes).toContain('video/H264');
    expect(mimeTypes).toContain('video/VP8');
    // H264 Baseline (iOS) is present and listed before VP8.
    const baseline = routerCfg.mediaCodecs.find(
      (c) => c.mimeType === 'video/H264' && c.parameters?.['profile-level-id'] === '42e01f'
    );
    expect(baseline).toBeDefined();
    expect(svc.router).not.toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('worker creation failure leaves worker null and does not throw', async () => {
    jest.useFakeTimers();
    mediasoup.createWorker.mockImplementationOnce(async () => { throw new Error('boom'); });
    const svc = new MediasoupService();
    await expect(svc.initialize()).resolves.toBeUndefined();
    expect(svc.worker).toBeNull();
    expect(svc.router).toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — getRouterRtpCapabilities', () => {
  test('returns raw capabilities by default', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const caps = await svc.getRouterRtpCapabilities(false);
    expect(caps.codecs.length).toBe(4);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('preferH264=true reorders codecs: audio first, then H264 baseline, drops VP8', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const caps = await svc.getRouterRtpCapabilities(true);
    const mimes = caps.codecs.map((c) => c.mimeType);
    // audio first
    expect(caps.codecs[0].kind).toBe('audio');
    // VP8 dropped for iOS
    expect(mimes).not.toContain('video/VP8');
    // baseline H264 present
    expect(caps.codecs.some(
      (c) => c.mimeType === 'video/H264' && c.parameters?.['profile-level-id'] === '42e01f'
    )).toBe(true);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('throws when router is not available', async () => {
    jest.useFakeTimers();
    const svc = new MediasoupService();
    await expect(svc.getRouterRtpCapabilities()).rejects.toThrow('MediaSoup router not available');

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — createWebRtcTransport', () => {
  test('creates a transport, stores it by socketId, and returns ICE/DTLS shape', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();

    const promise = svc.createWebRtcTransport('sock-A', false);
    // service awaits an internal 50ms cleanup delay
    await jest.advanceTimersByTimeAsync(60);
    const result = await promise;

    expect(svc.router.createWebRtcTransport).toHaveBeenCalledTimes(1);
    const cfg = svc.router.createWebRtcTransport.mock.calls[0][0];
    expect(cfg.enableUdp).toBe(true);
    expect(cfg.appData.socketId).toBe('sock-A');
    expect(svc.transports.has('sock-A')).toBe(true);
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('iceParameters');
    expect(result).toHaveProperty('iceCandidates');
    expect(result).toHaveProperty('dtlsParameters');

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('mobile flag raises the SCTP-enabled / mobile-tuned bitrate config', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();

    const promise = svc.createWebRtcTransport('sock-M', true);
    await jest.advanceTimersByTimeAsync(60);
    await promise;

    const cfg = svc.router.createWebRtcTransport.mock.calls[0][0];
    expect(cfg.appData.clientType).toBe('mobile');
    expect(cfg.initialAvailableOutgoingBitrate).toBe(800000);
    expect(cfg.enableSctp).toBe(true);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('throws when worker/router not initialized', async () => {
    jest.useFakeTimers();
    const svc = new MediasoupService();
    await expect(svc.createWebRtcTransport('x')).rejects.toThrow('MediaSoup not initialized');

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — connectTransport', () => {
  test('connects the stored transport with the given dtlsParameters', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const p = svc.createWebRtcTransport('sock-C', false);
    await jest.advanceTimersByTimeAsync(60);
    await p;

    const transport = svc.transports.get('sock-C');
    const dtls = { role: 'client', fingerprints: [] };
    await svc.connectTransport('sock-C', dtls);

    expect(transport.connect).toHaveBeenCalledWith({ dtlsParameters: dtls });

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('throws after retries when transport is absent', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const promise = svc.connectTransport('ghost', {});
    const assertion = expect(promise).rejects.toThrow('Transport not found for ghost');
    // drive the retry backoff (100 + 200 ms)
    await jest.advanceTimersByTimeAsync(400);
    await assertion;

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — produce / createProducer', () => {
  async function withTransport(socketId) {
    const svc = await makeInitializedService();
    const p = svc.createWebRtcTransport(socketId, false);
    await jest.advanceTimersByTimeAsync(60);
    await p;
    return svc;
  }

  test('produce stores producer by socketId+kind, sets currentStreamer, returns id', async () => {
    jest.useFakeTimers();
    const svc = await withTransport('sock-P');
    const transport = svc.transports.get('sock-P');

    const id = await svc.produce('sock-P', 'video', { mid: '0', codecs: [] }, { foo: 1 });

    expect(transport.produce).toHaveBeenCalledTimes(1);
    expect(svc.producers.get('sock-P').get('video')).toBeDefined();
    expect(svc.currentStreamer).toBe('sock-P');
    expect(typeof id).toBe('string');

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('produce throws when transport missing', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    await expect(svc.produce('nope', 'video', {}, {})).rejects.toThrow('Transport not found for nope');

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('createProducer stores producer and returns { id } shape', async () => {
    jest.useFakeTimers();
    const svc = await withTransport('sock-CP');
    const out = await svc.createProducer('sock-CP', { codecs: [] }, 'audio');
    expect(out).toHaveProperty('id');
    expect(svc.producers.get('sock-CP').get('audio')).toBeDefined();
    expect(svc.currentStreamer).toBe('sock-CP');

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — consume / createConsumer', () => {
  async function withProducerAndConsumerTransport() {
    const svc = await makeInitializedService();
    // producer transport
    let p = svc.createWebRtcTransport('streamer', false);
    await jest.advanceTimersByTimeAsync(60);
    await p;
    const producerId = await svc.produce('streamer', 'video', { codecs: [] }, {});
    // consumer transport
    p = svc.createWebRtcTransport('viewer', false);
    await jest.advanceTimersByTimeAsync(60);
    await p;
    return { svc, producerId };
  }

  test('consume finds producer by id, creates consumer, stores it', async () => {
    jest.useFakeTimers();
    const { svc, producerId } = await withProducerAndConsumerTransport();

    const consumer = await svc.consume('viewer', producerId, { codecs: [] });
    expect(consumer).not.toBeNull();
    expect(svc.consumers.get('viewer')).toBeInstanceOf(Set);
    expect(svc.consumers.get('viewer').size).toBe(1);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('consume returns null when producer id is unknown', async () => {
    jest.useFakeTimers();
    const { svc } = await withProducerAndConsumerTransport();
    const consumer = await svc.consume('viewer', 'no-such-producer', { codecs: [] });
    expect(consumer).toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('createConsumer returns a descriptor shape with id/kind/rtpParameters/producerId', async () => {
    jest.useFakeTimers();
    const { svc } = await withProducerAndConsumerTransport();
    const out = await svc.createConsumer('viewer', 'streamer', { codecs: [] }, 'video');
    expect(out).not.toBeNull();
    expect(out).toHaveProperty('id');
    expect(out).toHaveProperty('kind');
    expect(out).toHaveProperty('rtpParameters');
    expect(out).toHaveProperty('producerId');

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('createConsumer returns null when consumer transport missing', async () => {
    jest.useFakeTimers();
    const { svc } = await withProducerAndConsumerTransport();
    const out = await svc.createConsumer('absent-viewer', 'streamer', { codecs: [] }, 'video');
    expect(out).toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — getters / stats', () => {
  test('hasActiveProducer / hasProducer / getCurrentStreamer reflect map state', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const p = svc.createWebRtcTransport('s', false);
    await jest.advanceTimersByTimeAsync(60);
    await p;
    await svc.produce('s', 'video', { codecs: [] }, {});

    expect(svc.getCurrentStreamer()).toBe('s');
    expect(svc.hasActiveProducer()).toBe(true);
    expect(svc.hasProducer('s', 'video')).toBe(true);
    expect(svc.hasProducer('s', 'audio')).toBe(false);
    expect(svc.hasProducer('other')).toBe(false);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('getStats reports transport/producer/consumer counts and active streamer', async () => {
    jest.useFakeTimers();
    const { svc } = await (async () => {
      const s = await makeInitializedService();
      let pr = s.createWebRtcTransport('streamer', false);
      await jest.advanceTimersByTimeAsync(60); await pr;
      await s.produce('streamer', 'video', { codecs: [] }, {});
      pr = s.createWebRtcTransport('viewer', false);
      await jest.advanceTimersByTimeAsync(60); await pr;
      await s.consume('viewer', s.producers.get('streamer').get('video').id, { codecs: [] });
      return { svc: s };
    })();

    const stats = svc.getStats();
    expect(stats.activeStreamer).toBe('streamer');
    expect(stats.transportCount).toBe(2);
    expect(stats.producerCount).toBe(1);
    expect(stats.consumerCount).toBe(1);

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe('MediasoupService — cleanup', () => {
  test('cleanupSocketResources closes + removes consumers/producers/transport and clears streamer', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const p = svc.createWebRtcTransport('gone', false);
    await jest.advanceTimersByTimeAsync(60);
    await p;
    await svc.produce('gone', 'video', { codecs: [] }, {});
    const transport = svc.transports.get('gone');
    const producer = svc.producers.get('gone').get('video');

    await svc.cleanupSocketResources('gone');

    expect(producer.close).toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
    expect(svc.producers.has('gone')).toBe(false);
    expect(svc.transports.has('gone')).toBe(false);
    expect(svc.currentStreamer).toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('cleanupAll clears every map and resets currentStreamer', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const p = svc.createWebRtcTransport('a', false);
    await jest.advanceTimersByTimeAsync(60);
    await p;
    await svc.produce('a', 'video', { codecs: [] }, {});

    svc.cleanupAll();

    expect(svc.producers.size).toBe(0);
    expect(svc.consumers.size).toBe(0);
    expect(svc.transports.size).toBe(0);
    expect(svc.currentStreamer).toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('cleanup() delegates to cleanupSocketResources (backward-compat alias)', async () => {
    jest.useFakeTimers();
    const svc = await makeInitializedService();
    const spy = jest.spyOn(svc, 'cleanupSocketResources');
    svc.cleanup('whatever');
    expect(spy).toHaveBeenCalledWith('whatever');

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
