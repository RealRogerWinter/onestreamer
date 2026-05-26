/**
 * Thin client for the /api/whitelist routes (ADR-0010, PR-W5).
 *
 * Uses the `makeApiCall` helper that AdminPanelV3 injects into child
 * components — preserves auth header threading + per-error log line in
 * the admin log panel. Same pattern as URLStreamManagement.
 */

export type Platform = 'twitch' | 'kick';
export type Mode = 'off' | 'blacklist' | 'whitelist';
export type EntryType = 'streamer' | 'category';
export type ListKind = 'allow' | 'block';

export interface ConfigRow {
  platform: Platform;
  mode: Mode;
  fallback_category: string | null;
  fallback_evergreen: string | null;
  drift_check_seconds: number;
  updated_at?: string;
  updated_by?: string | null;
}

export interface EntryRow {
  id: number;
  platform: Platform;
  entry_type: EntryType;
  value: string;
  list: ListKind;
  is_evergreen: boolean;
  risk_flag: string | null;
  notes: string | null;
  source: string | null;
  created_at: string;
  created_by: string | null;
  last_reviewed_at: string | null;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  platform: string | null;
  entry_type: string | null;
  value: string | null;
  before_json: string | null;
  after_json: string | null;
  context: string | null;
}

export interface ConfigResponse {
  config: Record<Platform, ConfigRow>;
  entries: Record<Platform, EntryRow[]>;
}

type ApiCall = (endpoint: string, opts?: RequestInit) => Promise<any>;

export function whitelistApi(makeApiCall: ApiCall) {
  return {
    getConfig: (): Promise<ConfigResponse> =>
      makeApiCall('/api/whitelist/config'),

    setMode: (platform: Platform, mode: Mode) =>
      makeApiCall('/api/whitelist/mode', {
        method: 'POST',
        body: JSON.stringify({ platform, mode }),
      }),

    setFallback: (
      platform: Platform,
      payload: { fallback_category?: string | null; fallback_evergreen?: string | null; drift_check_seconds?: number }
    ) =>
      makeApiCall('/api/whitelist/fallback', {
        method: 'POST',
        body: JSON.stringify({ platform, ...payload }),
      }),

    addEntry: (entry: {
      platform: Platform;
      entry_type: EntryType;
      value: string;
      list: ListKind;
      notes?: string;
      risk_flag?: string;
      is_evergreen?: boolean;
    }) =>
      makeApiCall('/api/whitelist/entry', {
        method: 'POST',
        body: JSON.stringify(entry),
      }),

    removeEntry: (id: number) =>
      makeApiCall(`/api/whitelist/entry/${id}`, { method: 'DELETE' }),

    markReviewed: (id: number) =>
      makeApiCall(`/api/whitelist/entry/${id}/review`, { method: 'POST' }),

    getAudit: (limit = 50, action?: string): Promise<{ rows: AuditRow[] }> => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (action) params.set('action', action);
      return makeApiCall(`/api/whitelist/audit?${params.toString()}`);
    },
  };
}
