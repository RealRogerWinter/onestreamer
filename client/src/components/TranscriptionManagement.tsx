import React, { useState, useEffect, useRef } from 'react';
import { useMainSocket } from '../contexts/SocketContext';
import authService from '../services/AuthService';
import './TranscriptionManagement.css';

interface TranscriptionManagementProps {
  addLog: (message: string) => void;
}

interface TranscriptionSession {
  id: string;
  streamerId: string;
  startTime: string;
  status: string;
  wordCount: number;
  chunkCount: number;
  bufferStatus?: {
    size: number;
    duration: number;
    isActive: boolean;
  };
}

interface TranscriptionConfig {
  enableTranscription: boolean;
  autoStart: boolean;
  model: string;
  language: string;
  chunkDuration: number;
  bufferDuration: number;
}

interface TranscriptionHistory {
  id: string;
  streamer_id: string;
  start_time: string;
  end_time?: string;
  duration?: number;
  word_count: number;
  language: string;
  status: string;
  full_text?: string;
}

const TranscriptionManagement: React.FC<TranscriptionManagementProps> = ({ addLog }) => {
  const { socket, connected } = useMainSocket();
  const [config, setConfig] = useState<TranscriptionConfig>({
    enableTranscription: false,
    autoStart: false,
    model: 'base', // Fixed to base model
    language: 'en',
    chunkDuration: 5000,
    bufferDuration: 60
  });
  const [activeSessions, setActiveSessions] = useState<TranscriptionSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [liveTranscription, setLiveTranscription] = useState<string[]>([]);
  const [history, setHistory] = useState<TranscriptionHistory[]>([]);
  const [selectedTranscript, setSelectedTranscript] = useState<TranscriptionHistory | null>(null);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [hasActiveStream, setHasActiveStream] = useState(false);
  const [currentStreamerId, setCurrentStreamerId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTimeLeft, setRecordingTimeLeft] = useState(0);
  const [recordingTimerId, setRecordingTimerId] = useState<NodeJS.Timeout | null>(null);
  const [stats, setStats] = useState({
    totalWords: 0,
    activeCount: 0,
    bufferHealth: 'unknown' as 'good' | 'warning' | 'error' | 'unknown'
  });
  
  const liveTranscriptionRef = useRef<HTMLDivElement>(null);
  const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';

  useEffect(() => {
    if (!socket || !connected) return;

    // Socket is already connected via context
    addLog('Connected to transcription service');

    socket.on('transcription-started', (data: any) => {
      addLog(`Transcription started: ${data.sessionId}`);
      setCurrentSessionId(data.sessionId);
      setLiveTranscription([]);
      loadStatus();
    });

    socket.on('transcription-update', (data: any) => {
      if (data.sessionId === currentSessionId) {
        // Filter out common hallucinations
        if (data.text && data.text.trim() !== 'you' && data.text.trim() !== '') {
          // For timed recordings, show complete transcription
          if (data.complete) {
            setLiveTranscription([data.text]);
          } else {
            // For continuous transcription, show chunks
            setLiveTranscription(prev => [...prev, `[Chunk ${data.chunkNumber}] ${data.text}`]);
          }
          setStats(prev => ({
            ...prev,
            totalWords: prev.totalWords + (data.text?.split(' ').length || 0)
          }));
          
          // Auto-scroll to bottom
          if (liveTranscriptionRef.current) {
            liveTranscriptionRef.current.scrollTop = liveTranscriptionRef.current.scrollHeight;
          }
        }
      }
    });

    // Listen for buffer status updates
    socket.on('buffer-status', (data: any) => {
      if (data.sessionId === currentSessionId) {
        // Update buffer health based on status
        const bufferHealth = data.duration > 10 ? 'good' : data.duration > 5 ? 'warning' : 'error';
        setStats(prev => ({ ...prev, bufferHealth }));
        
        // Update active session buffer status
        setActiveSessions(prev => prev.map(session => 
          session.id === data.sessionId 
            ? { ...session, bufferStatus: { size: data.size, duration: data.duration, isActive: true } }
            : session
        ));
      }
    });

    socket.on('transcription-stopped', (data: any) => {
      addLog(`Transcription completed: ${data.wordCount} words`);
      if (data.sessionId === currentSessionId) {
        setCurrentSessionId(null);
        setIsRecording(false);
        setRecordingTimeLeft(0);
        if (recordingTimerId) {
          clearInterval(recordingTimerId);
          setRecordingTimerId(null);
        }
      }
      loadStatus();
      loadHistory();
    });

    socket.on('stream-started', (data: any) => {
      addLog('Stream started');
      checkActiveStream();
    });

    socket.on('stream-ended', () => {
      addLog('Stream ended');
      setHasActiveStream(false);
      setCurrentStreamerId(null);
      if (currentSessionId) {
        stopTranscription();
      }
    });

    // Load initial data
    loadStatus();
    loadHistory();
    checkActiveStream();

    return () => {
      // Clean up event listeners
      socket.off('transcription-started');
      socket.off('transcription-update');
      socket.off('buffer-status');
      socket.off('transcription-stopped');
      socket.off('stream-started');
      socket.off('stream-ended');
    };
  }, [socket, connected, currentSessionId]);

  const loadStatus = async () => {
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/status`, {
        headers: {
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setConfig({
          enableTranscription: data.status.enabled,
          autoStart: data.status.autoStart || false,
          model: data.status.model,
          language: data.status.language,
          chunkDuration: data.status.chunkDuration || 5000,
          bufferDuration: data.status.bufferDuration || 60
        });
        setActiveSessions(data.status.activeSessions || []);
        setStats(prev => ({
          ...prev,
          activeCount: data.status.activeCount
        }));
        
        if (data.status.activeSessions?.length > 0) {
          setCurrentSessionId(data.status.activeSessions[0].id);
        }
      }
    } catch (error) {
      addLog(`Failed to load status: ${error}`);
    }
  };

  const loadHistory = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/transcriptions/history?limit=20`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setHistory(data.transcriptions || []);
      }
    } catch (error) {
      addLog(`Failed to load history: ${error}`);
    }
  };

  const checkActiveStream = async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/stream/active`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setHasActiveStream(data.isActive);
        setCurrentStreamerId(data.streamerId);
      }
    } catch (error) {
      addLog(`Failed to check active stream: ${error}`);
    }
  };

  const applySettings = async () => {
    setIsLoading(true);
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({
          enable: config.enableTranscription,
          autoStart: config.autoStart,
          model: config.model,
          language: config.language,
          chunkDuration: config.chunkDuration,
          bufferDuration: config.bufferDuration
        })
      });

      if (response.ok) {
        addLog('Transcription settings updated successfully');
        loadStatus();
      } else {
        throw new Error('Failed to update settings');
      }
    } catch (error) {
      addLog(`Failed to apply settings: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const startTranscription = async () => {
    if (!currentStreamerId) {
      addLog('No active stream to transcribe');
      return;
    }

    setIsLoading(true);
    setLiveTranscription([]);
    
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/timed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({
          streamerId: currentStreamerId,
          duration: config.bufferDuration,
          options: {
            model: config.model,
            language: config.language,
            chunkDuration: config.chunkDuration
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          addLog(`Recording ${config.bufferDuration}s of audio for transcription`);
          setCurrentSessionId(data.sessionId);
          setIsRecording(true);
          setRecordingTimeLeft(config.bufferDuration);
          
          // Start countdown timer
          const timer = setInterval(() => {
            setRecordingTimeLeft(prev => {
              if (prev <= 1) {
                clearInterval(timer);
                setIsRecording(false);
                setRecordingTimerId(null);
                return 0;
              }
              return prev - 1;
            });
          }, 1000);
          
          setRecordingTimerId(timer);
        }
      } else {
        throw new Error('Failed to start transcription');
      }
    } catch (error) {
      addLog(`Failed to start transcription: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const stopTranscription = async () => {
    if (!currentSessionId) return;

    // Clear timer if running
    if (recordingTimerId) {
      clearInterval(recordingTimerId);
      setRecordingTimerId(null);
    }
    
    setIsLoading(true);
    setIsRecording(false);
    setRecordingTimeLeft(0);
    
    try {
      const adminKey = localStorage.getItem('adminKey') || '';
      const response = await fetch(`${SERVER_URL}/admin/transcription/stop/${currentSessionId}`, {
        method: 'POST',
        headers: {
          'x-admin-key': adminKey,
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        addLog('Transcription stopped');
        setCurrentSessionId(null);
        loadHistory();
      } else {
        throw new Error('Failed to stop transcription');
      }
    } catch (error) {
      addLog(`Failed to stop transcription: ${error}`);
    } finally {
      setIsLoading(false);
    }
  };

  const viewTranscript = async (sessionId: string) => {
    try {
      const response = await fetch(`${SERVER_URL}/api/transcription/${sessionId}`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setSelectedTranscript(data);
        setShowTranscriptModal(true);
      }
    } catch (error) {
      addLog(`Failed to load transcript: ${error}`);
    }
  };

  const exportLiveTranscription = () => {
    const text = liveTranscription.join('\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcription_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    addLog('Live transcription exported');
  };

  const copyLiveTranscription = () => {
    const text = liveTranscription.join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      addLog('Transcription copied to clipboard');
    });
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (recordingTimerId) {
        clearInterval(recordingTimerId);
      }
    };
  }, [recordingTimerId]);

  const formatDuration = (seconds?: number) => {
    if (!seconds) return 'N/A';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="transcription-management">
      <div className="transcription-header">
        <h3>🎙️ Transcription Management</h3>
        <div className="transcription-stats">
          <span className="stat">
            <strong>Active:</strong> {stats.activeCount}
          </span>
          <span className="stat">
            <strong>Total Words:</strong> {stats.totalWords}
          </span>
          <span className="stat">
            <strong>Model:</strong> base
          </span>
          <span className="stat">
            <strong>Buffer:</strong> 
            <span className={`buffer-indicator ${stats.bufferHealth}`}>
              {stats.bufferHealth === 'good' ? '✓' : stats.bufferHealth === 'warning' ? '⚠' : stats.bufferHealth === 'error' ? '✗' : '?'}
            </span>
          </span>
        </div>
      </div>

      <div className="transcription-grid">
        {/* Control Panel */}
        <div className="transcription-control">
          <h4>Control Panel</h4>
          
          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={config.enableTranscription}
                onChange={(e) => setConfig({...config, enableTranscription: e.target.checked})}
              />
              Enable Transcription System
            </label>
          </div>

          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={config.autoStart}
                onChange={(e) => setConfig({...config, autoStart: e.target.checked})}
                disabled={!config.enableTranscription}
              />
              Auto-Start on Stream
            </label>
            <span className="help-text">Automatically start transcription when a stream begins</span>
          </div>

          <div className="control-group">
            <label>Whisper Model</label>
            <div className="model-display">
              <strong>Base Model (142 MB)</strong>
              <span className="model-description">Balanced speed and accuracy</span>
            </div>
          </div>

          <div className="control-group">
            <label>Language</label>
            <select 
              value={config.language} 
              onChange={(e) => setConfig({...config, language: e.target.value})}
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ru">Russian</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
          </div>

          <div className="control-group">
            <label>Advanced Settings</label>
            <div className="advanced-settings">
              <div className="setting-item">
                <label>Processing Interval</label>
                <select 
                  value={config.chunkDuration} 
                  onChange={(e) => setConfig({...config, chunkDuration: parseInt(e.target.value)})}
                  disabled={!config.enableTranscription}
                >
                  <option value="3000">3 seconds</option>
                  <option value="5000">5 seconds (recommended)</option>
                  <option value="10000">10 seconds</option>
                </select>
              </div>
              <div className="setting-item">
                <label>Buffer Duration</label>
                <select 
                  value={config.bufferDuration} 
                  onChange={(e) => setConfig({...config, bufferDuration: parseInt(e.target.value)})}
                  disabled={!config.enableTranscription}
                >
                  <option value="30">30 seconds</option>
                  <option value="60">60 seconds (recommended)</option>
                  <option value="120">120 seconds</option>
                </select>
              </div>
            </div>
          </div>

          <div className="control-group">
            <label>System Status</label>
            <div className="stream-status">
              {hasActiveStream ? (
                <span className="status-indicator active">● Stream Active</span>
              ) : (
                <span className="status-indicator inactive">● No Active Stream</span>
              )}
              {config.enableTranscription ? (
                <span className="status-indicator active">● System Enabled</span>
              ) : (
                <span className="status-indicator inactive">● System Disabled</span>
              )}
            </div>
          </div>

          <div className="button-group">
            <button 
              className="btn btn-primary"
              onClick={applySettings}
              disabled={isLoading || isRecording}
            >
              Apply Settings
            </button>
          </div>

          <div className="transcription-action-section">
            <div className="section-divider"></div>
            <h5>Transcription Control</h5>
            {isRecording ? (
              <div className="recording-status">
                <div className="recording-indicator">
                  <span className="recording-dot"></span>
                  Recording... {recordingTimeLeft}s remaining
                </div>
                <div className="recording-progress">
                  <div 
                    className="recording-progress-bar" 
                    style={{ width: `${((config.bufferDuration - recordingTimeLeft) / config.bufferDuration) * 100}%` }}
                  ></div>
                </div>
                <button 
                  className="btn btn-danger"
                  onClick={stopTranscription}
                  disabled={isLoading}
                >
                  Stop Early
                </button>
              </div>
            ) : (
              <>
                <p className="help-text">
                  Record and transcribe the next {config.bufferDuration} seconds of audio
                </p>
                <button 
                  className="btn btn-transcribe"
                  onClick={startTranscription}
                  disabled={isLoading || !hasActiveStream || !!currentSessionId}
                >
                  {isLoading ? 'Starting...' : `Record & Transcribe Next ${config.bufferDuration}s`}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Live Transcription */}
        <div className="live-transcription">
          <h4>
            Live Transcription 
            {isRecording && <span className="live-indicator">● Recording ({recordingTimeLeft}s)</span>}
          </h4>
          <div className="transcription-display" ref={liveTranscriptionRef}>
            {liveTranscription.length > 0 ? (
              liveTranscription.map((chunk, index) => (
                <div key={index} className="transcription-chunk">
                  {chunk}
                </div>
              ))
            ) : (
              <div className="empty-state">
                No active transcription. Start a transcription to see live text here.
              </div>
            )}
          </div>
          <div className="transcription-actions">
            <button 
              className="btn btn-secondary"
              onClick={() => setLiveTranscription([])}
              disabled={liveTranscription.length === 0}
            >
              Clear
            </button>
            <button 
              className="btn btn-secondary"
              onClick={exportLiveTranscription}
              disabled={liveTranscription.length === 0}
            >
              Export
            </button>
            <button 
              className="btn btn-secondary"
              onClick={copyLiveTranscription}
              disabled={liveTranscription.length === 0}
            >
              Copy
            </button>
          </div>
        </div>
      </div>

      {/* History Table */}
      <div className="transcription-history">
        <h4>Transcription History</h4>
        <div className="history-table-container">
          <table className="history-table">
            <thead>
              <tr>
                <th>Session ID</th>
                <th>Streamer</th>
                <th>Start Time</th>
                <th>Duration</th>
                <th>Words</th>
                <th>Language</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {history.length > 0 ? (
                history.map(session => (
                  <tr key={session.id}>
                    <td>{session.id.substring(0, 8)}...</td>
                    <td>{session.streamer_id || 'Unknown'}</td>
                    <td>{new Date(session.start_time).toLocaleString()}</td>
                    <td>{formatDuration(session.duration)}</td>
                    <td>{session.word_count || 0}</td>
                    <td>{session.language || 'auto'}</td>
                    <td>
                      <span className={`status-badge status-${session.status}`}>
                        {session.status}
                      </span>
                    </td>
                    <td>
                      <button 
                        className="btn btn-small"
                        onClick={() => viewTranscript(session.id)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="empty-row">No transcriptions found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Transcript Modal */}
      {showTranscriptModal && selectedTranscript && (
        <div className="modal-overlay" onClick={() => setShowTranscriptModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>View Transcript</h3>
              <button className="close-button" onClick={() => setShowTranscriptModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <pre className="transcript-text">
                {selectedTranscript.full_text || 'No transcript available'}
              </pre>
            </div>
            <div className="modal-footer">
              <button 
                className="btn btn-secondary"
                onClick={() => {
                  navigator.clipboard.writeText(selectedTranscript.full_text || '');
                  addLog('Transcript copied to clipboard');
                }}
              >
                Copy
              </button>
              <button 
                className="btn btn-primary"
                onClick={() => {
                  const blob = new Blob([selectedTranscript.full_text || ''], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `transcript_${selectedTranscript.id}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                  addLog('Transcript downloaded');
                }}
              >
                Download
              </button>
              <button 
                className="btn btn-secondary"
                onClick={() => setShowTranscriptModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TranscriptionManagement;