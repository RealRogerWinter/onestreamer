const RotationScheduler = require('../../../services/viewbot/rotationScheduler');

function make(overrides = {}) {
  const onRotate = jest.fn();
  const parentService = {
    rotationEnabled: true,
    rotationCheckIntervalMin: 5000,
    rotationCheckIntervalMax: 10000,
    rotationProbability: 0.31,
    ...overrides.parentService,
  };
  const scheduler = new RotationScheduler({
    botId: 'bot-A',
    getParentService: () => (overrides.noParent ? null : parentService),
    isStreaming: () => overrides.isStreaming !== false,
    onRotate,
    rng: overrides.rng || (() => 0.5),
  });
  return { scheduler, onRotate, parentService };
}

describe('RotationScheduler.computeInterval', () => {
  test('maps rng across [min, max]', () => {
    expect(RotationScheduler.computeInterval(5000, 10000, () => 0)).toBe(5000);
    expect(RotationScheduler.computeInterval(5000, 10000, () => 0.99999)).toBe(10000);
  });
});

describe('RotationScheduler.start', () => {
  test('does nothing when no parent service', () => {
    jest.useFakeTimers();
    try {
      const { scheduler } = make({ noParent: true });
      scheduler.start();
      expect(scheduler.timer).toBeNull();
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test('does nothing when rotation disabled', () => {
    jest.useFakeTimers();
    try {
      const { scheduler } = make({ parentService: { rotationEnabled: false } });
      scheduler.start();
      expect(scheduler.timer).toBeNull();
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test('arms a timer when enabled', () => {
    jest.useFakeTimers();
    try {
      const { scheduler } = make();
      scheduler.start();
      expect(scheduler.timer).not.toBeNull();
      scheduler.stop();
      expect(scheduler.timer).toBeNull();
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });
});

describe('RotationScheduler.performCheck', () => {
  test('roll below threshold -> onRotate, no reschedule', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, onRotate } = make({ rng: () => 0.1 }); // < 0.31
      scheduler.performCheck();
      expect(onRotate).toHaveBeenCalled();
      expect(scheduler.timer).toBeNull(); // did not schedule next
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test('roll above threshold -> reschedules, no rotate', () => {
    jest.useFakeTimers();
    try {
      const { scheduler, onRotate } = make({ rng: () => 0.9 }); // > 0.31
      scheduler.performCheck();
      expect(onRotate).not.toHaveBeenCalled();
      expect(scheduler.timer).not.toBeNull();
      scheduler.stop();
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test('skips when not streaming', () => {
    const { scheduler, onRotate } = make({ isStreaming: false, rng: () => 0.0 });
    scheduler.performCheck();
    expect(onRotate).not.toHaveBeenCalled();
  });

  test('skips when rotation disabled at check time', () => {
    const { scheduler, onRotate } = make({ parentService: { rotationEnabled: false }, rng: () => 0.0 });
    scheduler.performCheck();
    expect(onRotate).not.toHaveBeenCalled();
  });
});
