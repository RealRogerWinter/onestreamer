import React, { useState, useEffect, useRef } from 'react';
import '../../styles/RecordingsPlayback.css';

interface Recording {
  filename: string;
  status: 'active' | 'completed' | 'archived';
  streamerId: string;
  username?: string;
  timestamp: string;
  quality: string;
  size: number;
  sizeFormatted: string;
  createdAt: string;
  modifiedAt: string;
  isRecording: boolean;
}

interface RecordingsPlaybackProps {
  authToken: string;
}

const RecordingsPlayback: React.FC<RecordingsPlaybackProps> = ({ authToken }) => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchRecordings();
    
    // Auto-refresh every 5 seconds to show new recordings
    const interval = setInterval(fetchRecordings, 5000);
    setRefreshInterval(interval);
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [authToken]);

  const fetchRecordings = async () => {
    try {
      const response = await fetch('/admin/recordings/all', {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch recordings');
      }

      const data = await response.json();
      setRecordings(data.recordings);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching recordings:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  };

  const playRecording = (recording: Recording) => {
    setSelectedRecording(recording);
    setIsPlaying(true);
  };

  const closePlayer = () => {
    setSelectedRecording(null);
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.src = '';
    }
  };

  const downloadRecording = (recording: Recording) => {
    const link = document.createElement('a');
    link.href = `/admin/recordings/stream/${recording.filename}`;
    link.download = recording.filename;
    link.click();
  };

  const deleteRecording = async (recording: Recording) => {
    if (!window.confirm(`Are you sure you want to delete ${recording.filename}?`)) {
      return;
    }

    try {
      const response = await fetch(`/admin/recordings/${recording.filename}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });

      if (response.ok) {
        fetchRecordings(); // Refresh the list
      }
    } catch (err) {
      console.error('Error deleting recording:', err);
    }
  };

  const getStatusBadge = (recording: Recording) => {
    if (recording.isRecording) {
      return <span className="badge badge-recording">🔴 Recording</span>;
    }
    
    switch (recording.status) {
      case 'active':
        return <span className="badge badge-active">Active</span>;
      case 'completed':
        return <span className="badge badge-completed">Completed</span>;
      case 'archived':
        return <span className="badge badge-archived">Archived</span>;
      default:
        return <span className="badge">Unknown</span>;
    }
  };

  if (loading) {
    return <div className="recordings-loading">Loading recordings...</div>;
  }

  if (error) {
    return <div className="recordings-error">Error: {error}</div>;
  }

  return (
    <div className="recordings-playback">
      <div className="recordings-header">
        <h3>📹 Recorded Streams</h3>
        <div className="recordings-stats">
          <span>Total: {recordings.length} recordings</span>
          <span>Active: {recordings.filter(r => r.isRecording).length}</span>
          <span>Storage: {recordings.reduce((acc, r) => acc + r.size, 0) / (1024 * 1024 * 1024) > 1 
            ? `${(recordings.reduce((acc, r) => acc + r.size, 0) / (1024 * 1024 * 1024)).toFixed(2)} GB`
            : `${(recordings.reduce((acc, r) => acc + r.size, 0) / (1024 * 1024)).toFixed(2)} MB`}</span>
        </div>
      </div>

      <div className="recordings-list">
        {recordings.length === 0 ? (
          <div className="no-recordings">No recordings available</div>
        ) : (
          <table className="recordings-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Streamer</th>
                <th>Username</th>
                <th>Date/Time</th>
                <th>Quality</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recordings.map((recording, index) => (
                <tr key={index} className={recording.isRecording ? 'recording-active' : ''}>
                  <td>{getStatusBadge(recording)}</td>
                  <td className="streamer-id">{recording.streamerId}</td>
                  <td className="username">{recording.username || 'Unknown'}</td>
                  <td>{new Date(recording.createdAt).toLocaleString()}</td>
                  <td>{recording.quality}</td>
                  <td>{recording.sizeFormatted}</td>
                  <td className="recording-actions">
                    {!recording.isRecording && (
                      <>
                        <button 
                          className="btn-play" 
                          onClick={() => playRecording(recording)}
                          title="Play"
                        >
                          ▶️
                        </button>
                        <button 
                          className="btn-download" 
                          onClick={() => downloadRecording(recording)}
                          title="Download"
                        >
                          💾
                        </button>
                        {recording.status !== 'active' && (
                          <button 
                            className="btn-delete" 
                            onClick={() => deleteRecording(recording)}
                            title="Delete"
                          >
                            🗑️
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Video Player Modal */}
      {isPlaying && selectedRecording && (
        <div className="video-modal-overlay" onClick={closePlayer}>
          <div className="video-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h4>Playing: {selectedRecording.filename}</h4>
              <button className="modal-close" onClick={closePlayer}>✕</button>
            </div>
            <div className="modal-body">
              <video
                ref={videoRef}
                controls
                autoPlay
                className="recording-player"
                src={`/admin/recordings/stream/${selectedRecording.filename}`}
              >
                Your browser does not support the video tag.
              </video>
              <div className="recording-info">
                <p><strong>Streamer:</strong> {selectedRecording.streamerId}</p>
                <p><strong>Date:</strong> {new Date(selectedRecording.createdAt).toLocaleString()}</p>
                <p><strong>Quality:</strong> {selectedRecording.quality}</p>
                <p><strong>Size:</strong> {selectedRecording.sizeFormatted}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RecordingsPlayback;