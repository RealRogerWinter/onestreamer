const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../data/random-rotation-state.json');

let backup;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  if (fs.existsSync(STATE_FILE)) {
    backup = fs.readFileSync(STATE_FILE, 'utf8');
  }
});

afterAll(() => {
  jest.restoreAllMocks();
  if (backup !== undefined) {
    fs.writeFileSync(STATE_FILE, backup);
  } else if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
});

beforeEach(() => {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  jest.resetModules();
});

describe('RandomStreamRotationService.updateSettings persistence', () => {
  // Regression: settings edited from the admin UI were only persisted as
  // a side-effect of start()/stop(). A pm2 restart between "user changes
  // setting" and "user toggles rotation" silently reverted the change.
  it('writes the new value to random-rotation-state.json so it survives a restart', () => {
    const RandomStreamRotationService = require('../../services/RandomStreamRotationService');
    const svc = new RandomStreamRotationService();

    svc.updateSettings({ minViewers: 499, maxViewers: 123456 });

    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    expect(persisted.settings.minViewers).toBe(499);
    expect(persisted.settings.maxViewers).toBe(123456);
  });

  it('a fresh instance picks up the persisted minViewers without start() being called', () => {
    const RandomStreamRotationService = require('../../services/RandomStreamRotationService');

    const first = new RandomStreamRotationService();
    first.updateSettings({ minViewers: 777 });

    jest.resetModules();
    const RandomStreamRotationServiceReloaded = require('../../services/RandomStreamRotationService');
    const second = new RandomStreamRotationServiceReloaded();

    expect(second.settings.minViewers).toBe(777);
  });
});
