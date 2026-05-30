import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SERVER_URL,
  buildAuthHeaders,
  VisionBotConfig,
  VisionBotStatus,
  VisionBotLog,
  ChatBotRow,
} from './types';

/**
 * Encapsulates all VisionBot data: status polling, the chatbot list, live
 * logs, and the enable/disable/config/per-bot mutations. The component layer
 * stays presentational. Behavior is preserved verbatim from the original
 * inline implementation.
 */
export function useVisionBotData(addLog: (message: string) => void) {
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

  return {
    // state
    status,
    fetchError,
    busy,
    logs,
    logsOpen,
    setLogsOpen,
    promptDraft,
    setPromptDraft,
    promptEditing,
    setPromptEditing,
    setDraft,
    // actions
    fetchStatus,
    fetchLogs,
    enable,
    disable,
    pushConfig,
    savePrompt,
    cancelPrompt,
    togglePerBotVision,
    fieldValue,
    setDraftField,
    commitField,
    // derived
    visionEligibleBots,
    visionEnabledCount,
    cyclesAttempted,
    cyclesSucceeded,
    successPct,
  };
}

export type UseVisionBotData = ReturnType<typeof useVisionBotData>;
