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
  onShowTutorial?: () => void;
  onShowBugReport?: () => void;
  onShowAbout?: () => void;
  onShowTerms?: () => void;
  onShowPrivacy?: () => void;
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
  onProfileSettings,
  onShowTutorial,
  onShowBugReport,
  onShowAbout,
  onShowTerms,
  onShowPrivacy
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLDivElement>(null);

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

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (hamburgerRef.current && !hamburgerRef.current.contains(event.target as Node)) {
        setShowHamburgerMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (showHamburgerMenu) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showHamburgerMenu]);

  // Back button/gesture handler for hamburger menu
  const menuHistoryRef = useRef<boolean>(false);

  useEffect(() => {
    if (showHamburgerMenu && !menuHistoryRef.current) {
      // Menu opened - push state
      window.history.pushState({ menu: 'hamburger' }, '', window.location.href);
      menuHistoryRef.current = true;
    } else if (!showHamburgerMenu && menuHistoryRef.current) {
      // Menu closed by other means - clean up history
      menuHistoryRef.current = false;
      if (window.history.state?.menu === 'hamburger') {
        window.history.back();
      }
    }
  }, [showHamburgerMenu]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (menuHistoryRef.current && showHamburgerMenu) {
        setShowHamburgerMenu(false);
        menuHistoryRef.current = false;
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [showHamburgerMenu]);

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

  const handleMenuItemClick = (action: () => void) => {
    setShowHamburgerMenu(false);
    action();
  };

  return (
    <>
      <header className="mobile-header-v2">
        <div className="mobile-header-content">
          {/* Hamburger Menu Button */}
          <div className="header-hamburger" ref={hamburgerRef}>
            <button
              className={`hamburger-button ${showHamburgerMenu ? 'open' : ''}`}
              onClick={() => setShowHamburgerMenu(!showHamburgerMenu)}
              aria-label="Menu"
            >
              <span className="hamburger-line"></span>
              <span className="hamburger-line"></span>
              <span className="hamburger-line"></span>
            </button>
          </div>

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

                {/* User Dropdown Menu */}
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

      {/* Hamburger Menu Overlay */}
      {showHamburgerMenu && (
        <div className="hamburger-overlay" onClick={() => setShowHamburgerMenu(false)}>
          <nav className="hamburger-menu" onClick={e => e.stopPropagation()}>
            <div className="hamburger-menu-header">
              <span className="menu-brand">OneStreamer</span>
              <button className="menu-close" onClick={() => setShowHamburgerMenu(false)}>×</button>
            </div>

            <div className="menu-section">
              <div className="menu-section-title">Navigation</div>
              <a href="/clips/" className="menu-item" onClick={() => setShowHamburgerMenu(false)}>
                <span className="menu-item-icon">🎬</span>
                <span className="menu-item-text">Clips</span>
              </a>
              <a href="/blog/" className="menu-item" onClick={() => setShowHamburgerMenu(false)}>
                <span className="menu-item-icon">📰</span>
                <span className="menu-item-text">Blog</span>
              </a>
            </div>

            <div className="menu-section">
              <div className="menu-section-title">Community</div>
              <a
                href="https://discord.gg/As5CA3ekYA"
                target="_blank"
                rel="noopener noreferrer"
                className="menu-item discord-item"
                onClick={() => setShowHamburgerMenu(false)}
              >
                <span className="menu-item-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
                  </svg>
                </span>
                <span className="menu-item-text">Join Discord</span>
              </a>
            </div>

            <div className="menu-section">
              <div className="menu-section-title">Help & Support</div>
              <button
                className="menu-item"
                onClick={() => handleMenuItemClick(() => onShowTutorial?.())}
              >
                <span className="menu-item-icon">❓</span>
                <span className="menu-item-text">Tutorial</span>
              </button>
              <button
                className="menu-item"
                onClick={() => handleMenuItemClick(() => onShowBugReport?.())}
              >
                <span className="menu-item-icon">🐛</span>
                <span className="menu-item-text">Report Bug</span>
              </button>
              <button
                className="menu-item"
                onClick={() => handleMenuItemClick(() => onShowAbout?.())}
              >
                <span className="menu-item-icon">ℹ️</span>
                <span className="menu-item-text">About</span>
              </button>
            </div>

            <div className="menu-section">
              <div className="menu-section-title">Legal</div>
              <button
                className="menu-item"
                onClick={() => handleMenuItemClick(() => onShowTerms?.())}
              >
                <span className="menu-item-icon">📄</span>
                <span className="menu-item-text">Terms of Service</span>
              </button>
              <button
                className="menu-item"
                onClick={() => handleMenuItemClick(() => onShowPrivacy?.())}
              >
                <span className="menu-item-icon">🔒</span>
                <span className="menu-item-text">Privacy Policy</span>
              </button>
            </div>
          </nav>
        </div>
      )}
    </>
  );
};

export default MobileHeader;
