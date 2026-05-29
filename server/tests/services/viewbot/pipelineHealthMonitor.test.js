const PipelineHealthMonitor = require('../../../services/viewbot/pipelineHealthMonitor');

function makeMonitor(overrides = {}) {
  const onCrash = jest.fn();
  const monitor = new PipelineHealthMonitor({
    botId: 'bot-A',
    getVideoProcess: () => ({ pid: process.pid }), // a real live pid
    getAudioProcess: () => ({ pid: process.pid }),
    shouldRun: () => true,
    onCrash,
    ...overrides,
  });
  return { monitor, onCrash };
}

describe('PipelineHealthMonitor.isProcessAlive', () => {
  test('true for a live pid, false for bogus/missing', () => {
    expect(PipelineHealthMonitor.isProcessAlive(process.pid)).toBe(true);
    expect(PipelineHealthMonitor.isProcessAlive(2147483646)).toBe(false);
    expect(PipelineHealthMonitor.isProcessAlive(null)).toBe(false);
    expect(PipelineHealthMonitor.isProcessAlive(0)).toBe(false);
  });
});

describe('PipelineHealthMonitor.checkHealth', () => {
  test('no-op when shouldRun() is false', async () => {
    const { monitor, onCrash } = makeMonitor({ shouldRun: () => false, getVideoProcess: () => null, getAudioProcess: () => null });
    await monitor.checkHealth();
    expect(onCrash).not.toHaveBeenCalled();
  });

  test('both processes dead -> onCrash(both)', async () => {
    const { monitor, onCrash } = makeMonitor({ getVideoProcess: () => null, getAudioProcess: () => null });
    await monitor.checkHealth();
    expect(onCrash).toHaveBeenCalledWith('both');
  });

  test('video dead only -> onCrash(video)', async () => {
    const { monitor, onCrash } = makeMonitor({ getVideoProcess: () => ({ pid: 2147483646 }) });
    await monitor.checkHealth();
    expect(onCrash).toHaveBeenCalledWith('video');
  });

  test('audio dead only -> onCrash(audio)', async () => {
    const { monitor, onCrash } = makeMonitor({ getAudioProcess: () => ({ pid: 2147483646 }) });
    await monitor.checkHealth();
    expect(onCrash).toHaveBeenCalledWith('audio');
  });

  test('both alive -> runs activity check, no crash on first pass', async () => {
    const { monitor, onCrash } = makeMonitor();
    await monitor.checkHealth();
    expect(onCrash).not.toHaveBeenCalled();
    expect(monitor.lastHealthCheck).not.toBeNull();
  });
});

describe('PipelineHealthMonitor.checkActivity', () => {
  test('first call initializes lastHealthCheck, no crash', () => {
    const { monitor, onCrash } = makeMonitor();
    monitor.checkActivity();
    expect(monitor.lastHealthCheck).toMatchObject({ videoFrames: 0, audioFrames: 0 });
    expect(onCrash).not.toHaveBeenCalled();
  });

  test('crashes (stuck) when >15s elapsed since lastHealthCheck', () => {
    const { monitor, onCrash } = makeMonitor();
    monitor.lastHealthCheck = { time: Date.now() - 16000, videoFrames: 0, audioFrames: 0 };
    monitor.checkActivity();
    expect(onCrash).toHaveBeenCalledWith('stuck');
  });

  test('no crash between 10s and 15s elapsed', () => {
    const { monitor, onCrash } = makeMonitor();
    monitor.lastHealthCheck = { time: Date.now() - 12000, videoFrames: 0, audioFrames: 0 };
    monitor.checkActivity();
    expect(onCrash).not.toHaveBeenCalled();
  });
});

describe('PipelineHealthMonitor start/stop', () => {
  test('start arms an interval; stop clears it', () => {
    jest.useFakeTimers();
    try {
      const { monitor } = makeMonitor();
      monitor.start();
      expect(monitor.timer).not.toBeNull();
      monitor.stop();
      expect(monitor.timer).toBeNull();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
