import React, { useState, useEffect } from 'react';
import { 
  Film, 
  Upload, 
  Trash2, 
  Play, 
  Pause,
  RefreshCw,
  Clock,
  CheckCircle,
  AlertCircle
} from 'lucide-react';
import '../../styles/ViewBotVideoManager.css';

interface VideoFile {
  filename: string;
  path: string;
  size: number;
  uploadDate: string;
  duration?: string;
  isActive?: boolean;
}

interface RotationStatus {
  enabled: boolean;
  currentBot?: string;
  nextRotationIn?: number;
  settings: {
    minRotationInterval: number;
    maxRotationInterval: number;
    cooldownDuration: number;
  };
}

interface ViewBotVideoManagerProps {
  makeApiCall?: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog?: (message: string) => void;
}

const ViewBotVideoManager: React.FC<ViewBotVideoManagerProps> = ({ makeApiCall, addLog }) => {
  // console.log('ViewBotVideoManager component loaded!');
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [rotationStatus, setRotationStatus] = useState<RotationStatus | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [loading, setLoading] = useState(true);

  // Fetch video list and rotation status
  const fetchData = async () => {
    if (!makeApiCall) return;
    
    try {
      setLoading(true);
      
      // Fetch videos
      const videosResponse = await makeApiCall('/admin/viewbot/videos');
      if (videosResponse.success) {
        setVideos(videosResponse.videos);
      }
      
      // Fetch rotation status
      const statusResponse = await makeApiCall('/admin/viewbot/rotation/status');
      if (statusResponse.success) {
        setRotationStatus(statusResponse.status);
      }
      
      addLog?.('✅ Loaded ViewBot video library');
    } catch (error) {
      console.error('Failed to fetch data:', error);
      addLog?.('❌ Failed to load ViewBot data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle video upload
  const handleVideoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('video/')) {
      addLog?.('❌ Please select a video file');
      return;
    }

    // Validate file size (max 500MB)
    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) {
      addLog?.('❌ File too large. Maximum size is 500MB');
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('video', file);

    try {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = (e.loaded / e.total) * 100;
          setUploadProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          if (response.success) {
            addLog?.(`✅ Uploaded video: ${file.name}`);
            fetchData();
          }
        }
      });

      xhr.addEventListener('error', () => {
        addLog?.('❌ Upload failed');
      });

      xhr.open('POST', '/admin/viewbot/videos/upload');
      xhr.send(formData);
      
    } catch (error) {
      console.error('Upload error:', error);
      addLog?.('❌ Failed to upload video');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // Delete video
  const handleDeleteVideo = async (filename: string) => {
    if (!window.confirm(`Delete ${filename}?`)) return;
    if (!makeApiCall) return;

    try {
      const response = await makeApiCall('/admin/viewbot/videos/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });

      if (response.success) {
        addLog?.(`✅ Deleted video: ${filename}`);
        fetchData();
      }
    } catch (error) {
      console.error('Delete error:', error);
      addLog?.('❌ Failed to delete video');
    }
  };

  // Toggle rotation
  const toggleRotation = async () => {
    if (!makeApiCall) return;
    
    try {
      const endpoint = rotationStatus?.enabled 
        ? '/admin/viewbot/rotation/stop'
        : '/admin/viewbot/rotation/start';
      
      const response = await makeApiCall(endpoint, { method: 'POST' });
      
      if (response.success) {
        addLog?.(rotationStatus?.enabled ? '⏸️ Stopped rotation' : '▶️ Started rotation');
        fetchData();
      }
    } catch (error) {
      console.error('Toggle error:', error);
      addLog?.('❌ Failed to toggle rotation');
    }
  };

  // Force rotation
  const forceRotation = async () => {
    if (!makeApiCall) return;
    
    try {
      const response = await makeApiCall('/admin/viewbot/rotation/force', { 
        method: 'POST' 
      });
      
      if (response.success) {
        addLog?.('🔄 Forced rotation to next video');
        fetchData();
      }
    } catch (error) {
      console.error('Force rotation error:', error);
      addLog?.('❌ Failed to force rotation');
    }
  };

  // Format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // Format time
  const formatTime = (ms: number): string => {
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

  if (loading) {
    return (
      <div className="viewbot-video-manager">
        <div className="loading-state">
          <RefreshCw className="spin" />
          <p>Loading video library...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="viewbot-video-manager">
      {/* Header */}
      <div className="manager-header">
        <div className="header-title">
          <Film size={24} />
          <h2>ViewBot Video Library</h2>
        </div>
        
        <div className="header-actions">
          {/* Upload button */}
          <label className="upload-button">
            <input
              type="file"
              accept="video/*"
              onChange={handleVideoUpload}
              disabled={isUploading}
              style={{ display: 'none' }}
            />
            <Upload size={18} />
            Upload Video
          </label>

          {/* Rotation controls */}
          <button 
            className={`rotation-toggle ${rotationStatus?.enabled ? 'active' : ''}`}
            onClick={toggleRotation}
          >
            {rotationStatus?.enabled ? <Pause size={18} /> : <Play size={18} />}
            {rotationStatus?.enabled ? 'Stop Rotation' : 'Start Rotation'}
          </button>

          <button 
            className="force-rotation"
            onClick={forceRotation}
            disabled={!rotationStatus?.enabled}
          >
            <RefreshCw size={18} />
            Next
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="status-bar">
        <div className="status-item">
          <span className="status-label">Status:</span>
          <span className={`status-value ${rotationStatus?.enabled ? 'active' : 'inactive'}`}>
            {rotationStatus?.enabled ? (
              <>
                <CheckCircle size={14} />
                Rotation Active
              </>
            ) : (
              <>
                <AlertCircle size={14} />
                Rotation Stopped
              </>
            )}
          </span>
        </div>

        {rotationStatus?.currentBot && (
          <div className="status-item">
            <span className="status-label">Current:</span>
            <span className="status-value">{rotationStatus.currentBot}</span>
          </div>
        )}

        {rotationStatus?.nextRotationIn && (
          <div className="status-item">
            <span className="status-label">Next rotation:</span>
            <span className="status-value">
              <Clock size={14} />
              {formatTime(rotationStatus.nextRotationIn)}
            </span>
          </div>
        )}

        <div className="status-item">
          <span className="status-label">Videos:</span>
          <span className="status-value">{videos.length}</span>
        </div>

        <div className="status-item">
          <span className="status-label">Rotation interval:</span>
          <span className="status-value">
            {formatTime(rotationStatus?.settings.minRotationInterval || 60000)} - {formatTime(rotationStatus?.settings.maxRotationInterval || 180000)}
          </span>
        </div>
      </div>

      {/* Upload progress */}
      {isUploading && (
        <div className="upload-progress">
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <span className="progress-text">Uploading... {Math.round(uploadProgress)}%</span>
        </div>
      )}

      {/* Video list */}
      <div className="video-list">
        {videos.length === 0 ? (
          <div className="empty-state">
            <Film size={48} />
            <h3>No videos uploaded</h3>
            <p>Upload video files to enable ViewBot rotation</p>
          </div>
        ) : (
          <div className="video-grid">
            {videos.map((video, index) => (
              <div 
                key={video.filename} 
                className={`video-card ${video.isActive ? 'active' : ''}`}
              >
                <div className="video-thumbnail">
                  <Film size={32} />
                  {video.isActive && (
                    <div className="active-indicator">
                      <Play size={14} />
                      LIVE
                    </div>
                  )}
                </div>
                
                <div className="video-info">
                  <h4 className="video-name">{video.filename}</h4>
                  <div className="video-meta">
                    <span className="meta-item">{formatFileSize(video.size)}</span>
                    {video.duration && (
                      <span className="meta-item">{video.duration}</span>
                    )}
                  </div>
                  <div className="video-id">Bot #{index + 1}</div>
                </div>

                <button
                  className="delete-button"
                  onClick={() => handleDeleteVideo(video.filename)}
                  disabled={video.isActive}
                  title={video.isActive ? "Cannot delete active video" : "Delete video"}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ViewBotVideoManager;