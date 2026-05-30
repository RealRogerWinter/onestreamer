import React from 'react';
import { Star, Play, Trash2 } from 'lucide-react';
import { Preset, getPlatformStyle } from './types';

interface PresetsViewProps {
  presets: Preset[];
  handleStartPreset: (presetId: number) => void;
  handleDeletePreset: (presetId: number) => void;
}

// The "Presets" tab content. Markup preserved verbatim from the original.
const PresetsView: React.FC<PresetsViewProps> = ({
  presets,
  handleStartPreset,
  handleDeletePreset,
}) => {
  return (
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
  );
};

export default PresetsView;
