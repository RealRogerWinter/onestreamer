// Shared types + pure helpers extracted from AdminRecordingReview.
// No behavior changes: every value here is a verbatim move of the original
// inline definitions so the characterization test stays green.

export interface PlaybackInfo {
  sessionIds: string[];
  sessionCount: number;
  earliestRecording: number;
  latestRecording: number;
  totalDurationMs: number;
  totalChatMessages: number;
  streamUrl: string;
}

export interface TimelineData {
  startTime: number;
  endTime: number;
  events: any[];
  recordings: any[];
}

export type ViewMode = 'player' | 'settings';

// Time filter presets
export type TimeFilterPreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'last_hour'
  | 'last_6_hours'
  | 'last_24_hours'
  | 'custom';

export interface TimeFilterState {
  preset: TimeFilterPreset;
  customStart: number | null;
  customEnd: number | null;
}

// Helper to get time range for a preset
export const getPresetTimeRange = (
  preset: TimeFilterPreset
): { start: number | null; end: number | null } => {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  switch (preset) {
    case 'all':
      return { start: null, end: null };
    case 'today':
      return { start: startOfToday.getTime(), end: now };
    case 'yesterday':
      return { start: startOfYesterday.getTime(), end: startOfToday.getTime() };
    case 'last_hour':
      return { start: now - 60 * 60 * 1000, end: now };
    case 'last_6_hours':
      return { start: now - 6 * 60 * 60 * 1000, end: now };
    case 'last_24_hours':
      return { start: now - 24 * 60 * 60 * 1000, end: now };
    case 'custom':
      return { start: null, end: null }; // Will use custom values
    default:
      return { start: null, end: null };
  }
};

// Format duration for display
export const formatDuration = (ms: number): string => {
  if (!ms || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

// Format date for display
export const formatDate = (ms: number): string => {
  return new Date(ms).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// Format time (HH:MM:SS)
export const formatTime = (ms: number): string => {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// Get platform icon
export const getPlatformIcon = (platform: string, sourceUrl?: string): string => {
  const p = platform?.toLowerCase() || '';
  if (sourceUrl?.includes('playback.live-video.net')) return '🟢'; // Kick
  if (p.includes('twitch')) return '🟣';
  if (p.includes('kick')) return '🟢';
  return '📺';
};

// Get display name (clean up suffixes)
export const getDisplayName = (name: string, sourceUrl?: string): string => {
  let displayName = name || 'Unknown';
  displayName = displayName.replace(/\s*\([^)]+\)\s*$/, '').trim();
  if ((displayName === 'Unknown' || displayName === 'Kick') && sourceUrl) {
    const twitchMatch = sourceUrl.match(/twitch\.tv\/([^/?]+)/i);
    if (twitchMatch) displayName = twitchMatch[1];
  }
  return displayName;
};
