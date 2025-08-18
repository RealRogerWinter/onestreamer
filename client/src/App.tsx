import React, { useState, useEffect, useRef } from 'react';
import { SocketProvider, useMainSocket } from './contexts/SocketContext';
import './App.css';
import StreamViewer from './components/StreamViewer';
import StreamControls from './components/StreamControls';
import StreamerSettings, { AudioSettingsConfig, VideoSettingsConfig, StreamerSettingsConfig } from './components/StreamerSettings';
import ViewerStats from './components/ViewerStats';
import AdminPanel from './components/AdminPanel';
import Chat from './components/Chat';
import Login from './components/Login';
import Signup from './components/Signup';
import UserProfile from './components/UserProfile';
import ProfileSettings from './components/ProfileSettings';
import Tutorial from './components/Tutorial';
import InventoryPanel from './components/inventory/InventoryPanel';
import ModalShopPanel from './components/shop/ModalShopPanel';
import BuffDisplay from './components/BuffDisplay';
import NotificationManager from './components/notifications/NotificationManager';
import SoundFxPlayer from './components/soundfx/SoundFxPlayer';
import { FloatingPointsManager } from './components/FloatingPoints';
import AnimatedNumber from './components/AnimatedNumber';
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
  
  useEffect(() => {
    console.log(`🔴 AppContent Instance #${instanceId.current} created`);
    return () => {
      console.log(`🟢 AppContent Instance #${instanceId.current} destroyed`);
    };
  }, []);
  
  // Handle initial authentication on app load
  useEffect(() => {
    const token = authService.getToken();
    if (token && isAuthenticated) {
      console.log('🔑 App: Initializing socket authentication on app load');
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

  // Inventory state
  const [showInventory, setShowInventory] = useState(false);
  
  // Profile Settings state
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  
  // Tutorial state
  const [showTutorial, setShowTutorial] = useState(false);

  // Points state
  const [userPoints, setUserPoints] = useState(0);

  // Canvas effects
  const [streamerBuffs, setStreamerBuffs] = useState<any[]>([]);

  // Settings state
  const [audioSettings, setAudioSettings] = useState<AudioSettingsConfig>({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 2,
    profile: 'microphone'
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
      console.log('🔌 CLIENT: Socket disconnected while streaming');
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
      console.log('🔌 CLIENT: Reconnected after force disconnect');
      setIsForceDisconnected(false);
      setDisconnectionReason(null);
    }
  }, [connected, isStreaming, isForceDisconnected]);

  // Setup socket event listeners
  useEffect(() => {
    if (!socket) return;

    socket.emit('join-as-viewer');

    socket.on('stream-status', (status: StreamStatus) => {
      console.log('📊 CLIENT: Received stream status:', status);
      setStreamStatus(status);

      if (status.hasActiveStream && isStreaming && socket.id !== status.streamerId) {
        console.log('🚫 CLIENT: Another user is streaming, stopping my stream');
        setIsStreaming(false);
        setWasStreamingBeforeTakeover(false);
      }
    });

    socket.on('stream-started', (data: any) => {
      console.log('🎥 CLIENT: Stream started event:', data);
      
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
        console.log('🔄 CLIENT: Being taken over by:', data.streamerId);
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
      console.log('🛑 CLIENT: Stream ended event received');
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
        console.log('🔄 CLIENT: Was streaming before takeover, preparing to resume...');
        lastStreamSwitchRef.current = now;
        
        if (streamSwitchTimeoutRef.current) {
          clearTimeout(streamSwitchTimeoutRef.current);
        }
        
        streamSwitchTimeoutRef.current = setTimeout(() => {
          console.log('🎬 CLIENT: Attempting to resume streaming after takeover ended');
          setWasStreamingBeforeTakeover(false);
          setIsStreaming(true);
        }, 2000);
      }
    });

    socket.on('viewer-count-update', (count: number) => {
      console.log('👥 CLIENT: Viewer count update:', count);
      setStreamStatus(prev => ({ ...prev, viewerCount: count }));
    });

    socket.on('global-cooldown', (data: { cooldownRemaining: number }) => {
      console.log('⏳ CLIENT: Global cooldown update:', data.cooldownRemaining);
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
    });

    socket.on('cooldown-status-update', (data: { globalCooldown: any, timestamp: number }) => {
      console.log('🛡️ CLIENT: Cooldown status update from item:', data);
      if (data.globalCooldown) {
        const remaining = data.globalCooldown.remainingSeconds || data.globalCooldown.remaining || 0;
        console.log('🛡️ CLIENT: Setting cooldown to', remaining, 'seconds');
        setCooldownRemaining(Math.ceil(remaining));
        startCooldownTimer(Math.ceil(remaining));
      }
    });

    socket.on('streaming-approved', () => {
      console.log('✅ CLIENT: Streaming approved! Starting stream...');
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
      console.log('✅ CLIENT: isStreaming set to true');
    });

    socket.on('takeover-approved', () => {
      console.log('✅ CLIENT: Takeover approved!');
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
      console.log('🚫 CLIENT: Takeover denied:', data.reason);
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      setError(data.reason);
    });

    // Keep backward compatibility with old event name
    socket.on('takeover-blocked', (data: { message: string, cooldownRemaining: number }) => {
      console.log('🚫 CLIENT: Takeover blocked (legacy):', data.message);
      setCooldownRemaining(data.cooldownRemaining);
      startCooldownTimer(data.cooldownRemaining);
      setError(data.message);
    });

    socket.on('admin-notification', (data: { message: string; type: string }) => {
      console.log('📢 ADMIN:', data.message);
      setError(data.message);
      setTimeout(() => setError(null), 5000);
    });

    socket.on('streamer-buffs-update', (data: { buffs: any[] }) => {
      console.log('🎭 CLIENT: Received streamer buffs update:', data.buffs);
      setStreamerBuffs(data.buffs || []);
    });

    socket.on('banned', (data: { reason: string }) => {
      setError(`You have been banned: ${data.reason}`);
    });

    socket.on('timeout', (data: { duration: number; reason: string }) => {
      setError(`You are timed out for ${data.duration} seconds: ${data.reason}`);
    });

    socket.on('time-stats-update', (data: any) => {
      console.log('📊 CLIENT: Received time-stats-update:', data);
      // Only process updates for the current user
      if (currentUser && data.userId && data.userId !== currentUser.id) {
        console.log('📊 CLIENT: Ignoring update for different user', data.userId, '!==', currentUser?.id);
        return;
      }
      
      if (data.points !== undefined) {
        setUserPoints((prevPoints) => {
          // Trigger floating points animation if points increased
          if (data.points > prevPoints && window.showFloatingPoints) {
            const pointsGained = data.points - prevPoints;
            const source = data.pointSource || data.updateType || 'general';
            console.log('🎯 Points increased via time-stats-update!', prevPoints, '->', data.points, '(+' + pointsGained + ')', 'Source:', source);
            window.showFloatingPoints(pointsGained, source);
          }
          return data.points;
        });
      }
    });

    socket.on('points-updated', (data: { points: number }) => {
      console.log('💎 CLIENT: Received points-updated:', data);
      setUserPoints(data.points);
    });

    // Handle force disconnect from killswitch or admin
    socket.on('force-disconnect', (data: { reason: string; activatedBy?: string; message: string }) => {
      console.log('💥 CLIENT: Force disconnect received:', data);
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
      console.log('💥 CLIENT: Kill switch activated notification:', data);
      // Show notification to all users about the kill switch (but not the disconnected user)
      if (!isForceDisconnected) {
        setError(data.message);
        setTimeout(() => setError(null), 5000);
      }
    });

    // Handle stream takeover event (sent to the current streamer being taken over)
    socket.on('stream-takeover', (data: { newStreamerId: string; cooldownRemaining: number }) => {
      console.log('🔄 CLIENT: Stream takeover event received:', data);
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
      setIsAdmin(adminStatus);
    };
    
    if (isAuthenticated) {
      checkAdmin();
    }
  }, [isAuthenticated]);

  const fetchUserPoints = async () => {
    try {
      const response = await fetch(`${process.env.REACT_APP_SERVER_URL}/api/auth/me`, {
        headers: {
          'Authorization': `Bearer ${authService.getToken()}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        const points = data.stats?.points || 0;
        console.log('📊 Fetched user points from /me endpoint:', points);
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


  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Admin panel shortcut (Ctrl+Shift+A)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        setShowAdminPanel(!showAdminPanel);
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
  }, [showAdminPanel, showInventory, isAuthenticated]);

  return (
    <div className="App">
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
      
      <header className="App-header">
        {/* Help Button */}
        <button 
          className="help-button"
          onClick={() => setShowTutorial(true)}
          title="Tutorial & Help"
        >
          ?
        </button>
        
        <div className="header-center">
          <ViewerStats 
            viewerCount={streamStatus.viewerCount}
            hasActiveStream={streamStatus.hasActiveStream}
            streamDuration={streamStatus.streamDuration}
            streamStartTime={streamStatus.streamStartTime}
            streamerDisplayName={streamStatus.streamerDisplayName}
          />
        </div>
        <div className="header-right">
          <div className="auth-buttons">
            {isAuthenticated ? (
              <>
                <div className="user-points points-counter">
                  <span className="points-icon">💎</span>
                  <AnimatedNumber value={userPoints} />
                  <span className="points-label">Points</span>
                </div>
                <UserProfile 
                  socket={socket}
                  onLogout={() => {
                    handleLogout();
                  }}
                  onOpenProfileSettings={() => setShowProfileSettings(true)}
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
                          console.log('🎯 Viewing session detected! SessionTime:', (profile as any).currentSessionTime, 'seconds');
                        } else {
                          source = 'general';
                          pointsGained = totalDiff;
                        }
                      }
                      
                      console.log('🎯 Points increased!', prevPoints, '->', profile.points, '(+' + pointsGained + ')', 'Source:', source, 'UpdateType:', profile.updateType, 'PointSource:', (profile as any).pointSource, 'SessionType:', (profile as any).sessionType, 'SessionTime:', (profile as any).currentSessionTime);
                      
                      if (window.showFloatingPoints) {
                        console.log('🎯 Triggering floating points animation for', source);
                        window.showFloatingPoints(pointsGained, source);
                      } else {
                        console.log('❌ window.showFloatingPoints not available');
                      }
                    }
                  }}
                />
              </>
            ) : (
              <>
                <button className="auth-button login-button" onClick={() => setShowLogin(true)}>
                  Login
                </button>
                <button className="auth-button signup-button" onClick={() => setShowSignup(true)}>
                  Sign Up
                </button>
              </>
            )}
            {isAuthenticated && isAdmin && (
              <button 
                className="auth-button admin-button" 
                onClick={() => setShowAdminPanel(!showAdminPanel)}
                title="Admin Panel (Ctrl+Shift+A)"
              >
                ⚙️ Admin
              </button>
            )}
          </div>
        </div>
      </header>

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
          <div className="stream-layout-container">
            <div className="status-effects-sidebar-left">
              <BuffDisplay 
                showStreamerBuffs={true}
                className="streamer-buffs-sidebar-left"
                isCurrentUserStreaming={isStreaming}
                currentUserId={currentUser?.id?.toString()}
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
              onTakeOver={() => {
                if (!socket) {
                  console.warn('Cannot take over stream: Socket not connected');
                  return;
                }
                console.log('Emitting request-to-stream event', { 
                  hasActiveStream: streamStatus.hasActiveStream,
                  currentStreamerId: streamStatus.streamerId 
                });
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
                console.log('Emitting stop-streaming event');
                socket.emit('stop-streaming');
                setIsStreaming(false);
              }}
            />
          </div>
        </div>

        <div className="chat-sidebar">
          <Chat />
          <BuffDisplay 
            showPersonalBuffs={true}
            className="personal-buffs-below-chat"
            isCurrentUserStreaming={isStreaming}
            currentUserId={currentUser?.id?.toString()}
          />
        </div>

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

      <AdminPanel 
        isVisible={showAdminPanel}
        onClose={() => setShowAdminPanel(false)}
      />
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