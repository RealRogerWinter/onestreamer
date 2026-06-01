import React, { useState, useEffect } from 'react';
import authService from '../../services/AuthService';
import './RecordingManagement.css';

// Live continuous-recording status, as returned by
// GET /admin/recordings/continuous/status (LiveKit egress). The MediaSoup-era
// manual-recording surface (list/active/system-status/start/stop/download/
// delete/cleanup + the file-based RecordingsPlayback) was retired with
// ADR-0024 — recording is now automatic via LiveKit egress, and per-session
// review/playback lives in the separate "Recording Review" tab
// (AdminRecordingReview, /admin/review/*).
interface ContinuousRecordingStatus {
  enabled: boolean;
  isRecording: boolean;
  sessionId: string | null;
  startTime: number | null;
  duration: number;
  recordingTarget: string | null;
  isParticipantEgress: boolean;
}

interface RecordingManagementProps {
  addLog: (message: string) => void;
}

const RecordingManagement: React.FC<RecordingManagementProps> = ({ addLog }) => {
  const [continuousRecordingStatus, setContinuousRecordingStatus] = useState<ContinuousRecordingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const serverUrl = process.env.REACT_APP_SERVER_URL || 'http://localhost:8080';

  useEffect(() => {
    loadContinuousRecordingStatus();

    // Refresh status every 30 seconds
    const interval = setInterval(loadContinuousRecordingStatus, 30000);
    return () => clearInterval(interval);
  }, []);

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

  const enableContinuousRecording = async () => {
    try {
      setBusy(true);
      const data = await makeApiCall('/admin/recordings/continuous/enable', {
        method: 'POST'
      });

      if (data.success) {
        addLog('Continuous recording enabled');
        loadContinuousRecordingStatus();
      } else {
        addLog(`Failed to enable continuous recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to enable continuous recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const disableContinuousRecording = async () => {
    try {
      setBusy(true);
      const data = await makeApiCall('/admin/recordings/continuous/disable', {
        method: 'POST'
      });

      if (data.success) {
        addLog('Continuous recording disabled');
        loadContinuousRecordingStatus();
      } else {
        addLog(`Failed to disable continuous recording: ${data.error}`);
      }
    } catch (error) {
      addLog(`Failed to disable continuous recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const formatDuration = (ms?: number | null) => {
    if (!ms) return '0:00:00';
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="recording-management">
      <h3>📹 Recording Management</h3>

      <p className="recording-info-note">
        Recording runs automatically over LiveKit egress whenever a stream is
        live. Use the <strong>Recording Review</strong> tab to browse, play back,
        and manage recorded sessions.
      </p>

      {/* Continuous Recording Controls */}
      <div className="continuous-recording-section">
        <h4>🔄 Continuous Recording (LiveKit Egress)</h4>
        <div className="continuous-status">
          {continuousRecordingStatus && (
            <div className="status-info">
              <div className="status-indicator">
                <span className={`status-dot ${continuousRecordingStatus.enabled ? 'active' : 'inactive'}`}></span>
                Status: {continuousRecordingStatus.enabled ? 'Enabled (automatic)' : 'Disabled'}
              </div>
              <div className="status-detail">
                Recording: {continuousRecordingStatus.isRecording ? '🔴 Active' : '⏸️ Waiting for stream'}
              </div>
              {continuousRecordingStatus.sessionId && (
                <div className="status-detail">
                  Session ID: {continuousRecordingStatus.sessionId.substring(0, 8)}...
                </div>
              )}
              {continuousRecordingStatus.isRecording && (
                <>
                  <div className="status-detail">Duration: {formatDuration(continuousRecordingStatus.duration)}</div>
                  <div className="status-detail">
                    Target: {continuousRecordingStatus.isParticipantEgress
                      ? `Participant (${continuousRecordingStatus.recordingTarget})`
                      : 'Room composite'}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="continuous-controls">
          <button
            onClick={enableContinuousRecording}
            className="btn btn-success"
            disabled={busy}
          >
            🔄 Start Recording Now
          </button>
          <button
            onClick={disableContinuousRecording}
            className="btn btn-warning"
            disabled={busy}
          >
            🛑 Stop Recording
          </button>
          <button
            onClick={loadContinuousRecordingStatus}
            className="btn btn-secondary btn-sm"
            disabled={busy}
          >
            🔄 Refresh
          </button>
        </div>
        <div className="continuous-help">
          <small>📋 Recording starts/stops automatically as streams come and go. These controls force an immediate start or stop of the current egress.</small>
        </div>
      </div>
    </div>
  );
};

export default RecordingManagement;
