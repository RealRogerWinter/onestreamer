import React, { useState, useEffect } from 'react';
import './DesktopHeaderV2.css';
import AnimatedNumber from './AnimatedNumber';
import UserProfile from './UserProfile';
import SoundVolumeControl from './SoundVolumeControl';
import { Socket } from 'socket.io-client';

interface DesktopHeaderV2Props {
  // Stream status
  viewerCount: number;
  hasActiveStream: boolean;
  streamDuration: number;
  streamStartTime: number | null;
  streamerDisplayName?: string | null;

  // Random rotation info
  isRandomRotation?: boolean;
  randomRotationPlatform?: string | null;
  randomRotationStreamerUrl?: string | null;
  randomRotationStreamerUsername?: string | null;
  
  // Auth
  isAuthenticated: boolean;
  currentUser: any;
  userPoints: number;
  isAdmin: boolean;
  isModerator?: boolean;
  
  // Theatre Mode
  isTheatreMode?: boolean;
  showInventory?: boolean;
  theatreDropdownOpen?: boolean;
  
  // Actions
  onLogin: () => void;
  onSignup: () => void;
  onLogout: () => void;
  onProfileSettings: () => void;
  onAdminPanel: () => void;
  onUserProfileUpdate: (profile: any) => void;
  onInventoryToggle?: () => void;
  onTheatreDropdownToggle?: () => void;
  onShowAbout?: () => void;
  onShowTerms?: () => void;
  onShowPrivacy?: () => void;
  onShowTutorial?: () => void;
  onShowBugReport?: () => void;
  
  // Sound volume
  soundVolume?: number;
  onSoundVolumeChange?: (volume: number) => void;
  
  // Socket
  socket?: Socket | null;
}

const DesktopHeaderV2: React.FC<DesktopHeaderV2Props> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName,
  isRandomRotation = false,
  randomRotationPlatform,
  randomRotationStreamerUrl,
  randomRotationStreamerUsername,
  isAuthenticated,
  currentUser,
  userPoints,
  isAdmin,
  isModerator = false,
  isTheatreMode = false,
  showInventory = false,
  theatreDropdownOpen = false,
  onLogin,
  onSignup,
  onLogout,
  onProfileSettings,
  onAdminPanel,
  onUserProfileUpdate,
  onInventoryToggle,
  onTheatreDropdownToggle,
  onShowAbout,
  onShowTerms,
  onShowPrivacy,
  onShowTutorial,
  onShowBugReport,
  soundVolume = 0.8,
  onSoundVolumeChange,
  socket
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isScrolled, setIsScrolled] = useState(false);
  const [showInventoryHint, setShowInventoryHint] = useState(false);

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

  // Periodic inventory hint for non-authenticated users
  useEffect(() => {
    if (isAuthenticated || !isTheatreMode) return;

    // Show hint after initial delay, then periodically
    const initialDelay = setTimeout(() => {
      setShowInventoryHint(true);
      // Hide after 15 seconds
      setTimeout(() => setShowInventoryHint(false), 15000);
    }, 15000); // First appearance after 15 seconds

    const interval = setInterval(() => {
      setShowInventoryHint(true);
      // Hide after 15 seconds
      setTimeout(() => setShowInventoryHint(false), 15000);
    }, 90000); // Show every 90 seconds

    return () => {
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [isAuthenticated, isTheatreMode]);

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
                <div className="logo-glow-ring"></div>
                <div className="logo-sparkles">
                  <span className="sparkle sparkle-1"></span>
                  <span className="sparkle sparkle-2"></span>
                  <span className="sparkle sparkle-3"></span>
                </div>
                <img 
                  src="/logo-header-v2.png" 
                  alt="OneStreamer Logo" 
                  className="header-logo-img"
                />
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
                <span className="stat-value viewer-count">{(viewerCount ?? 0).toLocaleString()}</span>
              </div>
            </div>

            {/* Current Streamer */}
            {hasActiveStream && streamerDisplayName && (
              <div className="stat-card streamer-card">
                <div className="stat-icon-wrapper">
                  {isRandomRotation && randomRotationPlatform ? (
                    <div className="platform-icon">
                      {randomRotationPlatform === 'kick' ? '🟢' : '🟣'}
                    </div>
                  ) : (
                    <div className="streamer-avatar">
                      {streamerDisplayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="stat-info">
                  <span className="stat-label">Streaming</span>
                  {isRandomRotation && randomRotationStreamerUrl && randomRotationStreamerUsername ? (
                    <a
                      href={randomRotationStreamerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="stat-value streamer-name streamer-link"
                      title={`Watch ${randomRotationStreamerUsername} on ${randomRotationPlatform === 'kick' ? 'Kick' : 'Twitch'}`}
                    >
                      {randomRotationStreamerUsername}
                      <svg className="external-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/>
                      </svg>
                    </a>
                  ) : (
                    <span className="stat-value streamer-name">{streamerDisplayName}</span>
                  )}
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
              {/* Admin/Moderator Button - Moved to the left */}
              {(isAdmin || isModerator) && (
                <button 
                  className="admin-btn-modern"
                  onClick={onAdminPanel}
                  title={`${isAdmin ? 'Admin' : 'Moderator'} Panel (Ctrl+Shift+A)`}
                >
                  <div className="admin-btn-bg"></div>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
                  </svg>
                </button>
              )}

              {/* Divider for admins/moderators */}
              {(isAdmin || isModerator) && <div className="header-divider-vertical"></div>}

              {/* Theatre Mode Buttons - Inventory and Dropdown */}
              {isTheatreMode && (
                <>
                  {/* Inventory Button */}
                  <button
                    className="theatre-inventory-btn"
                    onClick={onInventoryToggle}
                    title="Inventory"
                  >
                    🎒
                  </button>

                  {/* Sound Volume Control */}
                  {onSoundVolumeChange && (
                    <SoundVolumeControl
                      volume={soundVolume}
                      onVolumeChange={onSoundVolumeChange}
                    />
                  )}

                  {/* Clips Link */}
                  <a
                    href="https://onestreamer.live/clips/"
                    className="theatre-clips-btn"
                    title="Clips"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                      <path d="M23 7l-7 5 7 5V7z"/>
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                  </a>

                  {/* Blog Link */}
                  <a
                    href="https://onestreamer.live/blog/"
                    className="theatre-blog-btn"
                    title="Blog"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                    </svg>
                  </a>

                  {/* Discord Link */}
                  <a
                    href="https://discord.gg/As5CA3ekYA"
                    className="theatre-discord-btn"
                    title="Discord"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
                    </svg>
                  </a>

                  {/* Theatre Dropdown Menu */}
                  <div className="theatre-dropdown-container">
                    <button
                      className="theatre-dropdown-btn"
                      onClick={onTheatreDropdownToggle}
                      title="More Options"
                    >
                      ⋮
                    </button>
                    {theatreDropdownOpen && (
                      <div className="theatre-dropdown-menu">
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowTutorial?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">📖</span>
                          <span className="dropdown-label">Tutorial</span>
                        </button>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowAbout?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">ℹ️</span>
                          <span className="dropdown-label">About</span>
                        </button>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowBugReport?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <svg className="dropdown-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 8h-1.81c-.45-.78-1.07-1.45-1.82-1.96l.93-.93a.996.996 0 1 0-1.41-1.41l-1.47 1.47C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L9.11 3.7A.996.996 0 1 0 7.7 5.11l.92.93C7.88 6.55 7.26 7.22 6.81 8H5c-.55 0-1 .45-1 1s.45 1 1 1h1.09c-.05.33-.09.66-.09 1v1H5c-.55 0-1 .45-1 1s.45 1 1 1h1v1c0 .34.04.67.09 1H5c-.55 0-1 .45-1 1s.45 1 1 1h1.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H19c.55 0 1-.45 1-1s-.45-1-1-1h-1.09c.05-.33.09-.66.09-1v-1h1c.55 0 1-.45 1-1s-.45-1-1-1h-1v-1c0-.34-.04-.67-.09-1H19c.55 0 1-.45 1-1s-.45-1-1-1zm-6 8h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1zm0-4h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1z"/>
                          </svg>
                          <span className="dropdown-label">Bug Report</span>
                        </button>
                        <div className="dropdown-divider"></div>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowTerms?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">📄</span>
                          <span className="dropdown-label">Terms of Service</span>
                        </button>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowPrivacy?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">🔒</span>
                          <span className="dropdown-label">Privacy Policy</span>
                        </button>
                                              </div>
                    )}
                  </div>

                  <div className="header-divider-vertical"></div>
                </>
              )}

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
              {/* Theatre Mode Buttons - Also visible for non-authenticated users */}
              {isTheatreMode && (
                <>
                  {/* Inventory Button with Hint */}
                  <div className="inventory-btn-wrapper">
                    <button
                      className="theatre-inventory-btn"
                      onClick={onInventoryToggle}
                      title="Inventory"
                    >
                      🎒
                    </button>
                    {showInventoryHint && (
                      <div className="inventory-signup-hint">
                        <span className="hint-icon">✨</span>
                        <span className="hint-text">Sign up to collect items & effects!</span>
                        <button
                          className="hint-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowInventoryHint(false);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Sound Volume Control */}
                  {onSoundVolumeChange && (
                    <SoundVolumeControl
                      volume={soundVolume}
                      onVolumeChange={onSoundVolumeChange}
                    />
                  )}

                  {/* Clips Link */}
                  <a
                    href="https://onestreamer.live/clips/"
                    className="theatre-clips-btn"
                    title="Clips"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                      <path d="M23 7l-7 5 7 5V7z"/>
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                  </a>

                  {/* Blog Link */}
                  <a
                    href="https://onestreamer.live/blog/"
                    className="theatre-blog-btn"
                    title="Blog"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                    </svg>
                  </a>

                  {/* Discord Link */}
                  <a
                    href="https://discord.gg/As5CA3ekYA"
                    className="theatre-discord-btn"
                    title="Discord"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
                    </svg>
                  </a>

                  {/* Theatre Dropdown Menu */}
                  <div className="theatre-dropdown-container">
                    <button
                      className="theatre-dropdown-btn"
                      onClick={onTheatreDropdownToggle}
                      title="More Options"
                    >
                      ⋮
                    </button>
                    {theatreDropdownOpen && (
                      <div className="theatre-dropdown-menu">
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowTutorial?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">📖</span>
                          <span className="dropdown-label">Tutorial</span>
                        </button>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowAbout?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">ℹ️</span>
                          <span className="dropdown-label">About</span>
                        </button>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowBugReport?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <svg className="dropdown-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 8h-1.81c-.45-.78-1.07-1.45-1.82-1.96l.93-.93a.996.996 0 1 0-1.41-1.41l-1.47 1.47C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L9.11 3.7A.996.996 0 1 0 7.7 5.11l.92.93C7.88 6.55 7.26 7.22 6.81 8H5c-.55 0-1 .45-1 1s.45 1 1 1h1.09c-.05.33-.09.66-.09 1v1H5c-.55 0-1 .45-1 1s.45 1 1 1h1v1c0 .34.04.67.09 1H5c-.55 0-1 .45-1 1s.45 1 1 1h1.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H19c.55 0 1-.45 1-1s-.45-1-1-1h-1.09c.05-.33.09-.66.09-1v-1h1c.55 0 1-.45 1-1s-.45-1-1-1h-1v-1c0-.34-.04-.67-.09-1H19c.55 0 1-.45 1-1s-.45-1-1-1zm-6 8h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1zm0-4h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1z"/>
                          </svg>
                          <span className="dropdown-label">Bug Report</span>
                        </button>
                        <div className="dropdown-divider"></div>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowTerms?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">📄</span>
                          <span className="dropdown-label">Terms of Service</span>
                        </button>
                        <button
                          className="theatre-dropdown-item"
                          onClick={() => {
                            onShowPrivacy?.();
                            onTheatreDropdownToggle?.();
                          }}
                        >
                          <span className="dropdown-icon">🔒</span>
                          <span className="dropdown-label">Privacy Policy</span>
                        </button>
                                              </div>
                    )}
                  </div>

                  <div className="header-divider-vertical"></div>
                </>
              )}

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