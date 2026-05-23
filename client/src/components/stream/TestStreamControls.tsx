import React, { useState, useEffect, useRef } from 'react';
import { TestStreamGenerator } from '../../services/TestStreamGenerator';

interface TestStreamControlsProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

interface TestStreamStatus {
  isActive: boolean;
  streamId: string | null;
  startTime: number | null;
  duration: number;
  config: {
    type: string;
    content: string;
    width: number;
    height: number;
    frameRate: number;
  };
}

interface TestStreamMetrics {
  streamId: string;
  duration: number;
  totalFrames: number;
  frameRate: number;
  resolution: string;
  bitrate: number;
  lastFrameTime: number;
}

const TestStreamControls: React.FC<TestStreamControlsProps> = ({ makeApiCall, addLog }) => {
  const [status, setStatus] = useState<TestStreamStatus | null>(null);
  const [metrics, setMetrics] = useState<TestStreamMetrics | null>(null);
  const [config, setConfig] = useState({
    content: 'color-bars',
    width: 1280,
    height: 720,
    frameRate: 30
  });
  const [isLoading, setIsLoading] = useState(false);
  const [lastFrame, setLastFrame] = useState<any>(null);
  const testStreamGeneratorRef = useRef<TestStreamGenerator | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const contentTypes = [
    { value: 'color-bars', label: 'SMPTE Color Bars' },
    { value: 'noise', label: 'Random Noise' },
    { value: 'gradient', label: 'Color Gradient' },
    { value: 'moving-text', label: 'Scrolling Text' },
    { value: 'clock', label: 'Digital Clock' }
  ];

  const resolutions = [
    { value: { width: 1920, height: 1080 }, label: '1920×1080 (Full HD)' },
    { value: { width: 1280, height: 720 }, label: '1280×720 (HD)' },
    { value: { width: 854, height: 480 }, label: '854×480 (SD)' },
    { value: { width: 640, height: 360 }, label: '640×360 (Low)' }
  ];

  const fetchStatus = async () => {
    try {
      const result = await makeApiCall('/admin/test-stream/status');
      setStatus(result.status);
      setMetrics(result.metrics);
    } catch (error) {
      addLog(`Failed to fetch test stream status: ${error}`);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (!status?.isActive) return;

    const interval = setInterval(() => {
      fetchStatus();
      fetchLastFrame();
    }, 2000);

    return () => clearInterval(interval);
  }, [status?.isActive]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      if (testStreamGeneratorRef.current) {
        testStreamGeneratorRef.current.cleanup();
      }
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [localStream]);

  const fetchLastFrame = async () => {
    try {
      const frame = await makeApiCall('/admin/test-stream/frame');
      setLastFrame(frame);
    } catch (error) {
      // Silent fail for frame fetching
    }
  };

  const handleStartStream = async () => {
    setIsLoading(true);
    try {
      // Create test stream generator with current config
      testStreamGeneratorRef.current = new TestStreamGenerator(
        config.width,
        config.height,
        config.frameRate,
        config.content
      );
      
      // Generate the media stream
      const stream = testStreamGeneratorRef.current.generateCombinedStream();
      setLocalStream(stream);
      
      addLog(`🎬 Generated test stream - Video: ${stream.getVideoTracks().length} tracks, Audio: ${stream.getAudioTracks().length} tracks`);
      
      // Now start the server-side test stream
      const result = await makeApiCall('/admin/test-stream/start', { 
        method: 'POST',
        body: JSON.stringify({
          config: config,
          hasRealStream: true
        })
      });
      
      addLog(result.message);
      fetchStatus();
    } catch (error) {
      addLog(`Failed to start test stream: ${error}`);
      // Cleanup on error
      if (testStreamGeneratorRef.current) {
        testStreamGeneratorRef.current.cleanup();
        testStreamGeneratorRef.current = null;
      }
      setLocalStream(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStopStream = async () => {
    setIsLoading(true);
    try {
      // Stop the server-side test stream
      const result = await makeApiCall('/admin/test-stream/stop', { method: 'POST' });
      addLog(result.message);
      
      // Cleanup the local test stream generator
      if (testStreamGeneratorRef.current) {
        testStreamGeneratorRef.current.cleanup();
        testStreamGeneratorRef.current = null;
      }
      
      // Stop all tracks in the local stream
      if (localStream) {
        localStream.getTracks().forEach(track => {
          track.stop();
        });
        setLocalStream(null);
      }
      
      fetchStatus();
      setLastFrame(null);
      addLog('🧹 Test stream generator cleaned up');
    } catch (error) {
      addLog(`Failed to stop test stream: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateConfig = async () => {
    try {
      const result = await makeApiCall('/admin/test-stream/config', {
        method: 'POST',
        body: JSON.stringify(config)
      });
      addLog(result.message);
      fetchStatus();
    } catch (error) {
      addLog(`Failed to update config: ${error}`);
    }
  };

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  };

  return (
    <div className="test-stream-controls">
      <div className="controls-header">
        <h3>🧪 Test Stream Controls</h3>
        <div className="stream-status">
          Status: <span className={`status ${status?.isActive ? 'active' : 'inactive'}`}>
            {status?.isActive ? 'RUNNING' : 'STOPPED'}
          </span>
        </div>
      </div>

      {/* Stream Controls */}
      <div className="controls-section">
        <h4>Stream Control</h4>
        <div className="button-group">
          <button
            onClick={handleStartStream}
            disabled={isLoading || status?.isActive}
            className="start-button"
          >
            ▶️ Start Test Stream
          </button>
          <button
            onClick={handleStopStream}
            disabled={isLoading || !status?.isActive}
            className="stop-button"
          >
            ⏹️ Stop Test Stream
          </button>
        </div>
      </div>

      {/* Configuration */}
      <div className="controls-section">
        <h4>Stream Configuration</h4>
        <div className="config-grid">
          <div className="config-group">
            <label>Content Type:</label>
            <select
              value={config.content}
              onChange={(e) => setConfig({ ...config, content: e.target.value })}
              disabled={status?.isActive}
            >
              {contentTypes.map(type => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          <div className="config-group">
            <label>Resolution:</label>
            <select
              value={`${config.width}x${config.height}`}
              onChange={(e) => {
                const selected = resolutions.find(r => 
                  `${r.value.width}x${r.value.height}` === e.target.value
                );
                if (selected) {
                  setConfig({ ...config, ...selected.value });
                }
              }}
              disabled={status?.isActive}
            >
              {resolutions.map(res => (
                <option key={`${res.value.width}x${res.value.height}`} value={`${res.value.width}x${res.value.height}`}>
                  {res.label}
                </option>
              ))}
            </select>
          </div>

          <div className="config-group">
            <label>Frame Rate:</label>
            <input
              type="number"
              value={config.frameRate}
              onChange={(e) => setConfig({ ...config, frameRate: parseInt(e.target.value) })}
              min="10"
              max="60"
              step="5"
              disabled={status?.isActive}
            />
          </div>

          <div className="config-actions">
            <button
              onClick={handleUpdateConfig}
              disabled={status?.isActive}
            >
              💾 Update Config
            </button>
          </div>
        </div>
      </div>

      {/* Current Status */}
      {status?.isActive && (
        <div className="controls-section">
          <h4>Current Stream Info</h4>
          <div className="info-grid">
            <div className="info-item">
              <span>Stream ID:</span>
              <code>{status.streamId}</code>
            </div>
            <div className="info-item">
              <span>Duration:</span>
              <span>{formatDuration(status.duration)}</span>
            </div>
            <div className="info-item">
              <span>Content:</span>
              <span>{status.config.content}</span>
            </div>
            <div className="info-item">
              <span>Resolution:</span>
              <span>{status.config.width}×{status.config.height}</span>
            </div>
          </div>
        </div>
      )}

      {/* Metrics */}
      {metrics && (
        <div className="controls-section">
          <h4>Stream Metrics</h4>
          <div className="metrics-grid">
            <div className="metric">
              <span className="metric-label">Total Frames:</span>
              <span className="metric-value">{metrics.totalFrames.toLocaleString()}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Frame Rate:</span>
              <span className="metric-value">{metrics.frameRate} fps</span>
            </div>
            <div className="metric">
              <span className="metric-label">Est. Bitrate:</span>
              <span className="metric-value">{metrics.bitrate} kbps</span>
            </div>
            <div className="metric">
              <span className="metric-label">Resolution:</span>
              <span className="metric-value">{metrics.resolution}</span>
            </div>
          </div>
        </div>
      )}

      {/* Live Stream Preview */}
      {localStream && (
        <div className="controls-section">
          <h4>🎥 Live Stream Preview</h4>
          <div className="stream-preview">
            <video
              autoPlay
              muted
              playsInline
              webkit-playsinline="true"
              crossOrigin="anonymous"
              preload="auto"
              className="preview-video"
              ref={(video) => {
                if (video && localStream) {
                  video.srcObject = localStream;
                }
              }}
              style={{
                width: '100%',
                maxWidth: '640px',
                height: 'auto',
                border: '1px solid #ccc',
                borderRadius: '4px',
                // Mobile Chrome specific fixes
                WebkitTransform: 'translateZ(0)', // Force hardware acceleration
                transform: 'translateZ(0)',
                WebkitBackfaceVisibility: 'hidden',
                backfaceVisibility: 'hidden'
              }}
            />
            <div className="preview-info">
              <div>Resolution: {config.width}×{config.height}</div>
              <div>Frame Rate: {config.frameRate} fps</div>
              <div>Video Tracks: {localStream.getVideoTracks().length}</div>
              <div>Audio Tracks: {localStream.getAudioTracks().length}</div>
            </div>
          </div>
        </div>
      )}

      {/* Live Frame Preview */}
      {lastFrame && (
        <div className="controls-section">
          <h4>Live Frame Data</h4>
          <div className="frame-preview">
            <div className="frame-info">
              <div>Frame #{lastFrame.frameNumber}</div>
              <div>Uptime: {lastFrame.uptime}s</div>
              <div>Pattern: {lastFrame.data.pattern}</div>
            </div>
            <div className="frame-data">
              <pre>{JSON.stringify(lastFrame.data, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TestStreamControls;