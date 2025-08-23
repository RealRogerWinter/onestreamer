import React, { useState, useEffect } from 'react';
import './DesktopHeaderV2.css';
import AnimatedNumber from './AnimatedNumber';
import UserProfile from './UserProfile';
import { Socket } from 'socket.io-client';

interface DesktopHeaderV2Props {
  // Stream status
  viewerCount: number;
  hasActiveStream: boolean;
  streamDuration: number;
  streamStartTime: number | null;
  streamerDisplayName?: string | null;
  
  // Auth
  isAuthenticated: boolean;
  currentUser: any;
  userPoints: number;
  isAdmin: boolean;
  
  // Actions
  onLogin: () => void;
  onSignup: () => void;
  onLogout: () => void;
  onProfileSettings: () => void;
  onAdminPanel: () => void;
  onUserProfileUpdate: (profile: any) => void;
  
  // Socket
  socket?: Socket | null;
}

const DesktopHeaderV2: React.FC<DesktopHeaderV2Props> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName,
  isAuthenticated,
  currentUser,
  userPoints,
  isAdmin,
  onLogin,
  onSignup,
  onLogout,
  onProfileSettings,
  onAdminPanel,
  onUserProfileUpdate,
  socket
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isScrolled, setIsScrolled] = useState(false);

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

  // Update clock every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Handle scroll effect
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
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

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  };

  return (
    <header className={`desktop-header-v2 ${isScrolled ? 'scrolled' : ''}`}>
      {/* Animated background gradient */}
      <div className="header-background">
        <div className="gradient-mesh"></div>
        <div className="noise-overlay"></div>
      </div>

      <div className="header-v2-container">
        {/* Left Section - Modern Logo */}
        <div className="header-v2-left">
          <div className="brand-logo-modern">
            <div className="logo-wrapper">
              <div className="logo-icon">
                <span className="logo-pulse"></span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                </svg>
              </div>
              <span className="brand-name">OneStreamer</span>
            </div>
          </div>
        </div>

        {/* Center Section - Dynamic Stream Stats */}
        <div className="header-v2-center">
          <div className="stream-stats-container">
            {/* Live Indicator */}
            <div className={`stat-card ${hasActiveStream ? 'live-active' : 'offline'}`}>
              <div className="stat-icon-wrapper">
                {hasActiveStream ? (
                  <div className="live-indicator-modern">
                    <span className="live-dot"></span>
                    <span className="live-ripple"></span>
                    <span className="live-ripple-2"></span>
                  </div>
                ) : (
                  <div className="offline-indicator"></div>
                )}
              </div>
              <div className="stat-info">
                <span className="stat-label">Status</span>
                <span className="stat-value">{hasActiveStream ? 'LIVE' : 'OFFLINE'}</span>
              </div>
            </div>

            {/* Viewers */}
            <div className="stat-card viewers-card">
              <div className="stat-icon-wrapper">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                  <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                </svg>
              </div>
              <div className="stat-info">
                <span className="stat-label">Viewers</span>
                <span className="stat-value viewer-count">{viewerCount.toLocaleString()}</span>
              </div>
            </div>

            {/* Current Streamer */}
            {hasActiveStream && streamerDisplayName && (
              <div className="stat-card streamer-card">
                <div className="stat-icon-wrapper">
                  <div className="streamer-avatar">
                    {streamerDisplayName.charAt(0).toUpperCase()}
                  </div>
                </div>
                <div className="stat-info">
                  <span className="stat-label">Streaming</span>
                  <span className="stat-value streamer-name">{streamerDisplayName}</span>
                </div>
              </div>
            )}

            {/* Duration */}
            {hasActiveStream && streamStartTime && (
              <div className="stat-card duration-card">
                <div className="stat-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                </div>
                <div className="stat-info">
                  <span className="stat-label">Duration</span>
                  <span className="stat-value duration-time">{formatDuration(streamDuration)}</span>
                </div>
              </div>
            )}

            {/* Time */}
            <div className="stat-card time-card">
              <div className="stat-info">
                <span className="stat-value time-display">{formatTime(currentTime)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Section - User Area */}
        <div className="header-v2-right">
          {isAuthenticated ? (
            <div className="user-area-modern">
              {/* Admin Button - Moved to the left */}
              {isAdmin && (
                <button 
                  className="admin-btn-modern"
                  onClick={onAdminPanel}
                  title="Admin Panel (Ctrl+Shift+A)"
                >
                  <div className="admin-btn-bg"></div>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
                  </svg>
                </button>
              )}

              {/* Divider for admins */}
              {isAdmin && <div className="header-divider-vertical"></div>}

              {/* Points Display with Animation Target */}
              <div className="points-display-modern points-counter">
                <div className="points-glow"></div>
                <div className="points-inner">
                  <div className="points-icon-modern">
                    <span className="gem-icon">💎</span>
                    <div className="gem-sparkle sparkle-1"></div>
                    <div className="gem-sparkle sparkle-2"></div>
                    <div className="gem-sparkle sparkle-3"></div>
                  </div>
                  <div className="points-value-wrapper">
                    <AnimatedNumber value={userPoints} />
                    <span className="points-suffix">Points</span>
                  </div>
                </div>
              </div>

              {/* User Profile */}
              <UserProfile
                socket={socket}
                currentUser={currentUser}
                onLogout={onLogout}
                onOpenProfileSettings={onProfileSettings}
                onUserProfileUpdate={onUserProfileUpdate}
              />
            </div>
          ) : (
            <div className="auth-area-modern">
              <button className="auth-btn-modern signin" onClick={onLogin}>
                <span>Sign In</span>
              </button>
              <button className="auth-btn-modern signup" onClick={onSignup}>
                <div className="signup-gradient"></div>
                <span>Get Started</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default DesktopHeaderV2;