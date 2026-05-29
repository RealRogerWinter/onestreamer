// Shared formatting helpers for chat commands.

// Human-readable "Xh Ym" / "Ym" / "0m" duration from a seconds count.
// Extracted (verbatim) from the two identical inline copies in the !who and
// !stats handlers of commandParser.js.
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return '0m';
  }
}

module.exports = { formatDuration };
