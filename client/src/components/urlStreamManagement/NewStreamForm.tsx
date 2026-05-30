import React from 'react';
import {
  Plus,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertCircle,
  Play,
  Star,
  Save,
} from 'lucide-react';
import { ValidationResult, getPlatformStyle } from './types';

interface NewStreamFormProps {
  newUrl: string;
  setNewUrl: (v: string) => void;
  selectedQuality: string;
  setSelectedQuality: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  autoReconnect: boolean;
  setAutoReconnect: (v: boolean) => void;
  validating: boolean;
  validationResult: ValidationResult | null;
  isStarting: boolean;
  showPresetForm: boolean;
  setShowPresetForm: (v: boolean) => void;
  presetName: string;
  setPresetName: (v: string) => void;
  handleValidate: () => void;
  handleStartStream: () => void;
  handleSavePreset: () => void;
}

// The "Start New Stream" form section. Markup preserved verbatim from the
// original component so the DOM/class names/text are byte-identical.
const NewStreamForm: React.FC<NewStreamFormProps> = ({
  newUrl,
  setNewUrl,
  selectedQuality,
  setSelectedQuality,
  displayName,
  setDisplayName,
  autoReconnect,
  setAutoReconnect,
  validating,
  validationResult,
  isStarting,
  showPresetForm,
  setShowPresetForm,
  presetName,
  setPresetName,
  handleValidate,
  handleStartStream,
  handleSavePreset,
}) => {
  return (
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
  );
};

export default NewStreamForm;
