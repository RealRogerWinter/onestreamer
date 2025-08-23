import React, { useState, useEffect, useRef } from 'react';
import { SocketProvider, useMainSocket } from './contexts/SocketContext';
import './App.css';
import StreamViewer from './components/StreamViewer';
import StreamControls from './components/StreamControls';
import StreamerSettings, { AudioSettingsConfig, VideoSettingsConfig, StreamerSettingsConfig } from './components/StreamerSettings';
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
import { FloatingPointsManager } from './components/FloatingPoints';
import MobileBottomNav from './components/MobileBottomNav';
import MobileHeader from './components/MobileHeader';
import DesktopHeaderV2 from './components/DesktopHeaderV2';
import OAuthCallback from './components/OAuthCallback';
import BugReportModal from './components/BugReportModal';
import EmailVerification from './components/EmailVerification';
import PasswordReset from './components/PasswordReset';
import ModerationPanel from './components/ModerationPanel';
import BotsPanel from './components/BotsPanel';
import authService from './services/AuthService';
import SocketManager from './services/SocketManager';

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
  
  // Check if we're on the email verification page
  const currentPath = window.location.pathname;
  const isEmailVerification = /^\/verify-email\/[a-fA-F0-9]+$/i.test(currentPath);
  const [showEmailVerification, setShowEmailVerification] = useState(isEmailVerification);
  
  // Check if we're on the password reset page
  const isPasswordReset = /^\/reset-password\/[a-fA-F0-9]+$/i.test(currentPath);
  const [showPasswordReset, setShowPasswordReset] = useState(isPasswordReset);
  
  useEffect(() => {
    // console.log(`🔴 AppContent Instance #${instanceId.current} created`);
    // console.log('📧 Email Verification Check - Path:', currentPath, 'Is verification?:', isEmailVerification);
    
    // Check on mount if we need to show email verification
    if (currentPath.startsWith('/verify-email/')) {
      // console.log('📧 Setting showEmailVerification to true');
      setShowEmailVerification(true);
    }
    
    // Check on mount if we need to show password reset
    if (currentPath.startsWith('/reset-password/')) {
      setShowPasswordReset(true);
    }
    
    return () => {
      // console.log(`🟢 AppContent Instance #${instanceId.current} destroyed`);
    };
  }, []);
  
  // Handle initial authentication on app load
  useEffect(() => {
    const token = authService.getToken();
    if (token && isAuthenticated) {
      // console.log('🔑 App: Initializing socket authentication on app load');
      SocketManager.updateAuth(token);
    }
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
  const [isMobile, setIsMobile] = useState(false);
  
  // Reliable mobile detection
  useEffect(() => {
    const checkMobile = () => {
      const mobileCheck = window.innerWidth <= 768 || 
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(mobileCheck);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  
  // Tutorial state
  const [showTutorial, setShowTutorial] = useState(false);

  // Points state
  const [userPoints, setUserPoints] = useState(0);

  // Canvas effects
  const [streamerBuffs, setStreamerBuffs] = useState<any[]>([]);
  
  // Bug Report state
  const [showBugReportModal, setShowBugReportModal] = useState(false);

  // Settings state
  const [audioSettings, setAudioSettings] = useState<AudioSettingsConfig>({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 2,
    profile: 'raw'
  });

  const [videoSettings, setVideoSettings] = useState<VideoSettingsConfig>({
    resolution: '720p',
    frameRate: 30,
    facingMode: 'user',
    bitrate: 2000,
    videoEnabled: true,
    mirror: false
  });

  const [streamerSettings, setStreamerSettings] = useState<StreamerSettingsConfig>({
    audio: audioSettings,
    video: videoSettings
  });

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
    
    // Reset force disconnect state when reconnected
    if (connected && isForceDisconnected) {
      // console.log('🔌 CLIENT: Reconnected after force disconnect');
      setIsForceDisconnected(false);
      setDisconnectionReason(null);
    }
  }, [connected, isStreaming, isForceDisconnected]);

  // Setup socket event listeners
  useEffect(() => {
    if (!socket) return;

    socket.emit('join-as-viewer');

    socket.on('stream-status', (status: StreamStatus) => {
      setStreamStatus(status);

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

    socket.on('stream-ended', () => {
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
      // console.log('💥 CLIENT: Force disconnect received:', data);
      if (isStreaming) {
        setIsStreaming(false);
        setIsForceDisconnected(true);
        setDisconnectionReason(data.message || data.reason);
        
        // Clear our stream from status if we were the streamer
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
    socket.on('stream-takeover', (data: { newStreamerId: string; cooldownRemaining: number }) => {
      // console.log('🔄 CLIENT: Stream takeover event received:', data);
      if (isStreaming) {
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(true);
        setCooldownRemaining(data.cooldownRemaining);
        startCooldownTimer(data.cooldownRemaining);
        
        // Show takeover overlay
        setShowTakeoverOverlay(true);
        setTakeoverMessage('Your stream is being taken over!');
        
        // Hide overlay after 3 seconds
        setTimeout(() => {
          setShowTakeoverOverlay(false);
        }, 3000);
      }
    });

    return () => {
      socket.off('stream-status');
      socket.off('stream-started');
      socket.off('stream-ended');
      socket.off('viewer-count-update');
      socket.off('global-cooldown');
      socket.off('cooldown-status-update');
      socket.off('streaming-approved');
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

  const handleLogin = () => {
    setIsAuthenticated(true);
    setCurrentUser(authService.getUser());
    fetchUserPoints();
    
    // Update socket connections with new auth token
    const token = authService.getToken();
    SocketManager.updateAuth(token);
  };

  const handleLogout = () => {
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

  // If we're on the OAuth callback page, show the callback handler
  if (isOAuthCallback) {
    return <OAuthCallback />;
  }

  return (
    <div className="App">
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
      
      {/* Mobile Header V2 */}
      {isMobile ? (
        <MobileHeader
          viewerCount={streamStatus.viewerCount}
          hasActiveStream={streamStatus.hasActiveStream}
          streamDuration={streamStatus.streamDuration}
          streamStartTime={streamStatus.streamStartTime}
          streamerDisplayName={streamStatus.streamerDisplayName}
          isAuthenticated={isAuthenticated}
          currentUser={currentUser}
          userPoints={userPoints}
          onLogin={() => setShowLogin(true)}
          onLogout={handleLogout}
          onProfileSettings={() => setShowProfileSettings(true)}
        />
      ) : (
        /* Desktop Header V2 - Modern Design */
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
          socket={socket}
          onLogin={() => setShowLogin(true)}
          onSignup={() => setShowSignup(true)}
          onLogout={handleLogout}
          onProfileSettings={() => setShowProfileSettings(true)}
          onAdminPanel={() => setShowAdminPanel(!showAdminPanel)}
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
        />
      )}

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

        <div className="main-content">
          {/* Moderation Panel - Only visible to admins */}
          <BotsPanel />
          <ModerationPanel streamStatus={streamStatus} />
          
          <div className="stream-layout-container">
            <div className="status-effects-sidebar-left">
              <BuffDisplay 
                showStreamerBuffs={true}
                className="streamer-buffs-sidebar-left"
                isCurrentUserStreaming={isStreaming}
                currentUserId={currentUser?.id?.toString()}
                initialBuffs={streamerBuffs}
              />
            </div>
            <div className="stream-viewer-container">
              <StreamViewer 
                socket={socket}
                isStreaming={isStreaming}
                hasActiveStream={streamStatus.hasActiveStream}
                streamType={streamStatus.streamType}
                audioSettings={streamerSettings.audio}
                onAudioSettingsChange={(newAudioSettings) => {
                  setStreamerSettings({
                    ...streamerSettings,
                    audio: newAudioSettings
                  });
                }}
                videoSettings={streamerSettings.video}
                onVideoSettingsChange={(newVideoSettings) => {
                  setStreamerSettings({
                    ...streamerSettings,
                    video: newVideoSettings
                  });
                }}
              />
            </div>
          </div>

          <div className="stream-controls-container">
            <StreamerSettings 
              settings={streamerSettings}
              onSettingsChange={setStreamerSettings}
              isStreaming={isStreaming}
              compact={true}
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
                // console.log('Emitting request-to-stream event', { 
                //   hasActiveStream: streamStatus.hasActiveStream,
                //   currentStreamerId: streamStatus.streamerId 
                // });
                // Always emit request-to-stream - the server handles both new streams and takeovers
                socket.emit('request-to-stream', {
                  streamType: 'webcam',
                  timestamp: Date.now()
                });
              }}
              onStopStream={() => {
                if (!socket) {
                  console.warn('Cannot stop stream: Socket not connected');
                  return;
                }
                // console.log('Emitting stop-streaming event');
                socket.emit('stop-streaming');
                setIsStreaming(false);
              }}
            />
          </div>
        </div>

        {/* Chat and Status Effects Container - Desktop only, mobile uses bottom nav */}
        {!isMobile && (
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

        <FloatingPointsManager>
          <div />
        </FloatingPointsManager>
        <NotificationManager />
        <SoundFxPlayer socket={socket} />
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
        onClose={() => setShowTutorial(false)}
      />


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
      />

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
      
      {/* Mobile Chat Panel with swipe gesture */}
      {isMobile && (
        <MobileChat 
          isOpen={showMobileChat} 
          onClose={() => setShowMobileChat(false)} 
        />
      )}
      
      {/* Mobile Bottom Navigation */}
      {isMobile && (
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