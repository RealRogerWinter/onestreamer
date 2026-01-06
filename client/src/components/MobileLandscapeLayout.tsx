import React, { useState, useRef, useEffect } from 'react';
import './MobileLandscapeLayout.css';
import Chat from './Chat';
import AnimatedNumber from './AnimatedNumber';

interface MobileLandscapeLayoutProps {
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

  // Panel states
  showChat: boolean;
  showInventory: boolean;
  showShop: boolean;

  // Callbacks
  onChatToggle: () => void;
  onInventoryToggle: () => void;
  onShopToggle: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  onProfileSettings?: () => void;
  onShowTutorial?: () => void;
  onShowBugReport?: () => void;
  onShowAbout?: () => void;
  onShowTerms?: () => void;
  onShowPrivacy?: () => void;
}

const MobileLandscapeLayout: React.FC<MobileLandscapeLayoutProps> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName,
  isAuthenticated,
  currentUser,
  userPoints = 0,
  showChat,
  showInventory,
  showShop,
  onChatToggle,
  onInventoryToggle,
  onShopToggle,
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
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState<'backpack' | 'shop' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

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
        setShowHamburgerMenu(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
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
    if (!streamerDisplayName) return '';
    if (streamerDisplayName.length > 10) {
      return streamerDisplayName.substring(0, 8) + '...';
    }
    return streamerDisplayName;
  };

  const handleMenuItemClick = (action: () => void) => {
    setShowHamburgerMenu(false);
    action();
  };

  const handleBackpackClick = () => {
    if (isAuthenticated) {
      onInventoryToggle();
    } else {
      setShowLoginPrompt('backpack');
    }
  };

  const handleShopClick = () => {
    if (isAuthenticated) {
      onShopToggle();
    } else {
      setShowLoginPrompt('shop');
    }
  };

  return (
    <>
      {/* Horizontal Header Bar */}
      <header className="landscape-header">
        <div className="landscape-header-content">
          {/* Left: Hamburger Menu */}
          <div className="header-left">
            <button
              className={`landscape-hamburger ${showHamburgerMenu ? 'open' : ''}`}
              onClick={() => setShowHamburgerMenu(!showHamburgerMenu)}
              aria-label="Menu"
            >
              <span className="hamburger-line"></span>
              <span className="hamburger-line"></span>
              <span className="hamburger-line"></span>
            </button>
          </div>

          {/* Center: Stream Info */}
          <div className="header-center">
            {hasActiveStream ? (
              <div className="landscape-stream-info">
                <span className="landscape-live-badge">LIVE</span>
                <span className="landscape-viewers">
                  <span className="viewer-icon">👥</span>
                  {viewerCount}
                </span>
                {streamerDisplayName && (
                  <span className="landscape-streamer">{getDisplayName()}</span>
                )}
                {streamStartTime && (
                  <span className="landscape-duration">{formatDuration(streamDuration)}</span>
                )}
              </div>
            ) : (
              <span className="landscape-offline">OFFLINE</span>
            )}
          </div>

          {/* Right: User Section */}
          <div className="header-right" ref={userMenuRef}>
            {isAuthenticated ? (
              <>
                <button
                  className="landscape-user-button"
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  aria-label="User menu"
                >
                  <div className="landscape-user-avatar">
                    {getUserInitial()}
                  </div>
                </button>

                {/* User Dropdown */}
                {showUserMenu && (
                  <div className="landscape-user-dropdown">
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
                      Settings
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
                className="landscape-login-btn"
                onClick={onLogin}
              >
                Login
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Right Side Action Bar - Hide when chat is open */}
      {!showChat && (
        <div className="landscape-action-bar">
          {/* Points Display */}
          <div className="landscape-action-item landscape-points">
            <span className="action-icon">💎</span>
            <span className="points-value">{isAuthenticated ? userPoints : '---'}</span>
          </div>

          {/* Chat Button */}
          <button
            className={`landscape-action-item ${showChat ? 'active' : ''}`}
            onClick={onChatToggle}
            title="Chat"
          >
            <span className="action-icon">💬</span>
            <span className="action-label">Chat</span>
          </button>

          {/* Backpack Button */}
          <button
            className={`landscape-action-item ${showInventory ? 'active' : ''}`}
            onClick={handleBackpackClick}
            title="Backpack"
          >
            <span className="action-icon">🎒</span>
            <span className="action-label">Bag</span>
          </button>

          {/* Shop Button */}
          <button
            className={`landscape-action-item ${showShop ? 'active' : ''}`}
            onClick={handleShopClick}
            title="Shop"
          >
            <span className="action-icon">🛒</span>
            <span className="action-label">Shop</span>
          </button>
        </div>
      )}

      {/* Chat Slide Panel */}
      <div className={`landscape-chat-panel ${showChat ? 'open' : ''}`}>
        <div className="landscape-chat-header">
          <span className="chat-title">Chat</span>
          <button className="chat-close-btn" onClick={onChatToggle}>×</button>
        </div>
        <div className="landscape-chat-content">
          <Chat />
        </div>
      </div>

      {/* Hamburger Menu Overlay */}
      {showHamburgerMenu && (
        <div className="landscape-menu-overlay" onClick={() => setShowHamburgerMenu(false)}>
          <nav className="landscape-hamburger-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
            <div className="menu-header">
              <span className="menu-brand">OneStreamer</span>
              <button className="menu-close" onClick={() => setShowHamburgerMenu(false)}>×</button>
            </div>

            <div className="menu-section">
              <div className="menu-section-title">Navigation</div>
              <a href="/clips/" className="menu-item">
                <span className="menu-item-icon">🎬</span>
                <span className="menu-item-text">Clips</span>
              </a>
              <a href="/blog/" className="menu-item">
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
              >
                <span className="menu-item-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
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
                <span className="menu-item-text">Terms</span>
              </button>
              <button
                className="menu-item"
                onClick={() => handleMenuItemClick(() => onShowPrivacy?.())}
              >
                <span className="menu-item-icon">🔒</span>
                <span className="menu-item-text">Privacy</span>
              </button>
            </div>
          </nav>
        </div>
      )}

      {/* Login Prompt Overlay */}
      {showLoginPrompt && (
        <div className="landscape-login-overlay" onClick={() => setShowLoginPrompt(null)}>
          <div className="landscape-login-prompt" onClick={e => e.stopPropagation()}>
            <button className="prompt-close" onClick={() => setShowLoginPrompt(null)}>×</button>
            <div className="prompt-icon">
              {showLoginPrompt === 'backpack' ? '🎒' : '🛒'}
            </div>
            <h3>{showLoginPrompt === 'backpack' ? 'Unlock Your Backpack!' : 'Welcome to the Shop!'}</h3>
            <p>
              {showLoginPrompt === 'backpack'
                ? 'Sign up or log in to collect items and power-ups!'
                : 'Sign up or log in to buy items and effects!'}
            </p>
            <div className="prompt-buttons">
              <button
                className="prompt-btn prompt-login"
                onClick={() => {
                  setShowLoginPrompt(null);
                  onLogin?.();
                }}
              >
                Login
              </button>
              <button
                className="prompt-btn prompt-signup"
                onClick={() => {
                  setShowLoginPrompt(null);
                  onLogin?.();
                }}
              >
                Sign Up
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default MobileLandscapeLayout;
