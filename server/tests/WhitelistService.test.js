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
        language: 'en',
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
        language: 'en',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('category_allowed');
    });

    test('rejects everything not on the allowlist', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');

      const result = svc.checkAllowed({
        platform: 'twitch', login: 'whoever', currentGameName: 'Anything',
        language: 'en',
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
        language: 'en',
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
        language: 'en',
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
        { login: 'good_a', currentGameName: 'Minecraft', language: 'en' },
        { login: 'bad_b', currentGameName: 'Minecraft', language: 'en' },
        { login: 'good_a', currentGameName: 'Other', isMature: true, language: 'en' },  // mature wins
      ];
      const out = svc.filterCandidates('twitch', candidates);
      expect(out).toHaveLength(1);
      expect(out[0].login).toBe('good_a');
    });
  });

  describe('language gate', () => {
    test('default preferred_languages is ["en"] via DEFAULT constant', async () => {
      const { svc } = await makeService({ withSeed: false });
      const cfg = await svc.getConfig();
      expect(cfg.config.twitch.preferred_languages).toEqual(['en']);
      expect(cfg.config.kick.preferred_languages).toEqual(['en']);
    });

    test('allows when language matches preferred', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'en',
      });
      expect(result.allowed).toBe(true);
    });

    test('rejects when language does not match preferred', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'de',
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('language_gate');
      expect(result.reason).toContain('language_not_preferred:de');
    });

    test('blacklist mode is lenient on null language (allows when missing)', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        // language omitted
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('blacklist_pass');
    });

    test('whitelist mode is strict on null language (rejects when missing)', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'allowedone', list: 'allow',
      }, 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'allowedone', currentGameName: 'Minecraft',
        // language omitted
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('language_gate');
      expect(result.reason).toBe('language_unknown_strict');
    });

    test('off mode skips language gate entirely', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'off', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'de',
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('mode_off');
    });

    test('empty preferred_languages disables gate', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'whitelist', 'test');
      await svc.setLanguagePreference('twitch', [], 'test');
      await svc.addEntry({
        platform: 'twitch', entry_type: 'streamer', value: 'allowedone', list: 'allow',
      }, 'test');
      // No language in snapshot — would normally trigger strict reject;
      // with empty preferred_languages the gate is skipped entirely.
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'allowedone', currentGameName: 'Minecraft',
      });
      expect(result.allowed).toBe(true);
    });

    test('language match is case-insensitive', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'EN',
      });
      expect(result.allowed).toBe(true);
    });

    test('language gate fires after CCL gate (CCL is always-on, higher priority)', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      const result = svc.checkAllowed({
        platform: 'twitch', login: 'someone',
        ccls: ['SexualThemes'],
        language: 'de',  // would also be rejected by language gate
      });
      expect(result.allowed).toBe(false);
      expect(result.gateThatBlocked).toBe('ccl_gate');
    });

    test('multi-language preference allows any in the set', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      await svc.setLanguagePreference('twitch', ['en', 'ja'], 'test');
      const enResult = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'en',
      });
      const jaResult = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'ja',
      });
      const deResult = svc.checkAllowed({
        platform: 'twitch', login: 'someone', currentGameName: 'Minecraft',
        language: 'de',
      });
      expect(enResult.allowed).toBe(true);
      expect(jaResult.allowed).toBe(true);
      expect(deResult.allowed).toBe(false);
    });
  });

  describe('setLanguagePreference', () => {
    test('writes audit row', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setLanguagePreference('twitch', ['en'], 'alice');
      const log = await svc.getAuditLog({ action: 'language_preference_change' });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].actor).toBe('alice');
      expect(JSON.parse(log[0].after_json).preferred_languages).toEqual(['en']);
    });

    test('normalizes to lowercase and dedupes', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setLanguagePreference('twitch', ['EN', 'en', '  ja  ', 'JA'], 'test');
      const cfg = await svc.getConfig();
      expect(cfg.config.twitch.preferred_languages).toEqual(['en', 'ja']);
    });

    test('rejects non-array input', async () => {
      const { svc } = await makeService({ withSeed: false });
      await expect(svc.setLanguagePreference('twitch', 'en', 'test'))
        .rejects.toThrow(/array/);
    });

    test('rejects unknown platform', async () => {
      const { svc } = await makeService({ withSeed: false });
      await expect(svc.setLanguagePreference('mixer', ['en'], 'test'))
        .rejects.toThrow(/platform/);
    });

    test('preserves mode through preference change (does not reset to off)', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setMode('twitch', 'blacklist', 'test');
      await svc.setLanguagePreference('twitch', ['en', 'ja'], 'test');
      const cfg = await svc.getConfig();
      expect(cfg.config.twitch.mode).toBe('blacklist');
      expect(cfg.config.twitch.preferred_languages).toEqual(['en', 'ja']);
    });

    test('emits change event', async () => {
      const { svc } = await makeService({ withSeed: false });
      const events = [];
      svc.on('change', (e) => events.push(e));
      await svc.setLanguagePreference('twitch', ['en'], 'test');
      expect(events.some((e) => e.kind === 'language_preference')).toBe(true);
    });

    test('empty array persists as "filter disabled"', async () => {
      const { svc } = await makeService({ withSeed: false });
      await svc.setLanguagePreference('twitch', [], 'test');
      const cfg = await svc.getConfig();
      expect(cfg.config.twitch.preferred_languages).toEqual([]);
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
