// Best-effort extraction of a streamer username/handle from a source stream URL,
// extracted verbatim from ContinuousRecordingService.extractUsernameFromUrl.
// Pure (optional logger for the defensive catch). Returns null when no username
// can be determined (e.g. CDN/IVS playback URLs).

function usernameFromStreamUrl(sourceUrl, logger = null) {
  if (!sourceUrl) return null;

  try {
    // Twitch: https://twitch.tv/username, https://www.twitch.tv/username
    const twitchMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)/i);
    if (twitchMatch) {
      return twitchMatch[1];
    }

    // Kick: https://kick.com/username, https://www.kick.com/username
    const kickMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?kick\.com\/([a-zA-Z0-9_-]+)/i);
    if (kickMatch) {
      return kickMatch[1];
    }

    // YouTube: youtube.com/@username
    const youtubeMatch = sourceUrl.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9_-]+)/i);
    if (youtubeMatch) {
      return youtubeMatch[1];
    }

    // AWS IVS / CDN playback URLs — no extractable username.
    if (sourceUrl.includes('live-video.net') || sourceUrl.includes('playback.')) {
      return null;
    }

    // Generic fallback: last path segment, if it looks like a username.
    try {
      const url = new URL(sourceUrl);
      const pathParts = url.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        const lastPart = pathParts[pathParts.length - 1];
        if (/^[a-zA-Z0-9_-]+$/.test(lastPart) && !lastPart.includes('.')) {
          return lastPart;
        }
      }
    } catch (e) {
      // URL parsing failed
    }

    return null;
  } catch (error) {
    if (logger) logger.error('Error extracting username from URL:', error.message);
    return null;
  }
}

module.exports = { usernameFromStreamUrl };
