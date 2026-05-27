// AIModerationManagement.tsx — admin events viewer for the AI moderation
// pipeline (PR-M5 of ADR-0013).
//
// This is the minimum viable admin surface for the AI moderation system:
// a paginated list of moderation_events rows with a filter by decision, an
// expandable detail panel per row showing the full transcript / matched
// terms / Stage 2 + Stage 3 verdicts, and a "Reverse" button on auto_ban
// rows that hits POST /api/moderation-ai/events/:id/reverse.
//
// Deferred to a follow-up PR (to keep this PR focused on validating the
// API surface end-to-end):
//   - Full terms-management CRUD UI (admins can use POST /api/moderation-ai/terms
//     via curl until the UI lands).
//   - Per-category config UI (similarly POSTable).
//   - Live socket subscription to 'moderation-event-created' for real-time
//     refresh (the current UI does a polling refresh on a Refresh click).
//   - Streamer-side AIModerationBanner.tsx (renders on receiving the
//     'moderation-streamer-banner' socket event — needs a host component
//     that sits on every page, separate from the admin panel).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  aiModerationApi,
  ModerationDecision,
  ModerationEventRow,
} from '../../services/aiModerationApi';

type ApiCall = (endpoint: string, opts?: RequestInit) => Promise<any>;

interface Props {
  makeApiCall: ApiCall;
}

const DECISION_LABELS: Record<ModerationDecision, string> = {
  clean: 'Clean',
  admin_review: 'Admin review',
  auto_ban: 'Auto-banned',
  auto_skip: 'Auto-skipped (URL relay)',
  mb_output_dropped: 'MovieBot output dropped',
  deferred_degraded: 'Deferred (degraded)',
};

const DECISION_BADGE_COLOR: Record<ModerationDecision, string> = {
  clean: '#5a5a5a',
  admin_review: '#c9a227',
  auto_ban: '#b32424',
  auto_skip: '#7a3aa8',
  mb_output_dropped: '#3a7aa8',
  deferred_degraded: '#777',
};

const DECISION_FILTERS: Array<ModerationDecision | 'all'> = [
  'all',
  'admin_review',
  'auto_ban',
  'auto_skip',
  'mb_output_dropped',
  'deferred_degraded',
];

const PAGE_SIZE = 25;

function formatTs(ts: string | null): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function safeJsonParse(raw: string | null): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export default function AIModerationManagement({ makeApiCall }: Props) {
  const api = useMemo(() => aiModerationApi(makeApiCall), [makeApiCall]);
  const [events, setEvents] = useState<ModerationEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionFilter, setDecisionFilter] = useState<ModerationDecision | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [reversing, setReversing] = useState<number | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: any = { limit: PAGE_SIZE, offset };
      if (decisionFilter !== 'all') params.decision = decisionFilter;
      const resp = await api.listEvents(params);
      setEvents(resp.rows || []);
    } catch (e: any) {
      setError((e && e.message) || String(e));
    } finally {
      setLoading(false);
    }
  }, [api, decisionFilter, offset]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const handleReverse = useCallback(async (eventId: number) => {
    const reason = window.prompt('Reversal reason (optional, shown in audit log):') ?? undefined;
    setReversing(eventId);
    try {
      await api.reverseEvent(eventId, reason);
      await fetchEvents();
    } catch (e: any) {
      setError((e && e.message) || String(e));
    } finally {
      setReversing(null);
    }
  }, [api, fetchEvents]);

  return (
    <div style={{ padding: '16px 24px', color: '#e8e8e8' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>AI Moderation Events</h2>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 13 }}>
          Filter:{' '}
          <select
            value={decisionFilter}
            onChange={(e) => { setOffset(0); setDecisionFilter(e.target.value as any); }}
            style={selectStyle}
          >
            {DECISION_FILTERS.map((d) => (
              <option key={d} value={d}>
                {d === 'all' ? 'All decisions' : DECISION_LABELS[d as ModerationDecision]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={fetchEvents} style={btnStyle} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div style={errorBoxStyle}>Error: {error}</div>}

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>When</th>
            <th style={thStyle}>Decision</th>
            <th style={thStyle}>Type</th>
            <th style={thStyle}>Streamer</th>
            <th style={thStyle}>Excerpt</th>
            <th style={thStyle}>Action</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && !loading && (
            <tr>
              <td colSpan={6} style={emptyCellStyle}>No events.</td>
            </tr>
          )}
          {events.map((e) => {
            const open = expandedId === e.id;
            return (
              <React.Fragment key={e.id}>
                <tr
                  style={{ ...rowStyle, opacity: e.reversed_at ? 0.55 : 1 }}
                  onClick={() => setExpandedId(open ? null : e.id)}
                >
                  <td style={tdStyle}>{formatTs(e.created_at)}</td>
                  <td style={tdStyle}>
                    <span style={{ ...badgeStyle, background: DECISION_BADGE_COLOR[e.final_decision] }}>
                      {DECISION_LABELS[e.final_decision]}
                    </span>
                    {e.reversed_at && <span style={reversedBadgeStyle}>reversed</span>}
                  </td>
                  <td style={tdStyle}>{e.stream_type}</td>
                  <td style={tdStyle}>
                    {e.external_login
                      || (e.streamer_id ? `socket ${e.streamer_id.slice(0, 8)}…` : '—')}
                  </td>
                  <td style={{ ...tdStyle, ...excerptCellStyle }}>{e.transcript_excerpt}</td>
                  <td style={tdStyle} onClick={(ev) => ev.stopPropagation()}>
                    {e.final_decision === 'auto_ban' && !e.reversed_at && (
                      <button
                        onClick={() => handleReverse(e.id)}
                        style={dangerBtnStyle}
                        disabled={reversing === e.id}
                      >
                        {reversing === e.id ? 'Reversing…' : 'Reverse ban'}
                      </button>
                    )}
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={6} style={detailCellStyle}>
                      <EventDetail event={e} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          style={btnStyle}
          disabled={offset === 0 || loading}
        >
          ← Prev
        </button>
        <button
          onClick={() => setOffset(offset + PAGE_SIZE)}
          style={btnStyle}
          disabled={events.length < PAGE_SIZE || loading}
        >
          Next →
        </button>
        <span style={{ alignSelf: 'center', color: '#888', fontSize: 13 }}>
          Page offset: {offset}
        </span>
      </div>
    </div>
  );
}

function EventDetail({ event }: { event: ModerationEventRow }) {
  const matched = safeJsonParse(event.matched_terms_json) || [];
  const stage2 = safeJsonParse(event.stage2_verdict_json);
  const stage3 = safeJsonParse(event.stage3_verdict_json);
  const models = safeJsonParse(event.ml_model_versions_json);

  return (
    <div style={{ padding: 12, background: '#202020', borderRadius: 4 }}>
      <Section label="Surrounding context (60s)">
        <div style={preStyle}>{event.surrounding_context || <em style={{ color: '#888' }}>(none)</em>}</div>
      </Section>
      <Section label={`Stage 1 matches (${matched.length})`}>
        {matched.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {matched.map((m: any, i: number) => (
              <li key={i}>
                <code style={codeStyle}>{m.term}</code> — {m.category} ({m.severity})
              </li>
            ))}
          </ul>
        ) : (
          <em style={{ color: '#888' }}>(no Stage 1 hits)</em>
        )}
      </Section>
      <Section label="Stage 2 verdict (Groq)">
        <pre style={preStyle}>{stage2 ? JSON.stringify(stage2, null, 2) : '(no Stage 2 call)'}</pre>
      </Section>
      <Section label="Stage 3 verdict (OpenAI omni-moderation)">
        <pre style={preStyle}>{stage3 ? JSON.stringify(stage3, null, 2) : '(no Stage 3 call)'}</pre>
      </Section>
      <Section label="Action taken">
        <code style={codeStyle}>{event.action_taken || '(none)'}</code>
      </Section>
      {event.reversed_at && (
        <Section label="Reversed">
          <div>
            {formatTs(event.reversed_at)} by <code style={codeStyle}>{event.reversed_by}</code>
            {event.reversal_reason && (
              <div style={{ marginTop: 4, color: '#bbb' }}>“{event.reversal_reason}”</div>
            )}
          </div>
        </Section>
      )}
      <Section label="Models">
        <code style={codeStyle}>{models ? JSON.stringify(models) : '—'}</code>
      </Section>
      <Section label="Session / streamer">
        <div style={{ fontSize: 12, color: '#bbb' }}>
          stream_session_id={event.stream_session_id || '—'}, streamer_id={event.streamer_id || '—'},
          stream_type={event.stream_type}
          {event.external_platform && (
            <>, platform={event.external_platform}, login={event.external_login || '—'}</>
          )}
        </div>
      </Section>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: '#aaa', fontSize: 12 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #333', fontSize: 12, color: '#aaa', textTransform: 'uppercase' };
const tdStyle: React.CSSProperties = { padding: '8px 6px', borderBottom: '1px solid #222', fontSize: 13, verticalAlign: 'top' };
const rowStyle: React.CSSProperties = { cursor: 'pointer' };
const excerptCellStyle: React.CSSProperties = { maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const detailCellStyle: React.CSSProperties = { background: '#181818', padding: 0 };
const btnStyle: React.CSSProperties = { background: '#2a2a2a', color: '#e8e8e8', border: '1px solid #444', padding: '6px 12px', borderRadius: 4, cursor: 'pointer' };
const dangerBtnStyle: React.CSSProperties = { ...btnStyle, background: '#5a1818', border: '1px solid #b32424' };
const selectStyle: React.CSSProperties = { background: '#2a2a2a', color: '#e8e8e8', border: '1px solid #444', padding: '4px 6px', borderRadius: 4 };
const badgeStyle: React.CSSProperties = { display: 'inline-block', padding: '2px 6px', borderRadius: 3, color: '#fff', fontSize: 11, fontWeight: 600 };
const reversedBadgeStyle: React.CSSProperties = { marginLeft: 6, padding: '2px 6px', background: '#444', borderRadius: 3, fontSize: 11, color: '#ddd' };
const preStyle: React.CSSProperties = { background: '#111', padding: 8, borderRadius: 3, fontSize: 12, color: '#cfc', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 };
const codeStyle: React.CSSProperties = { background: '#111', padding: '1px 5px', borderRadius: 2, fontSize: 12, color: '#cfc' };
const emptyCellStyle: React.CSSProperties = { padding: 24, textAlign: 'center', color: '#888' };
const errorBoxStyle: React.CSSProperties = { background: '#3a1818', color: '#fcc', padding: '8px 12px', borderRadius: 4, marginBottom: 12, border: '1px solid #6a2828' };
