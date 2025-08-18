import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import RecordingsPlayback from './RecordingsPlayback';
import './RecordingManagement.css';

interface Recording {
  id: string;
  stream_id: string;
  streamer_id: string;
  username?: string;
  start_time: string;
  end_time?: string;
  duration?: number;
  file_path: string;
  file_size?: number;
  quality_profile: string;
  format: string;
  status: 'recording' | 'processing' | 'completed' | 'failed' | 'archived';
  compression_status: string;
  thumbnail_path?: string;
  created_at: string;
}

interface ActiveRecording {
  id: string;
  streamerId: string;
  quality: string;
  startTime: string;
  status: string;
  progress?: any;
}

interface RecordingSystemStatus {
  recording: {
    activeRecordings: number;
    maxConcurrentRecordings: number;
    qualityProfiles: string[];
  };
  compression: {
    queueSize: number;
    activeCount: number;
    maxConcurrent: number;
  };
  storage: {
    totalFiles: number;
    totalSize: number;
    directories: Record<string, any>;
  };
}

interface ContinuousRecordingStatus {
  enabled: boolean;
  quality: string;
  sessionId: string | null;
  currentRecording: string | null;
  streamSwitches: number;
  isRecording: boolean;
}

interface RecordingManagementProps {
  addLog: (message: string) => void;
}

const RecordingManagement: React.FC<RecordingManagementProps> = ({ addLog }) => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [activeRecordings, setActiveRecordings] = useState<ActiveRecording[]>([]);
  const [systemStatus, setSystemStatus] = useState<RecordingSystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedQuality, setSelectedQuality] = useState('720p');
  const [streamerIdInput, setStreamerIdInput] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [continuousRecordingStatus, setContinuousRecordingStatus] = useState<ContinuousRecordingStatus | null>(null);

  const recordingsPerPage = 10;
  const serverUrl = process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';

  useEffect(() => {
    loadRecordings();
    loadActiveRecordings();
    loadSystemStatus();
    loadContinuousRecordingStatus();
    
    // Refresh data every 30 seconds
    const interval = setInterval(() => {
      loadActiveRecordings();
      loadSystemStatus();
      loadContinuousRecordingStatus();
    }, 30000);
    
    return () => clearInterval(interval);
  }, [currentPage, statusFilter]);

  const makeApiCall = async (endpoint: string, options: RequestInit = {}) => {
    try {
      const token = authService.getToken();
      const response = await fetch(`${serverUrl}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...options.headers
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      addLog(`API Error (${endpoint}): ${errorMessage}`);
      throw error;
    }
  };

  const loadRecordings = async () => {
    try {
      setLoading(true);
      const offset = currentPage * recordingsPerPage;
      const queryParams = new URLSearchParams({
        limit: recordingsPerPage.toString(),
        offset: offset.toString(),
        ...(statusFilter && { status: statusFilter })
      });

      const data = await makeApiCall(`/admin/recordings/list?${queryParams}`);
      if (data.success) {
        setRecordings(data.recordings);
      }
    } catch (error) {
      addLog(`Failed to load recordings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const loadActiveRecordings = async () => {
    try {
      const data = await makeApiCall('/admin/recordings/active');
      if (data.success) {
        setActiveRecordings(data.activeRecordings);
      }
    } catch (error) {
      console.error('Failed to load active recordings:', error);
    }
  };

  const loadSystemStatus = async () => {
    try {
      const data = await makeApiCall('/admin/recordings/system-status');
      if (data.success) {
        setSystemStatus(data);
      }
    } catch (error) {
      console.error('Failed to load system status:', error);
    }
  };

  const loadContinuousRecordingStatus = async () => {
    try {
      const data = await makeApiCall('/admin/recordings/continuous/status');
      if (data.success) {
        setContinuousRecordingStatus(data.status);
      }
    } catch (error) {
      console.error('Failed to load continuous recording status:', error);
    }
  };

  const startRecording = async () => {
    if (!streamerIdInput.trim()) {
      addLog('Please enter a streamer ID');
      return;
    }

    try {
      const data = await makeApiCall('/admin/recordings/start', {
        method: 'POST',
        body: JSON.stringify({
          streamerId: streamerIdInput.trim(),
          quality: selectedQuality
        })
      });

      if (data.success) {
        addLog(`Recording started for ${streamerIdInput} (${selectedQuality})`);
        setStreamerIdInput('');
        loadActiveRecordings();
        loadSystemStatus();
      } else {
        addLog(`Failed to start recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to start recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const stopRecording = async (recordingId: string) => {
    try {
      const data = await makeApiCall(`/admin/recordings/stop/${recordingId}`, {
        method: 'POST'
      });

      if (data.success) {
        const duration = Math.round(data.duration / 1000);
        addLog(`Recording stopped: ${recordingId} (${duration}s)`);
        loadActiveRecordings();
        loadRecordings();
        loadSystemStatus();
      } else {
        addLog(`Failed to stop recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to stop recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const downloadRecording = async (recording: Recording) => {
    try {
      const token = authService.getToken();
      const response = await fetch(`${serverUrl}/admin/recordings/download/${recording.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording_${recording.streamer_id}_${recording.quality_profile}.${recording.format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        addLog(`Downloaded recording: ${recording.id}`);
      } else {
        const errorData = await response.json();
        addLog(`Failed to download recording: ${errorData.error}`);
      }
    } catch (error) {
      addLog(`Failed to download recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const deleteRecording = async (recordingId: string) => {
    if (!window.confirm('Are you sure you want to delete this recording? This action cannot be undone.')) {
      return;
    }

    try {
      const data = await makeApiCall(`/admin/recordings/${recordingId}`, {
        method: 'DELETE'
      });

      if (data.success) {
        addLog(`Recording deleted: ${recordingId}`);
        loadRecordings();
        loadSystemStatus();
      } else {
        addLog(`Failed to delete recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to delete recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const enableContinuousRecording = async () => {
    try {
      const data = await makeApiCall('/admin/recordings/continuous/enable', {
        method: 'POST',
        body: JSON.stringify({ quality: selectedQuality })
      });

      if (data.success) {
        addLog(`Continuous recording enabled (${selectedQuality})`);
        loadContinuousRecordingStatus();
        loadActiveRecordings();
      } else {
        addLog(`Failed to enable continuous recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to enable continuous recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const disableContinuousRecording = async () => {
    try {
      const data = await makeApiCall('/admin/recordings/continuous/disable', {
        method: 'POST'
      });

      if (data.success) {
        addLog('Continuous recording disabled');
        loadContinuousRecordingStatus();
        loadActiveRecordings();
      } else {
        addLog(`Failed to disable continuous recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to disable continuous recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const runCleanup = async () => {
    if (!window.confirm('Run cleanup to remove old recordings and orphaned files?')) {
      return;
    }

    try {
      setLoading(true);
      const data = await makeApiCall('/admin/recordings/cleanup', {
        method: 'POST'
      });

      if (data.success) {
        addLog(`Cleanup completed: ${data.cleaned} deleted, ${data.archived} archived, ${data.orphaned} orphaned files removed`);
        loadRecordings();
        loadSystemStatus();
      } else {
        addLog(`Cleanup failed: ${data.error}`);
      }
    } catch (error) {
      addLog(`Cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'Unknown';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'recording': return '#ff6b6b';
      case 'processing': return '#4ecdc4';
      case 'completed': return '#95e1d3';
      case 'failed': return '#fce38a';
      case 'archived': return '#b8b8b8';
      default: return '#e8e8e8';
    }
  };

  return (
    <div className="recording-management">
      <h3>📹 Recording Management</h3>
      
      {/* System Status */}
      {systemStatus && (
        <div className="system-status">
          <div className="status-grid">
            <div className="status-card">
              <h4>Active Recordings</h4>
              <div className="status-value">
                {systemStatus.recording?.activeRecordings ?? 0} / {systemStatus.recording?.maxConcurrentRecordings ?? 0}
              </div>
            </div>
            <div className="status-card">
              <h4>Compression Queue</h4>
              <div className="status-value">
                {systemStatus.compression?.queueSize ?? 0} queued, {systemStatus.compression?.activeCount ?? 0} active
              </div>
            </div>
            <div className="status-card">
              <h4>Storage</h4>
              <div className="status-value">
                {systemStatus.storage?.totalFiles ?? 0} files ({formatFileSize(systemStatus.storage?.totalSize ?? 0)})
              </div>
            </div>
            <div className="status-card">
              <h4>Quality Profiles</h4>
              <div className="status-value">
                {systemStatus.recording?.qualityProfiles?.join(', ') ?? 'Loading...'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Continuous Recording Controls */}
      <div className="continuous-recording-section">
        <h4>🔄 Continuous Recording Mode</h4>
        <div className="continuous-status">
          {continuousRecordingStatus && (
            <div className="status-info">
              <div className="status-indicator">
                <span className={`status-dot ${continuousRecordingStatus.enabled ? 'active' : 'inactive'}`}></span>
                Status: {continuousRecordingStatus.enabled ? 'Enabled' : 'Disabled'}
              </div>
              {continuousRecordingStatus.enabled && (
                <>
                  <div className="status-detail">Quality: {continuousRecordingStatus.quality}</div>
                  <div className="status-detail">Session ID: {continuousRecordingStatus.sessionId?.substring(0, 8)}...</div>
                  <div className="status-detail">Stream Switches: {continuousRecordingStatus.streamSwitches}</div>
                  <div className="status-detail">
                    Recording: {continuousRecordingStatus.isRecording ? '🔴 Active' : '⏸️ Waiting for stream'}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="continuous-controls">
          <select
            value={selectedQuality}
            onChange={(e) => setSelectedQuality(e.target.value)}
            className="quality-select"
            disabled={continuousRecordingStatus?.enabled || false}
          >
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
          {!continuousRecordingStatus?.enabled ? (
            <button 
              onClick={enableContinuousRecording}
              className="btn btn-success"
            >
              🔄 Enable Continuous Recording
            </button>
          ) : (
            <button 
              onClick={disableContinuousRecording}
              className="btn btn-warning"
            >
              🛑 Disable Continuous Recording
            </button>
          )}
        </div>
        <div className="continuous-help">
          <small>📋 Continuous recording automatically records all streams and handles stream switching</small>
        </div>
      </div>

      {/* Manual Recording Controls */}
      <div className="recording-controls">
        <h4>Manual Recording</h4>
        <div className="control-row">
          <input
            type="text"
            placeholder="Streamer ID"
            value={streamerIdInput}
            onChange={(e) => setStreamerIdInput(e.target.value)}
            className="streamer-input"
            disabled={continuousRecordingStatus?.enabled || false}
          />
          <select
            value={selectedQuality}
            onChange={(e) => setSelectedQuality(e.target.value)}
            className="quality-select"
            disabled={continuousRecordingStatus?.enabled || false}
          >
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
          </select>
          <button 
            onClick={startRecording}
            className="btn btn-primary"
            disabled={continuousRecordingStatus?.enabled || !streamerIdInput.trim() || (systemStatus?.recording?.activeRecordings ?? 0) >= (systemStatus?.recording?.maxConcurrentRecordings ?? 0)}
          >
            🎬 Start Recording
          </button>
        </div>
        {continuousRecordingStatus?.enabled && (
          <div className="disabled-notice">
            <small>⚠️ Manual recording is disabled while continuous recording is active</small>
          </div>
        )}
      </div>

      {/* Active Recordings */}
      {activeRecordings.length > 0 && (
        <div className="active-recordings">
          <h4>Active Recordings ({activeRecordings.length})</h4>
          <div className="active-recordings-grid">
            {activeRecordings.map((recording) => (
              <div key={recording.id} className="active-recording-card">
                <div className="recording-info">
                  <div className="recording-id">📹 {recording.id.substring(0, 8)}...</div>
                  <div className="recording-details">
                    <span>Streamer: {recording.streamerId}</span>
                    <span>Quality: {recording.quality}</span>
                    <span>Status: {recording.status}</span>
                    <span>Started: {new Date(recording.startTime).toLocaleTimeString()}</span>
                  </div>
                </div>
                <button
                  onClick={() => stopRecording(recording.id)}
                  className="btn btn-danger btn-sm"
                >
                  🛑 Stop
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recording History */}
      <div className="recording-history">
        <div className="history-header">
          <h4>Recording History</h4>
          <div className="history-controls">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(0);
              }}
              className="status-filter"
            >
              <option value="">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="processing">Processing</option>
              <option value="failed">Failed</option>
              <option value="archived">Archived</option>
            </select>
            <button onClick={runCleanup} className="btn btn-warning btn-sm" disabled={loading}>
              🧹 Cleanup
            </button>
            <button onClick={loadRecordings} className="btn btn-secondary btn-sm" disabled={loading}>
              🔄 Refresh
            </button>
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading recordings...</div>
        ) : (
          <>
            <div className="recordings-table">
              <div className="table-header">
                <div>ID</div>
                <div>Streamer</div>
                <div>Username</div>
                <div>Quality</div>
                <div>Duration</div>
                <div>Size</div>
                <div>Status</div>
                <div>Created</div>
                <div>Actions</div>
              </div>
              {recordings.map((recording) => (
                <div key={recording.id} className="table-row">
                  <div className="recording-id" title={recording.id}>
                    {recording.id.substring(0, 8)}...
                  </div>
                  <div>{recording.streamer_id}</div>
                  <div>{recording.username || 'Unknown'}</div>
                  <div>{recording.quality_profile}</div>
                  <div>{formatDuration(recording.duration)}</div>
                  <div>{formatFileSize(recording.file_size)}</div>
                  <div>
                    <span 
                      className="status-badge" 
                      style={{ backgroundColor: getStatusColor(recording.status) }}
                    >
                      {recording.status}
                    </span>
                  </div>
                  <div>{new Date(recording.created_at).toLocaleString()}</div>
                  <div className="actions">
                    {recording.status === 'completed' && (
                      <button
                        onClick={() => downloadRecording(recording)}
                        className="btn btn-primary btn-xs"
                        title="Download"
                      >
                        📥
                      </button>
                    )}
                    <button
                      onClick={() => deleteRecording(recording.id)}
                      className="btn btn-danger btn-xs"
                      title="Delete"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div className="pagination">
              <button
                onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
                disabled={currentPage === 0}
                className="btn btn-secondary btn-sm"
              >
                ← Previous
              </button>
              <span className="page-info">
                Page {currentPage + 1}
              </span>
              <button
                onClick={() => setCurrentPage(currentPage + 1)}
                disabled={recordings.length < recordingsPerPage}
                className="btn btn-secondary btn-sm"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
      
      {/* Recordings Playback Section */}
      <RecordingsPlayback authToken={authService.getToken() || ''} />
    </div>
  );
};

export default RecordingManagement;