const { execSync } = require('child_process');
const { killProcessGroup } = require('../../../services/viewbot/processKill');

jest.mock('child_process', () => ({ execSync: jest.fn() }));

const logger = { debug: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('killProcessGroup (linux branch)', () => {
  test('no-op when proc is null', () => {
    killProcessGroup(null, 'video', logger);
    expect(execSync).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('No video process reference'));
  });

  test('no-op when proc has no pid', () => {
    const proc = { kill: jest.fn() };
    killProcessGroup(proc, 'audio', logger);
    expect(execSync).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test('group-kills via kill -9 -PID and does not fall back when it succeeds', () => {
    const proc = { pid: 4321, kill: jest.fn() };
    killProcessGroup(proc, 'gstreamer', logger);
    expect(execSync).toHaveBeenCalledWith('kill -9 -4321', { stdio: 'ignore' });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test('falls back to single SIGKILL when group kill throws', () => {
    const proc = { pid: 99, kill: jest.fn() };
    execSync.mockImplementationOnce(() => { throw new Error('no such group'); });
    killProcessGroup(proc, 'video', logger);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('swallows error when both group kill and fallback throw', () => {
    const proc = { pid: 7, kill: jest.fn(() => { throw new Error('dead') }) };
    execSync.mockImplementationOnce(() => { throw new Error('no group'); });
    expect(() => killProcessGroup(proc, 'video', logger)).not.toThrow();
  });

  test('works with a null logger', () => {
    const proc = { pid: 1234, kill: jest.fn() };
    expect(() => killProcessGroup(proc, 'video', null)).not.toThrow();
    expect(execSync).toHaveBeenCalledWith('kill -9 -1234', { stdio: 'ignore' });
  });
});
