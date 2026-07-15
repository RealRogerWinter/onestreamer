// Timer hygiene (audit B6): background maintenance timers must never be the
// only thing keeping a process alive. Every periodic setInterval a service
// starts (module scope, constructor, or start method) must be unref'd so
// jest workers and one-off scripts exit cleanly — pre-fix, the unit suite
// ended with "A worker process has failed to exit gracefully and has been
// force exited", and `node -e "require(<singleton>)"` hung forever.
//
// Node timers expose hasRef(); unref() flips it to false. That's exactly the
// property these tests pin down. The DB module is mocked so requiring the two
// module-scope singletons never touches server/data/onestreamer.db (see
// docs/contributing/testing.md "Pitfalls").

jest.mock('../../database/database', () => ({
  db: {},
  runAsync: jest.fn().mockResolvedValue({}),
  getAsync: jest.fn().mockResolvedValue(undefined),
  allAsync: jest.fn().mockResolvedValue([]),
}));

describe('timer hygiene (audit B6) — background intervals are unref\'d', () => {
  test('StreamingLogsService module-scope cleanup timer is unref\'d', () => {
    const streamingLogsService = require('../../services/StreamingLogsService');
    expect(streamingLogsService._cleanupTimer).toBeDefined();
    expect(streamingLogsService._cleanupTimer.hasRef()).toBe(false);
    clearInterval(streamingLogsService._cleanupTimer);
  });

  test('IPBanService module-scope cleanup timer is unref\'d', () => {
    const ipBanService = require('../../services/IPBanService');
    expect(ipBanService._cleanupTimer).toBeDefined();
    expect(ipBanService._cleanupTimer.hasRef()).toBe(false);
    clearInterval(ipBanService._cleanupTimer);
  });

  test('ClipService constructor rate-limit cleanup timer is unref\'d and stoppable', () => {
    const ClipService = require('../../services/ClipService');
    const dbStub = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
    const service = new ClipService(dbStub, {}, {}, {});
    expect(service._rateLimitCleanupTimer).toBeDefined();
    expect(service._rateLimitCleanupTimer.hasRef()).toBe(false);
    service.stopRateLimitCleanup();
    expect(service._rateLimitCleanupTimer).toBeNull();
    service.stopRateLimitCleanup(); // idempotent
  });

  test('OllamaQueue processor tick is unref\'d, idempotent, and stoppable', () => {
    const { OllamaQueue } = require('../../services/chatbot/llm/ollamaQueue');
    const queue = new OllamaQueue({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
    queue.startRequestProcessor();
    const timer = queue._processorTimer;
    expect(timer).toBeDefined();
    expect(timer.hasRef()).toBe(false);
    queue.startRequestProcessor(); // idempotent: no second timer
    expect(queue._processorTimer).toBe(timer);
    queue.stop();
    expect(queue._processorTimer).toBeNull();
    queue.stop(); // idempotent
  });

  test('AudioFileJanitor periodic cleanup timer is unref\'d, idempotent, and stoppable', () => {
    const AudioFileJanitor = require('../../services/transcription/AudioFileJanitor');
    const janitor = new AudioFileJanitor();
    jest.spyOn(janitor, 'cleanupOldAudioFiles').mockResolvedValue({ success: true, deletedCount: 0 });
    janitor.startPeriodicCleanup(15);
    const timer = janitor._cleanupTimer;
    expect(timer).toBeDefined();
    expect(timer.hasRef()).toBe(false);
    janitor.startPeriodicCleanup(15); // idempotent: no second timer
    expect(janitor._cleanupTimer).toBe(timer);
    janitor.stopPeriodicCleanup();
    expect(janitor._cleanupTimer).toBeNull();
    janitor.stopPeriodicCleanup(); // idempotent
  });

  test('ContinuousRecordingService cleanup + auto-record intervals are unref\'d', () => {
    // Call the prototype methods on a minimal shape — constructing the real
    // service pulls the whole recording stack, which this test doesn't need.
    const ContinuousRecordingService = require('../../services/ContinuousRecordingService');

    const cleanupHost = { diskScanner: {}, cleanupOldRecordings: jest.fn() };
    ContinuousRecordingService.prototype.startCleanupInterval.call(cleanupHost);
    expect(cleanupHost.diskScanner.cleanupInterval.hasRef()).toBe(false);
    clearInterval(cleanupHost.diskScanner.cleanupInterval);

    const pollHost = { checkAndAutoRecord: jest.fn().mockResolvedValue(undefined) };
    ContinuousRecordingService.prototype.startAutoRecordPolling.call(pollHost);
    expect(pollHost.autoRecordInterval.hasRef()).toBe(false);
    clearInterval(pollHost.autoRecordInterval);
  });
});
