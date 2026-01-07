import React, { useState, useRef, useEffect } from 'react';
import ReactDOM from 'react-dom';
import './MobileLandscapeLayout.css';
import Chat from './Chat';
import { ClipCreationModal } from './clips';

interface MobileLandscapeLayoutProps {
  // Stream Status
  viewerCount: number;
  hasActiveStream: boolean;
  streamDuration: number;
  streamStartTime?: number | null;
  streamerDisplayName?: string | null;

  // Streaming controls
  isStreaming: boolean;
  cooldownRemaining: number;
  isConnected: boolean;

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

  // Stream control callbacks
  onTakeOver?: () => void;
  onStopStream?: () => void;
  onOpenStreamerSettings?: () => void;
}

const MobileLandscapeLayout: React.FC<MobileLandscapeLayoutProps> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName,
  isStreaming,
  cooldownRemaining,
  isConnected,
  isAuthenticated,
  currentUser,
  userPoints = 0,
  showInventory,
  showShop,
  onInventoryToggle,
  onShopToggle,
  onLogin,
  onLogout,
  onProfileSettings,
  onShowTutorial,
  onShowBugReport,
  onShowAbout,
  onShowTerms,
  onShowPrivacy,
  onTakeOver,
  onStopStream,
  onOpenStreamerSettings
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState<'backpack' | 'shop' | 'stream' | null>(null);
  const [showVideoControls, setShowVideoControls] = useState(false);
  const [showClipModal, setShowClipModal] = useState(false);
  const [clipStatus, setClipStatus] = useState<{ available: boolean; isRecording: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const menuHistoryRef = useRef<boolean>(false);

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

  // Close menus when clicking/touching outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowHamburgerMenu(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (showHamburgerMenu) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [showHamburgerMenu]);

  // Handle back button/gesture for hamburger menu
  useEffect(() => {
    if (showHamburgerMenu && !menuHistoryRef.current) {
      window.history.pushState({ menu: 'hamburger' }, '', window.location.href);
      menuHistoryRef.current = true;
    } else if (!showHamburgerMenu && menuHistoryRef.current) {
      menuHistoryRef.current = false;
    }
  }, [showHamburgerMenu]);

  useEffect(() => {
    const handlePopState = () => {
      if (menuHistoryRef.current) {
        setShowHamburgerMenu(false);
        menuHistoryRef.current = false;
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Auto-hide video controls after 4 seconds
  useEffect(() => {
    if (showVideoControls) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      controlsTimeoutRef.current = setTimeout(() => {
        setShowVideoControls(false);
      }, 4000);
    }
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [showVideoControls]);

  // Listen for clicks on the video area to toggle controls
  useEffect(() => {
    const handleVideoAreaClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if click is on video element or stream container
      const isVideoClick = target.closest('.webrtc-video, .stream-container, .webrtc-viewer-container, .stream-viewer');

      // Don't toggle if clicking on interactive elements like unmute button
      const isInteractiveElement = target.closest('button, input, a, [role="button"]');

      // Don't toggle if clicking on chat sidebar or other UI
      const isUIElement = target.closest('.landscape-chat-sidebar, .landscape-hamburger-menu, .video-controls-overlay, .video-playback-bar');

      if (isVideoClick && !isInteractiveElement && !isUIElement) {
        setShowVideoControls(prev => !prev);
      }
    };

    document.addEventListener('click', handleVideoAreaClick);
    return () => document.removeEventListener('click', handleVideoAreaClick);
  }, []);

  // Check clip availability
  useEffect(() => {
    const checkClipStatus = async () => {
      try {
        const response = await fetch('/api/clips/status');
        const data = await response.json();
        if (data.success) {
          setClipStatus({ available: data.available, isRecording: data.isRecording });
        }
      } catch (err) {
        console.error('Failed to check clip status:', err);
      }
    };

    checkClipStatus();
    const interval = setInterval(checkClipStatus, 10000);
    return () => clearInterval(interval);
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
    if (!streamerDisplayName) return '';
    if (streamerDisplayName.length > 12) {
      return streamerDisplayName.substring(0, 10) + '...';
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

  const handleTakeOverClick = () => {
    setShowVideoControls(false);
    onTakeOver?.();
  };

  const handleStopStreamClick = () => {
    setShowVideoControls(false);
    onStopStream?.();
  };

  const handleSettingsClick = () => {
    setShowVideoControls(false);
    onOpenStreamerSettings?.();
  };

  const handleClipClick = () => {
    setShowVideoControls(false);
    setShowClipModal(true);
  };

  const canTakeOver = isConnected && !isStreaming && cooldownRemaining <= 0;

  return (
    <>
    <div className="landscape-theatre-layout">
      {/* Video tap area - transparent overlay for controls (clicks pass through) */}
      <div className="landscape-video-tap-area">
        {/* Video Controls Overlay - shown on tap */}
        {showVideoControls && (
          <>
            {/* Right side action buttons */}
            <div className="video-controls-overlay" onClick={(e) => e.stopPropagation()}>
              <div className="video-controls-content">
                {isStreaming ? (
                  <>
                    <button
                      className="video-control-btn settings-btn"
                      onClick={handleSettingsClick}
                    >
                      <span className="control-icon">⚙️</span>
                      <span className="control-label">Settings</span>
                    </button>
                    <button
                      className={`video-control-btn clip-btn ${!clipStatus?.available ? 'disabled' : ''}`}
                      onClick={handleClipClick}
                      disabled={!clipStatus?.available}
                    >
                      <span className="control-icon">✂️</span>
                      <span className="control-label">Clip</span>
                    </button>
                    <button
                      className="video-control-btn stop-btn"
                      onClick={handleStopStreamClick}
                    >
                      <span className="control-icon">⏹️</span>
                      <span className="control-label">Stop Stream</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="video-control-btn settings-btn"
                      onClick={handleSettingsClick}
                    >
                      <span className="control-icon">⚙️</span>
                      <span className="control-label">Settings</span>
                    </button>
                    <button
                      className={`video-control-btn clip-btn ${!clipStatus?.available ? 'disabled' : ''}`}
                      onClick={handleClipClick}
                      disabled={!clipStatus?.available}
                    >
                      <span className="control-icon">✂️</span>
                      <span className="control-label">Clip</span>
                    </button>
                    <button
                      className={`video-control-btn takeover-btn ${!canTakeOver ? 'disabled' : ''}`}
                      onClick={handleTakeOverClick}
                      disabled={!canTakeOver}
                    >
                      <span className="control-icon">🎥</span>
                      <span className="control-label">
                        {cooldownRemaining > 0
                          ? `Wait ${cooldownRemaining}s`
                          : !isConnected
                            ? 'Connecting...'
                            : 'Take Over'}
                      </span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Top info bar overlay */}
      <div className="landscape-video-overlay">
        <div className="video-top-bar">
          <button
            className={`landscape-hamburger ${showHamburgerMenu ? 'open' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setShowHamburgerMenu(!showHamburgerMenu);
            }}
            aria-label="Menu"
          >
            <span className="hamburger-line"></span>
            <span className="hamburger-line"></span>
            <span className="hamburger-line"></span>
          </button>

          <div className="video-stream-info">
            {hasActiveStream ? (
              <>
                <span className="live-badge">LIVE</span>
                <span className="viewer-count">{viewerCount}</span>
                {streamerDisplayName && <span className="streamer-name">{getDisplayName()}</span>}
                {streamStartTime && <span className="stream-duration">{formatDuration(streamDuration)}</span>}
              </>
            ) : (
              <span className="offline-badge">OFFLINE</span>
            )}
          </div>
        </div>
      </div>

      {/* Right: Chat Panel (always visible, full height) */}
      <div className="landscape-chat-sidebar">
        {/* Chat header with actions */}
        <div className="chat-sidebar-header">
          <div className="chat-title">Chat</div>
          <div className="chat-actions">
            <button
              className={`chat-action-btn ${showInventory ? 'active' : ''}`}
              onClick={handleBackpackClick}
              title="Backpack"
            >
              🎒
            </button>
            <button
              className={`chat-action-btn ${showShop ? 'active' : ''}`}
              onClick={handleShopClick}
              title="Shop"
            >
              🛒
            </button>
            <div className="points-display">
              {isAuthenticated ? userPoints : '---'}
            </div>
            {/* User avatar/login */}
            <div className="user-section" ref={userMenuRef}>
              {isAuthenticated ? (
                <button
                  className="user-avatar-btn"
                  onClick={() => setShowUserMenu(!showUserMenu)}
                >
                  {getUserInitial()}
                </button>
              ) : (
                <button className="login-btn" onClick={onLogin}>
                  Login
                </button>
              )}

              {/* User dropdown */}
              {showUserMenu && isAuthenticated && (
                <div className="user-dropdown">
                  <div className="dropdown-username">{currentUser?.username}</div>
                  <button onClick={() => { onProfileSettings?.(); setShowUserMenu(false); }}>
                    Settings
                  </button>
                  <button onClick={() => { onLogout?.(); setShowUserMenu(false); }}>
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Chat content */}
        <div className="chat-sidebar-content">
          <Chat />
        </div>
      </div>

    </div>

      {/* Hamburger Menu Overlay - Portal to body */}
      {showHamburgerMenu && ReactDOM.createPortal(
        <div className="landscape-menu-overlay">
          {/* Explicit close area - covers everything except the menu */}
          <div
            className="landscape-menu-close-area"
            onClick={() => setShowHamburgerMenu(false)}
            onTouchStart={() => setShowHamburgerMenu(false)}
          />
          <nav className="landscape-hamburger-menu" ref={menuRef}>
            <div className="menu-header">
              <span className="menu-brand">OneStreamer</span>
              <button className="menu-close" onClick={() => setShowHamburgerMenu(false)}>×</button>
            </div>

            <div className="menu-section">
              <a href="/clips/" className="menu-item">
                <span className="menu-icon">🎬</span>
                <span className="menu-text">Clips</span>
              </a>
              <a href="/blog/" className="menu-item">
                <span className="menu-icon">📰</span>
                <span className="menu-text">Blog</span>
              </a>
            </div>

            <div className="menu-section">
              <a href="https://discord.gg/As5CA3ekYA" target="_blank" rel="noopener noreferrer" className="menu-item discord">
                <span className="menu-icon">💬</span>
                <span className="menu-text">Discord</span>
              </a>
            </div>

            <div className="menu-section">
              <button className="menu-item" onClick={() => handleMenuItemClick(() => onShowTutorial?.())}>
                <span className="menu-icon">❓</span>
                <span className="menu-text">Tutorial</span>
              </button>
              <button className="menu-item" onClick={() => handleMenuItemClick(() => onShowBugReport?.())}>
                <span className="menu-icon">🐛</span>
                <span className="menu-text">Report Bug</span>
              </button>
              <button className="menu-item" onClick={() => handleMenuItemClick(() => onShowAbout?.())}>
                <span className="menu-icon">ℹ️</span>
                <span className="menu-text">About</span>
              </button>
            </div>

            <div className="menu-section">
              <button className="menu-item" onClick={() => handleMenuItemClick(() => onShowTerms?.())}>
                <span className="menu-icon">📄</span>
                <span className="menu-text">Terms</span>
              </button>
              <button className="menu-item" onClick={() => handleMenuItemClick(() => onShowPrivacy?.())}>
                <span className="menu-icon">🔒</span>
                <span className="menu-text">Privacy</span>
              </button>
            </div>
          </nav>
        </div>,
        document.body
      )}

      {/* Login Prompt - Portal to body */}
      {showLoginPrompt && ReactDOM.createPortal(
        <div className="login-prompt-overlay" onClick={() => setShowLoginPrompt(null)}>
          <div className="login-prompt" onClick={e => e.stopPropagation()}>
            <button className="close-btn" onClick={() => setShowLoginPrompt(null)}>×</button>
            <div className="prompt-icon">
              {showLoginPrompt === 'backpack' ? '🎒' : showLoginPrompt === 'shop' ? '🛒' : '🎥'}
            </div>
            <h3>
              {showLoginPrompt === 'backpack' ? 'Unlock Your Backpack!' :
               showLoginPrompt === 'shop' ? 'Welcome to the Shop!' : 'Go Live!'}
            </h3>
            <p>Sign up or log in to {showLoginPrompt === 'stream' ? 'start streaming' : 'access this feature'}!</p>
            <div className="prompt-buttons">
              <button onClick={() => { setShowLoginPrompt(null); onLogin?.(); }}>Login</button>
              <button className="primary" onClick={() => { setShowLoginPrompt(null); onLogin?.(); }}>Sign Up</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Clip Creation Modal - Portal to body */}
      {showClipModal && ReactDOM.createPortal(
        <ClipCreationModal
          onClose={() => setShowClipModal(false)}
          onSuccess={(clipId) => {
            console.log('Clip created:', clipId);
          }}
        />,
        document.body
      )}
    </>
  );
};

export default MobileLandscapeLayout;
