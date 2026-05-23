import React, { useState, useEffect } from 'react';
import { useMainSocket } from '../../contexts/SocketContext';
import authService from '../../services/AuthService';
import './ModerationPanel.css';

interface StreamDetails {
  streamerId: string;
  ipAddress: string;
  startTime: string;
  connectionTime: string;
  streamerName?: string;
}

interface ModerationPanelProps {
  streamStatus: {
    hasActiveStream: boolean;
    streamerId: string | null;
    streamType: string | null;
    streamerDisplayName?: string | null;
  };
}

const ModerationPanel: React.FC<ModerationPanelProps> = ({ streamStatus }) => {
  const { socket } = useMainSocket();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isModerator, setIsModerator] = useState(false);
  const [isPanelVisible, setIsPanelVisible] = useState(() => {
    // Load panel visibility preference from localStorage
    const saved = localStorage.getItem('moderationPanelVisible');
    return saved !== null ? saved === 'true' : true;
  });
  const [streamDetails, setStreamDetails] = useState<StreamDetails | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'disconnect' | 'ban' | null>(null);
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  
  const openIPBanManagement = () => {
    // Dispatch custom event to open admin panel with IP bans tab
    window.dispatchEvent(new CustomEvent('openAdminPanel', { detail: { tab: 'ipbans' } }));
  };

  useEffect(() => {
    checkAdminStatus();
  }, []);

  // Save panel visibility preference
  useEffect(() => {
    localStorage.setItem('moderationPanelVisible', isPanelVisible.toString());
  }, [isPanelVisible]);

  useEffect(() => {
    if (streamStatus.hasActiveStream && streamStatus.streamerId && (isAdmin || isModerator)) {
      fetchStreamDetails(streamStatus.streamerId);
    } else {
      setStreamDetails(null);
    }
  }, [streamStatus.hasActiveStream, streamStatus.streamerId, isAdmin, isModerator]);

  const checkAdminStatus = async () => {
    const token = authService.getToken();
    if (!token) {
      setIsAdmin(false);
      setIsModerator(false);
      return;
    }

    try {
      const response = await fetch('/api/admin/verify', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setIsAdmin(data.isAdmin || false);
        setIsModerator(data.isModerator || false);
      } else {
        setIsAdmin(false);
        setIsModerator(false);
      }
    } catch (error) {
      console.error('Failed to verify admin status:', error);
      setIsAdmin(false);
      setIsModerator(false);
    }
  };

  const fetchStreamDetails = async (streamerId: string) => {
    const token = authService.getToken();
    if (!token) return;

    try {
      const response = await fetch(`/api/admin/stream-details/${streamerId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setStreamDetails({
          ...data,
          streamerName: streamStatus.streamerDisplayName || streamerId
        });
      }
    } catch (error) {
      console.error('Failed to fetch stream details:', error);
    }
  };

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 3000);
  };

  const handleDisconnect = async () => {
    if (!streamDetails) return;
    
    setLoading(true);
    const token = authService.getToken();

    try {
      const response = await fetch('/api/admin/stream/disconnect', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          streamerId: streamDetails.streamerId
        })
      });

      if (response.ok) {
        const result = await response.json();
        // Show appropriate message based on whether it was a rotation or disconnect
        const message = result.message === 'Viewbot rotation triggered' 
          ? 'Viewbot rotation triggered successfully'
          : 'Stream disconnected successfully';
        showNotification('success', message);
        setStreamDetails(null);
      } else {
        const error = await response.json();
        showNotification('error', error.message || 'Failed to disconnect stream');
      }
    } catch (error) {
      showNotification('error', 'Failed to disconnect stream');
    } finally {
      setLoading(false);
      setShowConfirmDialog(false);
      setConfirmAction(null);
    }
  };

  const handleBanIP = async () => {
    if (!streamDetails) return;
    
    setLoading(true);
    const token = authService.getToken();

    try {
      const response = await fetch('/api/admin/stream/ban-ip', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          streamerId: streamDetails.streamerId,
          ip: streamDetails.ipAddress,
          reason: 'Banned by admin moderation'
        })
      });

      if (response.ok) {
        showNotification('success', 'IP banned and stream terminated');
        setStreamDetails(null);
      } else {
        const error = await response.json();
        showNotification('error', error.message || 'Failed to ban IP');
      }
    } catch (error) {
      showNotification('error', 'Failed to ban IP');
    } finally {
      setLoading(false);
      setShowConfirmDialog(false);
      setConfirmAction(null);
    }
  };

  const formatDuration = (startTime: string) => {
    const start = new Date(startTime);
    const now = new Date();
    const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
    
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  };

  // Don't render if not admin
  if (!isAdmin && !isModerator) {
    return null;
  }

  return (
    <>
      {/* Toggle Button - Always visible */}
      <button 
        className={`moderation-toggle-btn ${isPanelVisible ? 'panel-open' : 'panel-closed'}`}
        onClick={() => setIsPanelVisible(!isPanelVisible)}
        title={isPanelVisible ? 'Hide Moderation Panel' : 'Show Moderation Panel'}
      >
        <svg className="toggle-icon" viewBox="0 0 24 24">
          {isPanelVisible ? (
            // Chevron left icon (hide)
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" fill="currentColor"/>
          ) : (
            // Shield with chevron right icon (show)
            <>
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" fill="currentColor"/>
              <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z" fill="white" transform="translate(0, 0) scale(0.7)"/>
            </>
          )}
        </svg>
      </button>

      {/* Main Panel - Conditionally visible */}
      <div className={`moderation-panel ${isPanelVisible ? 'visible' : 'hidden'}`}>
        <div className="moderation-header">
          <svg className="shield-icon" viewBox="0 0 24 24">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" fill="currentColor"/>
          </svg>
          <h3>Stream Moderation</h3>
          <button 
            className="manage-bans-btn"
            onClick={openIPBanManagement}
            title="Manage IP Bans"
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor"/>
            </svg>
          </button>
        </div>

        <div className="moderation-content">
          {streamStatus.hasActiveStream && streamDetails ? (
            <>
              <div className="stream-info-box">
                <div className="info-row">
                  <span className="info-label">Streamer:</span>
                  <span className="info-value">
                    {streamDetails.streamerName}
                    <span className="status-indicator active"></span>
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">IP Address:</span>
                  <span className="info-value ip-address">{streamDetails.ipAddress}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Duration:</span>
                  <span className="info-value">
                    {streamDetails.startTime ? formatDuration(streamDetails.startTime) : 'N/A'}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Type:</span>
                  <span className="info-value">{streamStatus.streamType || 'Standard'}</span>
                </div>
              </div>

              <div className="moderation-actions">
                <button 
                  className="mod-btn disconnect-btn"
                  onClick={() => {
                    setConfirmAction('disconnect');
                    setShowConfirmDialog(true);
                  }}
                  disabled={loading}
                >
                  <svg className="btn-icon" viewBox="0 0 24 24">
                    <path d="M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z" fill="currentColor"/>
                  </svg>
                  Disconnect Stream
                </button>
                <button 
                  className="mod-btn ban-btn"
                  onClick={() => {
                    setConfirmAction('ban');
                    setShowConfirmDialog(true);
                  }}
                  disabled={loading}
                >
                  <svg className="btn-icon" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z" fill="currentColor"/>
                  </svg>
                  Ban Streamer IP
                </button>
              </div>
            </>
          ) : (
            <div className="no-stream">
              <svg className="no-stream-icon" viewBox="0 0 24 24">
                <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" fill="currentColor"/>
              </svg>
              <p>No active stream</p>
              <span className="waiting-text">Waiting for stream to moderate...</span>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation Dialog */}
      {showConfirmDialog && (
        <div className="moderation-overlay">
          <div className="moderation-dialog">
            <h3 className="dialog-title">
              {confirmAction === 'disconnect' ? 'Disconnect Stream' : 'Ban Streamer IP'}
            </h3>
            <p className="dialog-message">
              {confirmAction === 'disconnect' 
                ? `Are you sure you want to disconnect ${streamDetails?.streamerName}? The stream will be immediately terminated.`
                : `Are you sure you want to ban IP ${streamDetails?.ipAddress}? This will disconnect the stream and prevent future connections from this IP.`
              }
            </p>
            <div className="dialog-actions">
              <button 
                className="dialog-btn cancel-btn"
                onClick={() => {
                  setShowConfirmDialog(false);
                  setConfirmAction(null);
                }}
                disabled={loading}
              >
                Cancel
              </button>
              <button 
                className="dialog-btn confirm-btn"
                onClick={confirmAction === 'disconnect' ? handleDisconnect : handleBanIP}
                disabled={loading}
              >
                {loading ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification Toast */}
      {notification && (
        <div className={`moderation-toast ${notification.type}`}>
          {notification.message}
        </div>
      )}
    </>
  );
};

export default ModerationPanel;