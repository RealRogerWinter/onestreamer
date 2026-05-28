// Unit tests for RotationAnnouncer (PR 17.1).
// Targets: placeholder substitution, Kick/Twitch platform label, fallbacks
// for missing displayName/game, custom-template injection.

const RotationAnnouncer = require('../../../services/random-stream/RotationAnnouncer');
const { ROTATION_MESSAGES } = RotationAnnouncer;

describe('RotationAnnouncer', () => {
  describe('canonical templates', () => {
    test('ROTATION_MESSAGES export is non-trivial and contains all placeholders', () => {
      expect(Array.isArray(ROTATION_MESSAGES)).toBe(true);
      expect(ROTATION_MESSAGES.length).toBeGreaterThan(10);
      for (const tpl of ROTATION_MESSAGES) {
        expect(tpl).toContain('{STREAMER}');
        expect(tpl).toContain('{PLATFORM}');
        expect(tpl).toContain('{URL}');
        expect(tpl).toContain('{GAME}');
      }
    });
  });

  describe('generate()', () => {
    test('substitutes all four placeholders for a twitch streamer', () => {
      const announcer = new RotationAnnouncer({
        templates: ['{STREAMER}/{PLATFORM}/{GAME}/{URL}'],
      });
      const msg = announcer.generate({
        displayName: 'Streamer123',
        platform: 'twitch',
        game: 'Just Chatting',
        url: 'https://twitch.tv/streamer123',
      });
      expect(msg).toBe('Streamer123/Twitch/Just Chatting/https://twitch.tv/streamer123');
    });

    test('renders platform "kick" with capital K', () => {
      const announcer = new RotationAnnouncer({ templates: ['{PLATFORM}'] });
      expect(announcer.generate({ platform: 'kick', displayName: 'x', url: 'y', game: 'z' })).toBe('Kick');
    });

    test('renders any non-kick platform value as "Twitch"', () => {
      // (Defensive: the production code defaults to Twitch for anything that
      // isn't strictly 'kick'.)
      const announcer = new RotationAnnouncer({ templates: ['{PLATFORM}'] });
      expect(announcer.generate({ platform: 'twitch', displayName: 'x', url: 'y', game: 'z' })).toBe('Twitch');
      expect(announcer.generate({ platform: 'unknown', displayName: 'x', url: 'y', game: 'z' })).toBe('Twitch');
    });

    test('falls back to username when displayName is absent', () => {
      const announcer = new RotationAnnouncer({ templates: ['{STREAMER}'] });
      const msg = announcer.generate({ username: 'fallback_user', platform: 'twitch', url: '', game: '' });
      expect(msg).toBe('fallback_user');
    });

    test('falls back to "Unknown" when game is absent', () => {
      const announcer = new RotationAnnouncer({ templates: ['{GAME}'] });
      const msg = announcer.generate({ displayName: 'x', platform: 'twitch', url: '' });
      expect(msg).toBe('Unknown');
    });

    test('picks from the templates pool (with one template, always the same)', () => {
      const announcer = new RotationAnnouncer({ templates: ['only-template-{STREAMER}'] });
      for (let i = 0; i < 5; i++) {
        expect(announcer.generate({ displayName: 'A', platform: 'twitch', url: '', game: '' }))
          .toBe('only-template-A');
      }
    });

    test('defaults to the bundled ROTATION_MESSAGES when no templates option is passed', () => {
      const announcer = new RotationAnnouncer();
      expect(announcer.templates).toBe(ROTATION_MESSAGES);
    });
  });
});
