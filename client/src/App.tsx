import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SocketProvider, useMainSocket } from './contexts/SocketContext';
import { useResponsiveLayout } from './hooks/useResponsiveLayout';
import { useAuthState } from './hooks/useAuthState';
import { useGameState } from './hooks/useGameState';
import { useStreamerSettings } from './hooks/useStreamerSettings';
import { useStreamState, StreamStatus } from './hooks/useStreamState';
import { useStreamGenerationGuard } from './hooks/useStreamGenerationGuard';
import { useModals } from './hooks/useModals';
import './App.css';
import StreamViewer from './components/stream/StreamViewer';
import StreamControls from './components/stream/StreamControls';
import StreamerSettings from './components/stream/StreamerSettings';
import TheatreControls from './components/stream/TheatreControls';
import AdminPanelV3 from './components/admin/AdminPanelV3';
import Chat from './components/Chat';
import MobileChat from './components/mobile/MobileChat';
import Login from './components/auth/Login';
import Signup from './components/auth/Signup';
import ProfileSettings from './components/user/ProfileSettings';
import Tutorial from './components/Tutorial';
import InventoryPanel from './components/inventory/InventoryPanel';
import ModalShopPanel from './components/shop/ModalShopPanel';
import BuffDisplay from './components/buffs/BuffDisplay';
import NotificationManager from './components/notifications/NotificationManager';
import SoundFxPlayer from './components/soundfx/SoundFxPlayer';
import SafariTTSNotice from './components/soundfx/SafariTTSNotice';
import { FloatingPointsManager } from './components/buffs/FloatingPoints';
import MobileBottomNav from './components/mobile/MobileBottomNav';
import MobileHeader from './components/mobile/MobileHeader';
import MobileLandscapeLayout from './components/mobile/MobileLandscapeLayout';
import DesktopHeaderV2 from './components/DesktopHeaderV2';
import OAuthCallback from './components/auth/OAuthCallback';
import OAuthUsernameSelection from './components/auth/OAuthUsernameSelection';
import BugReportModal from './components/BugReportModal';
import EmailVerification from './components/auth/EmailVerification';
import PasswordReset from './components/auth/PasswordReset';
import DeletionConfirmation from './components/auth/DeletionConfirmation';
import AccountRestoration from './components/auth/AccountRestoration';
import ModerationPanel from './components/admin/ModerationPanel';
import BotsPanel from './components/BotsPanel';
import { ClipsGallery, ClipPlayer } from './components/clips';
import { GameOverlay } from './components/game';
import authService from './services/AuthService';
import SocketManager from './services/SocketManager';
import CookieConsentService from './services/CookieConsentService';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import './styles/cookieconsent.css';

// Declare global showFloatingPoints function
declare global {
  interface Window {
    showFloatingPoints?: (amount: number, source?: string) => void;
  }
}

let appContentInstanceCount = 0;

function AppContent() {
  const instanceId = useRef(++appContentInstanceCount);
  
  // Check if we're on the OAuth callback page
  const isOAuthCallback = window.location.pathname === '/auth/success' || 
                         window.location.pathname === '/auth/error';
  
  // Check if we're on the OAuth username selection page
  const isOAuthUsernameSelection = window.location.pathname === '/auth/complete-registration';
  
  // Check if we're on the email verification page
  const currentPath = window.location.pathname;
  const isEmailVerification = /^\/verify-email\/[a-fA-F0-9]+$/i.test(currentPath);

  // Check if we're on the password reset page
  const isPasswordReset = /^\/reset-password\/[a-fA-F0-9]+$/i.test(currentPath);

  // Check if we're on the deletion confirmation page
  const isDeletionConfirmation = /^\/confirm-deletion\/[a-fA-F0-9]+$/i.test(currentPath);

  // Modal visibility state — all ~15 show* / is*Open flags live in useModals.
  // Initial values for the URL-driven verification modals are seeded here;
  // the post-mount effect below also re-asserts them in case the URL is
  // observed slightly differently after mount (preserved verbatim).
  const {
    showLogin, setShowLogin,
    showSignup, setShowSignup,
    showEmailVerification, setShowEmailVerification,
    showPasswordReset, setShowPasswordReset,
    showDeletionConfirmation, setShowDeletionConfirmation,
    showAccountRestoration, setShowAccountRestoration,
    pendingDeletionUser, setPendingDeletionUser,
    showProfileSettings, setShowProfileSettings,
    showInventory, setShowInventory,
    showAdminPanel, setShowAdminPanel,
    adminPanelTab, setAdminPanelTab,
    isShopOpen, setIsShopOpen,
    showMobileChat, setShowMobileChat,
    showMobileStreamerSettings, setShowMobileStreamerSettings,
    showTutorial, setShowTutorial,
    showBugReportModal, setShowBugReportModal,
    showAbout, setShowAbout,
    showTerms, setShowTerms,
    showPrivacy, setShowPrivacy,
  } = useModals({
    initialShowEmailVerification: isEmailVerification,
    initialShowPasswordReset: isPasswordReset,
    initialShowDeletionConfirmation: isDeletionConfirmation,
  });
  
  useEffect(() => {
    // console.log(`🔴 AppContent Instance #${instanceId.current} created`);
    // console.log('📧 Email Verification Check - Path:', currentPath, 'Is verification?:', isEmailVerification);
    
    // Initialize Cookie Consent
    CookieConsentService.initialize();
    
    // Check on mount if we need to show email verification
    if (currentPath.startsWith('/verify-email/')) {
      // console.log('📧 Setting showEmailVerification to true');
      setShowEmailVerification(true);
    }
    
    // Check on mount if we need to show password reset
    if (currentPath.startsWith('/reset-password/')) {
      setShowPasswordReset(true);
    }
    
    // Check on mount if we need to show deletion confirmation
    if (currentPath.startsWith('/confirm-deletion/')) {
      setShowDeletionConfirmation(true);
    }
    
    return () => {
      // console.log(`🟢 AppContent Instance #${instanceId.current} destroyed`);
    };
  }, []);
  
  // Auth state — owns currentUser, roles, points, login/logout flow.
  // The boot-time JWT verification and admin/points refresh live inside
  // the hook; the pending-deletion modal flow stays here in App.tsx and
  // is wired through the `onPendingDeletion` callback.
  const {
    isAuthenticated,
    currentUser,
    isAdmin,
    isModerator,
    userPoints,
    login: authLogin,
    logout: authLogout,
    setUserPoints,
    setUserPointsFromUpdater,
    refreshCurrentUser,
    setCurrentUser,
    setIsAuthenticated,
    fetchUserPoints,
  } = useAuthState({
    onPendingDeletion: (user) => {
      setPendingDeletionUser(user);
      setShowAccountRestoration(true);
    },
  });

  const { socket, connected, error: socketError } = useMainSocket();
  const socketRef = useRef(socket);
  const [error, setError] = useState<string | null>(null);
  const { isGameActive, setIsGameActive } = useGameState();

  // Stream state — owns isStreaming, streamStatus, cooldown countdown,
  // takeover/transition overlays, force-disconnect plumbing, streamer
  // buffs, and ~20 of the related socket listeners. The
  // `stream-status`, `game:*`, `*-notification`, banned/timeout,
  // points-related listeners stay in App.tsx because they mutate
  // cross-cutting state owned by other hooks or the inline `error`
  // banner. The hook calls back into `setError` via `onError` /
  // `onClearError` to keep those banners working.
  const {
    isStreaming,
    setIsStreaming,
    streamStatus,
    setStreamStatus,
    cooldownRemaining,
    setWasStreamingBeforeTakeover,
    forceViewerAfterTakeover,
    showTakeoverOverlay,
    takeoverMessage,
    showTransitionOverlay,
    transitionMessage,
    disconnectionReason,
    isForceDisconnected,
    streamerBuffs,
  } = useStreamState({
    socket,
    connected,
    onError: setError,
    onClearError: () => setError(null),
  });

  // PR 2.5b: drop-by-streamGeneration replaces the 10-second
  // takeoverTargetRef lock that used to live in the stream-status
  // handler below. Server bumps the counter on every setStreamer /
  // clearStreamer (StreamService.streamGeneration), and the guard
  // discards any stream-status payload with a counter older than the
  // last one we applied. Also resets on socket reconnect so a
  // server-restart-with-rewound-counter doesn't lock us out.
  const acceptStreamStatus = useStreamGenerationGuard(socket);

  // (Login/signup, inventory, profile settings, mobile chat, tutorial,
  // and bug-report modal visibility flags all live in useModals above.)
  const [showLandscapeChat, setShowLandscapeChat] = useState(false);
  const { isMobile, isLandscape } = useResponsiveLayout();
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);

  // Tutorial-default-tab pairs with showTutorial but is a string, not a boolean.
  const [tutorialDefaultTab, setTutorialDefaultTab] = useState<'about' | 'support' | 'tutorial' | 'terms' | 'privacy' | undefined>(undefined);

  // Theatre Mode state - Default to true for desktop users
  const [theatreMode, setTheatreMode] = useState(() => {
    // Check if desktop (not mobile)
    const mobileCheck = window.innerWidth <= 768 || 
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    return !mobileCheck; // Theatre mode ON for desktop, OFF for mobile
  });
  const [theatreChatCollapsed, setTheatreChatCollapsed] = useState(false);
  const [theatreDropdownOpen, setTheatreDropdownOpen] = useState(false);
  const [theatreControlsVisible, setTheatreControlsVisible] = useState(false);

  // (About / Terms / Privacy and mobile-landscape streamer-settings modal
  // visibility flags all come from useModals above.)

  // Settings state - Initialize from cookies or use defaults
  const {
    streamerSettings,
    setStreamerSettings,
    updateStreamerSettings,
    updateAudioSettings,
    updateVideoSettings,
  } = useStreamerSettings();

  // Screen sharing state
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const screenShareMethodsRef = useRef<{ startScreenShare: () => void; stopScreenShare: () => void } | null>(null);

  // Sound effects volume (for TTS, soundboards, etc)
  const [soundEffectsVolume, setSoundEffectsVolume] = useState(() => {
    const saved = localStorage.getItem('soundfx_volume');
    return saved ? parseFloat(saved) : 0.8;
  });

  const handleSoundVolumeChange = (volume: number) => {
    setSoundEffectsVolume(volume);
    localStorage.setItem('soundfx_volume', volume.toString());
  };

  // Update socketRef when socket changes
  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  // Handle socket error
  useEffect(() => {
    if (socketError) {
      setError(socketError);
    }
  }, [socketError]);

  // Setup socket event listeners
  //
  // PR-M4 note: the bulk of the stream-related listeners (stream-started,
  // stream-ended, viewer-count-update, new-streamer, all rotation-* events,
  // global-cooldown, cooldown-status-update, streaming-approved,
  // takeover-approved/denied/blocked, streamer-buffs-update,
  // force-disconnect, stream-takeover) now live inside `useStreamState`.
  // The listeners that remain here either mutate cross-cutting state
  // (useGameState, useAuthState, the local `error` banner) or interact
  // with `socket.id` in ways that are tangled with those cross-cutting
  // concerns. Splitting them further would require wiring more
  // callbacks into `useStreamState`; PR-M5 may revisit.
  useEffect(() => {
    if (!socket) return;

    socket.on('stream-status', (status: StreamStatus) => {
      // PR 2.5b: drop stale stream-status arrivals by monotonic
      // streamGeneration counter. Replaces the 10-second
      // `takeoverTargetRef` lock that used to live here. Server bumps
      // the counter on every setStreamer / clearStreamer (see
      // `StreamService.streamGeneration`), so an older counter means
      // this payload was already superseded — discard it. Payloads
      // without `streamGeneration` (older server, partial emit) are
      // accepted (back-compat).
      if (!acceptStreamStatus(status.streamGeneration)) {
        console.log(`⚠️ CLIENT: Dropping stale stream-status (gen ${status.streamGeneration}, streamerId=${status.streamerId})`);
        return;
      }

      // CRITICAL: Preserve streamerDisplayName and rotation timer values if not provided in status
      // This prevents the header name and countdown from disappearing during transitions
      setStreamStatus(prev => ({
        ...status,
        streamerDisplayName: status.streamerDisplayName || prev.streamerDisplayName,
        // Preserve rotation timer values (managed by rotation-timing event)
        nextRotationAt: prev.nextRotationAt,
        currentRotationDuration: prev.currentRotationDuration,
        isRotationLocked: prev.isRotationLocked,
        lockedRemainingMs: prev.lockedRemainingMs,
        isRandomRotation: prev.isRandomRotation,
        randomRotationPlatform: prev.randomRotationPlatform,
        randomRotationStreamerUrl: prev.randomRotationStreamerUrl,
        randomRotationStreamerUsername: prev.randomRotationStreamerUsername,
        randomRotationGame: prev.randomRotationGame,
        randomRotationViewers: prev.randomRotationViewers,
        randomRotationStartedAt: prev.randomRotationStartedAt
      }));

      if (status.hasActiveStream && isStreaming && socket.id !== status.streamerId) {
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(false);
      }

      // Handle game mode from stream-status
      if (status.isGameMode !== undefined) {
        setIsGameActive(status.isGameMode);
      }
    });

    // Game mode event handlers
    socket.on('game:started', (data: { startedBy: number | null; timestamp: number }) => {
      console.log('🎮 CLIENT: Game started');
      setIsGameActive(true);
    });

    socket.on('game:ended', (data: { endedBy: number | null; timestamp: number }) => {
      console.log('🎮 CLIENT: Game ended');
      setIsGameActive(false);
    });

    socket.on('stream-denied', (data: any) => {
      console.log('🚫 CLIENT: Stream denied:', data);
      setIsStreaming(false);
      
      // Handle permission-specific denials
      if (data.requiresPermissions) {
        setError('Camera and microphone permissions are required to stream. Please grant permissions and try again.');
        // Could trigger permission modal here if needed
      } else if (data.permissionStatus) {
        const { camera, microphone } = data.permissionStatus;
        setError(`Insufficient permissions: Camera is ${camera}, Microphone is ${microphone}. Both must be granted.`);
      } else {
        setError(data.reason || 'Stream request was denied');
      }
    });

    socket.on('admin-notification', (data: { message: string; type: string }) => {
      // console.log('📢 ADMIN:', data.message);
      setError(data.message);
      setTimeout(() => setError(null), 5000);
    });

    socket.on('banned', (data: { reason: string }) => {
      setError(`You have been banned: ${data.reason}`);
    });

    socket.on('timeout', (data: { duration: number; reason: string }) => {
      setError(`You are timed out for ${data.duration} seconds: ${data.reason}`);
    });

    socket.on('time-stats-update', (data: any) => {
      // Only process updates for the current user
      if (currentUser && data.userId && data.userId !== currentUser.id) {
        // console.log('📊 CLIENT: Ignoring update for different user', data.userId, '!==', currentUser?.id);
        return;
      }
      
      if (data.points !== undefined) {
        setUserPointsFromUpdater((prevPoints) => {
          // Trigger floating points animation if points increased
          if (data.points > prevPoints && window.showFloatingPoints) {
            const pointsGained = data.points - prevPoints;
            const source = data.pointSource || data.updateType || 'general';
            // console.log('🎯 Points increased via time-stats-update!', prevPoints, '->', data.points, '(+' + pointsGained + ')', 'Source:', source);
            window.showFloatingPoints(pointsGained, source);
          }
          return data.points;
        });
      }
    });

    socket.on('points-updated', (data: { points: number }) => {
      // console.log('💎 CLIENT: Received points-updated:', data);
      setUserPoints(data.points);
    });

    // Handle kill switch activation notification
    socket.on('kill-switch-activated', (data: { activatedBy: string; targetStreamer: string; message: string }) => {
      // console.log('💥 CLIENT: Kill switch activated notification:', data);
      // Show notification to all users about the kill switch (but not the disconnected user)
      if (!isForceDisconnected) {
        setError(data.message);
        setTimeout(() => setError(null), 5000);
      }
    });

    return () => {
      socket.off('stream-status');
      socket.off('game:started');
      socket.off('game:ended');
      socket.off('stream-denied');
      socket.off('admin-notification');
      socket.off('banned');
      socket.off('timeout');
      socket.off('time-stats-update');
      socket.off('points-updated');
      socket.off('kill-switch-activated');
    };
  }, [socket, isStreaming, currentUser, isForceDisconnected, setStreamStatus, setIsStreaming, setWasStreamingBeforeTakeover, setIsGameActive, setUserPoints, setUserPointsFromUpdater, acceptStreamStatus]);

  const handleLogin = async () => {
    // Pending-deletion short-circuit before activating auth state.
    const user = authService.getUser();
    if (user && (user.accountStatus === 'pending_deletion' || (user as any).account_status === 'pending_deletion')) {
      setPendingDeletionUser(user);
      setShowAccountRestoration(true);
      return;
    }

    // Activate auth via the hook (sets authenticated, fetches profile + points, updates socket auth).
    await authLogin();

    // Re-check pending deletion using the fresh profile, in case the cached
    // user lagged the server. The hook may have populated currentUser by now.
    const fresh = authService.getUser();
    if (fresh && (fresh.accountStatus === 'pending_deletion' || (fresh as any).account_status === 'pending_deletion')) {
      setPendingDeletionUser(fresh);
      setShowAccountRestoration(true);
      setIsAuthenticated(false);
    }
  };

  const handleLogout = async () => {
    await authLogout();
  };

  const handleOpenShop = () => {
    if (!isAuthenticated) {
      setShowLogin(true);
      return;
    }
    setIsShopOpen(true);
  };

  const handleCloseShop = () => {
    setIsShopOpen(false);
  };

  const handlePurchase = async (itemCost: number) => {
    await fetchUserPoints();
  };


  // Listen for custom event to open admin panel with specific tab
  useEffect(() => {
    const handleOpenAdminPanel = (e: CustomEvent) => {
      if (isAdmin && e.detail?.tab) {
        setAdminPanelTab(e.detail.tab);
        setShowAdminPanel(true);
      }
    };

    window.addEventListener('openAdminPanel', handleOpenAdminPanel as EventListener);
    return () => window.removeEventListener('openAdminPanel', handleOpenAdminPanel as EventListener);
  }, [isAdmin]);

  // Track if we've pushed a dialog state to history for mobile back gesture
  const dialogHistoryRef = useRef<string | null>(null);
  // Track when dialog was opened to prevent race conditions with menu cleanup
  const dialogOpenTimeRef = useRef<number>(0);

  // Close dialog handler - returns true if a dialog was closed
  const closeActiveDialog = useCallback(() => {
    // Priority order: modals first, then panels
    if (showBugReportModal) {
      setShowBugReportModal(false);
      return true;
    }
    if (showTutorial) {
      setShowTutorial(false);
      return true;
    }
    if (showProfileSettings) {
      setShowProfileSettings(false);
      return true;
    }
    if (showMobileStreamerSettings) {
      setShowMobileStreamerSettings(false);
      return true;
    }
    if (showLogin) {
      setShowLogin(false);
      return true;
    }
    if (showSignup) {
      setShowSignup(false);
      return true;
    }
    if (isShopOpen) {
      setIsShopOpen(false);
      return true;
    }
    if (showInventory) {
      setShowInventory(false);
      return true;
    }
    if (showMobileChat) {
      setShowMobileChat(false);
      return true;
    }
    if (showLandscapeChat) {
      setShowLandscapeChat(false);
      return true;
    }
    return false;
  }, [showBugReportModal, showTutorial, showProfileSettings, showMobileStreamerSettings, showLogin, showSignup,
      isShopOpen, showInventory, showMobileChat, showLandscapeChat]);

  // Check if any dialog is currently open
  const hasOpenDialog = useCallback(() => {
    return showMobileChat || showLandscapeChat || showInventory || isShopOpen || showLogin || showSignup ||
           showTutorial || showBugReportModal || showProfileSettings || showMobileStreamerSettings;
  }, [showMobileChat, showLandscapeChat, showInventory, isShopOpen, showLogin, showSignup,
      showTutorial, showBugReportModal, showProfileSettings, showMobileStreamerSettings]);

  // Mobile back button/gesture handler
  useEffect(() => {
    if (!isMobile) return;

    const handlePopState = (event: PopStateEvent) => {
      // Ignore popstate events within 300ms of opening a dialog
      // This prevents race conditions when hamburger menu cleanup triggers back()
      if (Date.now() - dialogOpenTimeRef.current < 300) {
        return;
      }

      // Check if any nested panel registered a close handler
      const closeNestedPanel = (window as any).__closeNestedPanel;
      if (closeNestedPanel && typeof closeNestedPanel === 'function') {
        closeNestedPanel();
        // Push state back to prevent leaving the page
        window.history.pushState({ nestedClosed: true }, '');
        return;
      }

      // Only handle our own dialog state
      if (dialogHistoryRef.current && hasOpenDialog()) {
        closeActiveDialog();
        dialogHistoryRef.current = null;
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isMobile, hasOpenDialog, closeActiveDialog]);

  // Push/pop history state when dialogs open/close
  useEffect(() => {
    if (!isMobile) return;

    const dialogOpen = hasOpenDialog();

    if (dialogOpen && !dialogHistoryRef.current) {
      // Dialog opened - push state and record timestamp
      window.history.pushState({ dialog: 'open' }, '', window.location.href);
      dialogHistoryRef.current = 'open';
      dialogOpenTimeRef.current = Date.now();
    } else if (!dialogOpen && dialogHistoryRef.current) {
      // All dialogs closed by other means (button click, etc.) - clean up history
      dialogHistoryRef.current = null;
      // Go back to remove our pushed state if it's still there
      if (window.history.state?.dialog === 'open') {
        window.history.back();
      }
    }
  }, [isMobile, hasOpenDialog]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Admin panel shortcut (Ctrl+Shift+A) - for admins and moderators
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        // Only toggle if user is admin or moderator
        if (isAdmin || isModerator) {
          setShowAdminPanel(!showAdminPanel);
        }
      }
      // Inventory shortcut (B key)
      else if (e.key && e.key.toLowerCase() === 'b' && isAuthenticated && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Only trigger if not typing in an input/textarea
        const activeElement = document.activeElement as HTMLElement;
        if (activeElement?.tagName !== 'INPUT' && activeElement?.tagName !== 'TEXTAREA' && activeElement?.contentEditable !== 'true') {
          e.preventDefault();
          setShowInventory(!showInventory);
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [showAdminPanel, showInventory, isAuthenticated, isAdmin, isModerator]);

  // Close theatre dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const dropdown = document.querySelector('.theatre-dropdown-container');
      if (dropdown && !dropdown.contains(event.target as Node)) {
        setTheatreDropdownOpen(false);
      }
    };

    if (theatreDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [theatreDropdownOpen]);

  // Listen for privacy policy and terms of service events from cookie consent
  useEffect(() => {
    const handleOpenPrivacy = () => {
      setTutorialDefaultTab('privacy');
      setShowTutorial(true);
    };

    const handleOpenTerms = () => {
      setTutorialDefaultTab('terms');
      setShowTutorial(true);
    };

    window.addEventListener('openPrivacyPolicy', handleOpenPrivacy);
    window.addEventListener('openTermsOfService', handleOpenTerms);

    return () => {
      window.removeEventListener('openPrivacyPolicy', handleOpenPrivacy);
      window.removeEventListener('openTermsOfService', handleOpenTerms);
    };
  }, []);

  // If we're on the OAuth callback page, show the callback handler
  if (isOAuthCallback) {
    return <OAuthCallback />;
  }

  // If we're on the OAuth username selection page, show the username selection form
  if (isOAuthUsernameSelection) {
    return <OAuthUsernameSelection />;
  }

  // If we're on the clips gallery page
  if (currentPath === '/clips' || currentPath === '/clips/') {
    return <ClipsGallery />;
  }

  // If we're on a single clip page
  const clipMatch = currentPath.match(/^\/clips\/([a-f0-9-]+)$/i);
  if (clipMatch) {
    return <ClipPlayer clipId={clipMatch[1]} />;
  }

  return (
    <div className={`App ${theatreMode ? 'theatre-mode' : ''}`}>

      {/* Takeover Overlay - When someone takes over your stream */}
      {showTakeoverOverlay && (
        <div className="takeover-overlay">
          <div className="takeover-content">
            <div className="takeover-icon">
              {takeoverMessage.includes('Kill Switch') ? '💥' : 
               takeoverMessage.includes('Connection') ? '🔌' : '🚫'}
            </div>
            <h1 className="takeover-title">
              {takeoverMessage.includes('Kill Switch') ? 'Kill Switch Activated!' :
               takeoverMessage.includes('Connection') ? 'Connection Lost!' : 'Stream Takeover!'}
            </h1>
            <p className="takeover-message">{takeoverMessage}</p>
            <div className="takeover-transition-info">
              <div className="transition-arrow">↓</div>
              <p className="takeover-countdown">Switching to Viewer Mode...</p>
            </div>
          </div>
        </div>
      )}
      
      {/* Transition Overlay - When you successfully take over */}
      {showTransitionOverlay && (
        <div className="takeover-overlay takeover-transition">
          <div className="transition-content">
            <div className="transition-icon">🎬</div>
            <h1 className="transition-title">Going Live!</h1>
            <p className="transition-message">{transitionMessage}</p>
          </div>
        </div>
      )}
      
      {/* Mobile Header V2 - Hide in landscape */}
      {isMobile && !isLandscape ? (
        <>
          <MobileHeader
            viewerCount={streamStatus.viewerCount}
            hasActiveStream={streamStatus.hasActiveStream}
            streamDuration={streamStatus.streamDuration}
            streamStartTime={streamStatus.streamStartTime}
            streamerDisplayName={streamStatus.streamerDisplayName}
            isRandomRotation={streamStatus.isRandomRotation}
            randomRotationPlatform={streamStatus.randomRotationPlatform}
            randomRotationStreamerUrl={streamStatus.randomRotationStreamerUrl}
            randomRotationStreamerUsername={streamStatus.randomRotationStreamerUsername}
            randomRotationGame={streamStatus.randomRotationGame}
            randomRotationViewers={streamStatus.randomRotationViewers}
            nextRotationAt={streamStatus.nextRotationAt}
            currentRotationDuration={streamStatus.currentRotationDuration}
            isRotationLocked={streamStatus.isRotationLocked}
            lockedRemainingMs={streamStatus.lockedRemainingMs}
            isAuthenticated={isAuthenticated}
            currentUser={currentUser}
            userPoints={userPoints}
            showHamburgerMenu={showHamburgerMenu}
            onHamburgerMenuToggle={setShowHamburgerMenu}
            onLogin={() => setShowLogin(true)}
            onLogout={handleLogout}
            onProfileSettings={() => setShowProfileSettings(true)}
            onShowTutorial={() => {
              setTutorialDefaultTab('tutorial');
              setShowTutorial(true);
            }}
            onShowBugReport={() => setShowBugReportModal(true)}
            onShowAbout={() => {
              setTutorialDefaultTab('about');
              setShowTutorial(true);
            }}
            onShowTerms={() => {
              setTutorialDefaultTab('terms');
              setShowTutorial(true);
            }}
            onShowPrivacy={() => {
              setTutorialDefaultTab('privacy');
              setShowTutorial(true);
            }}
          />
        </>
      ) : !isMobile ? (
        /* Desktop Header V2 - Modern Design */
        <>
          <DesktopHeaderV2
            viewerCount={streamStatus.viewerCount}
            hasActiveStream={streamStatus.hasActiveStream}
            streamDuration={streamStatus.streamDuration}
            streamStartTime={streamStatus.streamStartTime}
            streamerDisplayName={streamStatus.streamerDisplayName}
            isRandomRotation={streamStatus.isRandomRotation}
            randomRotationPlatform={streamStatus.randomRotationPlatform}
            randomRotationStreamerUrl={streamStatus.randomRotationStreamerUrl}
            randomRotationStreamerUsername={streamStatus.randomRotationStreamerUsername}
            randomRotationGame={streamStatus.randomRotationGame}
            randomRotationViewers={streamStatus.randomRotationViewers}
            randomRotationStartedAt={streamStatus.randomRotationStartedAt}
            nextRotationAt={streamStatus.nextRotationAt}
            currentRotationDuration={streamStatus.currentRotationDuration}
            isRotationLocked={streamStatus.isRotationLocked}
            lockedRemainingMs={streamStatus.lockedRemainingMs}
            isAuthenticated={isAuthenticated}
            currentUser={currentUser}
            userPoints={userPoints}
            isAdmin={isAdmin}
            isModerator={isModerator}
            isTheatreMode={theatreMode}
            showInventory={showInventory}
            theatreDropdownOpen={theatreDropdownOpen}
            socket={socket}
            onLogin={() => setShowLogin(true)}
            onSignup={() => setShowSignup(true)}
            onLogout={handleLogout}
            onProfileSettings={() => setShowProfileSettings(true)}
            onAdminPanel={() => setShowAdminPanel(!showAdminPanel)}
            onInventoryToggle={() => setShowInventory(!showInventory)}
            onTheatreDropdownToggle={() => setTheatreDropdownOpen(!theatreDropdownOpen)}
            onShowAbout={() => {
              setTutorialDefaultTab('about');
              setShowTutorial(true);
            }}
            onShowTerms={() => {
              setTutorialDefaultTab('terms');
              setShowTutorial(true);
            }}
            onShowPrivacy={() => {
              setTutorialDefaultTab('privacy');
              setShowTutorial(true);
            }}
            onShowTutorial={() => {
              setTutorialDefaultTab('tutorial');
              setShowTutorial(true);
            }}
            onShowBugReport={() => setShowBugReportModal(true)}
            onUserProfileUpdate={(profile) => {
            const prevPoints = userPoints;
            setUserPoints(profile.points);
            
            // Trigger floating points animation if points increased
            if (profile.points > prevPoints) {
              let pointsGained: number;
              let source: string = 'general';
              
              // Use server-provided values or calculate based on known multipliers
              if (profile.pointsEarned) {
                pointsGained = profile.pointsEarned;
                source = profile.updateType || 'general';
              } else {
                // Calculate difference and determine likely source
                const totalDiff = profile.points - prevPoints;
                
                // Map server pointSource/updateType to animation sources
                if (profile.updateType === 'chat' || (profile as any).pointSource === 'chatting') {
                  source = 'chatting';
                  // Chat messages give 2 points each, show exact amount or reasonable estimate
                  pointsGained = totalDiff <= 10 ? totalDiff : 2; // Cap at reasonable chat points
                } else if ((profile as any).pointSource === 'streaming' || (profile as any).sessionType === 'streaming') {
                  source = 'streaming';
                  pointsGained = totalDiff;
                } else if ((profile as any).pointSource === 'viewing' || (profile as any).sessionType === 'viewing') {
                  source = 'viewing';
                  pointsGained = totalDiff;
                  // console.log('🎯 Viewing session detected! SessionTime:', (profile as any).currentSessionTime, 'seconds');
                } else {
                  source = 'general';
                  pointsGained = totalDiff;
                }
              }
              
              // console.log('🎯 Points increased!', prevPoints, '->', profile.points, '(+' + pointsGained + ')', 'Source:', source, 'UpdateType:', profile.updateType, 'PointSource:', (profile as any).pointSource, 'SessionType:', (profile as any).sessionType, 'SessionTime:', (profile as any).currentSessionTime);
              
              if (window.showFloatingPoints) {
                // console.log('🎯 Triggering floating points animation for', source);
                window.showFloatingPoints(pointsGained, source);
              } else {
                // console.log('❌ window.showFloatingPoints not available');
              }
            }
          }}
          soundVolume={soundEffectsVolume}
          onSoundVolumeChange={handleSoundVolumeChange}
          />
        </>
      ) : null}

      <main
        className={`App-main ${isMobile && isLandscape ? 'landscape-video-only' : ''}`}
        style={isMobile && isLandscape ? {
          position: 'fixed',
          top: 0,
          left: 0,
          right: 280,
          bottom: 0,
          overflow: 'hidden',
          margin: 0,
          padding: 0,
          background: '#000'
        } : undefined}
      >
        {/* Hide error/disconnection banners in mobile landscape */}
        {!(isMobile && isLandscape) && error && !isForceDisconnected && (
          <div className="error-message">
            {error}
          </div>
        )}

        {!(isMobile && isLandscape) && isForceDisconnected && disconnectionReason && (
          <div className="disconnection-banner">
            <div className="disconnection-content">
              <div className="disconnection-icon">
                {disconnectionReason.includes('Kill Switch') ? '💥' : '⚠️'}
              </div>
              <div className="disconnection-text">
                <div className="disconnection-title">Stream Disconnected</div>
                <div className="disconnection-reason">{disconnectionReason}</div>
              </div>
              <div className="disconnection-status">
                <span className="viewer-mode-badge">Viewer Mode</span>
              </div>
            </div>
          </div>
        )}

        <div
          className={`main-content ${theatreMode ? 'theatre-mode-active' : ''} ${theatreMode && showInventory ? 'inventory-open' : ''} ${theatreMode && theatreChatCollapsed ? 'chat-collapsed' : ''}`}
          style={isMobile && isLandscape ? {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            overflow: 'hidden',
            margin: 0,
            padding: 0
          } : undefined}
        >
          {/* Admin Controls - Hide in mobile landscape */}
          {!(isMobile && isLandscape) && (!theatreMode || (theatreMode && isAdmin)) && (
            <>
              <div className={theatreMode ? `theatre-admin-controls ${theatreControlsVisible ? 'visible' : ''}` : ''}>
                <BotsPanel />
                <ModerationPanel streamStatus={streamStatus} />
              </div>
            </>
          )}

          <div
            className="stream-layout-container"
            style={isMobile && isLandscape ? {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: 'hidden',
              margin: 0,
              padding: 0
            } : undefined}
          >
            {!theatreMode && !(isMobile && isLandscape) && (
              <div className="status-effects-sidebar-left">
                <BuffDisplay
                showStreamerBuffs={true}
                className="streamer-buffs-sidebar-left"
                isCurrentUserStreaming={isStreaming}
                currentUserId={currentUser?.id?.toString()}
                initialBuffs={streamerBuffs}
                />
              </div>
            )}
            <div
              className="stream-viewer-container"
              style={isMobile && isLandscape ? {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                overflow: 'hidden',
                margin: 0,
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              } : undefined}
            >
              <StreamViewer
                socket={socket}
                isStreaming={isStreaming}
                hasActiveStream={streamStatus.hasActiveStream}
                streamType={streamStatus.streamType}
                currentStreamerId={streamStatus.streamerId}
                forceViewerMode={forceViewerAfterTakeover}
                landscapeMode={isMobile && isLandscape}
                audioSettings={streamerSettings.audio}
                onAudioSettingsChange={updateAudioSettings}
                videoSettings={streamerSettings.video}
                onVideoSettingsChange={updateVideoSettings}
                screenShareSettings={streamerSettings.screenShare}
                isScreenSharing={isScreenSharing}
                onScreenShareChange={setIsScreenSharing}
                onScreenShareMethodsReady={(methods) => {
                  screenShareMethodsRef.current = methods;
                }}
              />

              {/* Game Mode Overlay - Renders on top when game is active */}
              {isGameActive && currentUser && (
                <GameOverlay
                  isActive={isGameActive}
                  userId={currentUser.id}
                  socket={socket}
                />
              )}

              {/* Theatre Mode Controls - Only show in theatre mode */}
              {theatreMode && (
                <TheatreControls
                  isStreaming={isStreaming}
                  hasActiveStream={streamStatus.hasActiveStream}
                  cooldownRemaining={cooldownRemaining}
                  isConnected={connected && !!socket}
                  streamerSettings={streamerSettings}
                  currentUserId={currentUser?.id?.toString()}
                  streamerBuffs={streamerBuffs}
                  onVisibilityChange={(visible) => setTheatreControlsVisible(visible)}
                  onSettingsChange={updateStreamerSettings}
                  isScreenSharing={isScreenSharing}
                  onStartScreenShare={() => screenShareMethodsRef.current?.startScreenShare()}
                  onStopScreenShare={() => screenShareMethodsRef.current?.stopScreenShare()}
                  onExitTheatre={() => setTheatreMode(false)}
                  onTakeOver={() => {
                    if (!socket) {
                      console.warn('Cannot take over stream: Socket not connected');
                      return;
                    }
                    // Permission confirmation is now handled by TheatreControls
                    // The component will only call this after permissions are verified
                    socket.emit('request-to-stream', {
                      streamType: 'webcam',
                      timestamp: Date.now(),
                      permissionsGranted: true, // TheatreControls ensures this is true
                      permissionStatus: {
                        camera: 'granted',
                        microphone: 'granted'
                      }
                    });
                  }}
                  onStopStream={() => {
                    if (!socket) {
                      console.warn('Cannot stop stream: Socket not connected');
                      return;
                    }
                    socket.emit('stop-streaming');
                    setIsStreaming(false);
                  }}
                />
              )}
            </div>
          </div>

          {/* Show stream controls only when NOT in theatre mode and NOT in mobile landscape */}
          {!theatreMode && !(isMobile && isLandscape) && (
            <div className="stream-controls-container">
              {/* Theatre mode button - only show on desktop */}
              {!isMobile && (
                <button 
                  className="theatre-mode-btn"
                  onClick={() => setTheatreMode(true)}
                  title="Theatre Mode"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                  </svg>
                  Theatre
                </button>
              )}
              <StreamerSettings
                settings={streamerSettings}
                onSettingsChange={(newSettings) => {
                  setStreamerSettings(newSettings);
                  // Settings are already saved to cookies by StreamerSettings component
                }}
                isStreaming={isStreaming}
                compact={true}
                isScreenSharing={isScreenSharing}
                onStartScreenShare={() => screenShareMethodsRef.current?.startScreenShare()}
                onStopScreenShare={() => screenShareMethodsRef.current?.stopScreenShare()}
              />
              <StreamControls 
                isStreaming={isStreaming}
                hasActiveStream={streamStatus.hasActiveStream}
                cooldownRemaining={cooldownRemaining}
                isConnected={connected && !!socket}
                isForceDisconnected={isForceDisconnected}
                disconnectionReason={disconnectionReason}
                isMobile={isMobile}
                onShowTutorial={() => setShowTutorial(true)}
                onShowBugReport={() => setShowBugReportModal(true)}
                onTakeOver={() => {
                  if (!socket) {
                    console.warn('Cannot take over stream: Socket not connected');
                    return;
                  }
                  // StreamControls should also handle permission checking
                  socket.emit('request-to-stream', {
                    streamType: 'webcam',
                    timestamp: Date.now(),
                    permissionsGranted: true, // StreamControls should verify this
                    permissionStatus: {
                      camera: 'granted',
                      microphone: 'granted'
                    }
                  });
                }}
                onStopStream={() => {
                  if (!socket) {
                    console.warn('Cannot stop stream: Socket not connected');
                    return;
                  }
                  socket.emit('stop-streaming');
                  setIsStreaming(false);
                }}
              />
            </div>
          )}
        </div>

        {/* Chat and Status Effects Container - Different layout for theatre mode */}
        {!isMobile && !theatreMode && (
          <div className="chat-and-status-container">
            <div className="chat-sidebar">
              <Chat />
            </div>
            <div className="status-effects-sidebar-right">
              <BuffDisplay 
                showPersonalBuffs={true}
                className="personal-buffs-right-sidebar"
                isCurrentUserStreaming={isStreaming}
                currentUserId={currentUser?.id?.toString()}
              />
            </div>
          </div>
        )}
        
        {/* Theatre Mode Chat and Inventory - Right side panels */}
        {!isMobile && theatreMode && (
          <>
            <div className={`theatre-mode-sidebar ${showInventory ? 'inventory-open' : ''} ${theatreChatCollapsed ? 'collapsed' : ''}`}>
              {/* Inventory Panel - Shows when open */}
              {showInventory && (
                <div className="theatre-mode-inventory">
                  <InventoryPanel 
                    socket={socket}
                    isAuthenticated={isAuthenticated}
                    userProfile={{ points: userPoints }}
                    isOpen={true}
                    onToggle={() => setShowInventory(!showInventory)}
                    onToggleShop={() => {
                      setShowInventory(false);
                      setIsShopOpen(true);
                    }}
                    onLogin={() => setShowLogin(true)}
                    onSignup={() => setShowSignup(true)}
                    hideToggleButton={true}
                  />
                </div>
              )}
              {/* Chat Panel */}
              <div className="theatre-mode-chat">
                <div className="theatre-chat-content">
                  <Chat />
                </div>
              </div>
            </div>
            <button 
              className={`theatre-chat-toggle ${theatreChatCollapsed ? 'collapsed' : ''} ${showInventory ? 'inventory-open' : ''}`}
              onClick={() => setTheatreChatCollapsed(!theatreChatCollapsed)}
              title={theatreChatCollapsed ? "Show Chat" : "Hide Chat"}
            >
              {theatreChatCollapsed ? '◀' : '▶'}
            </button>
          </>
        )}

        <FloatingPointsManager>
          <div />
        </FloatingPointsManager>
        <NotificationManager />
        <SoundFxPlayer socket={socket} volume={soundEffectsVolume} />
        <SafariTTSNotice />
      </main>

      {showLogin && (
        <Login 
          onSuccess={() => {
            handleLogin();
            setShowLogin(false);
          }}
          onSwitchToSignup={() => {
            setShowLogin(false);
            setShowSignup(true);
          }}
          onClose={() => setShowLogin(false)}
        />
      )}

      {showSignup && (
        <Signup 
          onSuccess={() => {
            setShowSignup(false);
            setShowLogin(true);
          }}
          onSwitchToLogin={() => {
            setShowSignup(false);
            setShowLogin(true);
          }}
          onClose={() => setShowSignup(false)}
        />
      )}

      {showEmailVerification && (
        <EmailVerification
          onClose={() => setShowEmailVerification(false)}
          onSuccess={() => {
            setShowEmailVerification(false);
            handleLogin(); // Refresh user data after verification
          }}
        />
      )}

      {showPasswordReset && (
        <PasswordReset
          onClose={() => setShowPasswordReset(false)}
          onSuccess={() => {
            setShowPasswordReset(false);
            // Password reset successful, user can now login
          }}
        />
      )}

      {showDeletionConfirmation && (
        <DeletionConfirmation
          onClose={() => setShowDeletionConfirmation(false)}
        />
      )}

      {showAccountRestoration && pendingDeletionUser && (
        <AccountRestoration
          userEmail={pendingDeletionUser.email}
          onRestore={() => {
            // Account restored, continue with normal login
            setShowAccountRestoration(false);
            setPendingDeletionUser(null);
            setIsAuthenticated(true);
            setCurrentUser(authService.getUser());
            fetchUserPoints();
            const token = authService.getToken();
            SocketManager.updateAuth(token);
          }}
          onCancel={() => {
            setShowAccountRestoration(false);
            setPendingDeletionUser(null);
            authService.logout();
          }}
        />
      )}

      {showProfileSettings && (
        <ProfileSettings
          isOpen={showProfileSettings}
          onClose={() => setShowProfileSettings(false)}
          onProfileUpdate={() => {
            // Refresh user data if needed
            refreshCurrentUser();
          }}
        />
      )}

      <Tutorial
        isOpen={showTutorial}
        onClose={() => {
          setShowTutorial(false);
          setTutorialDefaultTab(undefined);
        }}
        defaultTab={tutorialDefaultTab}
      />


      {/* Only show standalone inventory panel when NOT in theatre mode */}
      {!theatreMode && (
        <InventoryPanel 
          socket={socket}
          isAuthenticated={isAuthenticated}
          userProfile={{ points: userPoints }}
          isOpen={showInventory}
          onToggle={() => setShowInventory(!showInventory)}
          onToggleShop={() => {
            setShowInventory(false);
            setIsShopOpen(true);
          }}
          onLogin={() => setShowLogin(true)}
          onSignup={() => setShowSignup(true)}
          hideToggleButton={false}
        />
      )}

      {isShopOpen && (
        <ModalShopPanel
          socket={socket}
          isAuthenticated={isAuthenticated}
          userProfile={{ points: userPoints }}
          isOpen={isShopOpen}
          onClose={handleCloseShop}
        />
      )}

      <AdminPanelV3 
        isVisible={showAdminPanel}
        onClose={() => setShowAdminPanel(false)}
        initialTab={adminPanelTab}
      />
      
      {/* Bug Report Modal */}
      <BugReportModal
        isOpen={showBugReportModal}
        onClose={() => setShowBugReportModal(false)}
        socket={socket}
        isAuthenticated={isAuthenticated}
        currentUser={currentUser}
      />

      {/* Mobile Landscape Streamer Settings Modal */}
      {showMobileStreamerSettings && (
        <div className="mobile-settings-modal-overlay" onClick={() => setShowMobileStreamerSettings(false)}>
          <div className="mobile-settings-modal" onClick={e => e.stopPropagation()}>
            <div className="mobile-settings-header">
              <h3>Stream Settings</h3>
              <button className="close-btn" onClick={() => setShowMobileStreamerSettings(false)}>×</button>
            </div>
            <div className="mobile-settings-content">
              <StreamerSettings
                settings={streamerSettings}
                onSettingsChange={(newSettings) => {
                  setStreamerSettings(newSettings);
                }}
                isStreaming={isStreaming}
                compact={false}
                isScreenSharing={isScreenSharing}
                onStartScreenShare={() => screenShareMethodsRef.current?.startScreenShare()}
                onStopScreenShare={() => screenShareMethodsRef.current?.stopScreenShare()}
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile Chat Panel - Different behavior for landscape */}
      {isMobile && !isLandscape && (
        <MobileChat 
          isOpen={showMobileChat} 
          onClose={() => setShowMobileChat(false)} 
        />
      )}
      
      {/* Landscape Mode - Full Layout with chat/shop/inventory */}
      {isMobile && isLandscape && (
        <MobileLandscapeLayout
          viewerCount={streamStatus.viewerCount}
          hasActiveStream={streamStatus.hasActiveStream}
          streamDuration={streamStatus.streamDuration}
          streamStartTime={streamStatus.streamStartTime}
          streamerDisplayName={streamStatus.streamerDisplayName}
          isRandomRotation={streamStatus.isRandomRotation}
          randomRotationPlatform={streamStatus.randomRotationPlatform}
          randomRotationStreamerUrl={streamStatus.randomRotationStreamerUrl}
          randomRotationStreamerUsername={streamStatus.randomRotationStreamerUsername}
          nextRotationAt={streamStatus.nextRotationAt}
          currentRotationDuration={streamStatus.currentRotationDuration}
          isRotationLocked={streamStatus.isRotationLocked}
          lockedRemainingMs={streamStatus.lockedRemainingMs}
          isStreaming={isStreaming}
          cooldownRemaining={cooldownRemaining}
          isConnected={connected && !!socket}
          isAuthenticated={isAuthenticated}
          currentUser={currentUser}
          userPoints={userPoints}
          showChat={showLandscapeChat}
          showInventory={showInventory}
          showShop={isShopOpen}
          onChatToggle={() => setShowLandscapeChat(!showLandscapeChat)}
          onInventoryToggle={() => {
            setShowInventory(!showInventory);
            setShowLandscapeChat(false);
            setIsShopOpen(false);
          }}
          onShopToggle={() => {
            setIsShopOpen(!isShopOpen);
            setShowInventory(false);
            setShowLandscapeChat(false);
          }}
          onLogin={() => setShowLogin(true)}
          onLogout={handleLogout}
          onProfileSettings={() => setShowProfileSettings(true)}
          onShowTutorial={() => {
            setTutorialDefaultTab('tutorial');
            setShowTutorial(true);
          }}
          onShowBugReport={() => setShowBugReportModal(true)}
          onShowAbout={() => {
            setTutorialDefaultTab('about');
            setShowTutorial(true);
          }}
          onShowTerms={() => {
            setTutorialDefaultTab('terms');
            setShowTutorial(true);
          }}
          onShowPrivacy={() => {
            setTutorialDefaultTab('privacy');
            setShowTutorial(true);
          }}
          onTakeOver={() => {
            if (!socket) {
              console.warn('Cannot take over stream: Socket not connected');
              return;
            }
            socket.emit('request-to-stream', {
              streamType: 'webcam',
              timestamp: Date.now(),
              permissionsGranted: true,
              permissionStatus: {
                camera: 'granted',
                microphone: 'granted'
              }
            });
          }}
          onStopStream={() => {
            if (!socket) {
              console.warn('Cannot stop stream: Socket not connected');
              return;
            }
            socket.emit('stop-streaming');
            setIsStreaming(false);
          }}
          onOpenStreamerSettings={() => setShowMobileStreamerSettings(true)}
        />
      )}

      {/* Mobile Bottom Navigation - Hide in landscape */}
      {isMobile && !isLandscape && (
        <MobileBottomNav
          isAuthenticated={isAuthenticated}
          userPoints={userPoints}
          showInventory={showInventory}
          showChat={showMobileChat}
          showShop={isShopOpen}
          onInventoryToggle={() => {
            setShowInventory(!showInventory);
            setShowMobileChat(false);
            setIsShopOpen(false);
          }}
          onChatToggle={() => {
            setShowMobileChat(!showMobileChat);
            setShowInventory(false);
            setIsShopOpen(false);
          }}
          onShopToggle={() => {
            setIsShopOpen(!isShopOpen);
            setShowInventory(false);
            setShowMobileChat(false);
          }}
          onStreamToggle={
            isStreaming 
              ? () => {
                  if (!socket) {
                    console.warn('Cannot stop stream: Socket not connected');
                    return;
                  }
                  // console.log('Emitting stop-streaming event');
                  socket.emit('stop-streaming');
                  setIsStreaming(false);
                }
              : undefined // Start stream is more complex, would need to be implemented
          }
          isStreaming={isStreaming}
          hasActiveStream={streamStatus.hasActiveStream}
          onLogin={() => setShowLogin(true)}
          onSignup={() => setShowSignup(true)}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <SocketProvider>
      <AppContent />
    </SocketProvider>
  );
}

export default App;