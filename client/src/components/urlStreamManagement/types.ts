// Shared types for the URL Stream Management feature. Extracted verbatim from
// the original URLStreamManagement.tsx so the data shapes are unchanged.

export interface URLStream {
  urlId: string;
  sourceUrl: string;
  platform: string;
  displayName: string;
  quality: string;
  status: string;
  startedAt: number;
  uptime: number;
  reconnectAttempts: number;
  health?: {
    overall: number;
    sourceStatus: string;
    ffmpegStatus: string;
  };
}

export interface Preset {
  id: number;
  name: string;
  source_url: string;
  platform: string;
  quality: string;
  display_name: string;
  auto_reconnect: boolean;
  use_count: number;
  last_used: string;
}

export interface ValidationResult {
  valid: boolean;
  isLive: boolean;
  platform: string;
  title: string;
  qualities: string[];
  error?: string;
}

export interface ToolsStatus {
  streamlink: boolean;
  ytdlp: boolean;
}

export interface RandomRotationStream {
  urlId: string;
  displayName: string;
  platform: string;
  streamerUsername: string;
  streamerDisplayName: string;
  game: string;
  title: string;
  viewers: number;
  url: string;
  startedAt: number;
  // Legacy compatibility
  twitchUsername?: string;
  twitchDisplayName?: string;
}

export interface RandomRotationStatus {
  enabled: boolean;
  currentStream: RandomRotationStream | null;
  stats: {
    totalRotations: number;
    startedAt: number | null;
    streamHistory: RandomRotationStream[];
    uptime: number;
  };
  settings: {
    minRotationMinutes: number;
    maxRotationMinutes: number;
    language: string;
    minViewers: number;
    maxViewers: number;
    blockedCategories: string[];
    platforms: string[];
    platformWeight: { twitch: number; kick: number };
  };
  twitchConfigured: boolean;
  kickConfigured: boolean;
  availablePlatforms: Array<{ id: string; name: string; icon: string }>;
}

export interface RandomSettings {
  minRotationMinutes: number;
  maxRotationMinutes: number;
  minViewers: number;
  maxViewers: number;
  language: string;
  platforms: string[];
  platformWeight: { twitch: number; kick: number };
}

export interface URLStreamManagementProps {
  makeApiCall?: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog?: (message: string) => void;
}

// Shared presentational helpers used across the sub-views. Pure functions,
// behavior identical to the originals.

export const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
};

export const getPlatformStyle = (platform: string): { color: string; bg: string } => {
  const styles: Record<string, { color: string; bg: string }> = {
    twitch: { color: '#9146ff', bg: 'rgba(145, 70, 255, 0.2)' },
    youtube: { color: '#ff0000', bg: 'rgba(255, 0, 0, 0.2)' },
    kick: { color: '#53fc18', bg: 'rgba(83, 252, 24, 0.2)' },
    facebook: { color: '#1877f2', bg: 'rgba(24, 119, 242, 0.2)' },
    unknown: { color: '#64ffda', bg: 'rgba(100, 255, 218, 0.2)' }
  };
  return styles[platform.toLowerCase()] || styles.unknown;
};

export const getHealthColor = (health: number): string => {
  if (health >= 80) return '#22c55e';
  if (health >= 50) return '#eab308';
  return '#ef4444';
};
