/**
 * WhitelistManagement — admin UI for the URL-relay content filter.
 *
 * ADR-0010 / PR-W5 / Phase 4. Tabs per platform (Twitch / Kick), each tab
 * showing: mode dropdown, fallback config, allow list, block list, add-entry
 * form, and a recent-audit preview. Mirrors the URLStreamManagement layout
 * conventions and uses the makeApiCall pattern AdminPanelV3 injects.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  whitelistApi,
  Platform,
  Mode,
  EntryType,
  ListKind,
  ConfigResponse,
  EntryRow,
  AuditRow,
} from '../../services/whitelistApi';

type ApiCall = (endpoint: string, opts?: RequestInit) => Promise<any>;

interface Props {
  makeApiCall: ApiCall;
  addLog: (msg: string) => void;
}

const PLATFORMS: Platform[] = ['twitch', 'kick'];

const WhitelistManagement: React.FC<Props> = ({ makeApiCall, addLog }) => {
  const api = useMemo(() => whitelistApi(makeApiCall), [makeApiCall]);

  const [activePlatform, setActivePlatform] = useState<Platform>('twitch');
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add-entry form state
  const [newEntryType, setNewEntryType] = useState<EntryType>('streamer');
  const [newList, setNewList] = useState<ListKind>('allow');
  const [newValue, setNewValue] = useState('');
  const [newRisk, setNewRisk] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // Fallback edit state
  const [fallbackCategory, setFallbackCategory] = useState('');
  const [fallbackEvergreen, setFallbackEvergreen] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfg, log] = await Promise.all([api.getConfig(), api.getAudit(50)]);
      setConfig(cfg);
      setAudit(log.rows || []);
      const platCfg = cfg.config && cfg.config[activePlatform];
      if (platCfg) {
        setFallbackCategory(platCfg.fallback_category || '');
        setFallbackEvergreen(platCfg.fallback_evergreen || '');
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load whitelist config');
      addLog(`Whitelist config load failed: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [api, activePlatform, addLog]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onModeChange = async (mode: Mode) => {
    try {
      await api.setMode(activePlatform, mode);
      addLog(`Whitelist: ${activePlatform} mode → ${mode}`);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const onSaveFallback = async () => {
    try {
      await api.setFallback(activePlatform, {
        fallback_category: fallbackCategory.trim() || null,
        fallback_evergreen: fallbackEvergreen.trim() || null,
      });
      addLog(`Whitelist: ${activePlatform} fallback updated`);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const onAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newValue.trim()) {
      setError('Value is required');
      return;
    }
    try {
      await api.addEntry({
        platform: activePlatform,
        entry_type: newEntryType,
        value: newValue.trim(),
        list: newList,
        risk_flag: newRisk.trim() || undefined,
        notes: newNotes.trim() || undefined,
      });
      addLog(`Whitelist: added ${newList} ${newEntryType} "${newValue}" to ${activePlatform}`);
      setNewValue('');
      setNewRisk('');
      setNewNotes('');
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const onRemoveEntry = async (id: number, value: string) => {
    if (!window.confirm(`Remove "${value}"?`)) return;
    try {
      await api.removeEntry(id);
      addLog(`Whitelist: removed entry id=${id} ("${value}")`);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const onMarkReviewed = async (id: number, value: string) => {
    try {
      await api.markReviewed(id);
      addLog(`Whitelist: marked id=${id} ("${value}") as reviewed`);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const platConfig = config?.config?.[activePlatform];
  const platEntries: EntryRow[] = config?.entries?.[activePlatform] || [];
  const allowList = platEntries.filter((r) => r.list === 'allow');
  const blockList = platEntries.filter((r) => r.list === 'block');

  return (
    <div style={{ padding: '16px', color: '#e0e0e0' }}>
      <h2 style={{ marginTop: 0 }}>URL Relay Whitelist (ADR-0010)</h2>
      <p style={{ opacity: 0.75, fontSize: 14, marginTop: -8 }}>
        Per-platform content filter. Direct submissions and random-rotation
        candidates are gated by the policy you set here. CCL/mature-flag gates
        always run regardless of mode.
      </p>

      {/* Platform tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {PLATFORMS.map((p) => (
          <button
            key={p}
            onClick={() => setActivePlatform(p)}
            style={{
              padding: '8px 16px',
              background: activePlatform === p ? '#4a4ade' : '#2a2a3a',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {p}
          </button>
        ))}
        <button
          onClick={refresh}
          disabled={loading}
          style={{ padding: '8px 12px', marginLeft: 'auto', background: '#3a3a4a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#5a2a2a', padding: 8, borderRadius: 4, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {platConfig && (
        <div style={{ background: '#1f1f2e', padding: 16, borderRadius: 6, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Mode</h3>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <select
              value={platConfig.mode}
              onChange={(e) => onModeChange(e.target.value as Mode)}
              style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
            >
              <option value="off">off (no filter)</option>
              <option value="blacklist">blacklist</option>
              <option value="whitelist">whitelist</option>
            </select>
            <small style={{ opacity: 0.7 }}>
              {platConfig.mode === 'off' && 'CCL/mature gates only — anything else passes through'}
              {platConfig.mode === 'blacklist' && 'Block listed streamers + categories, allow everything else'}
              {platConfig.mode === 'whitelist' && 'Allow only listed streamers + categories (strict)'}
            </small>
          </div>

          <h3 style={{ fontSize: 16 }}>Fallback (when no in-policy streamer is live)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Fallback category (e.g. Minecraft)"
              value={fallbackCategory}
              onChange={(e) => setFallbackCategory(e.target.value)}
              style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
            />
            <input
              placeholder="Fallback evergreen channel (e.g. bobross)"
              value={fallbackEvergreen}
              onChange={(e) => setFallbackEvergreen(e.target.value)}
              style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
            />
            <button
              onClick={onSaveFallback}
              style={{ padding: '8px 12px', background: '#3a8a3a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >
              Save fallback
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            Drift check interval: {platConfig.drift_check_seconds}s
          </div>
        </div>
      )}

      <div style={{ background: '#1f1f2e', padding: 16, borderRadius: 6, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Add entry</h3>
        <form onSubmit={onAddEntry} style={{ display: 'grid', gridTemplateColumns: 'auto auto 2fr 1fr 2fr auto', gap: 8, alignItems: 'center' }}>
          <select value={newEntryType} onChange={(e) => setNewEntryType(e.target.value as EntryType)} style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}>
            <option value="streamer">streamer</option>
            <option value="category">category</option>
          </select>
          <select value={newList} onChange={(e) => setNewList(e.target.value as ListKind)} style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}>
            <option value="allow">allow</option>
            <option value="block">block</option>
          </select>
          <input
            placeholder={newEntryType === 'streamer' ? 'login (e.g. cohhcarnage)' : 'category name (e.g. Minecraft)'}
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
          />
          <input
            placeholder="risk flag (optional)"
            value={newRisk}
            onChange={(e) => setNewRisk(e.target.value)}
            style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
          />
          <input
            placeholder="notes (optional)"
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            style={{ padding: 8, background: '#2a2a3a', color: '#fff', border: '1px solid #444', borderRadius: 4 }}
          />
          <button type="submit" style={{ padding: '8px 12px', background: '#4a4ade', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            Add
          </button>
        </form>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <EntryTable title="Allow list" rows={allowList} onRemove={onRemoveEntry} onReview={onMarkReviewed} />
        <EntryTable title="Block list" rows={blockList} onRemove={onRemoveEntry} onReview={onMarkReviewed} />
      </div>

      <div style={{ background: '#1f1f2e', padding: 16, borderRadius: 6, marginTop: 16 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Recent audit log</h3>
        {audit.length === 0 && <p style={{ opacity: 0.6 }}>No audit entries yet.</p>}
        {audit.length > 0 && (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #333' }}>
                <th style={{ padding: 4 }}>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Platform</th>
                <th>Value</th>
                <th>Context</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid #222' }}>
                  <td style={{ padding: 4, whiteSpace: 'nowrap' }}>{row.at}</td>
                  <td>{row.actor || '—'}</td>
                  <td>{row.action}</td>
                  <td>{row.platform || '—'}</td>
                  <td>{row.value || '—'}</td>
                  <td style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.context || row.after_json || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

interface EntryTableProps {
  title: string;
  rows: EntryRow[];
  onRemove: (id: number, value: string) => void;
  onReview: (id: number, value: string) => void;
}

const EntryTable: React.FC<EntryTableProps> = ({ title, rows, onRemove, onReview }) => {
  return (
    <div style={{ background: '#1f1f2e', padding: 12, borderRadius: 6 }}>
      <h3 style={{ marginTop: 0, fontSize: 14 }}>{title} ({rows.length})</h3>
      {rows.length === 0 && <p style={{ opacity: 0.5, fontSize: 12 }}>No entries.</p>}
      {rows.length > 0 && (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #333' }}>
              <th>Type</th>
              <th>Value</th>
              <th>Risk</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderBottom: '1px solid #222' }}>
                <td>{row.entry_type}{row.is_evergreen ? ' 🌲' : ''}</td>
                <td style={{ fontWeight: 600 }}>{row.value}</td>
                <td>{row.risk_flag || '—'}</td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.notes || ''}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button onClick={() => onReview(row.id, row.value)} style={{ fontSize: 11, padding: '2px 6px', background: '#3a3a4a', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', marginRight: 4 }}>
                    ✓
                  </button>
                  <button onClick={() => onRemove(row.id, row.value)} style={{ fontSize: 11, padding: '2px 6px', background: '#7a3a3a', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default WhitelistManagement;
