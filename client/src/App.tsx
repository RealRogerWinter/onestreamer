import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SocketProvider, useMainSocket } from './contexts/SocketContext';
import './App.css';
import StreamViewer from './components/StreamViewer';
import StreamControls from './components/StreamControls';
import StreamerSettings, { AudioSettingsConfig, VideoSettingsConfig, StreamerSettingsConfig } from './components/StreamerSettings';
import TheatreControls from './components/TheatreControls';
import AdminPanelV3 from './components/AdminPanelV3';
import Chat from './components/Chat';
import MobileChat from './components/MobileChat';
import Login from './components/Login';
import Signup from './components/Signup';
import ProfileSettings from './components/ProfileSettings';
import Tutorial from './components/Tutorial';
import InventoryPanel from './components/inventory/InventoryPanel';
import ModalShopPanel from './components/shop/ModalShopPanel';
import BuffDisplay from './components/BuffDisplay';
import NotificationManager from './components/notifications/NotificationManager';
import SoundFxPlayer from './components/soundfx/SoundFxPlayer';
import SafariTTSNotice from './components/soundfx/SafariTTSNotice';
import { FloatingPointsManager } from './components/FloatingPoints';
import MobileBottomNav from './components/MobileBottomNav';
import MobileHeader from './components/MobileHeader';
import MobileLandscapeLayout from './components/MobileLandscapeLayout';
import DesktopHeaderV2 from './components/DesktopHeaderV2';
import OAuthCallback from './components/OAuthCallback';
import OAuthUsernameSelection from './components/OAuthUsernameSelection';
import BugReportModal from './components/BugReportModal';
import EmailVerification from './components/EmailVerification';
import PasswordReset from './components/PasswordReset';
import DeletionConfirmation from './components/DeletionConfirmation';
import AccountRestoration from './components/AccountRestoration';
import ModerationPanel from './components/ModerationPanel';
import BotsPanel from './components/BotsPanel';
import { ClipsGallery, ClipPlayer } from './components/clips';
import authService from './services/AuthService';
import SocketManager from './services/SocketManager';
import CookieService, { COOKIE_NAMES } from './services/CookieService';
import CookieConsentService from './services/CookieConsentService';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import './styles/cookieconsent.css';

// Declare global showFloatingPoints function
declare global {
  interface Window {
    showFloatingPoints?: (amount: number, source?: string) => void;
  }
}

interface StreamStatus {
  hasActiveStream: boolean;
  streamerId: string | null;
  streamType: string | null;
  viewerCount: number;
  streamStartTime: number | null;
  streamDuration: number;
  streamerDisplayName?: string | null;
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
  const [showEmailVerification, setShowEmailVerification] = useState(isEmailVerification);
  
  // Check if we're on the password reset page
  const isPasswordReset = /^\/reset-password\/[a-fA-F0-9]+$/i.test(currentPath);
  const [showPasswordReset, setShowPasswordReset] = useState(isPasswordReset);
  
  // Check if we're on the deletion confirmation page
  const isDeletionConfirmation = /^\/confirm-deletion\/[a-fA-F0-9]+$/i.test(currentPath);
  const [showDeletionConfirmation, setShowDeletionConfirmation] = useState(isDeletionConfirmation);
  
  // State for showing account restoration modal
  const [showAccountRestoration, setShowAccountRestoration] = useState(false);
  const [pendingDeletionUser, setPendingDeletionUser] = useState<any>(null);
  
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
  
  // Handle initial authentication on app load
  useEffect(() => {
    const initializeAuthentication = async () => {
      const token = authService.getToken();
      if (token) {
        try {
          // Fetch fresh profile data to ensure we have the latest user info
          const profile = await authService.getProfile();
          if (profile) {
            // Check if account is pending deletion
            if (profile.user.accountStatus === 'pending_deletion' || (profile.user as any).account_status === 'pending_deletion') {
              setPendingDeletionUser(profile.user);
              setShowAccountRestoration(true);
              setIsAuthenticated(false);
              authService.logout(); // Clear invalid session
              return;
            }
            
            // Update local state with fresh data
            setCurrentUser(profile.user);
            setUserPoints(profile.stats?.points || 0);
            setIsAuthenticated(true);
            
            // Update socket authentication
            SocketManager.updateAuth(token);
            
            console.log('✅ App: Restored authenticated session for user:', profile.user.username, 'Points:', profile.stats?.points || 0);
          } else {
            // If profile fetch fails, clear invalid session
            console.log('❌ App: Failed to restore session, clearing invalid authentication');
            authService.logout();
            setIsAuthenticated(false);
            setCurrentUser(null);
            setUserPoints(0);
          }
        } catch (error) {
          console.error('❌ App: Error restoring authentication:', error);
          // Clear invalid session on error
          authService.logout();
          setIsAuthenticated(false);
          setCurrentUser(null);
          setUserPoints(0);
        }
      }
    };
    
    initializeAuthentication();
  }, []); // Only run once on mount

  const { socket, connected, error: socketError } = useMainSocket();
  const socketRef = useRef(socket);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>({
    hasActiveStream: false,
    streamerId: null,
    streamType: null,
    viewerCount: 0,
    streamStartTime: null,
    streamDuration: 0
  });
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminPanelTab, setAdminPanelTab] = useState<string>('dashboard');
  const [isShopOpen, setIsShopOpen] = useState(false);
  const streamSwitchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastStreamSwitchRef = useRef<number>(0);
  const [wasStreamingBeforeTakeover, setWasStreamingBeforeTakeover] = useState(false);
  // Track the expected new streamer during takeover to prevent stale stream-status from overwriting
  const takeoverTargetRef = useRef<string | null>(null);
  const takeoverTimestampRef = useRef<number>(0);
  // CRITICAL: Force viewer mode after takeover - bypasses isStreaming race conditions
  const [forceViewerAfterTakeover, setForceViewerAfterTakeover] = useState(false);
  const [disconnectionReason, setDisconnectionReason] = useState<string | null>(null);
  const [isForceDisconnected, setIsForceDisconnected] = useState(false);
  const [showTakeoverOverlay, setShowTakeoverOverlay] = useState(false);
  const [takeoverMessage, setTakeoverMessage] = useState<string>('');
  const [showTransitionOverlay, setShowTransitionOverlay] = useState(false);
  const [transitionMessage, setTransitionMessage] = useState<string>('');

  // Auth state
  const [isAuthenticated, setIsAuthenticated] = useState(authService.isAuthenticated());
  const [currentUser, setCurrentUser] = useState(authService.getUser());
  const [showLogin, setShowLogin] = useState(false);
  const [showSignup, setShowSignup] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isModerator, setIsModerator] = useState(false);

  // Inventory state
  const [showInventory, setShowInventory] = useState(false);
  
  // Profile Settings state
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  
  // Mobile-specific states
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [showLandscapeChat, setShowLandscapeChat] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [showHamburgerMenu, setShowHamburgerMenu] = useState(false);
  
  // Reliable mobile detection and orientation
  useEffect(() => {
    const checkMobileAndOrientation = () => {
      const mobileCheck = window.innerWidth <= 768 || 
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(mobileCheck);
      
      // Check if in landscape mode
      const landscapeCheck = window.innerWidth > window.innerHeight && mobileCheck;
      setIsLandscape(landscapeCheck);
    };
    
    checkMobileAndOrientation();
    window.addEventListener('resize', checkMobileAndOrientation);
    window.addEventListener('orientationchange', checkMobileAndOrientation);
    return () => {
      window.removeEventListener('resize', checkMobileAndOrientation);
      window.removeEventListener('orientationchange', checkMobileAndOrientation);
    };
  }, []);

  // Tutorial state
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialDefaultTab, setTutorialDefaultTab] = useState<'about' | 'support' | 'tutorial' | 'terms' | 'privacy' | undefined>(undefined);

  // Points state
  const [userPoints, setUserPoints] = useState(0);

  // Canvas effects
  const [streamerBuffs, setStreamerBuffs] = useState<any[]>([]);
  
  // Bug Report state
  const [showBugReportModal, setShowBugReportModal] = useState(false);
  
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
  
  // Modal states for About, Terms, Privacy
  const [showAbout, setShowAbout] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  // Settings state - Initialize from cookies or use defaults
  const [audioSettings, setAudioSettings] = useState<AudioSettingsConfig>(() => {
    const savedAudioSettings = CookieService.getCookie(COOKIE_NAMES.AUDIO_SETTINGS);
    return savedAudioSettings || {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000,
      channelCount: 2,
      profile: 'raw'
    };
  });

  const [videoSettings, setVideoSettings] = useState<VideoSettingsConfig>(() => {
    const savedVideoSettings = CookieService.getCookie(COOKIE_NAMES.VIDEO_SETTINGS);
    return savedVideoSettings || {
      resolution: '720p',
      frameRate: 30,
      facingMode: 'user',
      bitrate: 2000,
      videoEnabled: true,
      mirror: false
    };
  });

  const [streamerSettings, setStreamerSettings] = useState<StreamerSettingsConfig>(() => {
    const savedSettings = CookieService.getCookie(COOKIE_NAMES.STREAMER_SETTINGS);
    const defaultScreenShare = {
      cursor: 'always' as const,
      audio: false,
      displaySurface: 'monitor' as const
    };
    return savedSettings ? {
      ...savedSettings,
      screenShare: savedSettings.screenShare || defaultScreenShare
    } : {
      audio: audioSettings,
      video: videoSettings,
      screenShare: defaultScreenShare
    };
  });

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

  const cooldownTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Handle socket disconnection for active streamer
  useEffect(() => {
    if (!connected && isStreaming) {
      // console.log('🔌 CLIENT: Socket disconnected while streaming');
      setIsStreaming(false);
      setIsForceDisconnected(true);
      
      // Show takeover overlay for connection loss
      setShowTakeoverOverlay(true);
      setTakeoverMessage('⚠️ Connection Lost!');
      
      // Hide overlay and show persistent message
      setTimeout(() => {
        setShowTakeoverOverlay(false);
        setDisconnectionReason('Connection lost - Server unavailable');
      }, 3000);
      
      // Clear disconnection state after 15 seconds
      setTimeout(() => {
        setDisconnectionReason(null);
        setIsForceDisconnected(false);
      }, 15000);
    }
    
    // Reset force disconnect state when reconnected and request current stream status
    if (connected && isForceDisconnected && socket) {
      console.log('🔌 CLIENT: Reconnected after force disconnect - requesting stream status');
      setIsForceDisconnected(false);
      setDisconnectionReason(null);

      // CRITICAL: Re-emit join-as-viewer to get current stream status
      // This ensures we know about any active streams after reconnecting
      socket.emit('join-as-viewer');
    }
  }, [connected, isStreaming, isForceDisconnected, socket]);

  // Setup socket event listeners
  useEffect(() => {
    if (!socket) return;

    socket.emit('join-as-viewer');

    // Handle socket reconnection - always re-request stream status
    const handleConnect = () => {
      console.log('🔌 CLIENT: Socket (re)connected - requesting stream status');
      socket.emit('join-as-viewer');
    };
    socket.on('connect', handleConnect);

    socket.on('stream-status', (status: StreamStatus) => {
      // CRITICAL: During takeover transition, don't let stale stream-status overwrite the correct streamer
      const takeoverAge = Date.now() - takeoverTimestampRef.current;
      const isInTakeoverTransition = takeoverTargetRef.current && takeoverAge < 10000; // 10 second window

      if (isInTakeoverTransition && status.streamerId !== takeoverTargetRef.current) {
        console.log(`⚠️ CLIENT: Ignoring stale stream-status (got ${status.streamerId}, expected ${takeoverTargetRef.current})`);
        // Update other fields but preserve the correct streamerId
        setStreamStatus(prev => ({
          ...status,
          streamerId: takeoverTargetRef.current,
          hasActiveStream: true
        }));
      } else {
        // Normal update - also clear takeover lock if streamerId matches
        if (status.streamerId === takeoverTargetRef.current) {
          console.log(`✅ CLIENT: stream-status confirmed takeover target ${status.streamerId}, clearing lock`);
          takeoverTargetRef.current = null;
        }
        setStreamStatus(status);
      }

      if (status.hasActiveStream && isStreaming && socket.id !== status.streamerId) {
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(false);
      }
    });

    socket.on('stream-started', (data: any) => {

      // Clear any pending stream switch timeout
      if (streamSwitchTimeoutRef.current) {
        clearTimeout(streamSwitchTimeoutRef.current);
        streamSwitchTimeoutRef.current = null;
      }

      // Clear takeover lock if new streamer matches expected target
      if (data.streamerId === takeoverTargetRef.current) {
        console.log(`✅ CLIENT: stream-started confirmed takeover target ${data.streamerId}, clearing lock`);
        takeoverTargetRef.current = null;
      }

      setStreamStatus(prev => ({
        ...prev,
        hasActiveStream: true,
        streamerId: data.streamerId,
        streamType: data.streamType || 'unknown',
        streamStartTime: data.streamStartTime || Date.now(),
        streamDuration: 0,
        streamerDisplayName: data.streamerDisplayName || null
      }));

      if (data.streamerId !== socket.id && isStreaming) {
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(true);
        
        // Show takeover overlay
        setShowTakeoverOverlay(true);
        setTakeoverMessage(`${data.streamerDisplayName || 'Another user'} has taken over your stream!`);
        
        // Hide overlay after 3 seconds
        setTimeout(() => {
          setShowTakeoverOverlay(false);
        }, 3000);
      } else {
        setWasStreamingBeforeTakeover(false);
      }
    });

    socket.on('stream-ended', (data?: { reason?: string; previousStreamer?: string; newStreamer?: string; newStreamerDisplayName?: string }) => {
      // CRITICAL: Handle takeover differently - there IS an active stream (the new one)
      if (data?.reason === 'takeover' && data.newStreamer) {
        console.log(`🛑 CLIENT: Stream ended due to takeover by ${data.newStreamer} (${data.newStreamerDisplayName}) - updating to new streamer`);

        // CRITICAL: Lock in the takeover target to prevent stale stream-status from overwriting
        takeoverTargetRef.current = data.newStreamer;
        takeoverTimestampRef.current = Date.now();
        console.log(`🔒 CLIENT: Locked takeover target: ${data.newStreamer}`);

        setStreamStatus(prev => ({
          ...prev,
          hasActiveStream: true,
          streamerId: data.newStreamer!,
          streamerDisplayName: data.newStreamerDisplayName || null,
          streamStartTime: Date.now(),
          streamDuration: 0
        }));
        setWasStreamingBeforeTakeover(false);
        return;
      }

      // Normal stream end - clear everything
      setStreamStatus({
        hasActiveStream: false,
        streamerId: null,
        streamType: null,
        viewerCount: 0,
        streamStartTime: null,
        streamDuration: 0,
        streamerDisplayName: null
      });

      const minSwitchInterval = 3000;
      const now = Date.now();
      const timeSinceLastSwitch = now - lastStreamSwitchRef.current;

      if (wasStreamingBeforeTakeover && timeSinceLastSwitch > minSwitchInterval) {
        lastStreamSwitchRef.current = now;

        if (streamSwitchTimeoutRef.current) {
          clearTimeout(streamSwitchTimeoutRef.current);
        }

        streamSwitchTimeoutRef.current = setTimeout(() => {
          setWasStreamingBeforeTakeover(false);
          setIsStreaming(true);
        }, 2000);
      }
    });

    socket.on('viewer-count-update', (count: number) => {
      setStreamStatus(prev => ({ ...prev, viewerCount: count }));
    });

    socket.on('global-cooldown', (data: { cooldownRemaining: number }) => {
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
    });

    socket.on('cooldown-status-update', (data: { globalCooldown: any, timestamp: number }) => {
      // console.log('🛡️ CLIENT: Cooldown status update from item:', data);
      if (data.globalCooldown) {
        const remaining = data.globalCooldown.remainingSeconds || data.globalCooldown.remaining || 0;
        // console.log('🛡️ CLIENT: Setting cooldown to', remaining, 'seconds');
        setCooldownRemaining(Math.ceil(remaining));
        startCooldownTimer(Math.ceil(remaining));
      }
    });

    socket.on('streaming-approved', () => {
      // console.log('✅ CLIENT: Streaming approved! Starting stream...');
      setIsStreaming(true);
      setError(null);
      
      // Show transition overlay for starting a new stream
      setShowTransitionOverlay(true);
      setTransitionMessage('Starting your stream...');
      
      // Hide overlay after 2 seconds
      setTimeout(() => {
        setShowTransitionOverlay(false);
      }, 2000);
      
      // Log the state change
      // console.log('✅ CLIENT: isStreaming set to true');
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

    socket.on('takeover-approved', () => {
      // console.log('✅ CLIENT: Takeover approved!');
      setIsStreaming(true);
      setError(null);
      
      // Show transition overlay for successful takeover
      setShowTransitionOverlay(true);
      setTransitionMessage('Taking over the stream...');
      
      // Hide overlay after 2.5 seconds
      setTimeout(() => {
        setShowTransitionOverlay(false);
      }, 2500);
    });

    socket.on('takeover-denied', (data: { reason: string, cooldownRemaining: number }) => {
      // console.log('🚫 CLIENT: Takeover denied:', data.reason);
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      setError(data.reason);
    });

    // Keep backward compatibility with old event name
    socket.on('takeover-blocked', (data: { message: string, cooldownRemaining: number }) => {
      // console.log('🚫 CLIENT: Takeover blocked (legacy):', data.message);
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      setError(data.message);
    });

    socket.on('admin-notification', (data: { message: string; type: string }) => {
      // console.log('📢 ADMIN:', data.message);
      setError(data.message);
      setTimeout(() => setError(null), 5000);
    });

    socket.on('streamer-buffs-update', (data: { buffs: any[] }) => {
      setStreamerBuffs(data.buffs || []);
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
        setUserPoints((prevPoints) => {
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

    // Handle force disconnect from killswitch or admin
    socket.on('force-disconnect', (data: { reason: string; activatedBy?: string; message: string }) => {
      console.log('💥 CLIENT: Force disconnect received:', data);

      // CRITICAL: If this is a stream_takeover, DON'T clear the stream status or show disconnect UI
      // The stream-takeover handler already set up the transition to viewer mode
      if (data.reason === 'stream_takeover') {
        console.log('💥 CLIENT: Force disconnect is from takeover - skipping (stream-takeover handler handles this)');
        // Just set the flag, don't mess with stream status or UI
        setIsForceDisconnected(true);
        setTimeout(() => {
          setIsForceDisconnected(false);
        }, 5000);
        return;
      }

      if (isStreaming) {
        setIsStreaming(false);
        setIsForceDisconnected(true);
        setDisconnectionReason(data.message || data.reason);

        // Clear our stream from status if we were the streamer (but not during takeover)
        if (streamStatus.streamerId === socket.id) {
          setStreamStatus(prev => ({
            ...prev,
            hasActiveStream: false,
            streamerId: null,
            streamType: null,
            streamerDisplayName: null
          }));
        }

        // Show takeover overlay for the disconnection with custom message
        setShowTakeoverOverlay(true);
        if (data.reason.includes('Kill Switch')) {
          setTakeoverMessage('💥 Kill Switch Activated!');
        } else {
          setTakeoverMessage(data.message || `Disconnected: ${data.reason}`);
        }

        // Hide overlay and show persistent message after animation
        setTimeout(() => {
          setShowTakeoverOverlay(false);
          // Show a more integrated disconnection message
          setDisconnectionReason(data.message || data.reason);
        }, 3000);

        // Clear disconnection state after 15 seconds
        setTimeout(() => {
          setDisconnectionReason(null);
          setIsForceDisconnected(false);
        }, 15000);
      }
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

    // Handle stream takeover event (sent to the current streamer being taken over)
    socket.on('stream-takeover', (data: { newStreamerId: string; newStreamerDisplayName?: string; cooldownRemaining: number }) => {
      console.log('🔄 CLIENT: Stream takeover event received:', data);
      if (isStreaming) {
        console.log('🔄 CLIENT: I was streaming, transitioning to viewer mode');

        // CRITICAL: Set these BEFORE changing isStreaming to prevent race conditions
        // Lock in the takeover target
        takeoverTargetRef.current = data.newStreamerId;
        takeoverTimestampRef.current = Date.now();

        // Update stream status to point to new streamer BEFORE we stop streaming
        setStreamStatus(prev => ({
          ...prev,
          hasActiveStream: true,
          streamerId: data.newStreamerId,
          streamerDisplayName: data.newStreamerDisplayName || null,
          streamStartTime: Date.now(),
          streamDuration: 0
        }));

        // Force viewer mode to bypass any isStreaming race conditions
        setForceViewerAfterTakeover(true);

        // Now set isStreaming to false
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(false); // Don't auto-restart after takeover

        setCooldownRemaining(data.cooldownRemaining);
        startCooldownTimer(data.cooldownRemaining);

        console.log('🔄 CLIENT: Transitioning to view new streamer:', data.newStreamerId);

        // Show takeover overlay
        setShowTakeoverOverlay(true);
        setTakeoverMessage('Your stream is being taken over!');

        // Hide overlay and clear force viewer mode after transition completes
        setTimeout(() => {
          setShowTakeoverOverlay(false);
          // Clear force viewer mode after successful transition
          setTimeout(() => {
            setForceViewerAfterTakeover(false);
            takeoverTargetRef.current = null;
            console.log('🔄 CLIENT: Takeover transition complete, cleared force viewer mode');
          }, 2000);
        }, 3000);
      }
    });

    return () => {
      socket.off('connect', handleConnect);
      socket.off('stream-status');
      socket.off('stream-started');
      socket.off('stream-ended');
      socket.off('viewer-count-update');
      socket.off('global-cooldown');
      socket.off('cooldown-status-update');
      socket.off('streaming-approved');
      socket.off('stream-denied');
      socket.off('takeover-approved');
      socket.off('takeover-denied');
      socket.off('takeover-blocked');
      socket.off('admin-notification');
      socket.off('streamer-buffs-update');
      socket.off('banned');
      socket.off('timeout');
      socket.off('time-stats-update');
      socket.off('points-updated');
      socket.off('force-disconnect');
      socket.off('kill-switch-activated');
      socket.off('stream-takeover');
    };
  }, [socket, isStreaming, wasStreamingBeforeTakeover, currentUser, streamStatus.streamerId, isForceDisconnected]);

  const startCooldownTimer = (seconds: number) => {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
    }

    let remaining = seconds;
    setCooldownRemaining(remaining);

    cooldownTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        setCooldownRemaining(0);
        if (cooldownTimerRef.current) {
          clearInterval(cooldownTimerRef.current);
          cooldownTimerRef.current = null;
        }
      } else {
        setCooldownRemaining(remaining);
      }
    }, 1000);
  };

  useEffect(() => {
    const checkAdmin = async () => {
      const adminStatus = await authService.isAdmin();
      const moderatorStatus = await authService.isModerator();
      setIsAdmin(adminStatus);
      setIsModerator(moderatorStatus);
    };
    
    if (isAuthenticated) {
      checkAdmin();
    }
  }, [isAuthenticated]);

  const fetchUserPoints = async () => {
    try {
      const response = await fetch(`${process.env.REACT_APP_SERVER_URL}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        const points = data.stats?.points || 0;
        // console.log('📊 Fetched user points from /me endpoint:', points);
        setUserPoints(points);
      }
    } catch (error) {
      console.error('Failed to fetch user points:', error);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchUserPoints();
    } else {
      setUserPoints(0);
    }
  }, [isAuthenticated]);

  const handleLogin = async () => {
    // First check if the user is pending deletion
    const user = authService.getUser();
    
    if (user && (user.accountStatus === 'pending_deletion' || (user as any).account_status === 'pending_deletion')) {
      // Show restoration modal instead of normal login flow
      setPendingDeletionUser(user);
      setShowAccountRestoration(true);
      // Don't set authenticated or fetch data yet
      return;
    }
    
    setIsAuthenticated(true);
    
    // Fetch fresh profile data to ensure we have the latest verification status
    try {
      const profile = await authService.getProfile();
      if (profile) {
        // Check again after fetching profile
        if (profile.user.accountStatus === 'pending_deletion' || (profile.user as any).account_status === 'pending_deletion') {
          setPendingDeletionUser(profile.user);
          setShowAccountRestoration(true);
          setIsAuthenticated(false);
          return;
        }
        setCurrentUser(profile.user);
      } else {
        setCurrentUser(authService.getUser());
      }
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      setCurrentUser(authService.getUser());
    }
    
    fetchUserPoints();
    
    // Update socket connections with new auth token
    const token = authService.getToken();
    SocketManager.updateAuth(token);
  };

  const handleLogout = async () => {
    // Call the AuthService logout method to properly clear tokens and make API call
    await authService.logout();
    
    // Update local state
    setIsAuthenticated(false);
    setCurrentUser(null);
    setUserPoints(0);
    
    // Clear socket authentication
    SocketManager.updateAuth(null);
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
  }, [showBugReportModal, showTutorial, showProfileSettings, showLogin, showSignup,
      isShopOpen, showInventory, showMobileChat, showLandscapeChat]);

  // Check if any dialog is currently open
  const hasOpenDialog = useCallback(() => {
    return showMobileChat || showLandscapeChat || showInventory || isShopOpen || showLogin || showSignup ||
           showTutorial || showBugReportModal || showProfileSettings;
  }, [showMobileChat, showLandscapeChat, showInventory, isShopOpen, showLogin, showSignup,
      showTutorial, showBugReportModal, showProfileSettings]);

  // Mobile back button/gesture handler
  useEffect(() => {
    if (!isMobile) return;

    const handlePopState = (event: PopStateEvent) => {
      // Ignore popstate events within 300ms of opening a dialog
      // This prevents race conditions when hamburger menu cleanup triggers back()
      if (Date.now() - dialogOpenTimeRef.current < 300) {
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
      
      {/* Help Button - Bottom Left, above Bug Report */}
      <button 
        className="help-button-bottom"
        onClick={() => setShowTutorial(true)}
        title="Tutorial & Help"
      >
        ?
      </button>
      
      {/* Bug Report Button - Bottom Left, above Discord */}
      <button 
        className="bug-report-button"
        onClick={() => setShowBugReportModal(true)}
        title="Report a Bug"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 8h-1.81c-.45-.78-1.07-1.45-1.82-1.96l.93-.93a.996.996 0 1 0-1.41-1.41l-1.47 1.47C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L9.11 3.7A.996.996 0 1 0 7.7 5.11l.92.93C7.88 6.55 7.26 7.22 6.81 8H5c-.55 0-1 .45-1 1s.45 1 1 1h1.09c-.05.33-.09.66-.09 1v1H5c-.55 0-1 .45-1 1s.45 1 1 1h1v1c0 .34.04.67.09 1H5c-.55 0-1 .45-1 1s.45 1 1 1h1.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H19c.55 0 1-.45 1-1s-.45-1-1-1h-1.09c.05-.33.09-.66.09-1v-1h1c.55 0 1-.45 1-1s-.45-1-1-1h-1v-1c0-.34-.04-.67-.09-1H19c.55 0 1-.45 1-1s-.45-1-1-1zm-6 8h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1zm0-4h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1z"/>
        </svg>
      </button>
      
      {/* Discord Link - Bottom Left */}
      <a 
        href="https://discord.gg/As5CA3ekYA" 
        target="_blank" 
        rel="noopener noreferrer"
        className="discord-link"
        title="Join our Discord"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
        </svg>
      </a>
      
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

      <main className="App-main">
        {error && !isForceDisconnected && (
          <div className="error-message">
            {error}
          </div>
        )}
        
        {isForceDisconnected && disconnectionReason && (
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

        <div className={`main-content ${theatreMode ? 'theatre-mode-active' : ''} ${theatreMode && showInventory ? 'inventory-open' : ''} ${theatreMode && theatreChatCollapsed ? 'chat-collapsed' : ''}`}>
          {/* Admin Controls - Show in regular mode, or in theatre mode for admins */}
          {(!theatreMode || (theatreMode && isAdmin)) && (
            <>
              <div className={theatreMode ? `theatre-admin-controls ${theatreControlsVisible ? 'visible' : ''}` : ''}>
                <BotsPanel />
                <ModerationPanel streamStatus={streamStatus} />
              </div>
            </>
          )}
          
          <div className="stream-layout-container">
            {!theatreMode && (
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
            <div className="stream-viewer-container">
              <StreamViewer
                socket={socket}
                isStreaming={isStreaming}
                hasActiveStream={streamStatus.hasActiveStream}
                streamType={streamStatus.streamType}
                currentStreamerId={streamStatus.streamerId}
                forceViewerMode={forceViewerAfterTakeover}
                audioSettings={streamerSettings.audio}
                onAudioSettingsChange={(newAudioSettings) => {
                  const newSettings = {
                    ...streamerSettings,
                    audio: newAudioSettings
                  };
                  setStreamerSettings(newSettings);
                  // Save to cookies
                  CookieService.setCookie(COOKIE_NAMES.AUDIO_SETTINGS, newAudioSettings);
                  CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, newSettings);
                }}
                videoSettings={streamerSettings.video}
                onVideoSettingsChange={(newVideoSettings) => {
                  const newSettings = {
                    ...streamerSettings,
                    video: newVideoSettings
                  };
                  setStreamerSettings(newSettings);
                  // Save to cookies
                  CookieService.setCookie(COOKIE_NAMES.VIDEO_SETTINGS, newVideoSettings);
                  CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, newSettings);
                }}
                screenShareSettings={streamerSettings.screenShare}
                isScreenSharing={isScreenSharing}
                onScreenShareChange={setIsScreenSharing}
                onScreenShareMethodsReady={(methods) => {
                  screenShareMethodsRef.current = methods;
                }}
              />
              
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
                  onSettingsChange={(newSettings) => {
                    setStreamerSettings(newSettings);
                    CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, newSettings);
                  }}
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

          {/* Show stream controls only when NOT in theatre mode (theatre mode has its own overlay) */}
          {!theatreMode && (
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
            setCurrentUser(authService.getUser());
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