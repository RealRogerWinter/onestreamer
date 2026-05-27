import React, { useState, useEffect, useRef, useCallback } from 'react';
import authService from '../../services/AuthService';
import './VisionBotManagement.css';

interface VisionBotConfig {
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

interface DropReasons {
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

interface VisionBotStatus {
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

interface VisionBotLog {
  timestamp: string;
  eventType?: string;
  event?: string;
  data?: any;
  [k: string]: any;
}

interface ChatBotRow {
  id: number;
  name: string;
  is_enabled: boolean | number;
  vision_bot_enabled?: boolean | number;
  is_connected?: boolean;
}

interface Props {
  addLog: (message: string) => void;
}

const SERVER_URL = process.env.REACT_APP_SERVER_URL || '';

const DROP_REASON_LABELS: Record<string, string> = {
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

const buildAuthHeaders = (extra: Record<string, string> = {}) => {
  const adminKey = localStorage.getItem('adminKey') || '';
  const token = authService.getToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'x-admin-key': adminKey,
    ...extra,
  };
};

const formatTimestamp = (iso?: string | null): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const formatRelative = (iso?: string | null): string => {
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

const VisionBotManagement: React.FC<Props> = ({ addLog }) => {
  const [status, setStatus] = useState<VisionBotStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [logs, setLogs] = useState<VisionBotLog[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);

  const [bots, setBots] = useState<ChatBotRow[]>([]);

  // Local editable copies of config — pushed back on blur, like MovieBot.
  const [promptDraft, setPromptDraft] = useState('');
  const [promptEditing, setPromptEditing] = useState(false);

  // Track which form fields have a pending value the user typed but
  // hasn't blurred yet. Updates are pushed on blur to mirror MovieBot's UX.
  const [draft, setDraft] = useState<Partial<VisionBotConfig>>({});
  const initialFromStatus = useRef(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/admin/visionbot/status`, {
        headers: buildAuthHeaders(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`status ${res.status}: ${text || 'request failed'}`);
      }
      const data: VisionBotStatus = await res.json();
      setStatus(data);
      setFetchError(null);
      if (!initialFromStatus.current && data.config) {
        setPromptDraft(data.config.vision_prompt_template || '');
        initialFromStatus.current = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
    }
  }, []);

  const fetchBots = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/chatbots`, {
        headers: buildAuthHeaders(),
      });
      if (!res.ok) throw new Error(`chatbots fetch failed: ${res.status}`);
      const data: ChatBotRow[] = await res.json();
      setBots(data);
    } catch (err) {
      // non-fatal — VisionBot panel still works without the per-bot list
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`VisionBot: could not load bot list (${msg})`);
    }
  }, [addLog]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/admin/visionbot/logs?limit=100`, {
        headers: buildAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data.logs) ? data.logs : []);
      }
    } catch (err) {
      // silent — log viewer just shows empty
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchBots();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus, fetchBots]);

  useEffect(() => {
    if (!logsOpen) return;
    fetchLogs();
    const id = setInterval(fetchLogs, 3000);
    return () => clearInterval(id);
  }, [logsOpen, fetchLogs]);

  const enable = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${SERVER_URL}/admin/visionbot/enable`, {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        addLog(`VisionBot enable failed: ${body.error || res.status}`);
      } else {
        addLog('VisionBot enabled');
        await fetchStatus();
      }
    } catch (err) {
      addLog(`VisionBot enable error: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${SERVER_URL}/admin/visionbot/disable`, {
        method: 'POST',
        headers: buildAuthHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        addLog(`VisionBot disable failed: ${body.error || res.status}`);
      } else {
        addLog('VisionBot disabled');
        await fetchStatus();
      }
    } catch (err) {
      addLog(`VisionBot disable error: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const pushConfig = async (patch: Partial<VisionBotConfig>) => {
    try {
      const res = await fetch(`${SERVER_URL}/admin/visionbot/config`, {
        method: 'POST',
        headers: buildAuthHeaders(),
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        addLog(`VisionBot config update failed: ${body.error || res.status}`);
        return false;
      }
      addLog(`VisionBot config updated: ${Object.keys(patch).join(', ')}`);
      await fetchStatus();
      return true;
    } catch (err) {
      addLog(`VisionBot config error: ${err}`);
      return false;
    }
  };

  const savePrompt = async () => {
    const ok = await pushConfig({ vision_prompt_template: promptDraft });
    if (ok) setPromptEditing(false);
  };

  const cancelPrompt = () => {
    setPromptDraft(status?.config?.vision_prompt_template || '');
    setPromptEditing(false);
  };

  const togglePerBotVision = async (botId: number, next: boolean) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/chatbots/${botId}`, {
        method: 'PUT',
        headers: buildAuthHeaders(),
        body: JSON.stringify({ vision_bot_enabled: next ? 1 : 0 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog(`Bot ${botId}: VisionBot ${next ? 'ENABLED' : 'DISABLED'}`);
      await fetchBots();
    } catch (err) {
      addLog(`Per-bot vision toggle error: ${err}`);
    }
  };

  // Helpers for the form's controlled inputs. Value priority:
  // local draft > server config > undefined.
  const fieldValue = <K extends keyof VisionBotConfig>(key: K): VisionBotConfig[K] | undefined => {
    if (draft[key] !== undefined) return draft[key] as VisionBotConfig[K];
    return status?.config?.[key];
  };

  const setDraftField = <K extends keyof VisionBotConfig>(key: K, value: VisionBotConfig[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const commitField = <K extends keyof VisionBotConfig>(key: K) => {
    if (draft[key] === undefined) return;
    pushConfig({ [key]: draft[key] } as Partial<VisionBotConfig>);
    setDraft(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const visionEligibleBots = bots.filter(b => b.is_enabled === true || b.is_enabled === 1);
  const visionEnabledCount = visionEligibleBots.filter(
    b => b.vision_bot_enabled === true || b.vision_bot_enabled === 1,
  ).length;

  const cyclesAttempted = status?.cycles_attempted ?? 0;
  const cyclesSucceeded = status?.cycles_succeeded ?? 0;
  const successPct = cyclesAttempted > 0
    ? Math.round((cyclesSucceeded / cyclesAttempted) * 100)
    : null;

  return (
    <div className="visionbot-management">
      <div className="visionbot-header">
        <h2>👁️ VisionBot &mdash; AI Frame Commentary</h2>
        <p className="visionbot-subtitle">
          Periodically samples a frame from the live egress recording, pairs it with
          the most recent transcription, and asks vision-enabled chatbots to react.
        </p>
      </div>

      {fetchError && (
        <div className="vb-banner vb-banner-error">
          ⚠️ Could not reach the VisionBot service: <code>{fetchError}</code>.
          Confirm the <code>x-admin-key</code> in <code>localStorage.adminKey</code> is set.
        </div>
      )}

      {status?.kill_switch_env && (
        <div className="vb-banner vb-banner-warn">
          🛑 <strong>VISIONBOT_KILL_SWITCH=1</strong> is set in the server environment.
          All cycles will drop with reason <code>kill_switch</code> regardless of
          enable state.
        </div>
      )}

      {/* Service status header */}
      <div className="vb-section">
        <div className="vb-status-row">
          <div className="vb-status-block">
            <div className="vb-label">Service</div>
            <span className={`vb-badge ${status?.enabled ? 'on' : 'off'}`}>
              {status?.enabled ? '● Enabled' : '○ Disabled'}
            </span>
          </div>
          <div className="vb-status-block">
            <div className="vb-label">Runtime</div>
            <span className={`vb-badge ${status?.isActive ? 'on' : 'off'}`}>
              {status?.isActive ? '● Active' : '○ Idle'}
            </span>
          </div>
          <div className="vb-status-block">
            <div className="vb-label">Current Stream</div>
            <div className="vb-value">{status?.currentStreamerId || '—'}</div>
          </div>
          <div className="vb-status-block">
            <div className="vb-label">In flight</div>
            <div className="vb-value">{status?.in_flight ? 'yes' : 'no'}</div>
          </div>
          <div className="vb-status-block">
            <div className="vb-label">Vision-enabled bots</div>
            <div className="vb-value">
              {visionEnabledCount} / {visionEligibleBots.length} eligible
            </div>
          </div>
        </div>

        <div className="vb-actions">
          {!status?.enabled ? (
            <button
              className="vb-btn vb-btn-primary"
              onClick={enable}
              disabled={busy}
            >
              ▶ Enable VisionBot
            </button>
          ) : (
            <button
              className="vb-btn vb-btn-danger"
              onClick={disable}
              disabled={busy}
            >
              ■ Disable VisionBot
            </button>
          )}
          <button
            className="vb-btn vb-btn-secondary"
            onClick={() => { setLogsOpen(true); }}
          >
            📋 Live Logs
          </button>
          <button
            className="vb-btn vb-btn-secondary"
            onClick={() => fetchStatus()}
            disabled={busy}
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="vb-section">
        <h3>Cycle stats</h3>
        <div className="vb-stats-grid">
          <div className="vb-stat">
            <div className="vb-label">Attempted</div>
            <div className="vb-stat-num">{cyclesAttempted}</div>
          </div>
          <div className="vb-stat">
            <div className="vb-label">Succeeded</div>
            <div className="vb-stat-num">{cyclesSucceeded}</div>
            {successPct !== null && (
              <div className="vb-stat-sub">{successPct}% success</div>
            )}
          </div>
          <div className="vb-stat">
            <div className="vb-label">Last Groq latency</div>
            <div className="vb-stat-num">
              {status?.last_groq_latency_ms != null
                ? `${status.last_groq_latency_ms} ms`
                : '—'}
            </div>
          </div>
          <div className="vb-stat">
            <div className="vb-label">Consecutive failures</div>
            <div className={`vb-stat-num ${(status?.consecutive_failures ?? 0) > 0 ? 'warn' : ''}`}>
              {status?.consecutive_failures ?? 0}
            </div>
          </div>
          <div className="vb-stat">
            <div className="vb-label">Last success</div>
            <div className="vb-stat-num small">{formatRelative(status?.last_success_at)}</div>
            <div className="vb-stat-sub">{formatTimestamp(status?.last_success_at)}</div>
          </div>
          <div className="vb-stat">
            <div className="vb-label">Last 429</div>
            <div className="vb-stat-num small">{formatRelative(status?.last_groq_429_at)}</div>
            <div className="vb-stat-sub">{formatTimestamp(status?.last_groq_429_at)}</div>
          </div>
        </div>

        {status?.last_error_reason && (
          <div className="vb-error-line">
            <strong>Last error:</strong> {status.last_error_reason}
          </div>
        )}

        <h4 className="vb-subheader">Drops by reason</h4>
        <div className="vb-drops">
          {Object.keys(DROP_REASON_LABELS).map(reason => {
            const count = status?.cycles_dropped?.[reason] ?? 0;
            return (
              <div key={reason} className={`vb-drop ${count > 0 ? 'has' : 'zero'}`}>
                <div className="vb-drop-count">{count}</div>
                <div className="vb-drop-label">{DROP_REASON_LABELS[reason]}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Prompt editor */}
      <div className="vb-section">
        <h3>Vision prompt template</h3>
        <p className="vb-help">
          Sent to the vision model alongside the captured frame and the last
          transcription chunk. The token <code>[TRANSCRIPTION_DATA]</code> is
          replaced with the audio context at cycle time.
        </p>
        {!promptEditing ? (
          <div className="vb-prompt-display">
            <pre className="vb-prompt-text">
              {status?.config?.vision_prompt_template || '(no prompt configured)'}
            </pre>
            <button
              className="vb-btn vb-btn-secondary"
              onClick={() => {
                setPromptDraft(status?.config?.vision_prompt_template || '');
                setPromptEditing(true);
              }}
            >
              ✏️ Edit prompt
            </button>
          </div>
        ) : (
          <div className="vb-prompt-edit">
            <textarea
              className="vb-textarea"
              value={promptDraft}
              onChange={e => setPromptDraft(e.target.value)}
              rows={8}
            />
            <div className="vb-edit-actions">
              <button className="vb-btn vb-btn-primary" onClick={savePrompt}>
                Save
              </button>
              <button className="vb-btn vb-btn-secondary" onClick={cancelPrompt}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Config grid */}
      <div className="vb-section">
        <h3>Configuration</h3>
        <div className="vb-config-grid">
          <label className="vb-field">
            <span>Frequency (s)</span>
            <input
              type="number"
              min={60}
              max={3600}
              value={fieldValue('transcription_frequency_s') ?? ''}
              onChange={e => setDraftField('transcription_frequency_s', parseInt(e.target.value, 10))}
              onBlur={() => commitField('transcription_frequency_s')}
            />
            <small>Seconds between vision cycles (min 60).</small>
          </label>

          <label className="vb-field">
            <span>Audio window (s)</span>
            <input
              type="number"
              min={10}
              max={120}
              value={fieldValue('transcription_duration_s') ?? ''}
              onChange={e => setDraftField('transcription_duration_s', parseInt(e.target.value, 10))}
              onBlur={() => commitField('transcription_duration_s')}
            />
            <small>How much spoken audio precedes each frame (10–120).</small>
          </label>

          <label className="vb-field">
            <span>Image resolution (px)</span>
            <input
              type="number"
              min={128}
              max={1024}
              value={fieldValue('image_resolution_px') ?? ''}
              onChange={e => setDraftField('image_resolution_px', parseInt(e.target.value, 10))}
              onBlur={() => commitField('image_resolution_px')}
            />
            <small>Long edge of the captured JPEG.</small>
          </label>

          <label className="vb-field">
            <span>Image quality (1–100)</span>
            <input
              type="number"
              min={10}
              max={100}
              value={fieldValue('image_quality') ?? ''}
              onChange={e => setDraftField('image_quality', parseInt(e.target.value, 10))}
              onBlur={() => commitField('image_quality')}
            />
            <small>JPEG quality. Lower = smaller payload to Groq.</small>
          </label>

          <label className="vb-field">
            <span>Vision model</span>
            <input
              type="text"
              value={fieldValue('vision_model') ?? ''}
              onChange={e => setDraftField('vision_model', e.target.value)}
              onBlur={() => commitField('vision_model')}
              placeholder="meta-llama/llama-4-scout-17b-16e-instruct"
            />
            <small>Groq vision-capable model id.</small>
          </label>

          <label className="vb-field">
            <span>Max response tokens</span>
            <input
              type="number"
              min={20}
              max={500}
              value={fieldValue('max_response_tokens') ?? ''}
              onChange={e => setDraftField('max_response_tokens', parseInt(e.target.value, 10))}
              onBlur={() => commitField('max_response_tokens')}
            />
            <small>Hard cap on the comment length the model can emit.</small>
          </label>

          <label className="vb-field">
            <span>Temperature</span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={2}
              value={fieldValue('temperature') ?? ''}
              onChange={e => setDraftField('temperature', parseFloat(e.target.value))}
              onBlur={() => commitField('temperature')}
            />
            <small>0 = deterministic, 1 = balanced, 2 = chaotic.</small>
          </label>

          <label className="vb-field">
            <span>Bots per cycle</span>
            <input
              type="number"
              min={1}
              max={5}
              value={fieldValue('max_bots_per_cycle') ?? ''}
              onChange={e => setDraftField('max_bots_per_cycle', parseInt(e.target.value, 10))}
              onBlur={() => commitField('max_bots_per_cycle')}
            />
            <small>How many vision-enabled bots dispatch per cycle (1–5).</small>
          </label>

          <label className="vb-field">
            <span>Frame retention (hours)</span>
            <input
              type="number"
              min={0}
              max={24}
              value={fieldValue('frame_retention_hours') ?? ''}
              onChange={e => setDraftField('frame_retention_hours', parseInt(e.target.value, 10))}
              onBlur={() => commitField('frame_retention_hours')}
            />
            <small>Captured JPEGs are kept this long for audit; flagged frames are kept separately for 30 days.</small>
          </label>

          <label className="vb-field vb-field-checkbox">
            <input
              type="checkbox"
              checked={fieldValue('allow_url_relay') === true}
              onChange={e => {
                setDraftField('allow_url_relay', e.target.checked);
                pushConfig({ allow_url_relay: e.target.checked });
                setDraft(prev => {
                  const next = { ...prev };
                  delete next.allow_url_relay;
                  return next;
                });
              }}
            />
            <span>Allow vision cycles during URL-relay streams</span>
            <small>Default off &mdash; relayed streams have unknown copyright/audit exposure.</small>
          </label>
        </div>
      </div>

      {/* Per-bot vision toggles */}
      <div className="vb-section">
        <h3>Per-bot opt-in</h3>
        <p className="vb-help">
          Only bots flagged here will be considered when the service dispatches a
          vision cycle. The service still also requires the global toggle above.
        </p>
        {visionEligibleBots.length === 0 ? (
          <div className="vb-empty">No enabled chatbots found.</div>
        ) : (
          <div className="vb-bot-list">
            {visionEligibleBots.map(bot => {
              const on = bot.vision_bot_enabled === true || bot.vision_bot_enabled === 1;
              return (
                <div key={bot.id} className={`vb-bot-row ${on ? 'on' : ''}`}>
                  <span className="vb-bot-name">
                    🤖 {bot.name}
                    {bot.is_connected && <span className="vb-bot-online">● online</span>}
                  </span>
                  <label className="vb-switch">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={e => togglePerBotVision(bot.id, e.target.checked)}
                    />
                    <span className="vb-switch-slider" />
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Logs modal */}
      {logsOpen && (
        <div className="vb-modal-overlay" onClick={() => setLogsOpen(false)}>
          <div className="vb-modal" onClick={e => e.stopPropagation()}>
            <div className="vb-modal-header">
              <h3>VisionBot live logs</h3>
              <div>
                <button
                  className="vb-btn vb-btn-secondary"
                  onClick={fetchLogs}
                >
                  Refresh
                </button>
                <button
                  className="vb-btn vb-btn-secondary"
                  onClick={() => setLogsOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="vb-modal-body">
              {logs.length === 0 ? (
                <div className="vb-empty">No logs yet.</div>
              ) : (
                <div className="vb-log-list">
                  {logs.map((log, i) => {
                    const type = log.eventType || log.event || 'log';
                    return (
                      <div key={i} className={`vb-log-entry vb-log-${type.toLowerCase()}`}>
                        <div className="vb-log-head">
                          <span className="vb-log-type">{type}</span>
                          <span className="vb-log-time">
                            {formatTimestamp(log.timestamp)}
                          </span>
                        </div>
                        <pre className="vb-log-body">
                          {JSON.stringify(log.data ?? log, null, 2)}
                        </pre>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="vb-modal-footer">
              <small>Auto-refreshing every 3s while open.</small>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VisionBotManagement;
