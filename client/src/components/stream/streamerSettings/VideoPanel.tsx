import React from 'react';
import { VideoSettingsConfig, StreamerSettingsConfig } from './types';

// Presentational Video settings tab, extracted verbatim from the
// activeTab === 'video' branch of StreamerSettings. Stateless: data + handlers
// come from props (state still lives in StreamerSettings / useStreamerDevices).
interface VideoPanelProps {
  settings: StreamerSettingsConfig;
  isStreaming: boolean;
  videoInputs: MediaDeviceInfo[];
  isCameraPreview: boolean;
  setIsCameraPreview: (v: boolean) => void;
  cameraStream: MediaStream | null;
  setCameraStream: (s: MediaStream | null) => void;
  videoPreviewRef: React.RefObject<HTMLVideoElement | null>;
  toggleCameraPreview: () => void;
  applyVideoPreset: (preset: 'low' | 'max') => void;
  handleVideoToggle: (setting: keyof VideoSettingsConfig) => void;
  handleVideoSelectChange: (setting: keyof VideoSettingsConfig, value: string | number) => void;
}

const VideoPanel: React.FC<VideoPanelProps> = ({
  settings,
  isStreaming,
  videoInputs,
  isCameraPreview,
  setIsCameraPreview,
  cameraStream,
  setCameraStream,
  videoPreviewRef,
  toggleCameraPreview,
  applyVideoPreset,
  handleVideoToggle,
  handleVideoSelectChange,
}) => {
  return (
          <div className="settings-panel video-panel">
            <div className="video-presets">
              <label>Quick Video Presets:</label>
              <div className="preset-buttons">
                <button
                  className="preset-btn"
                  onClick={() => applyVideoPreset('low')}
                  title="Low quality - minimal bandwidth"
                >
                  Low (480p)
                </button>
                <button
                  className="preset-btn"
                  onClick={() => applyVideoPreset('max')}
                  title="Maximum quality - 720p HD"
                >
                  Max (720p)
                </button>
              </div>
            </div>

            <div className="settings-grid">
              {/* Camera Selector */}
              <div className="setting-group device-selector">
                <label className="setting-label">
                  <span>Camera</span>
                  <select
                    value={settings.video.videoDeviceId || ''}
                    disabled={false}
                    title={isStreaming ? "Change camera during stream" : "Select camera device"}
                    onChange={async (e) => {
                      const newDeviceId = e.target.value;

                      // Update settings with new device ID - this will trigger real-time update if streaming
                      handleVideoSelectChange('videoDeviceId', newDeviceId);

                      // If preview is active, restart it with new camera
                      if (isCameraPreview) {
                        // console.log('📹 Camera changed, restarting preview...');

                        // Stop current preview
                        if (cameraStream) {
                          cameraStream.getTracks().forEach(track => track.stop());
                          setCameraStream(null);
                        }
                        if (videoPreviewRef.current) {
                          videoPreviewRef.current.srcObject = null;
                        }
                        setIsCameraPreview(false);

                        // Start with new camera after a brief delay
                        setTimeout(() => {
                          toggleCameraPreview();
                        }, 100);
                      }
                    }}
                  >
                    {videoInputs.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Camera ${device.deviceId.slice(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Camera Preview */}
              <div className="setting-group camera-preview">
                <button
                  className={`test-button ${isCameraPreview ? 'active' : ''}`}
                  onClick={toggleCameraPreview}
                  disabled={false}
                >
                  {isCameraPreview ? '🔴 Stop Preview' : '📹 Preview Camera'}
                </button>
                <div className="video-preview-container" style={{ display: isCameraPreview ? 'block' : 'none' }}>
                  <video
                    ref={videoPreviewRef}
                    autoPlay
                    muted
                    playsInline
                    className="video-preview"
                    style={{
                      width: '100%',
                      height: 'auto',
                      maxHeight: '200px',
                      borderRadius: '4px',
                      backgroundColor: '#000',
                      transform: settings.video.mirror ? 'scaleX(-1)' : 'scaleX(1)'
                    }}
                  />
                </div>
              </div>

              {/* Video Settings */}
              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.video.videoEnabled}
                    onChange={() => handleVideoToggle('videoEnabled')}
                    disabled={isStreaming}
                  />
                  <span>Enable Video</span>
                </label>
                <small>Turn video on/off</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.video.mirror}
                    onChange={() => handleVideoToggle('mirror')}
                    disabled={isStreaming}
                  />
                  <span>Mirror Video</span>
                </label>
                <small>Flip video horizontally</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Resolution</span>
                  <select
                    value={settings.video.resolution}
                    onChange={(e) => handleVideoSelectChange('resolution', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="480p">480p (854x480)</option>
                    <option value="720p">720p HD (1280x720)</option>
                  </select>
                </label>
                <small>Higher resolution = better quality</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Frame Rate</span>
                  <select
                    value={settings.video.frameRate}
                    onChange={(e) => handleVideoSelectChange('frameRate', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="15">15 FPS</option>
                    <option value="24">24 FPS</option>
                    <option value="30">30 FPS</option>
                    <option value="60">60 FPS</option>
                  </select>
                </label>
                <small>Higher FPS = smoother motion</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Bitrate</span>
                  <select
                    value={settings.video.bitrate}
                    onChange={(e) => handleVideoSelectChange('bitrate', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="500000">500 Kbps</option>
                    <option value="1000000">1 Mbps</option>
                    <option value="1500000">1.5 Mbps</option>
                    <option value="2000000">2 Mbps</option>
                    <option value="2500000">2.5 Mbps</option>
                    <option value="3000000">3 Mbps (Max)</option>
                  </select>
                </label>
                <small>Higher bitrate = better quality</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Camera Mode</span>
                  <select
                    value={settings.video.facingMode}
                    onChange={(e) => handleVideoSelectChange('facingMode', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="user">Front Camera</option>
                    <option value="environment">Back Camera</option>
                  </select>
                </label>
                <small>Choose camera orientation</small>
              </div>
            </div>
          </div>
  );
};

export default VideoPanel;
