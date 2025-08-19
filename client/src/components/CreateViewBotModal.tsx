import React, { useState } from 'react';
import { X, Play, Settings, Monitor, Upload } from 'lucide-react';
import './CreateViewBotModal.css';

interface ViewBotConfig {
  contentType: 'testPattern' | 'videoFile' | 'webCam' | 'screenCapture' | 'customText';
  videoFile?: string;
  testPattern?: 'color-bars' | 'moving-text' | 'clock' | 'noise' | 'gradient';
  customText?: string;
  textColor?: string;
  backgroundColor?: string;
  fontSize?: number;
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: string;
  audioBitrate: string;
  autoStart: boolean;
  streamDuration: number;
}

interface CreateViewBotModalProps {
  isVisible: boolean;
  onClose: () => void;
  onCreateBot: (config: ViewBotConfig, startImmediately?: boolean) => Promise<void>;
}

const CreateViewBotModal: React.FC<CreateViewBotModalProps> = ({
  isVisible,
  onClose,
  onCreateBot
}) => {
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  
  const [config, setConfig] = useState<ViewBotConfig>({
    contentType: 'testPattern',
    testPattern: 'color-bars',
    customText: 'Welcome to OneStreamer!',
    textColor: '#00ff88',
    backgroundColor: '#001122',
    fontSize: 48,
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: '1000k',
    audioBitrate: '128k',
    autoStart: false,
    streamDuration: 0
  });
  
  const [creating, setCreating] = useState(false);

  const contentTypes = [
    { value: 'testPattern', label: 'Test Pattern' },
    { value: 'customText', label: 'Custom Text' },
    { value: 'videoFile', label: 'Video File' },
    { value: 'webCam', label: 'WebCam (Not Implemented)' },
    { value: 'screenCapture', label: 'Screen Capture (Not Implemented)' }
  ];

  const testPatterns = [
    { value: 'color-bars', label: 'SMPTE Color Bars' },
    { value: 'moving-text', label: 'Scrolling Text' },
    { value: 'clock', label: 'Digital Clock' },
    { value: 'noise', label: 'Random Noise' },
    { value: 'gradient', label: 'Color Gradient' }
  ];

  const resolutions = [
    { value: { width: 1920, height: 1080 }, label: '1920×1080 (Full HD)' },
    { value: { width: 1280, height: 720 }, label: '1280×720 (HD)' },
    { value: { width: 854, height: 480 }, label: '854×480 (SD)' },
    { value: { width: 640, height: 360 }, label: '640×360 (Low)' }
  ];

  const handleCreate = async (startImmediately = false) => {
    setCreating(true);
    try {
      await onCreateBot(config, startImmediately);
      onClose();
    } catch (error) {
      console.error('Failed to create ViewBot:', error);
    } finally {
      setCreating(false);
    }
  };

  const updateConfig = (key: keyof ViewBotConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const setResolution = (resolution: { width: number; height: number }) => {
    setConfig(prev => ({
      ...prev,
      width: resolution.width,
      height: resolution.height
    }));
  };

  if (!isVisible) return null;

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2><Monitor className="header-icon" /> Create ViewBot</h2>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-content">
          <div className="config-section">
            <h3><Settings size={18} /> Configuration</h3>
            
            <div className="form-group">
              <label>Content Type</label>
              <select
                value={config.contentType}
                onChange={(e) => updateConfig('contentType', e.target.value)}
              >
                {contentTypes.map(type => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>

            {config.contentType === 'testPattern' && (
              <div className="form-group">
                <label>Test Pattern</label>
                <select
                  value={config.testPattern}
                  onChange={(e) => updateConfig('testPattern', e.target.value)}
                >
                  {testPatterns.map(pattern => (
                    <option key={pattern.value} value={pattern.value}>
                      {pattern.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {config.contentType === 'customText' && (
              <>
                <div className="form-group">
                  <label>Custom Text</label>
                  <input
                    type="text"
                    value={config.customText}
                    onChange={(e) => updateConfig('customText', e.target.value)}
                    placeholder="Enter your custom text"
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Text Color</label>
                    <input
                      type="color"
                      value={config.textColor}
                      onChange={(e) => updateConfig('textColor', e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>Background Color</label>
                    <input
                      type="color"
                      value={config.backgroundColor}
                      onChange={(e) => updateConfig('backgroundColor', e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label>Font Size</label>
                    <input
                      type="number"
                      value={config.fontSize}
                      onChange={(e) => updateConfig('fontSize', parseInt(e.target.value))}
                      min="12"
                      max="120"
                    />
                  </div>
                </div>
              </>
            )}

            {config.contentType === 'videoFile' && (
              <div className="form-group">
                <label>Video File</label>
                <div className="video-file-input-group">
                  <input
                    type="text"
                    value={config.videoFile || ''}
                    onChange={(e) => updateConfig('videoFile', e.target.value)}
                    placeholder="Path to video file or URL"
                  />
                  <div className="file-upload-wrapper">
                    <input
                      type="file"
                      id="modal-file-upload"
                      accept="video/*"
                      disabled={uploadingVideo}
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          // Set uploading state
                          setUploadingVideo(true);
                          setUploadProgress(0);
                          
                          const formData = new FormData();
                          formData.append('video', file);
                          
                          try {
                            const token = localStorage.getItem('adminToken');
                            const adminKey = localStorage.getItem('adminKey') || token;
                            
                            // Create XMLHttpRequest to track upload progress
                            const xhr = new XMLHttpRequest();
                            
                            // Track upload progress
                            xhr.upload.addEventListener('progress', (event) => {
                              if (event.lengthComputable) {
                                const percentComplete = Math.round((event.loaded / event.total) * 100);
                                setUploadProgress(percentComplete);
                              }
                            });
                            
                            // Handle completion
                            await new Promise((resolve, reject) => {
                              xhr.onload = () => {
                                if (xhr.status === 200) {
                                  try {
                                    const result = JSON.parse(xhr.responseText);
                                    updateConfig('videoFile', result.filePath);
                                    console.log(`✅ Video uploaded: ${result.filePath}`);
                                    resolve(result);
                                  } catch (error) {
                                    reject(error);
                                  }
                                } else {
                                  console.error(`❌ Failed to upload video: ${xhr.statusText}`);
                                  reject(new Error(xhr.statusText));
                                }
                              };
                              
                              xhr.onerror = () => reject(new Error('Network error'));
                              
                              xhr.open('POST', `${process.env.REACT_APP_SERVER_URL || window.location.origin}/admin/viewbot-client/upload-video`);
                              xhr.setRequestHeader('x-admin-key', adminKey || '');
                              if (token) {
                                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                              }
                              xhr.send(formData);
                            });
                          } catch (error) {
                            console.error('File upload error:', error);
                          } finally {
                            // Reset upload state
                            setUploadingVideo(false);
                            setUploadProgress(0);
                          }
                        }
                      }}
                      style={{ display: 'none' }}
                    />
                    {uploadingVideo ? (
                      <div className="upload-progress">
                        <div className="upload-progress-bar">
                          <div 
                            className="upload-progress-fill" 
                            style={{ width: `${uploadProgress}%` }}
                          />
                        </div>
                        <span className="upload-progress-text">
                          Uploading... {uploadProgress}%
                        </span>
                      </div>
                    ) : (
                      <label htmlFor="modal-file-upload" className="file-upload-btn">
                        <Upload size={16} /> Upload Video
                      </label>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="form-group">
              <label>Resolution</label>
              <select
                value={`${config.width}x${config.height}`}
                onChange={(e) => {
                  const resolution = resolutions.find(r => 
                    `${r.value.width}x${r.value.height}` === e.target.value
                  );
                  if (resolution) setResolution(resolution.value);
                }}
              >
                {resolutions.map(resolution => (
                  <option 
                    key={`${resolution.value.width}x${resolution.value.height}`}
                    value={`${resolution.value.width}x${resolution.value.height}`}
                  >
                    {resolution.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Frame Rate</label>
                <select
                  value={config.frameRate}
                  onChange={(e) => updateConfig('frameRate', parseInt(e.target.value))}
                >
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </div>
              <div className="form-group">
                <label>Video Bitrate</label>
                <select
                  value={config.videoBitrate}
                  onChange={(e) => updateConfig('videoBitrate', e.target.value)}
                >
                  <option value="500k">500k (Low)</option>
                  <option value="1000k">1000k (Medium)</option>
                  <option value="2000k">2000k (High)</option>
                  <option value="4000k">4000k (Ultra)</option>
                </select>
              </div>
              <div className="form-group">
                <label>Audio Bitrate</label>
                <select
                  value={config.audioBitrate}
                  onChange={(e) => updateConfig('audioBitrate', e.target.value)}
                >
                  <option value="64k">64k</option>
                  <option value="128k">128k</option>
                  <option value="192k">192k</option>
                  <option value="256k">256k</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Stream Duration (minutes)</label>
              <input
                type="number"
                min="0"
                value={config.streamDuration}
                onChange={(e) => updateConfig('streamDuration', parseInt(e.target.value) || 0)}
                placeholder="0 for infinite"
              />
              <small className="form-hint">
                Set to 0 for infinite streaming. If rotation is enabled, this will be used as the time allotment.
              </small>
            </div>

            <div className="form-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={config.autoStart}
                  onChange={(e) => updateConfig('autoStart', e.target.checked)}
                />
                Auto-start streaming after creation
              </label>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button 
            className="btn-primary" 
            onClick={() => handleCreate(false)}
            disabled={creating}
          >
            {creating ? 'Creating...' : 'Create Bot'}
          </button>
          <button 
            className="btn-success" 
            onClick={() => handleCreate(true)}
            disabled={creating}
          >
            <Play size={16} />
            {creating ? 'Creating...' : 'Create & Start'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateViewBotModal;