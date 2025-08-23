import React, { useState, useRef, useEffect } from 'react';
import './MobileHeader.css';
import AnimatedNumber from './AnimatedNumber';

interface MobileHeaderProps {
  // Stream Status
  viewerCount: number;
  hasActiveStream: boolean;
  streamDuration: number;
  streamStartTime?: number | null;
  streamerDisplayName?: string | null;
  
  // Auth & User
  isAuthenticated: boolean;
  currentUser?: any;
  userPoints?: number;
  
  // Callbacks
  onLogin?: () => void;
  onLogout?: () => void;
  onProfileSettings?: () => void;
}

const MobileHeader: React.FC<MobileHeaderProps> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName,
  isAuthenticated,
  currentUser,
  userPoints = 0,
  onLogin,
  onLogout,
  onProfileSettings
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Update duration every second if stream is active
  useEffect(() => {
    if (hasActiveStream && streamStartTime) {
      const interval = setInterval(() => {
        const duration = Date.now() - streamStartTime;
        setStreamDuration(duration);
      }, 1000);

      return () => clearInterval(interval);
    } else {
      setStreamDuration(0);
    }
  }, [hasActiveStream, streamStartTime]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const formatDuration = (milliseconds: number): string => {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  };

  const getUserInitial = () => {
    if (currentUser?.username) {
      return currentUser.username.charAt(0).toUpperCase();
    }
    return 'U';
  };

  const getDisplayName = () => {
    if (!streamerDisplayName) return 'No Stream';
    if (streamerDisplayName.length > 12) {
      return streamerDisplayName.substring(0, 10) + '...';
    }
    return streamerDisplayName;
  };

  return (
    <header className="mobile-header-v2">
      <div className="mobile-header-content">
        {/* Viewers Section */}
        <div className="header-stat viewers-stat">
          <div className="stat-pill">
            <span className="stat-icon">👥</span>
            <span className="stat-value">{viewerCount}</span>
          </div>
        </div>

        {/* Streamer Section - Center */}
        <div className="header-stat streamer-stat">
          {hasActiveStream ? (
            <div className="streamer-info">
              <span className="live-badge">LIVE</span>
              <span className="streamer-name">{getDisplayName()}</span>
            </div>
          ) : (
            <div className="offline-status">
              <span className="offline-badge">OFFLINE</span>
            </div>
          )}
        </div>

        {/* Duration Section */}
        {hasActiveStream && streamStartTime && (
          <div className="header-stat duration-stat">
            <div className="stat-pill">
              <span className="stat-icon">⏱</span>
              <span className="stat-value">{formatDuration(streamDuration)}</span>
            </div>
          </div>
        )}

        {/* User Profile Section */}
        <div className="header-user-section" ref={menuRef}>
          {isAuthenticated ? (
            <>
              <button 
                className="user-profile-button"
                onClick={() => setShowUserMenu(!showUserMenu)}
                aria-label="User menu"
              >
                <div className="user-avatar">
                  {getUserInitial()}
                </div>
              </button>
              
              {/* Dropdown Menu */}
              {showUserMenu && (
                <div className="user-dropdown-menu">
                  <div className="dropdown-header">
                    <div className="dropdown-username">{currentUser?.username || 'User'}</div>
                    <div className="dropdown-points">
                      <span className="points-icon">💎</span>
                      <AnimatedNumber value={userPoints} />
                    </div>
                  </div>
                  <div className="dropdown-divider"></div>
                  <button 
                    className="dropdown-item"
                    onClick={() => {
                      onProfileSettings?.();
                      setShowUserMenu(false);
                    }}
                  >
                    <span className="dropdown-icon">⚙️</span>
                    Profile Settings
                  </button>
                  <button 
                    className="dropdown-item"
                    onClick={() => {
                      onLogout?.();
                      setShowUserMenu(false);
                    }}
                  >
                    <span className="dropdown-icon">🚪</span>
                    Logout
                  </button>
                </div>
              )}
            </>
          ) : (
            <button 
              className="mobile-login-button"
              onClick={onLogin}
            >
              Login
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

export default MobileHeader;