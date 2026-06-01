/**
 * fartConstants — single source of truth for the 'fart' auto-trigger item's
 * soundboard URL and StreamBot chat line.
 *
 * The 'fart' item is force-auto-triggered (ItemUseService sets isAutoTrigger
 * for 'fart'), so the live path is AutoTriggerHandler. These constants used to
 * be duplicated as string literals across AutoTriggerHandler and a now-deleted
 * dead fart branch in RegularHandler; centralised here so the URL/string live
 * in one place.
 *
 * NOTE: SoundFxService keeps its own copy of the URL in `itemSpecificSounds`
 * (a Set used to bypass the soundboard queue); that lookup is intentionally
 * left as-is to avoid a cross-cutting import into that service.
 */

// 101soundboards URL queued when the fart item fires.
const FART_SOUNDBOARD_URL = 'https://www.101soundboards.com/sounds/23972494-fart-reverb';

// StreamBot chat line announcing the fart. `{user}` is the triggering username.
const FART_CHAT_MESSAGE = '💨 {user} let one rip!';

/**
 * Build the fart chat line for a given username.
 * @param {string} username
 * @returns {string}
 */
function fartChatMessage(username) {
    return FART_CHAT_MESSAGE.replace('{user}', username);
}

module.exports = { FART_SOUNDBOARD_URL, FART_CHAT_MESSAGE, fartChatMessage };
