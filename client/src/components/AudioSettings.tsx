import React, { useEffect, useState } from 'react';
import './AudioSettings.css';

export interface AudioSettingsConfig {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate: number;
  channelCount: number;
  profile: 'raw' | 'microphone' | 'music' | 'streaming';
  inputDeviceId?: string;
  outputDeviceId?: string;
}

interface AudioSettingsProps {
  settings: AudioSettingsConfig;
  onSettingsChange: (settings: AudioSettingsConfig) => void;
  isStreaming?: boolean;
  compact?: boolean;
}

const AudioSettings: React.FC<AudioSettingsProps> = ({ 
  settings, 
  onSettingsChange,
  isStreaming = false,
  compact = false
}) => {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [expanded, setExpanded] = useState(!compact);

  useEffect(() => {
    // Get available audio devices
    const getDevices = async () => {
      try {
        // Only request permissions when the settings panel is expanded
        if (expanded || !compact) {
          // Request permissions first if needed
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          // Stop the stream immediately, we just needed permissions
          stream.getTracks().forEach(track => track.stop());
        }
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(device => device.kind === 'audioinput');
        const outputs = devices.filter(device => device.kind === 'audiooutput');
        
        // Only update if we have actual device labels (means we have permissions)
        if (inputs.length > 0 && (inputs[0].label || expanded || !compact)) {
          setAudioInputs(inputs);
          setAudioOutputs(outputs);
          
          // Set default devices if not already set
          if (!settings.inputDeviceId && inputs.length > 0) {
            onSettingsChange({ ...settings, inputDeviceId: inputs[0].deviceId });
          }
          if (!settings.outputDeviceId && outputs.length > 0) {
            onSettingsChange({ ...settings, outputDeviceId: outputs[0].deviceId });
          }
        }
      } catch (error) {
        console.error('Failed to enumerate devices:', error);
      }
    };

    // Only get devices if the settings panel is expanded or not in compact mode
    if (expanded || !compact) {
      getDevices();
    }

    // Listen for device changes
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', getDevices);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', getDevices);
      };
    }
  }, [expanded, compact]);
  const handleToggle = (setting: keyof AudioSettingsConfig) => {
    if (typeof settings[setting] === 'boolean') {
      onSettingsChange({
        ...settings,
        [setting]: !settings[setting]
      });
    }
  };

  const handleSelectChange = (setting: keyof AudioSettingsConfig, value: string | number) => {
    onSettingsChange({
      ...settings,
      [setting]: setting === 'sampleRate' || setting === 'channelCount' ? Number(value) : value
    });
  };

  const applyPreset = (preset: 'raw' | 'microphone' | 'music' | 'streaming') => {
    const presets = {
      raw: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'raw' as const
      },
      microphone: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,
        profile: 'microphone' as const
      },
      music: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'music' as const
      },
      streaming: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'streaming' as const
      }
    };

    onSettingsChange(presets[preset]);
  };

  // Compact mode for inline display
  if (compact && !expanded) {
    return (
      <div className="audio-settings compact">
        <button 
          className="expand-button"
          onClick={() => setExpanded(true)}
          title="Expand Audio Settings"
        >
          🎵 Audio ({settings.profile})
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Backdrop when expanded in compact mode */}
      {compact && expanded && (
        <div 
          className="audio-settings-backdrop"
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            zIndex: 99
          }}
        />
      )}
      
      <div className={`audio-settings ${compact ? 'compact-expanded' : ''}`}>
        <div className="audio-settings-header">
          <h3>🎵 Audio Settings</h3>
          {compact && (
            <button 
              className="collapse-button"
              onClick={() => setExpanded(false)}
              title="Collapse"
            >
              ✕
            </button>
          )}
          {isStreaming && (
            <span className="streaming-warning">Changes apply on next stream</span>
          )}
        </div>

      <div className="audio-presets">
        <label>Quick Presets:</label>
        <div className="preset-buttons">
          <button 
            className={`preset-btn ${settings.profile === 'raw' ? 'active' : ''}`}
            onClick={() => applyPreset('raw')}
            title="No processing - ideal for music or testing"
          >
            Raw Audio
          </button>
          <button 
            className={`preset-btn ${settings.profile === 'microphone' ? 'active' : ''}`}
            onClick={() => applyPreset('microphone')}
            title="Optimized for microphone input"
          >
            Microphone
          </button>
          <button 
            className={`preset-btn ${settings.profile === 'music' ? 'active' : ''}`}
            onClick={() => applyPreset('music')}
            title="High quality for music streaming"
          >
            Music
          </button>
          <button 
            className={`preset-btn ${settings.profile === 'streaming' ? 'active' : ''}`}
            onClick={() => applyPreset('streaming')}
            title="Balanced for general streaming"
          >
            Streaming
          </button>
        </div>
      </div>

      <div className="audio-settings-grid">
        {/* Device Selectors */}
        <div className="setting-group device-selector">
          <label className="setting-label">
            <span>Input (Mic)</span>
            <select
              value={settings.inputDeviceId || ''}
              onChange={(e) => handleSelectChange('inputDeviceId', e.target.value)}
              disabled={isStreaming}
              title="Select microphone input device"
            >
              {audioInputs.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Mic ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="setting-group device-selector">
          <label className="setting-label">
            <span>Output</span>
            <select
              value={settings.outputDeviceId || ''}
              onChange={(e) => handleSelectChange('outputDeviceId', e.target.value)}
              disabled={isStreaming}
            >
              {audioOutputs.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Speakers ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Processing Settings */}
        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.echoCancellation}
              onChange={() => handleToggle('echoCancellation')}
              disabled={isStreaming}
            />
            <span>Echo Cancellation</span>
          </label>
          <small>Removes echo and feedback from speakers</small>
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.noiseSuppression}
              onChange={() => handleToggle('noiseSuppression')}
              disabled={isStreaming}
            />
            <span>Noise Suppression</span>
          </label>
          <small>Reduces background noise</small>
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.autoGainControl}
              onChange={() => handleToggle('autoGainControl')}
              disabled={isStreaming}
            />
            <span>Auto Gain Control</span>
          </label>
          <small>Automatically adjusts volume levels</small>
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <span>Sample Rate</span>
            <select
              value={settings.sampleRate}
              onChange={(e) => handleSelectChange('sampleRate', e.target.value)}
              disabled={isStreaming}
            >
              <option value="16000">16 kHz (Voice)</option>
              <option value="24000">24 kHz (Standard)</option>
              <option value="44100">44.1 kHz (CD Quality)</option>
              <option value="48000">48 kHz (Studio)</option>
            </select>
          </label>
          <small>Higher = better quality, more bandwidth</small>
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <span>Channels</span>
            <select
              value={settings.channelCount}
              onChange={(e) => handleSelectChange('channelCount', e.target.value)}
              disabled={isStreaming}
            >
              <option value="1">Mono</option>
              <option value="2">Stereo</option>
            </select>
          </label>
          <small>Stereo for music, Mono for voice</small>
        </div>
      </div>

      <div className="audio-settings-info">
        <p className="current-profile">
          Current Profile: <strong>{settings.profile}</strong>
        </p>
        {settings.profile === 'raw' && (
          <p className="profile-warning">
            ⚠️ Raw audio mode: All processing disabled. You may experience echo or background noise.
          </p>
        )}
      </div>
    </div>
    </>
  );
};

export default AudioSettings;