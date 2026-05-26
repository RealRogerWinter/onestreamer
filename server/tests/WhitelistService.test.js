/**
 * Tests for WhitelistService — Phase 0 scaffolding.
 *
 * Uses an in-memory SQLite database; no filesystem or network I/O beyond
 * reading the seed and schema files.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const WhitelistService = require('../services/WhitelistService');

const SCHEMA_PATH = path.join(__dirname, '..', 'database', 'url-relay-whitelist-schema.sql');

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

async function makeService({ withSeed = true } = {}) {
  const db = await openMemoryDb();

  let seedPath;
  if (withSeed) {
    seedPath = path.join(__dirname, '..', 'data', 'seeds', 'url-relay-whitelist.seed.json');
  } else {
    // Write a minimal seed to a temp file: just the two config rows, no entries.
    const tmpSeed = {
      config: [
        { platform: 'twitch', mode: 'off', fallback_category: 'Minecraft', fallback_evergreen: 'bobross' },
        { platform: 'kick', mode: 'off', fallback_category: 'Minecraft', fallback_evergreen: 'hotradio' },
      ],
      twitch: {}, kick: {},
    };
    seedPath = path.join(os.tmpdir(), `whitelist-empty-${Date.now()}.json`);
    fs.writeFileSync(seedPath, JSON.stringify(tmpSeed));
  }

  const svc = new WhitelistService({ db, schemaPath: SCHEMA_PATH, seedPath });
  await svc.initialize();
  return { svc, db };
}

describe('WhitelistService', () => {
  describe('initialize', () => {
    test('applies schema and seeds when empty', async () => {
      const { svc } = await makeService();
      const cfg = await svc.getConfig();
      expect(cfg.config.twitch).toBeTruthy();
      expect(cfg.config.kick).toBeTruthy();
      expect(['off', 'blacklist', 'whitelist']).toContain(cfg.config.twitch.mode);
    });

    test('does not re-seed on second initialize', async () => {
      const { svc } = await makeService();
      const before = (await svc.getConfig()).entries.twitch.rows.length;
      // Re-initialize is a no-op for a same-instance call; the guard prevents
      // double work.
      await svc.initialize();
      const after = (await svc.getConfig()).entries.twitch.rows.length;
      expect(after).toBe(before);
    });
  });

  describe('CCL and mature gates (always-on)', () => {
    test('rejects when is_mature is true even in off mode', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch',
        login: 'anyone',
        currentGameName: 'Minecraft',
        isMature: true,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('mature_flag');
    });

    test('rejects when CCLs include SexualThemes even in off mode', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch',
        login: 'anyone',
        ccls: ['SexualThemes'],
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('ccl_gate');
      expect(result.reason).toContain('SexualThemes');
    });

    test('rejects when Kick has_mature_content is true even in off mode', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('kick', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'kick',
        login: 'anyone',
        hasMatureContent: true,
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('mature_flag');
    });

    test('allows clean stream in off mode', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch',
        login: 'someone',
        currentGameName: 'Minecraft',
        isMature: false,
        ccls: [],
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('mode_off');
    });

    test('CCL match is case-insensitive (defensive against non-Helix sources)', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch',
        login: 'someone',
        ccls: ['sexualthemes'],
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('ccl_gate');
    });

    test('CCL match trims whitespace', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch',
        login: 'someone',
        ccls: [' SexualThemes '],
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('ccl_gate');
    });

    test('CCL ProfanityVulgarity alone does not block (warn-only by default)', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch',
        login: 'someone',
        ccls: ['ProfanityVulgarity'],
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('blacklist mode', () => {
    test('blocks listed streamer', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'BadStreamer', list: 'block',
      }, 'test');

      const result = svc.checkAllowed({
        platform: 'twitch', login: 'badstreamer', currentGameName: 'Minecraft',
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('blacklist_streamer');
    });

    test('blocks listed category', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'category', value: 'Slots', list: 'block',
      }, 'test');

      const result = svc.checkAllowed({
        platform: 'twitch', login: 'anyone', currentGameName: 'Slots',
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('blacklist_category');
    });

    test('allows non-listed streamer in non-listed category', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'cleanperson', currentGameName: 'Minecraft',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('blacklist_pass');
    });
  });

  describe('whitelist mode', () => {
    test('allows streamer on allowlist', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'cohhcarnage', list: 'allow',
      }, 'test');

      const result = svc.checkAllowed({
        platform: 'twitch', login: 'CohhCarnage', currentGameName: 'Just Chatting',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('streamer_allowed');
    });

    test('allows non-allowlisted streamer when category is allowlisted', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'category', value: 'Minecraft', list: 'allow',
      }, 'test');

      const result = svc.checkAllowed({
        platform: 'twitch', login: 'unknown_person', currentGameName: 'Minecraft',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('category_allowed');
    });

    test('rejects everything not on the allowlist', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');

      const result = svc.checkAllowed({
        platform: 'twitch', login: 'whoever', currentGameName: 'Anything',
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('whitelist_miss');
    });

    test('login matching is case-insensitive', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'lowercase', list: 'allow',
      }, 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'LOWERCASE', currentGameName: 'Anything',
      });
      expect(result.allowed).toBe(true);
    });

    test('CCL gate fires before whitelist allow', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'flipped', list: 'allow',
      }, 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'flipped',
        ccls: ['SexualThemes'],
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('ccl_gate');
    });
  });

  describe('filterCandidates', () => {
    test('keeps allowed and drops rest', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'good_a', list: 'allow',
      }, 'test');

      const candidates = [
        { login: 'good_a', currentGameName: 'Minecraft' },
        { login: 'bad_b', currentGameName: 'Minecraft' },
        { login: 'good_a', currentGameName: 'Other', isMature: true },  // mature wins
      ];
      const out = svc.filterCandidates('twitch', candidates);
      expect(out).toHaveLength(1);
      expect(out[0].login).toBe('good_a');
    });
  });

  describe('chooseFallback', () => {
    test('returns configured fallback fields', async () => {
      const { svc } = await makeService();
      const fb = svc.chooseFallback('twitch');
      expect(fb).toBeTruthy();
      expect(fb.platform).toBe('twitch');
      expect(fb.fallbackCategory).toBeTruthy();
      expect(fb.fallbackEvergreen).toBeTruthy();
    });

    test('includes evergreen candidates from seed', async () => {
      const { svc } = await makeService();
      const fb = svc.chooseFallback('twitch');
      expect(fb.evergreenCandidates).toContain('bobross');
    });

    test('returns null for unknown platform', async () => {
      const { svc } = await makeService();
      const fb = svc.chooseFallback('twitter');
      expect(fb).toBeNull();
    });
  });

  describe('mutations write audit rows', () => {
    test('setMode writes audit row', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'alice');
      const log = await svc.getAuditLog({ action: 'mode_change' });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].actor).toBe('alice');
      expect(JSON.parse(log[0].after_json).mode).toBe('blacklist');
    });

    test('addEntry writes audit row', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'x', list: 'allow',
      }, 'bob');
      const log = await svc.getAuditLog({ action: 'add' });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].actor).toBe('bob');
      expect(log[0].value).toBe('x');
    });

    test('removeEntry writes audit row with before_json', async () => {
      const { svc } = await makeService({ withSeed: false });
      const { id } = await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'gone', list: 'allow',
      }, 'bob');
      await svc.removeEntry(id, 'carol');
      const log = await svc.getAuditLog({ action: 'remove' });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].actor).toBe('carol');
      expect(JSON.parse(log[0].before_json).value).toBe('gone');
    });
  });

  describe('cache invalidation', () => {
    test('mode change is visible to next checkAllowed', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      expect(svc.checkAllowed({
        platform: 'twitch', login: 'whoever', currentGameName: 'Minecraft',
      }).allowed).toBe(true);

      await svc.setMode('twitch', 'whitelist', 'test');
      expect(svc.checkAllowed({
        platform: 'twitch', login: 'whoever', currentGameName: 'Minecraft',
      }).allowed).toBe(false);
    });

    test('emits change event on mutation', async () => {
      const { svc } = await makeService({ withSeed: false });
      const events = [];
      svc.on('change', (e) => events.push(e));
      await svc.setMode('twitch', 'blacklist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'a', list: 'block',
      }, 'test');
      expect(events.some((e) => e.kind === 'mode')).toBe(true);
      expect(events.some((e) => e.kind === 'entry_add')).toBe(true);
    });
  });

  describe('validation', () => {
    test('rejects unknown platform', async () => {
      const { svc } = await makeService({ withSeed: false });
      await expect(svc.setMode('mixer', 'off', 'test')).rejects.toThrow(/platform/);
    });

    test('rejects unknown mode', async () => {
      const { svc } = await makeService({ withSeed: false });
      await expect(svc.setMode('twitch', 'banhammer', 'test')).rejects.toThrow(/mode/);
    });

    test('rejects entry without value', async () => {
      const { svc } = await makeService({ withSeed: false });
      await expect(svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: '', list: 'allow',
      }, 'test')).rejects.toThrow(/value/);
    });
  });

  describe('seed loading from actual seed file', () => {
    test('seed populates Twitch evergreen with bobross', async () => {
      const { svc } = await makeService();
      const cfg = await svc.getConfig();
      const evergreen = cfg.entries.twitch.evergreenList || [];
      const logins = evergreen.map((r) => r.value);
      expect(logins).toContain('bobross');
    });

    test('seed populates Kick whitelist (mustafa_go on allowlist)', async () => {
      const { svc } = await makeService();
      const cfg = await svc.getConfig();
      const allow = cfg.entries.kick.rows.filter(
        (r) => r.entry_type === 'streamer' && r.list === 'allow'
      );
      const logins = allow.map((r) => r.value);
      expect(logins).toContain('mustafa_go');
    });

    test('seed sets Kick default mode to whitelist', async () => {
      const { svc } = await makeService();
      const cfg = await svc.getConfig();
      expect(cfg.config.kick.mode).toBe('whitelist');
    });
  });
});
