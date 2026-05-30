import React from 'react';
import { AudioSettingsConfig, StreamerSettingsConfig } from './types';

// Presentational Audio settings tab, extracted verbatim from the
// activeTab === 'audio' branch of StreamerSettings. Stateless: data + handlers
// come from props (state still lives in StreamerSettings / useStreamerDevices).
interface AudioPanelProps {
  settings: StreamerSettingsConfig;
  isStreaming: boolean;
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  isMicTesting: boolean;
  audioLevel: number;
  peakLevel: number;
  toggleMicTest: () => void;
  applyAudioPreset: (preset: 'raw' | 'microphone' | 'music' | 'streaming') => void;
  handleAudioToggle: (setting: keyof AudioSettingsConfig) => void;
  handleAudioSelectChange: (setting: keyof AudioSettingsConfig, value: string | number) => void;
}

const AudioPanel: React.FC<AudioPanelProps> = ({
  settings,
  isStreaming,
  audioInputs,
  audioOutputs,
  isMicTesting,
  audioLevel,
  peakLevel,
  toggleMicTest,
  applyAudioPreset,
  handleAudioToggle,
  handleAudioSelectChange,
}) => {
  return (
          <div className="settings-panel audio-panel">
            <div className="audio-presets">
              <label>Quick Audio Presets:</label>
              <div className="preset-buttons">
                <button
                  className={`preset-btn ${settings.audio.profile === 'raw' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('raw')}
                  title="No processing - ideal for music or testing"
                >
                  Raw Audio
                </button>
                <button
                  className={`preset-btn ${settings.audio.profile === 'microphone' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('microphone')}
                  title="Optimized for microphone input"
                >
                  Microphone
                </button>
                <button
                  className={`preset-btn ${settings.audio.profile === 'music' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('music')}
                  title="High quality for music streaming"
                >
                  Music
                </button>
                <button
                  className={`preset-btn ${settings.audio.profile === 'streaming' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('streaming')}
                  title="Balanced for general streaming"
                >
                  Streaming
                </button>
              </div>
            </div>

            <div className="settings-grid">
              {/* Device Selectors */}
              <div className="setting-group device-selector">
                <label className="setting-label">
                  <span>Input (Mic)</span>
                  <select
                    value={settings.audio.inputDeviceId || ''}
                    onChange={(e) => handleAudioSelectChange('inputDeviceId', e.target.value)}
                    disabled={isMicTesting}
                    title={isStreaming ? "Change microphone during stream" : "Select microphone input device"}
                  >
                    {audioInputs.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Mic ${device.deviceId.slice(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Microphone Test */}
              <div className="setting-group mic-test">
                <button
                  className={`test-button ${isMicTesting ? 'active' : ''}`}
                  onClick={toggleMicTest}
                  disabled={false}
                >
                  {isMicTesting ? '🔴 Stop Test' : '🎤 Test Microphone'}
                </button>
                {isMicTesting && (
                  <div className="audio-level-meter">
                    <div className="meter-header">
                      <span className="level-label">Audio Level</span>
                      <span className="db-value">
                        {audioLevel > 0.001
                          ? `${Math.round(20 * Math.log10(audioLevel))} dB`
                          : '-∞ dB'}
                      </span>
                    </div>

                    <div className="db-scale">
                      <span>-60</span>
                      <span>-48</span>
                      <span>-36</span>
                      <span>-24</span>
                      <span>-12</span>
                      <span>-6</span>
                      <span>0</span>
                    </div>

                    <div className="level-bar-container">
                      {/* Simple gradient bar for now */}
                      <div
                        className="level-bar-fill"
                        style={{
                          width: `${Math.max(1, audioLevel * 100)}%`,
                          background: `linear-gradient(90deg,
                            #00ff00 0%,
                            #00ff00 50%,
                            #ffff00 65%,
                            #ff8800 80%,
                            #ff0000 95%)`
                        }}
                      />

                      {/* Peak indicator */}
                      <div
                        className="peak-indicator"
                        style={{
                          left: `${Math.min(98, peakLevel * 100)}%`
                        }}
                      />
                    </div>

                    {/* Tick marks below */}
                    <div className="meter-ticks">
                      <div className="tick" style={{ left: '0%' }} />
                      <div className="tick" style={{ left: '20%' }} />
                      <div className="tick" style={{ left: '40%' }} />
                      <div className="tick" style={{ left: '60%' }} />
                      <div className="tick" style={{ left: '80%' }} />
                      <div className="tick" style={{ left: '90%' }} />
                      <div className="tick major" style={{ left: '100%' }} />
                    </div>
                  </div>
                )}
              </div>

              <div className="setting-group device-selector">
                <label className="setting-label">
                  <span>Output</span>
                  <select
                    value={settings.audio.outputDeviceId || ''}
                    onChange={(e) => handleAudioSelectChange('outputDeviceId', e.target.value)}
                    disabled={false}
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
                    checked={settings.audio.echoCancellation}
                    onChange={() => handleAudioToggle('echoCancellation')}
                    disabled={false}
                  />
                  <span>Echo Cancellation</span>
                </label>
                <small>Removes echo and feedback from speakers</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.audio.noiseSuppression}
                    onChange={() => handleAudioToggle('noiseSuppression')}
                    disabled={false}
                  />
                  <span>Noise Suppression</span>
                </label>
                <small>Reduces background noise</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.audio.autoGainControl}
                    onChange={() => handleAudioToggle('autoGainControl')}
                    disabled={false}
                  />
                  <span>Auto Gain Control</span>
                </label>
                <small>Automatically adjusts volume levels</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Sample Rate</span>
                  <select
                    value={settings.audio.sampleRate}
                    onChange={(e) => handleAudioSelectChange('sampleRate', e.target.value)}
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
                    value={settings.audio.channelCount}
                    onChange={(e) => handleAudioSelectChange('channelCount', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="1">Mono</option>
                    <option value="2">Stereo</option>
                  </select>
                </label>
                <small>Stereo for music, Mono for voice</small>
              </div>
            </div>
          </div>
  );
};

export default AudioPanel;
