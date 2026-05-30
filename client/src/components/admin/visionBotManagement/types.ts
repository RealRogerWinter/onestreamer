import authService from '../../../services/AuthService';

export interface VisionBotConfig {
  enabled: boolean;
  streamerId: string | null;
  vision_prompt_template: string;
  transcription_frequency_s: number;
  transcription_duration_s: number;
  chatHistoryLimit?: number;
  image_resolution_px: number;
  image_quality: number;
  vision_model: string;
  max_response_tokens: number;
  temperature: number;
  max_bots_per_cycle: number;
  frame_retention_hours: number;
  allow_url_relay: boolean;
}

export interface DropReasons {
  no_egress?: number;
  no_frame?: number;
  no_bots?: number;
  groq_429?: number;
  groq_5xx?: number;
  moderated?: number;
  kill_switch?: number;
  url_relay_disallowed?: number;
  streamer_changed?: number;
  duplicate_session?: number;
  in_backoff?: number;
  unknown?: number;
  [k: string]: number | undefined;
}

export interface VisionBotStatus {
  enabled: boolean;
  isActive: boolean;
  currentStreamerId: string | null;
  in_flight?: boolean;
  cycles_attempted?: number;
  cycles_succeeded?: number;
  cycles_dropped?: DropReasons;
  last_groq_latency_ms?: number | null;
  consecutive_failures?: number;
  last_success_at?: string | null;
  last_error_reason?: string | null;
  last_groq_429_at?: string | null;
  kill_switch_env?: boolean;
  config: VisionBotConfig;
}

export interface VisionBotLog {
  timestamp: string;
  eventType?: string;
  event?: string;
  data?: any;
  [k: string]: any;
}

export interface ChatBotRow {
  id: number;
  name: string;
  is_enabled: boolean | number;
  vision_bot_enabled?: boolean | number;
  is_connected?: boolean;
}

export const SERVER_URL = process.env.REACT_APP_SERVER_URL || '';

export const DROP_REASON_LABELS: Record<string, string> = {
  no_egress: 'No egress recording',
  no_frame: 'No frame available',
  no_bots: 'No vision-enabled bots',
  groq_429: 'Groq rate-limited',
  groq_5xx: 'Groq server error',
  moderated: 'Frame moderated',
  kill_switch: 'Kill-switch active',
  url_relay_disallowed: 'URL-relay blocked',
  streamer_changed: 'Streamer changed mid-cycle',
  duplicate_session: 'Duplicate session id',
  in_backoff: 'In backoff window',
  unknown: 'Unknown',
};

export const buildAuthHeaders = (extra: Record<string, string> = {}) => {
  const adminKey = localStorage.getItem('adminKey') || '';
  const token = authService.getToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'x-admin-key': adminKey,
    ...extra,
  };
};

export const formatTimestamp = (iso?: string | null): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

export const formatRelative = (iso?: string | null): string => {
  if (!iso) return '—';
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return '—';
  const diff = Date.now() - date;
  if (diff < 0) return 'in the future';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};
