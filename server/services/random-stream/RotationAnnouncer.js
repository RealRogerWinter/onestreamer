/**
 * RotationAnnouncer — picks a random "we just switched the channel" message
 * from the ROTATION_MESSAGES template pool and fills in the
 * {STREAMER}/{PLATFORM}/{URL}/{GAME} placeholders for a given streamer record.
 * Used by RandomStreamRotationService to announce rotations in chat.
 *
 * Construction:
 *   new RotationAnnouncer({ templates? })   // defaults to ROTATION_MESSAGES
 *
 * The templates are intentionally goading ("Empty streams? Let's watch…") to
 * nudge real users into going live and reclaim the slot.
 */

const ROTATION_MESSAGES = [
  "📺 Looks like no one is going live... Changing the channel to: {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "🎬 Since nobody's streaming, we're tuning into: {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "😴 Empty streams? Let's watch {STREAMER} play {GAME} on {PLATFORM} instead! | {URL}",
  "🔄 No streamers? Fine, we'll watch {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "📡 Switching to: {STREAMER} ({GAME}) on {PLATFORM}. Someone go live already! | {URL}",
  "🎮 Nobody streaming? {STREAMER} is live playing {GAME} on {PLATFORM}! | {URL}",
  "🌟 While waiting for a real streamer, here's {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "📻 Channel surfing... landed on {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "🎪 The show must go on! Now watching: {STREAMER} play {GAME} on {PLATFORM} | {URL}",
  "🦥 Is anyone awake? Tuning into {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "🎯 Random channel acquired: {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "📺 *changes channel* Now showing: {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "🎲 Rolled the dice and got: {STREAMER} playing {GAME} on {PLATFORM} | {URL}",
  "🔮 The stream gods have chosen: {STREAMER} ({GAME}) on {PLATFORM} | {URL}",
  "⚡ Zapping to: {STREAMER} playing {GAME} on {PLATFORM} - come on, someone go live! | {URL}",
];

class RotationAnnouncer {
  constructor({ templates } = {}) {
    this.templates = templates || ROTATION_MESSAGES;
  }

  generate(streamer) {
    const template = this.templates[Math.floor(Math.random() * this.templates.length)];
    const platformName = streamer.platform === 'kick' ? 'Kick' : 'Twitch';

    return template
      .replace('{STREAMER}', streamer.displayName || streamer.username)
      .replace('{PLATFORM}', platformName)
      .replace('{URL}', streamer.url)
      .replace('{GAME}', streamer.game || 'Unknown');
  }
}

module.exports = RotationAnnouncer;
module.exports.ROTATION_MESSAGES = ROTATION_MESSAGES;
