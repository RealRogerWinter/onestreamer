import React from 'react';
import { StreamerSettingsConfig, ScreenShareSettingsConfig } from './StreamerSettings';

// Presentational Screen-share settings panel, extracted verbatim from the
// activeTab === 'screen' branch of StreamerSettings. Stateless: all data + 
// handlers come from props (handlers still live in StreamerSettings).
interface ScreenSharePanelProps {
  settings: StreamerSettingsConfig;
  isStreaming?: boolean;
  isScreenSharing?: boolean;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
  handleScreenShareToggle: (setting: keyof ScreenShareSettingsConfig) => void;
  handleScreenShareSelectChange: (setting: keyof ScreenShareSettingsConfig, value: string) => void;
  handleScreenShareGainChange: (setting: 'micGain' | 'systemGain', value: number) => void;
  handlePipSizeChange: (value: number) => void;
}

const ScreenSharePanel: React.FC<ScreenSharePanelProps> = ({
  settings,
  isStreaming,
  isScreenSharing,
  onStartScreenShare,
  onStopScreenShare,
  handleScreenShareToggle,
  handleScreenShareSelectChange,
  handleScreenShareGainChange,
  handlePipSizeChange,
}) => {
  return (
          <div className="settings-panel screen-panel">
            {/* Screen Share Status Banner */}
            {isScreenSharing && (
              <div className="screen-share-active-banner" style={{
                background: 'linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%)',
                color: 'white',
                padding: '12px 16px',
                borderRadius: '8px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                boxShadow: '0 2px 8px rgba(255, 107, 107, 0.3)'
              }}>
                <span style={{ fontWeight: 'bold' }}>🖥️ Screen Sharing Active</span>
                <button
                  onClick={onStopScreenShare}
                  style={{
                    background: 'rgba(255, 255, 255, 0.2)',
                    border: '1px solid rgba(255, 255, 255, 0.4)',
                    color: 'white',
                    padding: '6px 12px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  Stop Sharing
                </button>
              </div>
            )}

            {/* Screen Share Controls */}
            <div className="settings-grid">
              {/* Start/Stop Screen Share Button */}
              <div className="setting-group" style={{ gridColumn: '1 / -1' }}>
                <button
                  type="button"
                  className="screen-share-main-button"
                  onClick={() => {
                    console.log('🖥️ Screen share button clicked, isStreaming:', isStreaming, 'isScreenSharing:', isScreenSharing);
                    if (!isStreaming) {
                      console.log('🖥️ Not streaming, ignoring click');
                      return;
                    }
                    if (isScreenSharing) {
                      console.log('🖥️ Calling onStopScreenShare:', typeof onStopScreenShare);
                      onStopScreenShare?.();
                    } else {
                      console.log('🖥️ Calling onStartScreenShare:', typeof onStartScreenShare);
                      onStartScreenShare?.();
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '12px',
                    fontSize: '16px',
                    background: isStreaming
                      ? (isScreenSharing
                        ? 'linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%)'
                        : 'linear-gradient(135deg, #4ecdc4 0%, #44b3ab 100%)')
                      : '#444',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: isStreaming ? 'pointer' : 'not-allowed',
                    opacity: isStreaming ? 1 : 0.6,
                    position: 'relative',
                    zIndex: 10
                  }}
                >
                  {isScreenSharing ? '🔴 Stop Screen Share' : '🖥️ Start Screen Share'}
                </button>
                {!isStreaming && (
                  <small style={{ color: '#ff9800', display: 'block', marginTop: '8px' }}>
                    Start streaming first to enable screen sharing
                  </small>
                )}
              </div>

              {/* Browser Compatibility Notice */}
              <div style={{
                gridColumn: '1 / -1',
                padding: '10px 14px',
                background: 'rgba(255, 193, 7, 0.1)',
                border: '1px solid rgba(255, 193, 7, 0.3)',
                borderRadius: '8px',
                fontSize: '12px',
                color: '#ffc107',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <span style={{ fontSize: '16px' }}>💡</span>
                <span>Screen sharing features work best in <strong>Chrome</strong> or <strong>Edge</strong>. System audio and some features may not be available in other browsers.</span>
              </div>

              {/* Basic Settings Row */}
              <div style={{
                gridColumn: '1 / -1',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '16px',
                marginTop: '8px'
              }}>
                {/* Display Surface */}
                <div className="setting-group" style={{ margin: 0 }}>
                  <label className="setting-label">
                    <span>Share Type</span>
                    <select
                      value={settings.screenShare?.displaySurface || 'monitor'}
                      onChange={(e) => handleScreenShareSelectChange('displaySurface', e.target.value)}
                      disabled={isScreenSharing}
                    >
                      <option value="monitor">Entire Screen</option>
                      <option value="window">Application Window</option>
                      <option value="browser">Browser Tab</option>
                    </select>
                  </label>
                  <small>What to share with viewers</small>
                </div>

                {/* Cursor Visibility */}
                <div className="setting-group" style={{ margin: 0 }}>
                  <label className="setting-label">
                    <span>Cursor</span>
                    <select
                      value={settings.screenShare?.cursor || 'always'}
                      onChange={(e) => handleScreenShareSelectChange('cursor', e.target.value)}
                      disabled={isScreenSharing}
                    >
                      <option value="always">Always Visible</option>
                      <option value="motion">Show on Motion</option>
                      <option value="never">Hidden</option>
                    </select>
                  </label>
                  <small>Mouse cursor visibility</small>
                </div>
              </div>

              {/* Two Column Layout for Features */}
              <div style={{
                gridColumn: '1 / -1',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '20px',
                marginTop: '16px'
              }}>
                {/* Left Column: Webcam Overlay (PiP) */}
                <div style={{
                  padding: '16px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.08)'
                }}>
                  <label className="setting-label" style={{ marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={settings.screenShare?.pipEnabled ?? false}
                      onChange={() => handleScreenShareToggle('pipEnabled')}
                      disabled={isScreenSharing}
                    />
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>📹 Webcam Overlay</span>
                  </label>
                  <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#888', lineHeight: 1.4 }}>
                    Show your camera as a picture-in-picture overlay on your screen share
                  </p>

                  {/* PiP Options */}
                  {(settings.screenShare?.pipEnabled ?? false) && (
                    <div style={{
                      padding: '14px',
                      background: 'rgba(78, 205, 196, 0.08)',
                      borderRadius: '8px',
                      border: '1px solid rgba(78, 205, 196, 0.2)'
                    }}>
                      {/* Position Selector */}
                      <div style={{ marginBottom: '14px' }}>
                        <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Position
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                          {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
                            <button
                              key={pos}
                              type="button"
                              onClick={() => handleScreenShareSelectChange('pipPosition', pos)}
                              style={{
                                padding: '10px 8px',
                                border: (settings.screenShare?.pipPosition || 'bottom-right') === pos
                                  ? '2px solid #4ecdc4'
                                  : '1px solid rgba(255,255,255,0.15)',
                                borderRadius: '6px',
                                background: (settings.screenShare?.pipPosition || 'bottom-right') === pos
                                  ? 'rgba(78, 205, 196, 0.25)'
                                  : 'rgba(255,255,255,0.03)',
                                color: (settings.screenShare?.pipPosition || 'bottom-right') === pos ? '#4ecdc4' : '#999',
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: 500,
                                textTransform: 'capitalize',
                                transition: 'all 0.15s ease'
                              }}
                            >
                              {pos.replace('-', ' ')}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Size Slider */}
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <span style={{ fontSize: '11px', fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Size</span>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#4ecdc4' }}>{settings.screenShare?.pipSize ?? 25}%</span>
                        </div>
                        <input
                          type="range"
                          min="10"
                          max="50"
                          value={settings.screenShare?.pipSize ?? 25}
                          onChange={(e) => handlePipSizeChange(parseInt(e.target.value))}
                          style={{
                            width: '100%',
                            height: '6px',
                            cursor: 'pointer',
                            accentColor: '#4ecdc4'
                          }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#666', marginTop: '4px' }}>
                          <span>Small</span>
                          <span>Large</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right Column: System Audio */}
                <div style={{
                  padding: '16px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.08)'
                }}>
                  <label className="setting-label" style={{ marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={settings.screenShare?.audio ?? false}
                      onChange={() => handleScreenShareToggle('audio')}
                      disabled={isScreenSharing}
                    />
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>🔊 System Audio</span>
                  </label>
                  <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#888', lineHeight: 1.4 }}>
                    Capture audio from games, apps, or browser tabs along with your screen
                  </p>

                  {settings.screenShare?.audio && (
                    <div style={{
                      padding: '14px',
                      background: 'rgba(255, 107, 107, 0.08)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 107, 107, 0.2)'
                    }}>
                      {/* Tip */}
                      <div style={{
                        padding: '10px',
                        background: 'rgba(76, 175, 80, 0.12)',
                        border: '1px solid rgba(76, 175, 80, 0.3)',
                        borderRadius: '6px',
                        fontSize: '11px',
                        color: '#81c784',
                        marginBottom: '14px',
                        lineHeight: 1.5
                      }}>
                        <strong>💡 Tip:</strong> Check <strong>"Share system audio"</strong> in the browser dialog to capture audio.
                      </div>

                      {/* Mix with Microphone option */}
                      <label className="setting-label" style={{ marginBottom: '10px' }}>
                        <input
                          type="checkbox"
                          checked={settings.screenShare?.mixWithMic ?? true}
                          onChange={() => handleScreenShareToggle('mixWithMic')}
                          disabled={isScreenSharing}
                        />
                        <span style={{ fontSize: '13px' }}>Mix with Microphone</span>
                      </label>

                      {/* Volume Mixer */}
                      {(settings.screenShare?.mixWithMic ?? true) && (
                        <div style={{ marginTop: '12px' }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '12px', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Audio Balance
                          </div>

                          {/* Microphone Volume */}
                          <div style={{ marginBottom: '12px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                              <span style={{ fontSize: '12px' }}>🎤 Microphone</span>
                              <span style={{ fontSize: '13px', fontWeight: 600, color: '#4ecdc4' }}>{settings.screenShare?.micGain ?? 100}%</span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={settings.screenShare?.micGain ?? 100}
                              onChange={(e) => handleScreenShareGainChange('micGain', parseInt(e.target.value))}
                              style={{
                                width: '100%',
                                height: '6px',
                                cursor: 'pointer',
                                accentColor: '#4ecdc4'
                              }}
                            />
                          </div>

                          {/* System Audio Volume */}
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                              <span style={{ fontSize: '12px' }}>🔊 System</span>
                              <span style={{ fontSize: '13px', fontWeight: 600, color: '#ff6b6b' }}>{settings.screenShare?.systemGain ?? 100}%</span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={settings.screenShare?.systemGain ?? 100}
                              onChange={(e) => handleScreenShareGainChange('systemGain', parseInt(e.target.value))}
                              style={{
                                width: '100%',
                                height: '6px',
                                cursor: 'pointer',
                                accentColor: '#ff6b6b'
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
  );
};

export default ScreenSharePanel;
