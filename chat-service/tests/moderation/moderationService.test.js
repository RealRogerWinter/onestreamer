const fs = require('fs');
const os = require('os');
const path = require('path');
const createModerationService = require('../../moderation/moderationService');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onestreamer-mod-'));
  return path.join(dir, 'moderation_data.json');
}

describe('moderationService persistence (atomic write + .bak recovery)', () => {
  let storePath;
  let logSpy;
  let errSpy;

  beforeEach(() => {
    storePath = tmpStore();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('save is atomic (no leftover .tmp) and snapshots the prior state to .bak', () => {
    const svc = createModerationService({ moderationDataPath: storePath });

    svc.banUser('Alice', 'spam', 'admin'); // first save: no prior file -> no .bak
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.existsSync(`${storePath}.bak`)).toBe(false);

    svc.banUser('Bob'); // second save: prior {Alice} copied to .bak
    expect(fs.existsSync(`${storePath}.tmp`)).toBe(false); // temp renamed away
    const primary = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(primary.bannedUsers.map((u) => u.username).sort()).toEqual(['Alice', 'Bob']);
    const bak = JSON.parse(fs.readFileSync(`${storePath}.bak`, 'utf8'));
    expect(bak.bannedUsers.map((u) => u.username)).toEqual(['Alice']);
  });

  test('load recovers bans from .bak when the primary store is corrupt', () => {
    const svc = createModerationService({ moderationDataPath: storePath });
    svc.banUser('Carol', 'abuse', 'mod'); // save #1: primary {Carol}
    svc.banUser('Dave'); // save #2: .bak {Carol}, primary {Carol, Dave}

    fs.writeFileSync(storePath, '{ this is not valid json'); // simulate crash mid-write

    const recovered = createModerationService({ moderationDataPath: storePath });
    recovered.loadModerationData();
    expect(recovered.isUserBanned('carol')).toBe(true); // recovered from .bak, not wiped
  });

  test('load stays empty and does not throw when both primary and .bak are corrupt', () => {
    fs.writeFileSync(storePath, 'garbage');
    fs.writeFileSync(`${storePath}.bak`, 'also garbage');
    const svc = createModerationService({ moderationDataPath: storePath });
    expect(() => svc.loadModerationData()).not.toThrow();
    expect(svc.isUserBanned('anyone')).toBe(false);
  });
});
