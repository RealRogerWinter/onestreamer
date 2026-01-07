import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import authService from '../services/AuthService';
import './UserInfoPopup.css';

interface UserInfoPopupProps {
  username: string;
  position: { x: number; y: number };
  onClose: () => void;
}

interface UserProfileData {
  username: string;
  avatar_url?: string;
  description?: string;
  is_admin?: boolean;
  is_moderator?: boolean;
  created_at?: string;
  is_anonymous?: boolean;
  is_chatbot?: boolean;
  bot_type?: string;
  duration_minutes?: number;
  expires_at?: string;
  is_active?: boolean;
  points_balance?: number;
  total_stream_time?: number;
  total_view_time?: number;
  stream_count?: number;
}

const UserInfoPopup: React.FC<UserInfoPopupProps> = ({ username, position, onClose }) => {
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moderating, setModerating] = useState(false);
  const [isCurrentUserAdmin, setIsCurrentUserAdmin] = useState(false);
  const [isCurrentUserModerator, setIsCurrentUserModerator] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  // Keep onClose ref updated
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Get current user's admin/moderator status
  const currentUser = authService.getUser();

  useEffect(() => {
    // Reset states when username changes
    setAvatarError(false);
    setUserProfile(null);
    setError(null);

    loadUserProfile();

    // Check admin/moderator status using sync methods
    setIsCurrentUserAdmin(authService.isAdminSync());
    setIsCurrentUserModerator(authService.isModeratorSync());

    // Close popup when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        onCloseRef.current();
      }
    };

    // Close popup on escape key
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [username]); // Removed onClose from dependencies

  const loadUserProfile = async () => {
    try {
      setLoading(true);
      setError(null);
      const profile = await authService.getUserProfile(username);
      setUserProfile(profile);
    } catch (err: any) {
      setError(err.message || 'Failed to load user profile');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatTimeCompact = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainingHours = hours % 24;
      if (remainingHours > 0) {
        return `${days}d ${remainingHours}h`;
      }
      return `${days}d`;
    }

    if (hours > 0) {
      if (minutes > 0) {
        return `${hours}h ${minutes}m`;
      }
      return `${hours}h`;
    }

    return `${minutes}m`;
  };

  // Moderation functions
  const handleBanFromChat = async () => {
    if (!window.confirm(`Are you sure you want to ban ${username} from chat?`)) return;
    setModerating(true);
    try {
      const token = localStorage.getItem('token') || authService.getToken();
      if (!token) {
        alert('Authentication required. Please log in again.');
        return;
      }
      
      const response = await fetch('/api/moderation/ban-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      });
      if (response.ok) {
        alert(`${username} has been banned from chat`);
        onClose();
      } else {
        const data = await response.json();
        alert(`Failed to ban user: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Ban error:', err);
      alert('Failed to ban user');
    } finally {
      setModerating(false);
    }
  };

  const handleTimeout = async (duration: string) => {
    if (!window.confirm(`Are you sure you want to timeout ${username} for ${duration}?`)) return;
    setModerating(true);
    try {
      const token = localStorage.getItem('token') || authService.getToken();
      if (!token) {
        alert('Authentication required. Please log in again.');
        return;
      }
      
      const response = await fetch('/api/moderation/timeout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username, duration })
      });
      if (response.ok) {
        alert(`${username} has been timed out for ${duration}`);
        onClose();
      } else {
        const data = await response.json();
        alert(`Failed to timeout user: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Timeout error:', err);
      alert('Failed to timeout user');
    } finally {
      setModerating(false);
    }
  };

  const handleStreamerBan = async () => {
    if (!window.confirm(`Are you sure you want to ban ${username} from streaming? This is a serious action.`)) return;
    setModerating(true);
    try {
      const token = localStorage.getItem('token') || authService.getToken();
      if (!token) {
        alert('Authentication required. Please log in again.');
        return;
      }
      
      const response = await fetch('/api/moderation/ban-streamer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      });
      if (response.ok) {
        alert(`${username} has been banned from streaming`);
        onClose();
      } else {
        const data = await response.json();
        alert(`Failed to ban streamer: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      console.error('Streamer ban error:', err);
      alert('Failed to ban streamer');
    } finally {
      setModerating(false);
    }
  };

  // Calculate popup position to avoid going off-screen
  const popupStyle = useMemo(() => {
    // Always center on mobile or small screens for better UX
    const isMobile = window.innerWidth <= 768;
    const isSmallScreen = window.innerWidth <= 600 || window.innerHeight <= 600;
    
    if (isMobile || isSmallScreen) {
      return {
        position: 'fixed' as const,
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(90vw, 400px)',
        maxWidth: 'calc(100vw - 20px)',
        maxHeight: '85vh',
        zIndex: 999999,
        isolation: 'isolate' as const
      };
    }

    // Desktop positioning with better boundary detection
    const popupWidth = 320;
    const popupHeight = 500; // Estimate max height
    const padding = 10;
    
    // Get click position relative to viewport
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let left = position.x;
    let top = position.y;
    
    // If click is in right half of screen, show popup to the left of cursor
    if (position.x > viewportWidth / 2) {
      left = Math.max(padding, position.x - popupWidth - 10);
    } else {
      // Otherwise show to the right
      left = Math.min(position.x + 10, viewportWidth - popupWidth - padding);
    }
    
    // If click is in bottom half of screen, show popup above cursor
    if (position.y > viewportHeight / 2) {
      top = Math.max(padding, position.y - popupHeight + 100);
    } else {
      // Otherwise show below
      top = Math.min(position.y, viewportHeight - popupHeight - padding);
    }
    
    // Final boundary checks
    left = Math.max(padding, Math.min(left, viewportWidth - popupWidth - padding));
    top = Math.max(padding, Math.min(top, viewportHeight - popupHeight - padding));
    
    return {
      position: 'fixed' as const,
      left: `${left}px`,
      top: `${top}px`,
      zIndex: 999999,
      isolation: 'isolate' as const
    };
  }, [position.x, position.y]);

  const isMobileView = useMemo(() => {
    return window.innerWidth <= 768 || window.innerHeight <= 600;
  }, []);

  return (
    <>
      {isMobileView && (
        <div className="user-info-backdrop" onClick={onClose} />
      )}
      <div className="user-info-popup" ref={popupRef} style={popupStyle}>
        <div className="user-info-header">
          <button className="close-button" onClick={onClose}>×</button>
        </div>

      {loading ? (
        <div className="user-info-loading">
          <div className="loading-spinner"></div>
          <p>Loading profile...</p>
        </div>
      ) : error ? (
        <div className="user-info-error">
          <p>{error}</p>
        </div>
      ) : userProfile ? (
        <div className="user-info-content">
          <div className="user-info-avatar-section">
            {userProfile.is_anonymous ? (
              <div className="user-info-avatar-placeholder anonymous">
                <span className="anonymous-icon">👤</span>
              </div>
            ) : userProfile.is_chatbot ? (
              <div className="user-info-avatar-placeholder chatbot">
                <span className="chatbot-icon">🤖</span>
              </div>
            ) : userProfile.avatar_url && !avatarError ? (
              <img
                src={userProfile.avatar_url}
                alt={`${userProfile.username}'s avatar`}
                className="user-info-avatar"
                onError={() => setAvatarError(true)}
              />
            ) : (
              <div className="user-info-avatar-placeholder">
                {userProfile.username.substring(0, 2).toUpperCase()}
              </div>
            )}
          </div>

          <div className="user-info-details">
            <h3 className="user-info-username">
              {userProfile.is_chatbot && <span className="badge chatbot-badge" title="AI Chatbot">🤖</span>}
              {!userProfile.is_anonymous && !userProfile.is_chatbot && userProfile.is_admin && <span className="badge admin-badge" title="Admin">👑</span>}
              {!userProfile.is_anonymous && !userProfile.is_chatbot && !userProfile.is_admin && userProfile.is_moderator && <span className="badge moderator-badge" title="Moderator">🛡️</span>}
              {userProfile.username}
            </h3>

            {/* Special description for Admin */}
            {userProfile.username.toLowerCase() === 'admin' && !userProfile.description && (
              <div className="user-info-description">
                <p>System Administrator - Manages the OneStreamer platform, handles technical operations, and ensures the streaming service runs smoothly.</p>
              </div>
            )}
            
            {/* Regular description */}
            {userProfile.description && (
              <div className="user-info-description">
                <p>{userProfile.description}</p>
              </div>
            )}

            {userProfile.is_chatbot && (
              <>
                {userProfile.duration_minutes && (
                  <div className="user-info-bot-duration">
                    <span className="bot-info-label">Session:</span>
                    <span className="bot-info-value">{userProfile.duration_minutes} minutes</span>
                  </div>
                )}
                {userProfile.expires_at && (
                  <div className="user-info-bot-expires">
                    <span className="bot-info-label">Expires:</span>
                    <span className="bot-info-value">{new Date(userProfile.expires_at).toLocaleTimeString()}</span>
                  </div>
                )}
              </>
            )}

            {!userProfile.is_anonymous && !userProfile.is_chatbot && (
              <>
                {userProfile.created_at && (
                  <div className="user-info-joined">
                    <span className="joined-label">Member since:</span>
                    <span className="joined-date">{formatDate(userProfile.created_at)}</span>
                  </div>
                )}
                
                {/* User Stats */}
                {currentUser && currentUser.username && (
                  <div className="user-info-stats">
                    {userProfile.points_balance !== undefined && (
                      <div className="stat-item">
                        <span className="stat-icon">💰</span>
                        <span className="stat-label">Points:</span>
                        <span className="stat-value">{userProfile.points_balance.toLocaleString()}</span>
                      </div>
                    )}
                    {userProfile.total_stream_time !== undefined && userProfile.total_stream_time > 0 && (
                      <div className="stat-item">
                        <span className="stat-icon">📹</span>
                        <span className="stat-label">Stream Time:</span>
                        <span className="stat-value">{formatTimeCompact(userProfile.total_stream_time)}</span>
                      </div>
                    )}
                    {userProfile.total_view_time !== undefined && userProfile.total_view_time > 0 && (
                      <div className="stat-item">
                        <span className="stat-icon">👀</span>
                        <span className="stat-label">Watch Time:</span>
                        <span className="stat-value">{formatTimeCompact(userProfile.total_view_time)}</span>
                      </div>
                    )}
                    {userProfile.stream_count !== undefined && userProfile.stream_count > 0 && (
                      <div className="stat-item">
                        <span className="stat-icon">🎬</span>
                        <span className="stat-label">Streams:</span>
                        <span className="stat-value">{userProfile.stream_count}</span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="user-info-roles">
              {userProfile.is_anonymous ? (
                <span className="role-tag anonymous-tag">Anonymous User</span>
              ) : userProfile.is_chatbot ? (
                <>
                  <span className="role-tag chatbot-tag">AI Chatbot</span>
                  {userProfile.is_active === false && (
                    <span className="role-tag inactive-tag">Inactive</span>
                  )}
                </>
              ) : (
                <>
                  {userProfile.is_admin && (
                    <span className="role-tag admin-tag">Admin</span>
                  )}
                  {userProfile.is_moderator && !userProfile.is_admin && (
                    <span className="role-tag moderator-tag">Moderator</span>
                  )}
                  {!userProfile.is_admin && !userProfile.is_moderator && (
                    <span className="role-tag member-tag">Member</span>
                  )}
                </>
              )}
            </div>

            {/* Moderation Actions - Compact Display */}
            {(isCurrentUserAdmin || isCurrentUserModerator) && 
             !userProfile.is_chatbot && 
             currentUser?.username !== userProfile.username && (
              <div className="user-info-moderation compact">
                <h4 className="moderation-title">Moderation Tools</h4>
                
                <div className="moderation-actions">
                  <button 
                    className="mod-icon-btn ban"
                    onClick={handleBanFromChat}
                    disabled={moderating}
                  >
                    <span className="icon">🚫</span>
                    <span className="label">Ban Chat</span>
                  </button>
                  
                  <button 
                    className="mod-icon-btn timeout"
                    onClick={() => handleTimeout('1 hour')}
                    disabled={moderating}
                  >
                    <span className="icon">⏱️</span>
                    <span className="label">1 Hour</span>
                  </button>
                  
                  <button 
                    className="mod-icon-btn timeout"
                    onClick={() => handleTimeout('1 day')}
                    disabled={moderating}
                  >
                    <span className="icon">📅</span>
                    <span className="label">1 Day</span>
                  </button>
                  
                  <button 
                    className="mod-icon-btn timeout"
                    onClick={() => handleTimeout('1 week')}
                    disabled={moderating}
                  >
                    <span className="icon">📆</span>
                    <span className="label">1 Week</span>
                  </button>
                  
                  <button 
                    className="mod-icon-btn timeout"
                    onClick={() => handleTimeout('1 month')}
                    disabled={moderating}
                  >
                    <span className="icon">🗓️</span>
                    <span className="label">1 Month</span>
                  </button>
                  
                  {/* Streamer ban - Only for admins */}
                  {isCurrentUserAdmin && (
                    <button 
                      className="mod-icon-btn streamer-ban"
                      onClick={handleStreamerBan}
                      disabled={moderating}
                    >
                      <span className="icon">⛔</span>
                      <span className="label">Ban Stream</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
};

export default UserInfoPopup;