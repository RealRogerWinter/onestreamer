import { useState, useEffect, useRef } from 'react';
import {
  URLStream,
  Preset,
  ToolsStatus,
  ValidationResult,
  RandomRotationStatus,
  RandomSettings,
} from './types';

type MakeApiCall = (endpoint: string, options?: RequestInit) => Promise<any>;

// Owns all of URLStreamManagement's state, the data-loading effect (incl. the
// 10s refresh interval), and every action handler. Behavior is byte-for-byte
// the same as the original inline implementation — only the location changed.
export function useURLStreamData(makeApiCall?: MakeApiCall, addLog?: (message: string) => void) {
  // State
  const [streams, setStreams] = useState<URLStream[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [toolsStatus, setToolsStatus] = useState<ToolsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [activeTab, setActiveTab] = useState<'streams' | 'presets' | 'random'>('streams');

  // Random rotation state
  const [randomStatus, setRandomStatus] = useState<RandomRotationStatus | null>(null);
  const [isRandomLoading, setIsRandomLoading] = useState(false);
  const [showRandomSettings, setShowRandomSettings] = useState(false);
  // Keep a ref mirroring the panel-open flag. The 10s polling closure below is
  // created once on mount, so a plain `showRandomSettings` read inside it would
  // see the stale initial `false`; the ref always reflects the current value.
  const showRandomSettingsRef = useRef(showRandomSettings);
  showRandomSettingsRef.current = showRandomSettings;
  const [randomSettings, setRandomSettings] = useState<RandomSettings>({
    minRotationMinutes: 5,
    maxRotationMinutes: 20,
    minViewers: 499,
    maxViewers: 9999999,
    language: 'en',
    platforms: ['twitch', 'kick'] as string[],
    platformWeight: { twitch: 50, kick: 50 }
  });

  // Form state
  const [newUrl, setNewUrl] = useState('');
  const [selectedQuality, setSelectedQuality] = useState('best');
  const [displayName, setDisplayName] = useState('');
  const [autoReconnect, setAutoReconnect] = useState(true);

  // Validation state
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  // Preset form state
  const [showPresetForm, setShowPresetForm] = useState(false);
  const [presetName, setPresetName] = useState('');

  // Fetch random rotation status
  const fetchRandomStatus = async () => {
    if (!makeApiCall) return;

    try {
      const status = await makeApiCall('/api/random-stream/status');
      setRandomStatus(status);
      // Only sync the editable settings form from the server while the panel is
      // CLOSED. Otherwise the 10s poll overwrites the operator's in-progress
      // edits on every tick ("the values keep changing while I'm editing them").
      if (status.settings && !showRandomSettingsRef.current) {
        setRandomSettings({
          minRotationMinutes: status.settings.minRotationMinutes,
          maxRotationMinutes: status.settings.maxRotationMinutes,
          minViewers: status.settings.minViewers,
          maxViewers: status.settings.maxViewers,
          language: status.settings.language,
          platforms: status.settings.platforms || ['twitch', 'kick'],
          platformWeight: status.settings.platformWeight || { twitch: 50, kick: 50 }
        });
      }
    } catch (error) {
      console.error('Failed to fetch random rotation status:', error);
    }
  };

  // Fetch data
  const fetchData = async () => {
    if (!makeApiCall) return;

    try {
      // Fetch active streams
      const streamsResponse = await makeApiCall('/api/url-stream');
      if (streamsResponse.active) {
        setStreams(streamsResponse.active);
      }

      // Fetch presets
      try {
        const presetsResponse = await makeApiCall('/api/url-stream/presets');
        if (Array.isArray(presetsResponse)) {
          setPresets(presetsResponse);
        }
      } catch (e) {
        // Presets might not exist yet
      }

      // Fetch tools status
      const toolsResponse = await makeApiCall('/api/url-stream/tools/status');
      setToolsStatus(toolsResponse);

      // Fetch random rotation status
      await fetchRandomStatus();

    } catch (error) {
      console.error('Failed to fetch URL stream data:', error);
      addLog?.('Failed to load URL stream data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Refresh every 10 seconds
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Validate URL
  const handleValidate = async () => {
    if (!makeApiCall || !newUrl.trim()) return;

    setValidating(true);
    setValidationResult(null);

    try {
      const result = await makeApiCall('/api/url-stream/validate', {
        method: 'POST',
        body: JSON.stringify({ url: newUrl.trim() })
      });

      setValidationResult(result);

      if (result.valid) {
        if (result.title && !displayName) {
          setDisplayName(result.title);
        }
        addLog?.(`Validated: ${result.platform} - ${result.isLive ? 'LIVE' : 'Offline'}`);
      } else {
        addLog?.(`Validation failed: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      addLog?.('Failed to validate URL');
    } finally {
      setValidating(false);
    }
  };

  // Start stream
  const handleStartStream = async () => {
    if (!makeApiCall || !newUrl.trim()) return;

    setIsStarting(true);

    try {
      const result = await makeApiCall('/api/url-stream', {
        method: 'POST',
        body: JSON.stringify({
          url: newUrl.trim(),
          quality: selectedQuality,
          displayName: displayName || undefined,
          autoReconnect
        })
      });

      if (result.success) {
        addLog?.(`Started URL stream: ${result.urlId}`);
        // Reset form
        setNewUrl('');
        setDisplayName('');
        setValidationResult(null);
        fetchData();
      } else {
        addLog?.(`Failed to start stream: ${result.error}`);
      }
    } catch (error) {
      addLog?.('Failed to start URL stream');
    } finally {
      setIsStarting(false);
    }
  };

  // Stop stream
  const handleStopStream = async (urlId: string) => {
    if (!makeApiCall) return;

    try {
      const result = await makeApiCall(`/api/url-stream/${urlId}`, {
        method: 'DELETE'
      });

      if (result.success) {
        addLog?.(`Stopped URL stream: ${urlId}`);
        fetchData();
      }
    } catch (error) {
      addLog?.('Failed to stop stream');
    }
  };

  // Stop all streams
  const handleStopAll = async () => {
    if (!makeApiCall || !window.confirm('Stop all URL streams?')) return;

    try {
      await makeApiCall('/api/url-stream/stop-all', { method: 'POST' });
      addLog?.('Stopped all URL streams');
      fetchData();
    } catch (error) {
      addLog?.('Failed to stop all streams');
    }
  };

  // Save as preset
  const handleSavePreset = async () => {
    if (!makeApiCall || !presetName.trim() || !newUrl.trim()) return;

    try {
      const result = await makeApiCall('/api/url-stream/presets', {
        method: 'POST',
        body: JSON.stringify({
          name: presetName.trim(),
          sourceUrl: newUrl.trim(),
          platform: validationResult?.platform || 'unknown',
          quality: selectedQuality,
          displayName: displayName || undefined,
          autoReconnect
        })
      });

      if (result.success) {
        addLog?.(`Saved preset: ${presetName}`);
        setShowPresetForm(false);
        setPresetName('');
        fetchData();
      }
    } catch (error) {
      addLog?.('Failed to save preset');
    }
  };

  // Start from preset
  const handleStartPreset = async (presetId: number) => {
    if (!makeApiCall) return;

    try {
      const result = await makeApiCall(`/api/url-stream/presets/${presetId}/start`, {
        method: 'POST'
      });

      if (result.success) {
        addLog?.(`Started stream from preset`);
        fetchData();
      } else {
        addLog?.(`Failed: ${result.error}`);
      }
    } catch (error) {
      addLog?.('Failed to start preset');
    }
  };

  // Delete preset
  const handleDeletePreset = async (presetId: number) => {
    if (!makeApiCall || !window.confirm('Delete this preset?')) return;

    try {
      await makeApiCall(`/api/url-stream/presets/${presetId}`, {
        method: 'DELETE'
      });
      addLog?.('Deleted preset');
      fetchData();
    } catch (error) {
      addLog?.('Failed to delete preset');
    }
  };

  // Random rotation controls
  const handleStartRandomRotation = async () => {
    if (!makeApiCall) return;
    setIsRandomLoading(true);

    try {
      const result = await makeApiCall('/api/random-stream/start', { method: 'POST' });
      if (result.success) {
        addLog?.('Random rotation started');
        fetchRandomStatus();
      } else {
        addLog?.(`Failed to start: ${result.error}`);
      }
    } catch (error) {
      addLog?.('Failed to start random rotation');
    } finally {
      setIsRandomLoading(false);
    }
  };

  const handleStopRandomRotation = async () => {
    if (!makeApiCall || !window.confirm('Stop random rotation? Viewbot rotation will resume.')) return;
    setIsRandomLoading(true);

    try {
      const result = await makeApiCall('/api/random-stream/stop', { method: 'POST' });
      if (result.success) {
        addLog?.('Random rotation stopped');
        fetchRandomStatus();
      }
    } catch (error) {
      addLog?.('Failed to stop random rotation');
    } finally {
      setIsRandomLoading(false);
    }
  };

  const handleSkipToNext = async () => {
    if (!makeApiCall) return;
    setIsRandomLoading(true);

    try {
      const result = await makeApiCall('/api/random-stream/rotate', { method: 'POST' });
      if (result.success) {
        addLog?.(`Skipped to: ${result.stream?.displayName}`);
        fetchRandomStatus();
      } else {
        addLog?.(`Failed to skip: ${result.error}`);
      }
    } catch (error) {
      addLog?.('Failed to skip to next stream');
    } finally {
      setIsRandomLoading(false);
    }
  };

  const handleSaveRandomSettings = async () => {
    if (!makeApiCall) return;

    try {
      const result = await makeApiCall('/api/random-stream/settings', {
        method: 'PUT',
        body: JSON.stringify(randomSettings)
      });
      if (result.success) {
        addLog?.('Random rotation settings saved');
        setShowRandomSettings(false);
        fetchRandomStatus();
      }
    } catch (error) {
      addLog?.('Failed to save settings');
    }
  };

  return {
    // data state
    streams,
    presets,
    toolsStatus,
    loading,
    isStarting,
    activeTab,
    setActiveTab,
    // random state
    randomStatus,
    isRandomLoading,
    showRandomSettings,
    setShowRandomSettings,
    randomSettings,
    setRandomSettings,
    // form state
    newUrl,
    setNewUrl,
    selectedQuality,
    setSelectedQuality,
    displayName,
    setDisplayName,
    autoReconnect,
    setAutoReconnect,
    // validation state
    validating,
    validationResult,
    // preset form state
    showPresetForm,
    setShowPresetForm,
    presetName,
    setPresetName,
    // actions
    fetchData,
    handleValidate,
    handleStartStream,
    handleStopStream,
    handleStopAll,
    handleSavePreset,
    handleStartPreset,
    handleDeletePreset,
    handleStartRandomRotation,
    handleStopRandomRotation,
    handleSkipToNext,
    handleSaveRandomSettings,
  };
}
