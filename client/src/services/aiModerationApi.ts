/**
 * Thin client for the /api/moderation-ai routes (PR-M5 of ADR-0013).
 *
 * Mirrors the whitelistApi.ts pattern — accepts a makeApiCall function
 * from AdminPanelV3 so auth headers + error logging are threaded
 * consistently.
 */

export type ModerationCategory = 'hate_speech' | 'threat' | 'sexual';
export type ModerationSeverity = 'hard' | 'soft';
export type ModerationDecision =
  | 'clean'
  | 'admin_review'
  | 'auto_ban'
  | 'auto_skip'
  | 'mb_output_dropped'
  | 'deferred_degraded';
export type ModerationStreamType = 'webcam' | 'viewbot' | 'url-relay' | 'moviebot-output';
export type ModerationActionMode = 'auto_ban' | 'admin_review' | 'mute_pending';

export interface ModerationEventRow {
  id: number;
  created_at: string;
  stream_session_id: string | null;
  streamer_id: string | null;
  stream_type: ModerationStreamType;
  external_platform: string | null;
  external_user_id: string | null;
  external_login: string | null;
  transcript_chunk_id: number | null;
  transcript_excerpt: string;
  surrounding_context: string | null;
  matched_terms_json: string | null;
  stage1_hit: number;
  stage2_verdict_json: string | null;
  stage2_risk_level: number | null;
  stage2_categories_json: string | null;
  stage3_verdict_json: string | null;
  final_decision: ModerationDecision;
  action_taken: string | null;
  actor: string;
  automated_decision: number;
  legal_basis: string | null;
  redress_url: string | null;
  human_reviewed_at: string | null;
  human_reviewer_id: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  whisper_avg_logprob: number | null;
  whisper_no_speech_prob: number | null;
  ml_model_versions_json: string | null;
}

export interface ModerationTermRow {
  id: number;
  term: string;
  normalized_form: string;
  category: ModerationCategory;
  severity: ModerationSeverity;
  source: 'embedded' | 'admin';
  enabled: number;
  created_by: string | null;
  created_at: string;
  notes: string | null;
}

export interface ModerationConfigRow {
  category: ModerationCategory;
  enabled: number;
  action_mode: ModerationActionMode;
  stage2_threshold: number;
  stage3_required: number;
  updated_at: string;
  updated_by: string | null;
}

type ApiCall = (endpoint: string, opts?: RequestInit) => Promise<any>;

export function aiModerationApi(makeApiCall: ApiCall) {
  return {
    listEvents: (params: { limit?: number; offset?: number; decision?: ModerationDecision } = {}) => {
      const q = new URLSearchParams();
      if (params.limit) q.set('limit', String(params.limit));
      if (params.offset) q.set('offset', String(params.offset));
      if (params.decision) q.set('decision', params.decision);
      const qs = q.toString();
      return makeApiCall(`/api/moderation-ai/events${qs ? `?${qs}` : ''}`) as Promise<{
        rows: ModerationEventRow[];
        limit: number;
        offset: number;
      }>;
    },

    getEvent: (id: number) =>
      makeApiCall(`/api/moderation-ai/events/${id}`) as Promise<{ event: ModerationEventRow }>,

    reverseEvent: (id: number, reason?: string) =>
      makeApiCall(`/api/moderation-ai/events/${id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }) as Promise<{ ok: true; event_id: number; user_unbanned: boolean }>,

    listTerms: (params: { enabled?: boolean; category?: ModerationCategory; source?: 'embedded' | 'admin' } = {}) => {
      const q = new URLSearchParams();
      if (params.enabled !== undefined) q.set('enabled', String(params.enabled));
      if (params.category) q.set('category', params.category);
      if (params.source) q.set('source', params.source);
      const qs = q.toString();
      return makeApiCall(`/api/moderation-ai/terms${qs ? `?${qs}` : ''}`) as Promise<{ rows: ModerationTermRow[] }>;
    },

    addTerm: (term: { term: string; category: ModerationCategory; severity?: ModerationSeverity; notes?: string }) =>
      makeApiCall('/api/moderation-ai/terms', {
        method: 'POST',
        body: JSON.stringify(term),
      }) as Promise<{ id: number; normalized_form: string }>,

    setTermEnabled: (id: number, enabled: boolean) =>
      makeApiCall(`/api/moderation-ai/terms/${id}/enabled`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }) as Promise<{ ok: true; id: number }>,

    removeTerm: (id: number) =>
      makeApiCall(`/api/moderation-ai/terms/${id}`, { method: 'DELETE' }) as Promise<{ ok: true; id: number }>,

    getTermsAudit: (limit = 50) =>
      makeApiCall(`/api/moderation-ai/terms/audit?limit=${limit}`) as Promise<{ rows: any[] }>,

    getConfig: () =>
      makeApiCall('/api/moderation-ai/config') as Promise<{ rows: ModerationConfigRow[] }>,

    setConfig: (payload: {
      category: ModerationCategory;
      action_mode?: ModerationActionMode;
      stage2_threshold?: number;
      stage3_required?: boolean;
      enabled?: boolean;
    }) =>
      makeApiCall('/api/moderation-ai/config', {
        method: 'POST',
        body: JSON.stringify(payload),
      }) as Promise<{ ok: true; category: ModerationCategory }>,

    getGlobalConfig: () =>
      makeApiCall('/api/moderation-ai/global-config') as Promise<{
        row: { enforce: number; updated_at: string | null; updated_by: string | null };
      }>,

    setEnforce: (enforce: boolean) =>
      makeApiCall('/api/moderation-ai/global-config', {
        method: 'POST',
        body: JSON.stringify({ enforce }),
      }) as Promise<{ ok: true; enforce: boolean }>,
  };
}
