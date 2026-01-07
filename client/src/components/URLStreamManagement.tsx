import React, { useState, useEffect } from 'react';
import {
  Link2,
  Play,
  Square,
  RefreshCw,
  Clock,
  CheckCircle,
  AlertCircle,
  ExternalLink,
  Trash2,
  Plus,
  Save,
  Activity,
  Wifi,
  WifiOff,
  Star,
  Settings,
  Shuffle,
  SkipForward,
  Sliders,
  History
} from 'lucide-react';
import './URLStreamManagement.css';

interface URLStream {
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

interface Preset {
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

interface ValidationResult {
  valid: boolean;
  isLive: boolean;
  platform: string;
  title: string;
  qualities: string[];
  error?: string;
}

interface ToolsStatus {
  streamlink: boolean;
  ytdlp: boolean;
}

interface RandomRotationStream {
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

interface RandomRotationStatus {
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

interface URLStreamManagementProps {
  makeApiCall?: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog?: (message: string) => void;
}

const URLStreamManagement: React.FC<URLStreamManagementProps> = ({ makeApiCall, addLog }) => {
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
  const [randomSettings, setRandomSettings] = useState({
    minRotationMinutes: 5,
    maxRotationMinutes: 10,
    minViewers: 1,
    maxViewers: 999999,
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
      if (status.settings) {
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

  // Format uptime
  const formatUptime = (ms: number): string => {
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

  // Get platform icon/color
  const getPlatformStyle = (platform: string) => {
    const styles: Record<string, { color: string; bg: string }> = {
      twitch: { color: '#9146ff', bg: 'rgba(145, 70, 255, 0.2)' },
      youtube: { color: '#ff0000', bg: 'rgba(255, 0, 0, 0.2)' },
      kick: { color: '#53fc18', bg: 'rgba(83, 252, 24, 0.2)' },
      facebook: { color: '#1877f2', bg: 'rgba(24, 119, 242, 0.2)' },
      unknown: { color: '#64ffda', bg: 'rgba(100, 255, 218, 0.2)' }
    };
    return styles[platform.toLowerCase()] || styles.unknown;
  };

  // Get health color
  const getHealthColor = (health: number) => {
    if (health >= 80) return '#22c55e';
    if (health >= 50) return '#eab308';
    return '#ef4444';
  };

  if (loading) {
    return (
      <div className="url-stream-management">
        <div className="loading-state">
          <RefreshCw className="spin" />
          <p>Loading URL Stream Manager...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="url-stream-management">
      {/* Header */}
      <div className="manager-header">
        <div className="header-title">
          <Link2 size={24} />
          <h2>URL Stream Relay</h2>
          <span className="header-subtitle">Stream from Twitch, YouTube, Kick & more</span>
        </div>

        <div className="header-actions">
          {streams.length > 0 && (
            <button className="stop-all-btn" onClick={handleStopAll}>
              <Square size={16} />
              Stop All
            </button>
          )}
          <button className="refresh-btn" onClick={fetchData}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Tools Status */}
      <div className="tools-status">
        <div className={`tool-badge ${toolsStatus?.streamlink ? 'available' : 'unavailable'}`}>
          {toolsStatus?.streamlink ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          streamlink
        </div>
        <div className={`tool-badge ${toolsStatus?.ytdlp ? 'available' : 'unavailable'}`}>
          {toolsStatus?.ytdlp ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          yt-dlp
        </div>
      </div>

      {/* New Stream Form */}
      <div className="new-stream-section">
        <h3>
          <Plus size={18} />
          Start New Stream
        </h3>

        <div className="stream-form">
          <div className="form-row">
            <div className="input-group url-input-group">
              <label>Stream URL</label>
              <div className="url-input-wrapper">
                <input
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://twitch.tv/username or YouTube/Kick URL"
                  className="url-input"
                />
                <button
                  className="validate-btn"
                  onClick={handleValidate}
                  disabled={validating || !newUrl.trim()}
                >
                  {validating ? <RefreshCw size={14} className="spin" /> : 'Validate'}
                </button>
              </div>
            </div>
          </div>

          {/* Validation Result */}
          {validationResult && (
            <div className={`validation-result ${validationResult.valid ? 'valid' : 'invalid'}`}>
              {validationResult.valid ? (
                <>
                  <div className="validation-header">
                    <span
                      className="platform-badge"
                      style={{
                        background: getPlatformStyle(validationResult.platform).bg,
                        color: getPlatformStyle(validationResult.platform).color
                      }}
                    >
                      {validationResult.platform}
                    </span>
                    <span className={`live-status ${validationResult.isLive ? 'live' : 'offline'}`}>
                      {validationResult.isLive ? (
                        <><Wifi size={14} /> LIVE</>
                      ) : (
                        <><WifiOff size={14} /> Offline</>
                      )}
                    </span>
                  </div>
                  <div className="validation-title">{validationResult.title || 'Unknown'}</div>
                  {validationResult.qualities?.length > 0 && (
                    <div className="validation-qualities">
                      Available: {validationResult.qualities.slice(0, 5).join(', ')}
                    </div>
                  )}
                </>
              ) : (
                <div className="validation-error">
                  <AlertCircle size={16} />
                  {validationResult.error || 'Invalid URL or stream not found'}
                </div>
              )}
            </div>
          )}

          <div className="form-row">
            <div className="input-group">
              <label>Quality</label>
              <select
                value={selectedQuality}
                onChange={(e) => setSelectedQuality(e.target.value)}
                className="quality-select"
              >
                <option value="best">Best</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
                <option value="480p">480p</option>
                <option value="worst">Worst (Low bandwidth)</option>
              </select>
            </div>

            <div className="input-group">
              <label>Display Name (optional)</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Custom name for the stream"
                className="name-input"
              />
            </div>
          </div>

          <div className="form-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={autoReconnect}
                onChange={(e) => setAutoReconnect(e.target.checked)}
              />
              Auto-reconnect on failure
            </label>
          </div>

          <div className="form-actions">
            <button
              className="start-stream-btn"
              onClick={handleStartStream}
              disabled={isStarting || !newUrl.trim()}
            >
              {isStarting ? (
                <><RefreshCw size={16} className="spin" /> Starting...</>
              ) : (
                <><Play size={16} /> Start Streaming</>
              )}
            </button>

            {newUrl.trim() && (
              <button
                className="save-preset-btn"
                onClick={() => setShowPresetForm(true)}
              >
                <Star size={16} />
                Save as Preset
              </button>
            )}
          </div>

          {/* Preset Form */}
          {showPresetForm && (
            <div className="preset-form">
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name (e.g., 'xQc Stream')"
                className="preset-name-input"
              />
              <button
                className="save-btn"
                onClick={handleSavePreset}
                disabled={!presetName.trim()}
              >
                <Save size={14} />
                Save
              </button>
              <button
                className="cancel-btn"
                onClick={() => { setShowPresetForm(false); setPresetName(''); }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'streams' ? 'active' : ''}`}
          onClick={() => setActiveTab('streams')}
        >
          <Activity size={16} />
          Active Streams ({streams.length})
        </button>
        <button
          className={`tab ${activeTab === 'presets' ? 'active' : ''}`}
          onClick={() => setActiveTab('presets')}
        >
          <Star size={16} />
          Presets ({presets.length})
        </button>
        <button
          className={`tab ${activeTab === 'random' ? 'active' : ''}`}
          onClick={() => setActiveTab('random')}
        >
          <Shuffle size={16} />
          Random Rotation
          {randomStatus?.enabled && <span className="tab-badge live">LIVE</span>}
        </button>
      </div>

      {/* Active Streams */}
      {activeTab === 'streams' && (
        <div className="streams-list">
          {streams.length === 0 ? (
            <div className="empty-state">
              <Link2 size={48} />
              <h3>No active URL streams</h3>
              <p>Enter a stream URL above to start relaying</p>
            </div>
          ) : (
            <div className="streams-grid">
              {streams.map((stream) => {
                const platformStyle = getPlatformStyle(stream.platform);
                return (
                  <div key={stream.urlId} className="stream-card">
                    <div className="stream-header">
                      <span
                        className="platform-tag"
                        style={{ background: platformStyle.bg, color: platformStyle.color }}
                      >
                        {stream.platform}
                      </span>
                      <span className={`status-tag ${stream.status}`}>
                        {stream.status === 'streaming' && <><Activity size={12} /> Live</>}
                        {stream.status === 'connecting' && <><RefreshCw size={12} className="spin" /> Connecting</>}
                        {stream.status === 'reconnecting' && <><RefreshCw size={12} className="spin" /> Reconnecting</>}
                        {stream.status === 'error' && <><AlertCircle size={12} /> Error</>}
                      </span>
                    </div>

                    <h4 className="stream-name">{stream.displayName || 'URL Stream'}</h4>

                    <div className="stream-url">
                      <ExternalLink size={12} />
                      <a href={stream.sourceUrl} target="_blank" rel="noopener noreferrer">
                        {stream.sourceUrl.length > 40
                          ? stream.sourceUrl.substring(0, 40) + '...'
                          : stream.sourceUrl}
                      </a>
                    </div>

                    <div className="stream-stats">
                      <div className="stat">
                        <Clock size={14} />
                        <span>{formatUptime(stream.uptime)}</span>
                      </div>
                      <div className="stat">
                        <Settings size={14} />
                        <span>{stream.quality}</span>
                      </div>
                      {stream.health && (
                        <div className="stat health">
                          <Activity size={14} />
                          <span style={{ color: getHealthColor(stream.health.overall) }}>
                            {stream.health.overall}%
                          </span>
                        </div>
                      )}
                    </div>

                    {stream.reconnectAttempts > 0 && (
                      <div className="reconnect-info">
                        Reconnect attempts: {stream.reconnectAttempts}
                      </div>
                    )}

                    <button
                      className="stop-btn"
                      onClick={() => handleStopStream(stream.urlId)}
                    >
                      <Square size={14} />
                      Stop
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Presets */}
      {activeTab === 'presets' && (
        <div className="presets-list">
          {presets.length === 0 ? (
            <div className="empty-state">
              <Star size={48} />
              <h3>No presets saved</h3>
              <p>Save frequently used streams as presets for quick access</p>
            </div>
          ) : (
            <div className="presets-grid">
              {presets.map((preset) => {
                const platformStyle = getPlatformStyle(preset.platform);
                return (
                  <div key={preset.id} className="preset-card">
                    <div className="preset-header">
                      <span
                        className="platform-tag"
                        style={{ background: platformStyle.bg, color: platformStyle.color }}
                      >
                        {preset.platform}
                      </span>
                      <span className="use-count">{preset.use_count} uses</span>
                    </div>

                    <h4 className="preset-name">{preset.name}</h4>

                    <div className="preset-url">
                      {preset.source_url.length > 35
                        ? preset.source_url.substring(0, 35) + '...'
                        : preset.source_url}
                    </div>

                    <div className="preset-meta">
                      <span>Quality: {preset.quality}</span>
                      {preset.auto_reconnect && <span>Auto-reconnect</span>}
                    </div>

                    <div className="preset-actions">
                      <button
                        className="start-preset-btn"
                        onClick={() => handleStartPreset(preset.id)}
                      >
                        <Play size={14} />
                        Start
                      </button>
                      <button
                        className="delete-preset-btn"
                        onClick={() => handleDeletePreset(preset.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Random Rotation */}
      {activeTab === 'random' && (
        <div className="random-rotation-section">
          {/* API Config Info */}
          {randomStatus && !randomStatus.twitchConfigured && randomSettings.platforms.includes('twitch') && (
            <div className="warning-banner">
              <AlertCircle size={20} />
              <div className="warning-content">
                <strong>Twitch API Not Configured</strong>
                <p>Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET to your server .env file to enable Twitch discovery. Kick is available without API keys.</p>
              </div>
            </div>
          )}

          {/* Control Panel */}
          <div className="random-control-panel">
            <div className="control-header">
              <div className="control-title">
                <Shuffle size={24} />
                <div>
                  <h3>Random Stream Rotation</h3>
                  <p>Auto-discover and stream random channels from Twitch & Kick with animal names</p>
                </div>
              </div>
              <div className={`status-indicator ${randomStatus?.enabled ? 'active' : 'inactive'}`}>
                <span className="status-dot"></span>
                {randomStatus?.enabled ? 'Active' : 'Inactive'}
              </div>
            </div>

            {/* Platform badges */}
            <div className="platform-badges">
              {randomStatus?.availablePlatforms?.map(p => (
                <span
                  key={p.id}
                  className={`platform-badge ${randomSettings.platforms.includes(p.id) ? 'enabled' : 'disabled'}`}
                  style={{
                    background: p.id === 'twitch' ? 'rgba(145, 70, 255, 0.2)' : 'rgba(83, 252, 24, 0.2)',
                    color: p.id === 'twitch' ? '#9146ff' : '#53fc18'
                  }}
                >
                  {p.icon} {p.name}
                </span>
              ))}
            </div>

            <div className="control-actions">
              {!randomStatus?.enabled ? (
                <button
                  className="start-btn"
                  onClick={handleStartRandomRotation}
                  disabled={isRandomLoading || (randomSettings.platforms.length === 0) || (randomSettings.platforms.includes('twitch') && !randomStatus?.twitchConfigured && !randomSettings.platforms.includes('kick'))}
                >
                  {isRandomLoading ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
                  Start Rotation
                </button>
              ) : (
                <>
                  <button
                    className="skip-btn"
                    onClick={handleSkipToNext}
                    disabled={isRandomLoading}
                  >
                    {isRandomLoading ? <RefreshCw size={16} className="spin" /> : <SkipForward size={16} />}
                    Skip to Next
                  </button>
                  <button
                    className="stop-btn danger"
                    onClick={handleStopRandomRotation}
                    disabled={isRandomLoading}
                  >
                    <Square size={16} />
                    Stop
                  </button>
                </>
              )}
              <button
                className="settings-btn"
                onClick={() => setShowRandomSettings(!showRandomSettings)}
              >
                <Sliders size={16} />
                Settings
              </button>
            </div>
          </div>

          {/* Current Stream Card */}
          {randomStatus?.currentStream && (
            <div className="current-stream-card">
              <div className="stream-header-bar">
                <span className="live-badge">LIVE</span>
                <span
                  className="platform-source-badge"
                  style={{
                    background: randomStatus.currentStream.platform === 'kick' ? 'rgba(83, 252, 24, 0.2)' : 'rgba(145, 70, 255, 0.2)',
                    color: randomStatus.currentStream.platform === 'kick' ? '#53fc18' : '#9146ff'
                  }}
                >
                  {randomStatus.currentStream.platform === 'kick' ? '🟢 Kick' : '🟣 Twitch'}
                </span>
                <span className="stream-time">
                  <Clock size={14} />
                  {formatUptime(Date.now() - randomStatus.currentStream.startedAt)}
                </span>
              </div>
              <h2 className="animal-name">{randomStatus.currentStream.displayName}</h2>
              <div className="streamer-info">
                <span className="streamer-badge">
                  <ExternalLink size={12} />
                  {randomStatus.currentStream.streamerDisplayName || randomStatus.currentStream.twitchDisplayName}
                </span>
                <span className="game-badge">{randomStatus.currentStream.game || 'Unknown'}</span>
                <span className="viewers-badge">{randomStatus.currentStream.viewers} viewers</span>
              </div>
              {randomStatus.currentStream.title && (
                <p className="stream-title">{randomStatus.currentStream.title}</p>
              )}
            </div>
          )}

          {/* No Stream Placeholder */}
          {randomStatus && !randomStatus.currentStream && !randomStatus.enabled && (
            <div className="empty-state">
              <Shuffle size={48} />
              <h3>No Active Random Stream</h3>
              <p>Start the rotation to discover and stream random Twitch channels</p>
            </div>
          )}

          {/* Settings Panel */}
          {showRandomSettings && (
            <div className="settings-panel">
              <h4><Sliders size={18} /> Rotation Settings</h4>

              {/* Platform Selection */}
              <div className="settings-section">
                <h5>Platforms</h5>
                <div className="platform-selection">
                  <label className={`platform-checkbox ${randomStatus?.twitchConfigured ? '' : 'unavailable'}`}>
                    <input
                      type="checkbox"
                      checked={randomSettings.platforms.includes('twitch')}
                      disabled={!randomStatus?.twitchConfigured}
                      onChange={(e) => {
                        const newPlatforms = e.target.checked
                          ? [...randomSettings.platforms, 'twitch']
                          : randomSettings.platforms.filter(p => p !== 'twitch');
                        setRandomSettings({...randomSettings, platforms: newPlatforms});
                      }}
                    />
                    <span className="platform-label twitch">🟣 Twitch</span>
                    {!randomStatus?.twitchConfigured && <span className="config-warning">(API not configured)</span>}
                  </label>
                  <label className="platform-checkbox">
                    <input
                      type="checkbox"
                      checked={randomSettings.platforms.includes('kick')}
                      onChange={(e) => {
                        const newPlatforms = e.target.checked
                          ? [...randomSettings.platforms, 'kick']
                          : randomSettings.platforms.filter(p => p !== 'kick');
                        setRandomSettings({...randomSettings, platforms: newPlatforms});
                      }}
                    />
                    <span className="platform-label kick">🟢 Kick</span>
                    <span className="config-ok">(No API key needed)</span>
                  </label>
                </div>

                {/* Platform Weight Slider - only show when both platforms enabled */}
                {randomSettings.platforms.includes('twitch') && randomSettings.platforms.includes('kick') && randomStatus?.twitchConfigured && (
                  <div className="platform-weight-section">
                    <label>Platform Weight</label>
                    <div className="weight-slider">
                      <span className="weight-label twitch">🟣 Twitch {randomSettings.platformWeight.twitch}%</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={randomSettings.platformWeight.twitch}
                        onChange={(e) => {
                          const twitchWeight = parseInt(e.target.value);
                          setRandomSettings({
                            ...randomSettings,
                            platformWeight: { twitch: twitchWeight, kick: 100 - twitchWeight }
                          });
                        }}
                      />
                      <span className="weight-label kick">🟢 Kick {randomSettings.platformWeight.kick}%</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-grid">
                <div className="setting-group">
                  <label>Min Rotation (minutes)</label>
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={randomSettings.minRotationMinutes}
                    onChange={(e) => setRandomSettings({...randomSettings, minRotationMinutes: parseInt(e.target.value) || 5})}
                  />
                </div>
                <div className="setting-group">
                  <label>Max Rotation (minutes)</label>
                  <input
                    type="number"
                    min="1"
                    max="120"
                    value={randomSettings.maxRotationMinutes}
                    onChange={(e) => setRandomSettings({...randomSettings, maxRotationMinutes: parseInt(e.target.value) || 10})}
                  />
                </div>
                <div className="setting-group">
                  <label>Min Viewers</label>
                  <input
                    type="number"
                    min="0"
                    value={randomSettings.minViewers}
                    onChange={(e) => setRandomSettings({...randomSettings, minViewers: parseInt(e.target.value) || 0})}
                  />
                </div>
                <div className="setting-group">
                  <label>Max Viewers</label>
                  <input
                    type="number"
                    min="1"
                    value={randomSettings.maxViewers}
                    onChange={(e) => setRandomSettings({...randomSettings, maxViewers: parseInt(e.target.value) || 999999})}
                  />
                </div>
                <div className="setting-group">
                  <label>Language (Twitch only)</label>
                  <select
                    value={randomSettings.language}
                    onChange={(e) => setRandomSettings({...randomSettings, language: e.target.value})}
                  >
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="pt">Portuguese</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="zh">Chinese</option>
                    <option value="ru">Russian</option>
                  </select>
                </div>
              </div>
              <div className="settings-actions">
                <button className="save-btn" onClick={handleSaveRandomSettings}>
                  <Save size={14} /> Save Settings
                </button>
                <button className="cancel-btn" onClick={() => setShowRandomSettings(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Stats */}
          {randomStatus && (
            <div className="random-stats">
              <div className="stat-card">
                <div className="stat-value">{randomStatus.stats.totalRotations}</div>
                <div className="stat-label">Total Rotations</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {randomStatus.stats.uptime > 0 ? formatUptime(randomStatus.stats.uptime) : '--'}
                </div>
                <div className="stat-label">Session Uptime</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{randomStatus.stats.streamHistory.length}</div>
                <div className="stat-label">Streams in History</div>
              </div>
            </div>
          )}

          {/* History */}
          {randomStatus && randomStatus.stats.streamHistory.length > 0 && (
            <div className="history-section">
              <h4><History size={18} /> Recent Streams</h4>
              <div className="history-list">
                {[...randomStatus.stats.streamHistory].reverse().slice(0, 10).map((stream, index) => (
                  <div key={index} className="history-item">
                    <span
                      className="history-platform"
                      style={{
                        color: stream.platform === 'kick' ? '#53fc18' : '#9146ff'
                      }}
                    >
                      {stream.platform === 'kick' ? '🟢' : '🟣'}
                    </span>
                    <span className="history-name">{stream.displayName}</span>
                    <span className="history-streamer">{stream.streamerDisplayName || stream.twitchDisplayName}</span>
                    <span className="history-game">{stream.game || 'Unknown'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default URLStreamManagement;
