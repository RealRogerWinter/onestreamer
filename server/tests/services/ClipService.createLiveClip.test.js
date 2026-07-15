/**
 * P2.3 (audit R10) — createLiveClip fail-closed guards.
 *
 * The live path used to insert the clips row and then silently skip
 * queueing when processorService was falsy — a permanently-stuck
 * 'processing' row (the genuine phantom-row source; the two dead
 * non-live creation paths threw before any DB write and were deleted).
 * Now: the processorService precondition runs BEFORE any DB write, and a
 * synchronous queueClip failure marks the row 'failed' and rethrows
 * (skipping the rate-limit charge).
 */

const ClipService = require('../../services/ClipService');

// ClipService's constructor schedules a 15-min setInterval for rate-limit
// cache cleanup; fake timers keep the test runner from hanging.
beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

function makeService({ processorService } = {}) {
  const database = {
    db: {},
    runAsync: jest.fn().mockResolvedValue({ id: 0, changes: 1 }),
    getAsync: jest.fn(),
    allAsync: jest.fn().mockResolvedValue([]),
    withTransaction: jest.fn(async (fn) => fn({
      runAsync: jest.fn(), getAsync: jest.fn(), allAsync: jest.fn(),
    })),
  };
  const storageService = { deleteClip: jest.fn() };
  const continuousRecordingService = {
    getClippableRange: jest.fn(async () => ({
      available: true,
      start: Date.now() - 10 * 60 * 1000,
      end: Date.now(),
    })),
    findSegmentsForClip: jest.fn(async () => ({
      segments: [{ sessionId: 'recording_2026-07-15_1', path: '/dir/seg_1_00001.ts' }],
    })),
  };

  const service = new ClipService(database, storageService, processorService ?? null, continuousRecordingService);
  // Stub the repository + chat capture so no real SQL/HTTP runs.
  service.clipRepository = {
    insertClip: jest.fn(async () => {}),
    setClipFailed: jest.fn(async () => {}),
  };
  service.captureChatForClip = jest.fn(async () => {});
  return { service, database };
}

const CLIP_ARGS = {
  userId: 7,
  ipAddress: '203.0.113.7',
  durationSeconds: 30,
  title: 'A fine clip',
  description: '',
};

describe('ClipService.createLiveClip fail-closed guards (P2.3)', () => {
  test('missing processorService rejects BEFORE any DB write', async () => {
    const { service } = makeService({ processorService: null });

    await expect(service.createLiveClip(CLIP_ARGS))
      .rejects.toThrow(/Clip processing is unavailable/);
    expect(service.clipRepository.insertClip).not.toHaveBeenCalled();
  });

  test('a queueClip throw marks the row failed, rethrows, and skips the rate-limit charge', async () => {
    const processorService = {
      getStatus: jest.fn(() => ({ queueLength: 0 })),
      queueClip: jest.fn(() => { throw new Error('queue exploded'); }),
    };
    const { service } = makeService({ processorService });
    const chargeSpy = jest.spyOn(service, 'incrementRateLimits');

    await expect(service.createLiveClip(CLIP_ARGS))
      .rejects.toThrow(/Failed to queue clip/);

    expect(service.clipRepository.insertClip).toHaveBeenCalledTimes(1);
    const clipId = service.clipRepository.insertClip.mock.calls[0][0].clipId;
    expect(service.clipRepository.setClipFailed).toHaveBeenCalledWith(clipId);
    expect(chargeSpy).not.toHaveBeenCalled();
    expect(service.captureChatForClip).not.toHaveBeenCalled();
  });

  test('happy path: insert before queue, then chat capture + rate-limit charge', async () => {
    const processorService = {
      getStatus: jest.fn(() => ({ queueLength: 0 })),
      queueClip: jest.fn(),
    };
    const { service } = makeService({ processorService });

    const result = await service.createLiveClip(CLIP_ARGS);

    expect(result.status).toBe('processing');
    expect(service.clipRepository.insertClip).toHaveBeenCalledTimes(1);
    expect(processorService.queueClip).toHaveBeenCalledTimes(1);
    expect(service.clipRepository.insertClip.mock.invocationCallOrder[0])
      .toBeLessThan(processorService.queueClip.mock.invocationCallOrder[0]);
    expect(service.captureChatForClip).toHaveBeenCalledTimes(1);
    expect(service.clipRepository.setClipFailed).not.toHaveBeenCalled();
  });
});
