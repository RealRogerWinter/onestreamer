// Characterization net for ViewBotLiveKitService
// (PR: refactor/viewbotlivekit-decompose).
//
// This is core-media (LiveKit SDK + GStreamer/FFmpeg spawning). The risky core
// — the RTMP/GStreamer streaming state machine (startRTMPStream), the FFmpeg
// HLS fallback (startFFmpegFallback), and the live ingress/room lifecycle — is
// event-driven and timer-laden, so it is NOT pinned end-to-end here (doing so
// would require flaky timing assertions). Instead we PIN the stable,
// deterministic surface around that core:
//
//   - construction defaults + setter wiring (StreamService / URLViewBotService).
//   - protection gating: isURLStreamActive / isRealStreamerActive branching.
//   - getNextVideoFile rotation (pure) and loadVideoFiles fs filtering.
//   - initialize() constructs RoomServiceClient with a protocol-normalized host.
//   - generateBotToken builds an AccessToken and addGrant with the room config.
//   - createIngress: default (transcoding) request shape + RTMP_INPUT, and the
//     LIVEKIT_INGRESS_BYPASS_TRANSCODING bypass path; null-on-error path.
//   - deleteIngress success + error return values.
//   - getViewBotStatus / listViewBots output shapes (exists / not-exists).
//   - stop/remove/start lifecycle branching for the not-found / already-running
//     guards, and createViewBot's real-streamer-blocked + no-video guards.
//   - hasAudioTrack via a mocked ffprobe spawn.
//
// All livekit-server-sdk clients are jest.mock'd to spy classes; child_process
// .spawn is mocked; fake timers keep nothing real from firing.

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

// --- livekit-server-sdk spy doubles -----------------------------------------
const roomClientInstances = [];
const ingressClientInstances = [];
const accessTokenInstances = [];

const mockListParticipants = jest.fn().mockResolvedValue([]);
const mockRemoveParticipant = jest.fn().mockResolvedValue(undefined);
const mockCreateIngress = jest.fn().mockResolvedValue({ ingressId: 'ing-1', streamKey: 'key-1' });
const mockDeleteIngress = jest.fn().mockResolvedValue(undefined);

jest.mock('livekit-server-sdk', () => {
  class RoomServiceClient {
    constructor(host, apiKey, apiSecret) {
      this.host = host; this.apiKey = apiKey; this.apiSecret = apiSecret;
      this.listParticipants = (...a) => mockListParticipants(...a);
      this.removeParticipant = (...a) => mockRemoveParticipant(...a);
      roomClientInstances.push(this);
    }
  }
  class IngressClient {
    constructor(host, apiKey, apiSecret) {
      this.host = host; this.apiKey = apiKey; this.apiSecret = apiSecret;
      this.createIngress = (...a) => mockCreateIngress(...a);
      this.deleteIngress = (...a) => mockDeleteIngress(...a);
      ingressClientInstances.push(this);
    }
  }
  class AccessToken {
    constructor(apiKey, apiSecret, opts) {
      this.apiKey = apiKey; this.apiSecret = apiSecret; this.opts = opts;
      this.grants = [];
      this.addGrant = jest.fn((g) => { this.grants.push(g); });
      this.toJwt = jest.fn().mockResolvedValue('jwt-token-fake');
      accessTokenInstances.push(this);
    }
  }
  return {
    RoomServiceClient,
    IngressClient,
    AccessToken,
    IngressInput: { RTMP_INPUT: 0 },
    TrackSource: { CAMERA: 1, MICROPHONE: 2 },
    IngressVideoOptions: class {},
    IngressAudioOptions: class {},
  };
});

// --- child_process spawn / exec doubles -------------------------------------
const { EventEmitter } = require('events');

function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  proc.pid = 4321;
  proc.killed = false;
  return proc;
}

let lastSpawned = null;
const mockSpawn = jest.fn(() => { lastSpawned = makeFakeProc(); return lastSpawned; });
const mockExec = jest.fn((cmd, cb) => { if (typeof cb === 'function') cb(); });

jest.mock('child_process', () => ({
  spawn: (...a) => mockSpawn(...a),
  exec: (...a) => mockExec(...a),
}));

// --- fs double (loadVideoFiles uses readdirSync) ----------------------------
jest.mock('fs', () => ({
  readdirSync: jest.fn(() => []),
}));
const fs = require('fs');

// --- config double ----------------------------------------------------------
jest.mock('../../config/webrtc.config', () => ({
  livekit: {
    host: '127.0.0.1:7882', // no protocol, to exercise normalization
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    roomName: 'test-room',
  },
}));

const livekit = require('livekit-server-sdk');
const ViewBotLiveKitService = require('../../services/ViewBotLiveKitService');

function reset() {
  roomClientInstances.length = 0;
  ingressClientInstances.length = 0;
  accessTokenInstances.length = 0;
  mockListParticipants.mockClear().mockResolvedValue([]);
  mockRemoveParticipant.mockClear().mockResolvedValue(undefined);
  mockCreateIngress.mockClear().mockResolvedValue({ ingressId: 'ing-1', streamKey: 'key-1' });
  mockDeleteIngress.mockClear().mockResolvedValue(undefined);
  mockSpawn.mockClear();
  mockExec.mockClear();
  fs.readdirSync.mockReset().mockReturnValue([]);
  lastSpawned = null;
  delete process.env.LIVEKIT_INGRESS_BYPASS_TRANSCODING;
}

describe('ViewBotLiveKitService characterization', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    reset();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ---- construction ----
  test('constructs with empty active bots and null clients', () => {
    const svc = new ViewBotLiveKitService({ marker: 'lk' });
    expect(svc.activeBots).toBeInstanceOf(Map);
    expect(svc.activeBots.size).toBe(0);
    expect(svc.roomClient).toBeNull();
    expect(svc.currentVideoIndex).toBe(0);
    expect(svc.videoFiles).toEqual([]);
    expect(svc.livekitService).toEqual({ marker: 'lk' });
    expect(svc.config.roomName).toBe('test-room');
  });

  // ---- setter wiring ----
  test('setStreamService / setURLViewBotService store references', () => {
    const svc = new ViewBotLiveKitService({});
    const ss = { getCurrentStreamer: jest.fn() };
    const urls = { isURLStreamActive: jest.fn() };
    svc.setStreamService(ss);
    svc.setURLViewBotService(urls);
    expect(svc.streamService).toBe(ss);
    expect(svc.urlViewBotService).toBe(urls);
  });

  // ---- protection gating ----
  test('isURLStreamActive returns false with no url service, true when active', () => {
    const svc = new ViewBotLiveKitService({});
    expect(svc.isURLStreamActive()).toBe(false);
    svc.setURLViewBotService({
      isURLStreamActive: () => true,
      getActiveURLStream: () => ({ urlId: 'u1' }),
    });
    expect(svc.isURLStreamActive()).toBe(true);
  });

  test('isRealStreamerActive: url stream blocks, viewbot streamer does not, human does', () => {
    const svc = new ViewBotLiveKitService({});
    // no services -> false
    expect(svc.isRealStreamerActive()).toBe(false);

    // url stream active -> blocked
    svc.setURLViewBotService({ isURLStreamActive: () => true, getActiveURLStream: () => ({}) });
    expect(svc.isRealStreamerActive()).toBe(true);

    // url not active, current streamer is a viewbot -> not blocked
    svc.setURLViewBotService({ isURLStreamActive: () => false });
    svc.setStreamService({ getCurrentStreamer: () => 'viewbot-abc' });
    expect(svc.isRealStreamerActive()).toBe(false);

    // human streamer -> blocked
    svc.setStreamService({ getCurrentStreamer: () => 'realhuman' });
    expect(svc.isRealStreamerActive()).toBe(true);

    // no current streamer -> not blocked
    svc.setStreamService({ getCurrentStreamer: () => null });
    expect(svc.isRealStreamerActive()).toBe(false);
  });

  // ---- video rotation ----
  test('getNextVideoFile rotates through files and wraps', () => {
    const svc = new ViewBotLiveKitService({});
    expect(svc.getNextVideoFile()).toBeNull();
    svc.videoFiles = ['/a.mp4', '/b.mp4'];
    expect(svc.getNextVideoFile()).toBe('/a.mp4');
    expect(svc.getNextVideoFile()).toBe('/b.mp4');
    expect(svc.getNextVideoFile()).toBe('/a.mp4'); // wraps
  });

  test('loadVideoFiles keeps only .mp4 files as absolute paths', async () => {
    const svc = new ViewBotLiveKitService({});
    fs.readdirSync.mockReturnValue(['a.mp4', 'b.txt', 'c.mp4']);
    await svc.loadVideoFiles();
    expect(svc.videoFiles).toHaveLength(2);
    expect(svc.videoFiles.every(f => f.endsWith('.mp4'))).toBe(true);
  });

  // ---- initialize ----
  test('initialize constructs RoomServiceClient with protocol-normalized host', async () => {
    const svc = new ViewBotLiveKitService({});
    fs.readdirSync.mockReturnValue([]);
    await svc.initialize();
    expect(roomClientInstances).toHaveLength(1);
    expect(roomClientInstances[0].host).toBe('http://127.0.0.1:7882');
    expect(roomClientInstances[0].apiKey).toBe('test-api-key');
    expect(svc.roomClient).not.toBeNull();
    // idempotent: second call does not re-create
    await svc.initialize();
    expect(roomClientInstances).toHaveLength(1);
  });

  // ---- token shaping ----
  test('generateBotToken builds AccessToken with publish grant for config room', async () => {
    const svc = new ViewBotLiveKitService({});
    const jwt = await svc.generateBotToken('viewbot-xyz');
    expect(jwt).toBe('jwt-token-fake');
    expect(accessTokenInstances).toHaveLength(1);
    const at = accessTokenInstances[0];
    expect(at.apiKey).toBe('test-api-key');
    expect(at.apiSecret).toBe('test-api-secret');
    expect(at.opts.identity).toBe('viewbot-xyz');
    expect(at.grants[0]).toEqual({
      roomJoin: true,
      room: 'test-room',
      canPublish: true,
      canSubscribe: false,
    });
  });

  // ---- ingress creation: default transcoding path ----
  test('createIngress (default) calls createIngress with RTMP_INPUT + transcoding options', async () => {
    const svc = new ViewBotLiveKitService({});
    const ingress = await svc.createIngress({ id: 'viewbot-1' });
    expect(ingress).toEqual({ ingressId: 'ing-1', streamKey: 'key-1' });
    expect(mockCreateIngress).toHaveBeenCalledTimes(1);
    const [input, req] = mockCreateIngress.mock.calls[0];
    expect(input).toBe(livekit.IngressInput.RTMP_INPUT);
    expect(req.roomName).toBe('test-room');
    expect(req.participantIdentity).toBe('viewbot-1');
    expect(req.video).toBeDefined();
    expect(req.audio).toBeDefined();
    expect(req.bypassTranscoding).toBeUndefined();
    expect(ingressClientInstances[0].host).toBe('http://127.0.0.1:7882');
  });

  test('createIngress honors adaptive encodingSettings in the video layer', async () => {
    const svc = new ViewBotLiveKitService({});
    await svc.createIngress({ id: 'viewbot-2' }, { width: 640, height: 360, fps: 24, videoBitrate: 1500 });
    const [, req] = mockCreateIngress.mock.calls[0];
    const layer = req.video.encodingOptions.value.layers[0];
    expect(layer.width).toBe(640);
    expect(layer.height).toBe(360);
    expect(layer.bitrate).toBe(1500 * 1000);
    expect(req.video.encodingOptions.value.frameRate).toBe(24);
  });

  // ---- ingress creation: bypass path ----
  test('createIngress bypass path sets bypassTranscoding and omits encoding options', async () => {
    process.env.LIVEKIT_INGRESS_BYPASS_TRANSCODING = 'true';
    const svc = new ViewBotLiveKitService({});
    await svc.createIngress({ id: 'viewbot-3' });
    const [, req] = mockCreateIngress.mock.calls[0];
    expect(req.bypassTranscoding).toBe(true);
    expect(req.video).toBeUndefined();
    expect(req.audio).toBeUndefined();
  });

  test('createIngress returns null when the SDK throws', async () => {
    mockCreateIngress.mockRejectedValueOnce(new Error('boom'));
    const svc = new ViewBotLiveKitService({});
    const res = await svc.createIngress({ id: 'viewbot-4' });
    expect(res).toBeNull();
  });

  // ---- deleteIngress ----
  test('deleteIngress returns true on success, false on failure', async () => {
    const svc = new ViewBotLiveKitService({});
    await expect(svc.deleteIngress('ing-9')).resolves.toBe(true);
    expect(mockDeleteIngress).toHaveBeenCalledWith('ing-9');

    mockDeleteIngress.mockRejectedValueOnce(new Error('nope'));
    await expect(svc.deleteIngress('ing-10')).resolves.toBe(false);
  });

  // ---- status / list shapes ----
  test('getViewBotStatus reports not-exists / exists shapes', () => {
    const svc = new ViewBotLiveKitService({});
    expect(svc.getViewBotStatus('missing')).toEqual({ exists: false });

    svc.activeBots.set('bot-x', {
      id: 'bot-x',
      running: true,
      config: { videoFile: '/v.mp4' },
      startTime: Date.now(),
      gstreamerProcess: makeFakeProc(),
      ffmpegProcess: null,
      participantId: null,
    });
    const status = svc.getViewBotStatus('bot-x');
    expect(status.exists).toBe(true);
    expect(status.running).toBe(true);
    expect(status.videoFile).toBe('/v.mp4');
    expect(status.processActive).toBe(true);
  });

  test('listViewBots maps each active bot id to its status', () => {
    const svc = new ViewBotLiveKitService({});
    svc.activeBots.set('bot-a', { id: 'bot-a', running: false, config: {}, startTime: null });
    const list = svc.listViewBots();
    expect(list).toHaveLength(1);
    expect(list[0].botId).toBe('bot-a');
    expect(list[0].exists).toBe(true);
  });

  // ---- lifecycle guard branches ----
  test('stopViewBot / removeViewBot return not-found for unknown bot', async () => {
    const svc = new ViewBotLiveKitService({});
    await expect(svc.stopViewBot('nope')).resolves.toEqual({ success: false, message: 'ViewBot not found' });
    await expect(svc.removeViewBot('nope')).resolves.toEqual({ success: false, message: 'ViewBot not found' });
  });

  test('startViewBot returns not-found and already-running guards', async () => {
    const svc = new ViewBotLiveKitService({});
    await expect(svc.startViewBot('nope')).resolves.toEqual({ success: false, message: 'ViewBot not found' });
    svc.activeBots.set('bot-run', { id: 'bot-run', running: true });
    await expect(svc.startViewBot('bot-run')).resolves.toEqual({ success: false, message: 'ViewBot is already running' });
  });

  // ---- createViewBot guard branches ----
  test('createViewBot is blocked when a real streamer is active', async () => {
    const svc = new ViewBotLiveKitService({});
    svc.setStreamService({ getCurrentStreamer: () => 'realhuman' });
    const res = await svc.createViewBot();
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Real streamer is active/);
    expect(roomClientInstances).toHaveLength(0); // never initialized
  });

  test('createViewBot fails cleanly when no video files are available', async () => {
    const svc = new ViewBotLiveKitService({});
    fs.readdirSync.mockReturnValue([]); // no videos
    const res = await svc.createViewBot();
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/No video files available/);
  });

  // ---- ffprobe audio detection ----
  test('hasAudioTrack resolves true when ffprobe reports an audio stream', async () => {
    const svc = new ViewBotLiveKitService({});
    const p = svc.hasAudioTrack('/v.mp4');
    expect(mockSpawn).toHaveBeenCalledWith('ffprobe', expect.arrayContaining(['/v.mp4']));
    lastSpawned.stdout.emit('data', Buffer.from('audio'));
    lastSpawned.emit('close', 0);
    await expect(p).resolves.toBe(true);
  });

  test('hasAudioTrack resolves false when ffprobe reports no audio', async () => {
    const svc = new ViewBotLiveKitService({});
    const p = svc.hasAudioTrack('/v.mp4');
    lastSpawned.emit('close', 1);
    await expect(p).resolves.toBe(false);
  });
});
