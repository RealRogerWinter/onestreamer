import React from 'react';
import {
  AlertCircle,
  Shuffle,
  Play,
  RefreshCw,
  SkipForward,
  Square,
  Sliders,
  Clock,
  ExternalLink,
  Save,
  History,
} from 'lucide-react';
import { RandomRotationStatus, RandomSettings, formatUptime } from './types';

interface RandomRotationViewProps {
  randomStatus: RandomRotationStatus | null;
  randomSettings: RandomSettings;
  setRandomSettings: (s: RandomSettings) => void;
  isRandomLoading: boolean;
  showRandomSettings: boolean;
  setShowRandomSettings: (v: boolean) => void;
  handleStartRandomRotation: () => void;
  handleStopRandomRotation: () => void;
  handleSkipToNext: () => void;
  handleSaveRandomSettings: () => void;
}

// The "Random Rotation" tab content. Markup preserved verbatim from the original.
const RandomRotationView: React.FC<RandomRotationViewProps> = ({
  randomStatus,
  randomSettings,
  setRandomSettings,
  isRandomLoading,
  showRandomSettings,
  setShowRandomSettings,
  handleStartRandomRotation,
  handleStopRandomRotation,
  handleSkipToNext,
  handleSaveRandomSettings,
}) => {
  return (
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
  );
};

export default RandomRotationView;
