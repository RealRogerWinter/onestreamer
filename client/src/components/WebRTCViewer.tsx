import React, { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { WebRTCClientAdapter } from '../services/WebRTCClientAdapter';
import PerformanceMonitorComponent from './PerformanceMonitor';
import { StreamSwitchManager, StreamSwitchState } from '../services/StreamSwitchManager';
import CanvasEffectOverlay from './canvas/CanvasEffectOverlay';
import { useVisualFxProcessor } from '../hooks/useVisualFxProcessor';
import CookieService, { COOKIE_NAMES } from '../services/CookieService';
import { isIOSSafari, isIOS, isMobile, getBrowserInfo } from '../utils/browserDetection';
import './WebRTCViewer.css';

interface WebRTCViewerProps {
  socket: Socket;
  isActive: boolean;
  className?: string;
  showPerformanceMonitor?: boolean;
  forceInitialize?: boolean;
  currentStreamerId?: string | null;  // CRITICAL: Stream switching detection
}

const WebRTCViewer: React.FC<WebRTCViewerProps> = ({ socket, isActive, className = '', showPerformanceMonitor = false, forceInitialize = false, currentStreamerId }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediasoupClientRef = useRef<WebRTCClientAdapter | null>(null);
  const initTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isInitializingRef = useRef(false);
  const isSwitchingRef = useRef(false);
  const currentStreamIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastInitTimeRef = useRef<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [playbackState, setPlaybackState] = useState<'loading' | 'playing' | 'paused' | 'failed'>('loading');
  const [userInteracted, setUserInteracted] = useState(false);
  const [autoPlayAttempts, setAutoPlayAttempts] = useState(0);

  // Initialize Visual FX processor for viewer
  const visualFxProcessor = useVisualFxProcessor(videoRef, socket, false);
  const playRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [connectionState, setConnectionState] = useState<'connected' | 'disconnected' | 'reconnecting'>('disconnected');
  const [reconnectionAttempts, setReconnectionAttempts] = useState(0);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [switchState, setSwitchState] = useState<StreamSwitchState>('idle');
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const streamSwitchManagerRef = useRef<StreamSwitchManager | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const webrtcReconnectAttempts = useRef(0);
  const lastStreamUpdateRef = useRef<number>(0);
  const streamUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const streamSwitchAbortController = useRef<AbortController | null>(null);

  // Initialize volume from cookie or default
  const [volume, setVolume] = useState(() => {
    const savedVolume = CookieService.getCookie(COOKIE_NAMES.VOLUME);
    return savedVolume !== null ? savedVolume : 0.8;
  });
  
  // Initialize muted state from cookie
  const [isMuted, setIsMuted] = useState(() => {
    const savedMuted = CookieService.getCookie(COOKIE_NAMES.MUTED);
    return savedMuted !== null ? savedMuted : false;
  });
  
  const [showControls, setShowControls] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Debug info for mobile 5G issues
  const [debugInfo, setDebugInfo] = useState<{
    iceState?: string;
    candidates?: string[];
    turnStatus?: string;
    transportState?: string;
    error?: string;
    timestamp?: string;
    browser?: string;
    browserEngine?: string;
    gatheringState?: string;
    turnUrls?: any;
    lastCandidate?: string;
  }>({});

  useEffect(() => {
    // Clear any pending initialization
    if (initTimeoutRef.current) {
      clearTimeout(initTimeoutRef.current);
      initTimeoutRef.current = null;
    }

    if (!socket?.connected) {
      cleanupSync();
      return;
    }

    if (!isActive && !forceInitialize) {
      // CRITICAL: Don't cleanup if we're in the middle of a stream switch operation
      // This prevents race conditions where isActive becomes false (due to isStreaming state lag)
      // before the state update propagates
      if (isSwitchingRef.current) {
        console.log(`🛑 WEBRTC: Skipping cleanup - stream switch in progress`);
        return;
      }

      // CRITICAL: Don't cleanup if we have a working connection and isConnected
      // This handles the race condition where isActive becomes false due to stale isStreaming state
      if (mediasoupClientRef.current && isConnected && !mediasoupClientRef.current.isDestroyed) {
        console.log(`🛑 WEBRTC: Skipping cleanup - have active connection despite isActive=false (likely stale isStreaming state)`);
        return;
      }

      // CRITICAL: Don't cleanup if WE are the current streamer
      // This prevents destroying our connection during the takeover race condition
      const mySocketId = socket?.id;
      if (currentStreamerId && currentStreamerId === mySocketId) {
        console.log(`🛑 WEBRTC: Skipping cleanup - I am the streamer (${mySocketId})`);
        return;
      }
      // If we WERE the streamer (currentStreamIdRef.current === our socket ID), we need to cleanup
      // and prepare to become a viewer - this is the "being taken over" scenario
      if (currentStreamIdRef.current === mySocketId) {
        console.log(`🔄 WEBRTC: I was the streamer, cleaning up to become viewer`);
        currentStreamIdRef.current = null; // Clear so we can reconnect as viewer
        cleanupSync();
        return;
      }
      // If we were viewing someone else and streamer cleared, wait briefly for potential takeover
      if (!currentStreamerId && currentStreamIdRef.current) {
        console.log(`⏳ WEBRTC: Streamer cleared (was: ${currentStreamIdRef.current}), waiting briefly before cleanup...`);
        // Don't cleanup immediately - let the stream-switch handler deal with it
        return;
      }
      cleanupSync();
      return;
    }

    // Only initialize if we don't already have a working connection
    // This prevents destroying working connections when dependencies change
    if (mediasoupClientRef.current && isConnected) {
      // console.log('📺 WEBRTC: Skipping init - already connected');
      return;
    }

    // If we were the streamer (currentStreamIdRef equals our socket ID), clear it
    // and add a longer delay to ensure WebRTCStreamer's LiveKit connection is fully cleaned up
    const mySocketId = socket?.id;
    const wasStreamer = currentStreamIdRef.current === mySocketId ||
                        previousStreamerIdRef.current === mySocketId;
    if (wasStreamer) {
      console.log(`🔄 WEBRTC: Transitioning from streamer to viewer, clearing refs and adding delay`);
      currentStreamIdRef.current = null;
    }

    // Debounce initialization to prevent rapid switching issues
    // CRITICAL: forceInitialize means we were just taken over - need to wait for NEW streamer to publish tracks
    // This takes 2-3 seconds as they need to: connect to LiveKit -> publish tracks
    // wasStreamer: cleanup delay for our own streams
    // forceInitialize: LONG delay for takeover - wait for new streamer to publish
    // Otherwise: normal quick init
    const initDelay = forceInitialize ? 3000 : (wasStreamer ? 500 : 100);
    console.log(`📺 WEBRTC: Scheduling init with ${initDelay}ms delay (forceInit=${forceInitialize}, wasStreamer=${wasStreamer})`);
    initTimeoutRef.current = setTimeout(() => {
      console.log('📺 WEBRTC: Starting WebRTC viewer...', forceInitialize ? '(after takeover delay)' : '');
      initializeViewer();
    }, initDelay);

    return () => {
      // Clear any pending initialization
      if (initTimeoutRef.current) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      // DON'T cleanup here - only cleanup when socket disconnects or isActive becomes false
      // The cleanup on dependency change was destroying working connections
    };
  }, [isActive, socket?.connected, forceInitialize, isConnected]);

  // CRITICAL FIX: Detect streamer changes and handle appropriately
  // For LiveKit: Don't reconnect for viewbot rotations - let selectActiveParticipant handle it
  // Only reconnect for: no connection, takeover (viewbot→real), or broken connection
  const previousStreamerIdRef = useRef<string | null | undefined>(undefined);
  // Track if this user was EVER the streamer (persists through null transitions)
  const userWasStreamerRef = useRef<boolean>(false);

  useEffect(() => {
    const mySocketId = socket?.id;

    // Skip on first render (undefined → initial value)
    if (previousStreamerIdRef.current === undefined) {
      previousStreamerIdRef.current = currentStreamerId;
      // Track if user was streamer on first render
      if (currentStreamerId === mySocketId) {
        userWasStreamerRef.current = true;
      }
      return;
    }

    // Skip if streamer hasn't changed
    if (previousStreamerIdRef.current === currentStreamerId) {
      return;
    }

    const oldStreamerId = previousStreamerIdRef.current;
    previousStreamerIdRef.current = currentStreamerId;

    // Track if user was ever the streamer (set when they BECOME the streamer)
    // This persists through null transitions so we can detect "user's ID -> null -> new ID" pattern
    if (currentStreamerId === mySocketId) {
      userWasStreamerRef.current = true;
      console.log(`📝 STREAM-SWITCH: Marking user as current/former streamer (${mySocketId})`);
    }
    // Also set it if OLD streamer was the user (they just stopped being streamer)
    if (oldStreamerId === mySocketId) {
      userWasStreamerRef.current = true;
      console.log(`📝 STREAM-SWITCH: Marking user as former streamer (was ${mySocketId})`);
    }

    // If there's no new streamer, don't do anything special - don't cleanup!
    if (!currentStreamerId) {
      console.log(`🔄 STREAM-SWITCH: Streamer prop cleared (was: ${oldStreamerId}) - NOT cleaning up, waiting for new streamer`);
      // DON'T cleanup here - this fires during viewbot rotations and destroys working connections
      return;
    }

    // If our currentStreamIdRef already matches the new streamer, we're already connected
    if (currentStreamIdRef.current === currentStreamerId) {
      console.log(`🔄 STREAM-SWITCH: Already connected to ${currentStreamerId}, skipping reconnect`);
      return;
    }

    // Helper to check if an ID is a viewbot
    const isViewbot = (id: string | null | undefined) => id?.startsWith('viewbot-');
    const isRealStreamer = (id: string | null | undefined) => id && !id.startsWith('viewbot-');

    // CRITICAL: Check if WE WERE the streamer at any point (not just the immediate previous)
    // This handles the case where: user's ID -> null -> user's ID (or new streamer's ID)
    const wasStreamerImmediately = oldStreamerId === mySocketId;
    const wasStreamerEver = userWasStreamerRef.current;
    const wasStreamer = wasStreamerImmediately || wasStreamerEver;

    if (wasStreamer) {
      console.log(`🔄 STREAM-SWITCH: I was the streamer (immediate: ${wasStreamerImmediately}, ever: ${wasStreamerEver}), transitioning to viewer for ${currentStreamerId}`);
      // Clear refs so we get a fresh connection
      currentStreamIdRef.current = null;
      // DON'T return here - we need to continue to reconnect as viewer
    }

    // Check if this is OUR OWN stream - but ONLY block if we were NEVER the streamer
    // If we were EVER the streamer and currentStreamerId is our ID, this is a stale update
    if (currentStreamerId === mySocketId && !wasStreamer) {
      console.log(`🛑 STREAM-SWITCH: ${currentStreamerId} is MY OWN socket ID - I am actively streaming, not consuming my own stream`);
      currentStreamIdRef.current = currentStreamerId;
      return;
    }

    // If we were the streamer and the new ID is still our own, wait for the real update
    if (currentStreamerId === mySocketId && wasStreamer) {
      console.log(`⏳ STREAM-SWITCH: I was just taken over but currentStreamerId is still my ID - waiting for correct update`);
      // Don't set currentStreamIdRef, don't return - wait for another update with the real new streamer
      return;
    }

    // Clear the "was streamer" flag since we're now successfully transitioning to viewer
    if (wasStreamer && currentStreamerId !== mySocketId) {
      console.log(`✅ STREAM-SWITCH: Clearing former-streamer flag, now viewing ${currentStreamerId}`);
      userWasStreamerRef.current = false;
    }

    // Check if we have a working LiveKit connection
    const hasWorkingConnection = mediasoupClientRef.current &&
                                  !mediasoupClientRef.current.isDestroyed &&
                                  videoRef.current?.srcObject;

    // CRITICAL: If new streamer is a REAL streamer, ALWAYS reconnect - this is a takeover!
    const newStreamerIsReal = isRealStreamer(currentStreamerId);

    if (newStreamerIsReal) {
      console.log(`🚨 STREAM-SWITCH: REAL STREAMER DETECTED - ${currentStreamerId} - MUST reconnect!`);
      // Fall through to full reconnect - real streamers always take priority
    }
    // For viewbot→viewbot changes with working connection: just update tracking, don't reconnect
    else if (isViewbot(currentStreamerId) && hasWorkingConnection) {
      console.log(`🔄 STREAM-SWITCH: Viewbot ${currentStreamerId} with working connection, keeping connection`);
      // LiveKit's selectActiveParticipant will handle picking the right viewbot
      currentStreamIdRef.current = currentStreamerId;
      return;
    }
    // No connection and new is viewbot - need to connect
    else if (!hasWorkingConnection) {
      console.log(`🔄 STREAM-SWITCH: No working connection, connecting to ${currentStreamerId}`);
      // Fall through to reconnect
    }

    console.log(`🚨 STREAM-SWITCH: ${newStreamerIsReal ? 'TAKEOVER' : 'RECONNECT'} to ${currentStreamerId}`);

    // Only do full reconnect when necessary
    const forceReconnectToNewStream = async () => {
      console.log(`🔄 STREAM-SWITCH: Initiating reconnection to ${currentStreamerId}`);

      // CRITICAL: Set switching flag to prevent onStreamUpdate from interfering
      isSwitchingRef.current = true;

      // Cancel any pending operations
      if (streamSwitchAbortController.current) {
        streamSwitchAbortController.current.abort();
      }
      streamSwitchAbortController.current = new AbortController();

      // Update our tracking ref immediately
      currentStreamIdRef.current = currentStreamerId;

      // Set loading state
      setIsLoading(true);
      setError('Connecting to stream...');
      setSwitchState('switching');

      // Clean up existing connection only if it exists
      if (mediasoupClientRef.current) {
        console.log(`🧹 STREAM-SWITCH: Cleaning up old connection`);
        try {
          isInitializingRef.current = false;
          await mediasoupClientRef.current.cleanup();
          mediasoupClientRef.current = null;
        } catch (error) {
          console.error('❌ STREAM-SWITCH: Cleanup error:', error);
        }
      }

      // Reset video element
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }

      // Delay to ensure cleanup is complete
      // Longer delay if we were the streamer to ensure LiveKit session is fully closed
      // ALSO: If connecting to a REAL streamer (not viewbot), wait longer for them to publish tracks
      const isTargetRealStreamer = isRealStreamer(currentStreamerId);
      let cleanupDelay = wasStreamer ? 500 : 100;

      // CRITICAL: If we were the streamer AND connecting to a real streamer (takeover scenario),
      // we need to wait for the new streamer to finish publishing their tracks.
      // This can take 2-5 seconds as they need to: request stream -> get approved -> connect to LiveKit -> publish tracks
      if (wasStreamer && isTargetRealStreamer) {
        cleanupDelay = 3000; // Wait 3 seconds for new real streamer to publish
        console.log(`⏳ STREAM-SWITCH: TAKEOVER - waiting ${cleanupDelay}ms for new streamer ${currentStreamerId} to publish tracks`);
      } else {
        console.log(`⏳ STREAM-SWITCH: Waiting ${cleanupDelay}ms for cleanup${wasStreamer ? ' (was streamer)' : ''}`);
      }

      await new Promise(resolve => setTimeout(resolve, cleanupDelay));

      // Check if we're still supposed to connect to this streamer
      if (currentStreamIdRef.current !== currentStreamerId) {
        console.log(`🔄 STREAM-SWITCH: Target changed during cleanup, aborting`);
        isSwitchingRef.current = false;
        return;
      }

      // Initialize viewer connection to new stream
      console.log(`🔄 STREAM-SWITCH: Initializing connection to ${currentStreamerId}`);
      try {
        await initializeViewer(true);
        setSwitchState('idle');
        setError(null);
        setIsConnected(true);
        console.log(`✅ STREAM-SWITCH: Connected to ${currentStreamerId}`);
        socket.emit('join-as-viewer');
        // Clear switching flag on success
        isSwitchingRef.current = false;
      } catch (error) {
        console.error(`❌ STREAM-SWITCH: Failed to connect:`, error);
        setSwitchState('failed');
        setError(`Connection failed. Please refresh.`);

        // Retry once after a delay
        setTimeout(async () => {
          if (currentStreamIdRef.current === currentStreamerId) {
            console.log(`🔄 STREAM-SWITCH: Retrying...`);
            try {
              await initializeViewer(true);
              setSwitchState('idle');
              setError(null);
              setIsConnected(true);
              socket.emit('join-as-viewer');
              // Clear switching flag on retry success
              isSwitchingRef.current = false;
            } catch (retryError) {
              console.error(`❌ STREAM-SWITCH: Retry failed:`, retryError);
              // Clear switching flag even on retry failure so component isn't stuck
              isSwitchingRef.current = false;
            }
          } else {
            // Target changed, clear the flag
            isSwitchingRef.current = false;
          }
        }, 2000);
      }
    };

    forceReconnectToNewStream();

  }, [currentStreamerId, socket]);

  // Handle video events and apply volume
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      setIsPaused(false);
      setPlaybackState('playing');
    };
    const handlePause = () => {
      setIsPaused(true);
      setPlaybackState('paused');
    };
    
    // Sync initial pause state with video's actual state
    const handleLoadedData = () => {
      const paused = video.paused;
      setIsPaused(paused);
      setPlaybackState(paused ? 'paused' : 'playing');
    };
    
    // iOS-specific: Handle stalled/waiting events to prevent freezing
    const handleStalled = () => {
      if (isIOS()) {
        console.log('📱 iOS: Video stalled, attempting recovery...');
        // Force a small seek to unstall the video
        if (video.currentTime > 0) {
          video.currentTime = video.currentTime - 0.1;
        }
        // Try to play again
        video.play().catch(() => {});
      }
    };
    
    const handleWaiting = () => {
      if (isIOS()) {
        console.log('📱 iOS: Video waiting for data...');
        // Set a timeout to recover if stuck waiting
        setTimeout(() => {
          if (video.readyState < 3) { // HAVE_FUTURE_DATA
            console.log('📱 iOS: Video still waiting, forcing play...');
            video.load();
            video.play().catch(() => {});
          }
        }, 2000);
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('loadeddata', handleLoadedData);
    video.addEventListener('stalled', handleStalled);
    video.addEventListener('waiting', handleWaiting);
    
    // Apply volume and muted state from saved settings
    video.volume = volume;
    // Always start muted for autoplay to work on all browsers
    video.muted = true;
    
    // Initial state sync
    const initialPaused = video.paused;
    setIsPaused(initialPaused);
    setPlaybackState(initialPaused ? 'paused' : 'playing');

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('stalled', handleStalled);
      video.removeEventListener('waiting', handleWaiting);
    };
  }, [volume, userInteracted]);

  // Cleanup controls timeout on unmount
  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);

  // Update video muted state when user interaction changes
  useEffect(() => {
    const video = videoRef.current;
    if (video && userInteracted && volume > 0) {
      // console.log('📺 WEBRTC: User interacted, unmuting video with volume:', volume);
      video.muted = false;
    }
  }, [userInteracted, volume]);

  // Track fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      setIsFullscreen(isCurrentlyFullscreen);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);
  
  // iOS Safari video recovery - detect when video freezes with audio playing
  useEffect(() => {
    if (!isConnected || !videoRef.current || !isIOS()) return;
    if (playbackState !== 'playing') return;
    
    const video = videoRef.current;
    let lastVideoTime = 0;
    let stuckCount = 0;
    
    const checkInterval = setInterval(() => {
      if (!video || video.paused) return;
      
      // Check if we have both audio and video tracks
      const stream = video.srcObject as MediaStream;
      if (!stream) return;
      
      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;
      
      if (hasVideo && hasAudio) {
        // Check if video is progressing
        const currentVideoTime = video.currentTime;
        
        if (currentVideoTime > 0 && currentVideoTime === lastVideoTime) {
          stuckCount++;
          console.log(`📱 iOS: Video may be stuck (count: ${stuckCount}), audio at ${currentVideoTime.toFixed(2)}s`);
          
          if (stuckCount >= 3) { // After 6 seconds of no progress
            console.log('📱 iOS: Video confirmed stuck, attempting recovery...');
            
            // Try pause/play recovery
            video.pause();
            setTimeout(() => {
              video.play().catch(() => {});
            }, 100);
            
            stuckCount = 0;
          }
        } else {
          if (stuckCount > 0) {
            console.log('📱 iOS: Video recovered');
          }
          stuckCount = 0;
        }
        
        lastVideoTime = currentVideoTime;
      }
    }, 2000); // Check every 2 seconds
    
    return () => {
      clearInterval(checkInterval);
    };
  }, [isConnected, playbackState]);

  const initializeViewer = async (forceInit: boolean = false) => {
    const browserInfo = getBrowserInfo();

    // CRITICAL: Don't try to consume your own stream if you are ACTIVELY streaming!
    // This prevents the case where user starts streaming, server broadcasts stream-started,
    // and WebRTCViewer tries to consume the user's own stream (destroying the publisher)
    // BUT: Allow if we WERE the streamer (transitioning to viewer after takeover)
    const mySocketId = socket?.id;
    // Check both immediate previous AND the persistent "was ever streamer" flag
    const wasStreamer = previousStreamerIdRef.current === mySocketId || userWasStreamerRef.current;

    if (currentStreamerId && currentStreamerId === mySocketId && !wasStreamer && !forceInit) {
      console.log(`🛑 WEBRTC: Not initializing viewer - I am actively streaming (${mySocketId})`);
      return;
    }

    // If we were the streamer and currentStreamerId is still our ID, this is stale - skip
    if (currentStreamerId && currentStreamerId === mySocketId && wasStreamer) {
      console.log(`⏳ WEBRTC: Was streamer, but currentStreamerId is still my ID - waiting for correct update`);
      return;
    }

    // Clear the "was streamer" flag when successfully initializing as viewer for someone else
    if (wasStreamer && currentStreamerId && currentStreamerId !== mySocketId) {
      console.log(`✅ WEBRTC: Clearing former-streamer flag, initializing viewer for ${currentStreamerId}`);
      userWasStreamerRef.current = false;
    }

    // Clear any stuck states - but only if we're not in a legitimate switch operation
    // The forceInit flag indicates a legitimate switch, so don't clear in that case
    if (!forceInit && (switchState === 'switching' || switchState === 'retrying')) {
      console.log('📺 WEBRTC: Clearing stuck state (not from forceInit)...');
      setSwitchState('idle');
      setError(null);
    }
    
    // Prevent multiple simultaneous initializations
    if (isInitializingRef.current) {
      // console.log('📺 WEBRTC: Already initializing, waiting for completion...');
      // Wait for current initialization to complete
      let waitTime = 0;
      const maxWaitTime = browserInfo.isIOS ? 15000 : 10000; // iOS needs more time
      while (isInitializingRef.current && waitTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitTime += 100;
      }
      if (isInitializingRef.current) {
        console.error('📺 WEBRTC: Previous initialization stuck, forcing reset');
        isInitializingRef.current = false;
      } else {
        // console.log('📺 WEBRTC: Previous initialization completed');
        return;
      }
    }

    // Create abort controller for this initialization
    abortControllerRef.current = new AbortController();
    
    // Basic rate limiting - prevent rapid reinitialization
    const now = Date.now();
    const timeSinceLastInit = now - lastInitTimeRef.current;
    const minInterval = (forceInitialize || forceInit) ? 50 : 200; // Same for all platforms
    if (timeSinceLastInit < minInterval && !forceInitialize && !forceInit) {
      // console.log(`📺 WEBRTC: Rate limiting init (${timeSinceLastInit}ms < ${minInterval}ms), skipping...`);
      return;
    }
    lastInitTimeRef.current = now;

    try {
      isInitializingRef.current = true;
      setIsLoading(true);
      setError(null);

      // Ensure we have a clean video element
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.load();
        
        // Wait a bit for the video element to reset
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Always create a completely new MediasoupClient to avoid MID collisions
      if (mediasoupClientRef.current) {
        // Clean up existing client completely
        await mediasoupClientRef.current.cleanup();
        mediasoupClientRef.current = null;
      }
      
      // Create new client with connection recovery callbacks
      // Use the correct server URL from environment or default to HTTPS
      const serverUrl = process.env.REACT_APP_API_URL || `https://${window.location.hostname}`;
      // console.log('🌐 WEBRTC: Creating MediasoupClient with server URL:', serverUrl);
      // console.log('🌐 WEBRTC: Using HTTPS for transport connection');
      
      mediasoupClientRef.current = new WebRTCClientAdapter({
        socket,
        serverUrl,
        onConnectionLost: () => {
          // console.log('📡 WEBRTC: MediaSoup connection lost');
          setConnectionState('disconnected');
          setError('Connection lost - attempting recovery...');
          setDebugInfo(prev => ({ ...prev, error: 'Connection lost', timestamp: new Date().toISOString() }));
        },
        onConnectionRecovered: async () => {
          // console.log('🎉 WEBRTC: MediaSoup connection recovered');
          setConnectionState('reconnecting');
          setError(null);
          setDebugInfo(prev => ({ ...prev, error: 'Recovering...', timestamp: new Date().toISOString() }));
        },
        onStreamUpdate: async () => {
          // CRITICAL FIX: Skip if initializeViewer is handling the consume
          // This prevents competing consume calls that can destroy working connections
          if (isInitializingRef.current) {
            console.log(`⏭️ WEBRTC: Skipping onStreamUpdate - initializeViewer is handling consumption`);
            return;
          }

          // Also skip if we're in the middle of a stream switch operation
          if (isSwitchingRef.current) {
            console.log(`⏭️ WEBRTC: Skipping onStreamUpdate - stream switch in progress`);
            return;
          }

          // CRITICAL FIX: Use streamId-based deduplication instead of time-based debouncing
          // Get the current streamer ID from the client
          const newStreamerId = mediasoupClientRef.current?.getCurrentStreamer();

          // Skip if this is the same stream we're already showing
          if (newStreamerId && newStreamerId === currentStreamIdRef.current) {
            console.log(`⏭️ WEBRTC: Skipping duplicate stream update for ${newStreamerId} (already active)`);
            return;
          }

          console.log(`🔄 WEBRTC: Stream update triggered - switching from ${currentStreamIdRef.current || 'none'} to ${newStreamerId}`);

          // Clear any pending update timeout
          if (streamUpdateTimeoutRef.current) {
            clearTimeout(streamUpdateTimeoutRef.current);
            streamUpdateTimeoutRef.current = null;
          }

          // Helper function to attempt stream switch
          const attemptStreamSwitch = async (attempt: number = 1): Promise<boolean> => {
            try {
              if (!mediasoupClientRef.current || !videoRef.current) {
                console.log('⚠️ WEBRTC: Client or video ref not available');
                return false;
              }

              const video = videoRef.current;
              const newStream = await mediasoupClientRef.current.consume();

              if (newStream && newStream.getTracks().length > 0) {
                console.log(`🔄 WEBRTC: Switching to new stream with ${newStream.getTracks().length} tracks (attempt ${attempt})`);

                video.pause();
                video.srcObject = newStream;
                // Preserve user's mute preference during stream switch (fixes Android Chrome audio bug)
                video.muted = isMuted;
                video.volume = volume;
                video.load();

                try {
                  await video.play();
                  console.log('✅ WEBRTC: Stream updated and playing successfully');
                  setPlaybackState('playing');
                } catch (playError) {
                  console.log('⚠️ WEBRTC: Autoplay prevented after stream update:', playError);
                  setPlaybackState('paused');
                }

                // Update tracking ref after successful switch
                const actualStreamerId = mediasoupClientRef.current?.getCurrentStreamer();
                if (actualStreamerId) {
                  currentStreamIdRef.current = actualStreamerId;
                  console.log(`📝 WEBRTC: Updated currentStreamIdRef to ${actualStreamerId}`);
                }

                setIsConnected(true);
                setError(null);
                return true;
              } else {
                console.log(`⚠️ WEBRTC: No tracks available (attempt ${attempt})`);
                return false;
              }
            } catch (error) {
              console.error(`❌ WEBRTC: Stream switch attempt ${attempt} failed:`, error);
              return false;
            }
          };

          // Try up to 3 times with increasing delays
          let success = await attemptStreamSwitch(1);

          if (!success) {
            await new Promise(resolve => setTimeout(resolve, 300));
            success = await attemptStreamSwitch(2);
          }

          if (!success) {
            await new Promise(resolve => setTimeout(resolve, 700));
            success = await attemptStreamSwitch(3);
          }

          if (!success) {
            console.error('❌ WEBRTC: All stream switch attempts failed');
            // Don't set error state here - the stream might still be playing fine
            // Just log for debugging
          }
        },
        onDebugInfo: (info: any) => {
          setDebugInfo(prev => ({
            ...prev,
            ...info,
            timestamp: new Date().toISOString()
          }));
        }
      } as any);

      // Create StreamSwitchManager for graceful degradation
      streamSwitchManagerRef.current = new StreamSwitchManager(
        mediasoupClientRef.current,
        socket,
        {
          maxRetryAttempts: 3,
          retryDelay: 1000,
          fallbackTimeout: 8000,
          enableFallbackMode: true,
          qualityFallback: true
        }
      );

      // Set StreamSwitchManager callbacks
      streamSwitchManagerRef.current.setCallbacks({
        onSwitchStart: () => {
          // console.log('🔄 WEBRTC: Stream switch starting');
          setSwitchState('switching');
          setError('Switching stream...');
        },
        onSwitchSuccess: (result) => {
          // console.log('✅ WEBRTC: Stream switch successful:', result);
          setSwitchState('idle');
          setIsFallbackMode(result.fallbackActivated);
          setError(result.fallbackActivated ? 'Running in fallback mode' : null);
        },
        onSwitchFail: (result) => {
          console.error('❌ WEBRTC: Stream switch failed:', result);
          setSwitchState('failed');
          setError(`Stream switch failed: ${result.error}`);
        },
        onFallbackActivated: (reason) => {
          console.warn('⚠️ WEBRTC: Fallback mode activated:', reason);
          setIsFallbackMode(true);
          setError(`Fallback mode: ${reason}`);
        },
        onRetryAttempt: (attempt, maxAttempts) => {
          // console.log(`🔄 WEBRTC: Retry attempt ${attempt}/${maxAttempts}`);
          setSwitchState('retrying');
          setError(`Retrying stream switch (${attempt}/${maxAttempts})...`);
        },
        onStateChange: (newState) => {
          setSwitchState(newState);
        }
      });
      
      // Initialize device
      await mediasoupClientRef.current.initialize();
      
      // Create receive transport
      await mediasoupClientRef.current.createRecvTransport();
      
      // Enhanced consume logic with better error handling
      let stream = null;
      let consumeAttempts = 0;
      const maxConsumeAttempts = 5; // Increased attempts
      let lastError: Error | null = null;
      
      while (!stream && consumeAttempts < maxConsumeAttempts) {
        // Check if operation was cancelled
        if (abortControllerRef.current?.signal.aborted) {
          // console.log('🛑 WEBRTC: Initialization cancelled');
          throw new Error('Operation cancelled');
        }
        
        consumeAttempts++;
        // console.log(`📺 WEBRTC: Consume attempt ${consumeAttempts}/${maxConsumeAttempts}`);
        
        try {
          // Verify MediaSoup client is still valid before attempting consume
          if (!mediasoupClientRef.current || mediasoupClientRef.current.destroyed) {
            throw new Error('MediaSoup client is destroyed or invalid');
          }
          
          stream = await mediasoupClientRef.current.consume();
          if (stream) {
            // Verify stream has tracks before considering it successful
            const tracks = stream.getTracks();
            if (tracks.length === 0) {
              console.warn('⚠️ WEBRTC: Stream has no tracks, treating as failed');
              stream = null;
              throw new Error('Stream has no tracks');
            }
            // console.log(`✅ WEBRTC: Stream consumption successful with ${tracks.length} tracks`);
            break;
          } else {
            throw new Error('Consume returned null stream');
          }
        } catch (error) {
          lastError = error as Error;
          console.warn(`⚠️ WEBRTC: Consume attempt ${consumeAttempts} failed:`, error);
          
          // Check for specific error types that indicate we should give up or wait longer
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          
          // No active streamer - give up quickly
          if (errorMessage.includes('No active streamer') && consumeAttempts >= 2) {
            // console.log('🛑 WEBRTC: No active streamer after multiple attempts, stopping retries');
            break;
          }
          
          // Producers not ready - wait longer before retry
          if (errorMessage.includes('producers still initializing') || 
              errorMessage.includes('is not ready yet') ||
              errorMessage.includes('preparing stream') ||
              errorMessage.includes('no producers are ready')) {
            console.log('⏳ WEBRTC: Producers still initializing, will wait longer before retry...');
            // Don't count this as a full attempt if producers aren't ready
            if (consumeAttempts > 1) {
              consumeAttempts--; // Give more chances for producer readiness issues
            }
          }
          
          // Transport issues - may be recoverable
          if (errorMessage.includes('transport') || errorMessage.includes('Transport')) {
            console.log('🔄 WEBRTC: Transport issue detected, will retry with backoff');
          }
        }
        
        // Progressive backoff with extra delay for "not ready" errors
        if (!stream && consumeAttempts < maxConsumeAttempts) {
          const baseDelay = consumeAttempts * 500;
          // Add extra delay for "not ready" errors
          const extraDelay = lastError?.message?.includes('not ready') || 
                            lastError?.message?.includes('initializing') ||
                            lastError?.message?.includes('preparing') ? 1500 : 0;
          const delay = baseDelay + extraDelay;
          // console.log(`⏳ WEBRTC: Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Check if we were cancelled during the wait
          if ((!isActive && !forceInit) || !socket?.connected || abortControllerRef.current?.signal.aborted) {
            // console.log('🛑 WEBRTC: Consume cancelled during wait (inactive, disconnected, or aborted)');
            break;
          }
        }
      }
      
      // Handle complete failure
      if (!stream) {
        const finalError = lastError || new Error('Stream consumption failed after all attempts');
        console.error('❌ WEBRTC: Failed to consume stream after all attempts:', finalError);
        throw finalError;
      }
      
      // Get the current streamer ID from MediaSoup client and store it
      if (mediasoupClientRef.current) {
        const currentStreamer = mediasoupClientRef.current.getCurrentStreamer();
        if (currentStreamer) {
          // console.log(`📝 WEBRTC: Setting currentStreamIdRef to ${currentStreamer} after successful consumption`);
          currentStreamIdRef.current = currentStreamer;
        }
      }
      
      if (stream && videoRef.current) {
        // Ensure video element is ready and not in an interrupted state
        const video = videoRef.current;
        
        // Set the source
        video.srcObject = stream;

        // CRITICAL FIX for iOS Safari: Safari's WebRTC often doesn't fire loadedmetadata
        // We need to call load() explicitly and use a timeout fallback
        const isSafariBrowser = isIOSSafari();

        if (isSafariBrowser) {
          console.log('📱 WEBRTC: iOS Safari detected - using Safari-specific stream handling');
          // Safari needs explicit load() call for WebRTC streams
          video.load();
        }

        // Wait for loadedmetadata with timeout fallback for Safari
        await new Promise<void>((resolve, reject) => {
          let resolved = false;

          const cleanup = () => {
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('error', onError);
            video.removeEventListener('canplay', onCanPlay);
          };

          const onLoadedMetadata = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            console.log('📺 WEBRTC: loadedmetadata fired');
            resolve();
          };

          // Safari fallback: also listen for canplay event which fires more reliably
          const onCanPlay = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            console.log('📺 WEBRTC: canplay fired (Safari fallback)');
            resolve();
          };

          const onError = (e: Event) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            reject(new Error('Video failed to load'));
          };

          video.addEventListener('loadedmetadata', onLoadedMetadata);
          video.addEventListener('error', onError);
          video.addEventListener('canplay', onCanPlay);

          // If metadata is already loaded, resolve immediately
          if (video.readyState >= 1) {
            resolved = true;
            cleanup();
            resolve();
            return;
          }

          // CRITICAL: Timeout fallback for iOS Safari where events may not fire
          // Safari's WebRTC can leave the video in readyState 0 but still playable
          const timeoutMs = isSafariBrowser ? 3000 : 10000;
          setTimeout(() => {
            if (resolved) return;

            // For Safari, if we have a srcObject with tracks, try to proceed anyway
            if (isSafariBrowser && video.srcObject) {
              const mediaStream = video.srcObject as MediaStream;
              if (mediaStream.getTracks().length > 0) {
                console.log('📱 WEBRTC: Safari timeout - proceeding with tracks despite no metadata event');
                resolved = true;
                cleanup();
                resolve();
                return;
              }
            }

            // Otherwise timeout is a failure
            if (!resolved) {
              resolved = true;
              cleanup();
              reject(new Error(`Video metadata timeout after ${timeoutMs}ms`));
            }
          }, timeoutMs);
        });
        
        // Try to play with comprehensive fallback strategies
        try {
          await attemptVideoPlayback(video);
        } catch (playbackError) {
          console.warn('⚠️ WEBRTC: Video playback failed, but connection is established:', playbackError);
          // Don't fail the entire connection just because autoplay failed
          // iOS often needs user interaction to play
        }
        
        setIsConnected(true);
        setConnectionState('connected');
        setSwitchState('idle'); // Clear any switching overlay
        setError(null); // Clear any previous error messages on successful connection

        // Restart viewing session for points tracking
        socket.emit('join-as-viewer');
        // console.log('🎯 WEBRTC: Started viewing session for points tracking');
      } else {
        setError('No active stream available');
        // console.log('⚠️ WEBRTC: No stream to consume');
      }
      
      setIsLoading(false);
    } catch (error) {
      console.error('❌ WEBRTC: Failed to initialize viewer:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to stream';
      
      // Set error for all browsers
      setError(errorMessage);
      
      setIsLoading(false);
      
      // Retry initialization for certain types of errors
      if (errorMessage.includes('No active stream') || errorMessage.includes('consume')) {
        // console.log(`🔄 WEBRTC: Will retry initialization in 3 seconds...`);
        setTimeout(() => {
          if (isActive && !isInitializingRef.current && !isSwitchingRef.current) {
            // console.log('🔄 WEBRTC: Retrying initialization...');
            initializeViewer(true); // Force retry
          }
        }, 3000);
      }
    } finally {
      isInitializingRef.current = false;
    }
  };

  const attemptVideoPlayback = async (video: HTMLVideoElement): Promise<void> => {
    const maxAttempts = 3;
    let attempts = 0;
    const browserInfo = getBrowserInfo();
    
    const tryPlay = async (): Promise<boolean> => {
      attempts++;
      setAutoPlayAttempts(attempts);
      
      try {
        // console.log(`🎬 WEBRTC: Attempting video playback (attempt ${attempts}/${maxAttempts})`);
        
        // Always try muted autoplay for all browsers including iOS
        video.muted = true;
        await video.play();
        setPlaybackState('playing');
        // console.log('✅ WEBRTC: Video muted autoplay successful');
        return true;
        
      } catch (error: any) {
        console.warn(`⚠️ WEBRTC: Playback attempt ${attempts} failed:`, error);
        
        if (error.name === 'NotAllowedError' || error.name === 'NotSupportedError') {
          // Strategy 3: Try muted autoplay if unmuted failed
          if (attempts === 1 && !video.muted) {
            // console.log('🔇 WEBRTC: Unmuted autoplay failed, trying muted...');
            video.muted = true;
            try {
              await video.play();
              setPlaybackState('playing');
              // console.log('✅ WEBRTC: Muted autoplay successful, user interaction needed for audio');
              // Don't return false, playback is working just muted
              return true;
            } catch (mutedError) {
              console.warn('⚠️ WEBRTC: Even muted autoplay failed:', mutedError);
              setPlaybackState('paused');
              // console.log('📺 WEBRTC: User interaction required for playback');
              return false;
            }
          }
          
          // Strategy 4: User interaction required
          setPlaybackState('paused');
          // console.log('📺 WEBRTC: User interaction required for playback');
          return false;
          
        } else if (error.name === 'AbortError') {
          // Strategy 5: Retry after brief delay for AbortError
          if (attempts < maxAttempts) {
            // console.log('🔄 WEBRTC: Retrying playback after AbortError...');
            await new Promise(resolve => setTimeout(resolve, 200 + (attempts * 100)));
            return tryPlay();
          } else {
            setPlaybackState('failed');
            console.error(`Playback failed after ${maxAttempts} attempts: ${error.message}`);
            return false; // Don't throw - just return false
          }
          
        } else {
          // Strategy 6: Other errors - retry with exponential backoff
          if (attempts < maxAttempts) {
            // console.log('🔄 WEBRTC: Retrying playback after error...');
            await new Promise(resolve => setTimeout(resolve, 500 * attempts));
            return tryPlay();
          } else {
            setPlaybackState('failed');
            console.error(`Playback failed after ${maxAttempts} attempts: ${error.message}`);
            return false; // Don't throw - just return false
          }
        }
      }
    };
    
    const success = await tryPlay();
    
    if (!success && playbackState === 'paused') {
      // Strategy 7: Set up user interaction listeners
      setupUserInteractionHandlers(video);
    }
  };

  const setupUserInteractionHandlers = (video: HTMLVideoElement) => {
    const handleUserInteraction = async () => {
      if (!userInteracted) {
        setUserInteracted(true);
        try {
          // Set proper attributes for iOS
          video.setAttribute('playsinline', 'true');
          video.setAttribute('webkit-playsinline', 'true');
          video.setAttribute('x-webkit-airplay', 'allow');
          
          // iOS-specific optimizations
          if (isIOS()) {
            // Disable picture-in-picture which can interfere
            video.setAttribute('disablePictureInPicture', 'true');
            // Set preload to auto for faster start
            video.setAttribute('preload', 'auto');
            // Force immediate load
            video.load();
          }
          
          // Unmute after user interaction
          video.muted = false;
          video.volume = volume;
          
          // Play the video
          await video.play();
          setPlaybackState('playing');
          
          
          // console.log('✅ WEBRTC: Video playback started after user interaction');
        } catch (error) {
          console.error('❌ WEBRTC: Playback failed even after user interaction:', error);
          setPlaybackState('failed');
        }
      }
    };

    // Add event listeners for user interaction
    video.addEventListener('click', handleUserInteraction, { once: true });
    document.addEventListener('click', handleUserInteraction, { once: true });
    document.addEventListener('keydown', handleUserInteraction, { once: true });
    document.addEventListener('touchstart', handleUserInteraction, { once: true });
  };

  const retryPlayback = async () => {
    if (videoRef.current && isConnected) {
      setPlaybackState('loading');
      setAutoPlayAttempts(0);
      setUserInteracted(true); // Mark as interacted since user clicked
      
      const video = videoRef.current;
      
      // For iOS, unmute and ensure decoder starts
      if (isIOS()) {
        video.muted = false; // Can unmute after user interaction
        video.volume = volume;
        
        // Kickstart decoder with a small seek
        if (video.currentTime > 0) {
          video.currentTime = video.currentTime + 0.01;
        }
      }
      
      try {
        await video.play();
        setPlaybackState('playing');
        
        // iOS: Additional decoder kickstart after play
        if (isIOS()) {
          setTimeout(() => {
            if (video.currentTime > 0) {
              video.currentTime = video.currentTime + 0.01;
            }
          }, 100);
        }
      } catch (error) {
        console.error('❌ WEBRTC: Retry playback failed:', error);
        setPlaybackState('failed');
      }
    }
  };

  const handleForceReconnection = async () => {
    const browserInfo = getBrowserInfo();
    
    console.log('🔄 WEBRTC: Force reconnection initiated');
    
    // Clear all states first
    setSwitchState('idle');
    setConnectionState('disconnected');
    setError(null);
    setIsLoading(true);
    
    // Clean up completely before reconnecting
    await cleanupSync();
    
    // Wait a bit for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      setIsLoading(true);
      setError('Reconnecting...');
      
      if (mediasoupClientRef.current) {
        await mediasoupClientRef.current.forceReconnection();
      }
      
      // Try to reinitialize the viewer
      await initializeViewer(true); // Force init
    } catch (error) {
      console.error('❌ WEBRTC: Manual reconnection failed:', error);
      
      if (browserInfo.isIOS) {
        setError('Connection failed. Tap to retry.');
      } else {
        setError(`Manual reconnection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Monitor connection state
  useEffect(() => {
    if (!mediasoupClientRef.current) return;

    const updateConnectionInfo = () => {
      const client = mediasoupClientRef.current;
      if (client) {
        const clientState = client.connectionState;
        // Only update connectionState from client if we're not successfully connected
        // This prevents polling from overriding a successful connection state
        if (!isConnected || clientState === 'connected') {
          setConnectionState(clientState);
        }
        setReconnectionAttempts(client.reconnectionInfo.attempts);
      }
    };

    const interval = setInterval(updateConnectionInfo, 1000);
    return () => clearInterval(interval);
  }, [isConnected]);

  // Socket event handlers for stream switching (always active to detect new streams)
  useEffect(() => {
    if (!socket) return;
    
    // console.log('🔧 WEBRTC: Setting up event listeners for socket:', socket.id);

    const handleStreamSwitch = async (data: { newStreamId: string, streamerId: string, streamType?: string, isTestStream?: boolean, isWebRTC?: boolean }) => {
      // console.log('🔄 WEBRTC: Received legacy stream switch request:', data);
      // console.log('⚠️ WEBRTC: Using legacy new-streamer event - recommend upgrading to stream-ready');
      
      // Process as stream-ready for backward compatibility
      return handleStreamReady({
        newStreamId: data.newStreamId,
        streamerId: data.streamerId,
        streamType: data.streamType,
        isTestStream: data.isTestStream,
        isWebRTC: data.isWebRTC,
        hasVideo: true, // Assume both tracks for legacy events
        hasAudio: true,
        producerVerified: false,
        timestamp: Date.now()
      });
    };

    const handleTakeoverStarted = async (data: {
      streamerId: string,
      newStreamerId: string,
      streamType?: string,
      timestamp?: number
    }) => {
      // console.log('🔄 WEBRTC: Takeover started, preparing for stream switch:', data);
      // console.log(`🔄 WEBRTC: Viewer isActive: ${isActive}, will force activation`);
      // console.log(`🔄 WEBRTC: Current viewer state - isConnected: ${isConnected}, isLoading: ${isLoading}, switchState: ${switchState}`);
      
      // Skip if already processing this stream
      if (currentStreamIdRef.current === data.newStreamerId) {
        // console.log('✅ WEBRTC: Already targeting this stream for switch');
        return;
      }
      
      // Force activation for takeover even if viewer was inactive
      if (!isActive) {
        // console.log('🔄 WEBRTC: Forcing viewer activation for takeover (was inactive)');
        // The parent component should handle this, but we can prepare the UI
      }
      
      // Start the switching UI immediately - this will override "no stream active"
      currentStreamIdRef.current = data.newStreamerId;
      setSwitchState('switching');
      setError('Stream takeover in progress...');
      setIsLoading(true);
      
      // Ensure we exit any "waiting for stream" state
      if (!isConnected && !isLoading) {
        // console.log('🔄 WEBRTC: Activating viewer from idle state for takeover');
      }
      
      // Clean up current connection immediately
      if (mediasoupClientRef.current) {
        // console.log('🧹 WEBRTC: Pre-cleaning connection for takeover');
        await mediasoupClientRef.current.cleanup();
        mediasoupClientRef.current = null;
      }
      
      // Reset video element
      if (videoRef.current) {
        // Clean up test pattern animation if it exists
        if ((videoRef.current as any)._testPatternAnimation) {
          clearInterval((videoRef.current as any)._testPatternAnimation);
          (videoRef.current as any)._testPatternAnimation = null;
        }
        
        videoRef.current.pause();
        videoRef.current.srcObject = null;
        videoRef.current.load();
      }
      
      // Reset connection states
      setIsConnected(false);
      setPlaybackState('loading');
      
      // Clear "no stream active" by ensuring we show loading state
      setError(null); // Clear any previous "no active stream" errors
      
      // console.log('✅ WEBRTC: Ready for stream-ready event from new streamer');
      
      // Set up fallback timeout in case stream-ready never comes
      const fallbackTimer = setTimeout(async () => {
        // Check current state, not captured state
        if (currentStreamIdRef.current === data.newStreamerId) {
          // console.log('⚠️ WEBRTC: stream-ready timeout after takeover, checking current state...');
          // console.log(`⚠️ WEBRTC: Current switchState: ${switchState}, isConnected: ${isConnected}`);
          
          if (!isConnected) {
            // console.log('⚠️ WEBRTC: Attempting fallback connection after stream-ready timeout');
            setError('Stream producer delay, attempting direct connection...');
            setSwitchState('retrying');
            
            try {
              await initializeViewer(true); // Force fallback init
              setSwitchState('idle');
              setError(null);
              // console.log('✅ WEBRTC: Fallback connection successful');
            } catch (error) {
              console.error('❌ WEBRTC: Fallback connection failed:', error);
              setSwitchState('failed');
              setError('Connection failed: New stream may not be ready');
              
              // Try one more time after additional delay
              setTimeout(async () => {
                // console.log('🔄 WEBRTC: Final retry attempt...');
                try {
                  await initializeViewer(true); // Force final retry
                  setSwitchState('idle');
                  setError(null);
                } catch (finalError) {
                  console.error('❌ WEBRTC: Final retry failed:', finalError);
                  setError('Unable to connect to new stream');
                }
              }, 3000);
            }
          }
        }
      }, 3000); // 3 second fallback timeout
      
      // Store timer for potential cleanup
      (globalThis as any)._webrtcFallbackTimer = fallbackTimer;
    };

    const handleStreamReady = async (data: {
      newStreamId: string,
      streamerId: string,
      streamType?: string,
      isTestStream?: boolean,
      isWebRTC?: boolean,
      hasVideo?: boolean,
      hasAudio?: boolean,
      producerVerified?: boolean,
      fallback?: boolean,
      timestamp?: number
    }) => {
      console.log('🎬 WEBRTC: Received stream-ready notification:', data);
      console.log(`🎬 WEBRTC: Current state - streamId: ${currentStreamIdRef.current}, isConnected: ${isConnected}, switchState: ${switchState}`);

      // CRITICAL FIX: Don't process stream-ready while initialization is in progress
      // This prevents race conditions where a stream-ready arrives mid-init and destroys a working connection
      if (isInitializingRef.current) {
        console.log(`⏭️ WEBRTC: Ignoring stream-ready during initialization (streamId: ${data.newStreamId})`);
        return;
      }

      // CRITICAL FIX: Comprehensive deduplication to prevent unnecessary reconnections
      const isSameStream = currentStreamIdRef.current === data.newStreamId;
      const isAlreadyConnected = isConnected && switchState === 'idle';
      const isCurrentlySwitchingToThis = isSameStream &&
        (switchState === 'switching' || switchState === 'retrying');

      // Skip if: same stream + connected OR same stream + currently switching to it
      if (isSameStream && (isAlreadyConnected || isCurrentlySwitchingToThis)) {
        console.log(`⏭️ WEBRTC: Ignoring duplicate stream-ready for ${data.newStreamId} (connected: ${isAlreadyConnected}, switching: ${isCurrentlySwitchingToThis})`);
        return;
      }

      // If this is a different stream, process it
      const isDifferentStream = !isSameStream;

      if (isDifferentStream) {
        console.log(`🔄 WEBRTC: New stream detected - switching from ${currentStreamIdRef.current || 'none'} to ${data.newStreamId}`);
      } else {
        console.log(`🔄 WEBRTC: Retrying connection to ${data.newStreamId} (previous attempt may have failed)`);
      }

      // CRITICAL FIX: Cancel any pending stream switch operations
      if (streamSwitchAbortController.current) {
        console.log('🛑 WEBRTC: Canceling previous stream switch operation');
        streamSwitchAbortController.current.abort();
      }

      // Create new abort controller for this stream switch
      streamSwitchAbortController.current = new AbortController();
      const switchSignal = streamSwitchAbortController.current.signal;

      try {
        // Check if operation was cancelled
        if (switchSignal.aborted) {
          console.log('🛑 WEBRTC: Stream switch was cancelled before starting');
          return;
        }

        console.log(`🎬 WEBRTC: Processing stream-ready for ${data.newStreamId} (verified: ${data.producerVerified})`);

        if (isDifferentStream) {
          // This is a fresh stream (not from takeover), need to setup
          // console.log('🔄 WEBRTC: Fresh stream detected, setting up switch');
          currentStreamIdRef.current = data.newStreamId;
          setSwitchState('switching');
          setError(`Connecting to stream${data.producerVerified ? ' (verified)' : ''}...`);
          setIsLoading(true);
          
          // Clean up current connection for fresh streams
          if (mediasoupClientRef.current) {
            // console.log('🧹 WEBRTC: Cleaning up existing connection for fresh stream');
            
            // Cancel any ongoing initialization to prevent race conditions
            if (abortControllerRef.current) {
              abortControllerRef.current.abort();
              abortControllerRef.current = null;
            }
            isInitializingRef.current = false;
            
            await mediasoupClientRef.current.cleanup();
            mediasoupClientRef.current = null;
          }
          
          // Reset video element
          if (videoRef.current) {
            if ((videoRef.current as any)._testPatternAnimation) {
              clearInterval((videoRef.current as any)._testPatternAnimation);
              (videoRef.current as any)._testPatternAnimation = null;
            }
            videoRef.current.pause();
            videoRef.current.srcObject = null;
            videoRef.current.load();
          }
          
          setIsConnected(false);
          setPlaybackState('loading');
        } else {
          // This is expected from takeover-started, just update status
          // console.log('🎬 WEBRTC: Expected stream-ready from takeover, proceeding with connection');
          setError(`Connecting to stream${data.producerVerified ? ' (verified)' : ''}...`);
        }
        


        // Wait longer if producer not verified, shorter if verified
        const waitTime = data.producerVerified ? 200 : 800;
        console.log(`⏳ WEBRTC: Waiting ${waitTime}ms for producer stability...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Check if cancelled after wait
        if (switchSignal.aborted) {
          console.log('🛑 WEBRTC: Stream switch was cancelled during wait');
          setSwitchState('idle');
          setError(null);
          return;
        }

        // Initialize connection directly
        console.log('🔄 WEBRTC: Initializing connection for stream switch');
        setSwitchState('switching');

        try {
          await initializeViewer(true); // Force init for stream switching

          // Check if cancelled after initialization
          if (switchSignal.aborted) {
            console.log('🛑 WEBRTC: Stream switch was cancelled after initialization');
            setSwitchState('idle');
            setError(null);
            return;
          }

          setSwitchState('idle');
          setError(null);
          console.log('✅ WEBRTC: Stream switch completed successfully');

          // Restart viewing session for points tracking
          socket.emit('join-as-viewer');
          console.log('🎯 WEBRTC: Restarted viewing session for points tracking');
        } catch (error) {
          // Check if this was an abort
          if (error instanceof Error && error.name === 'AbortError') {
            console.log('🛑 WEBRTC: Stream switch was aborted');
            return;
          }

          console.error('❌ WEBRTC: Stream switch failed:', error);
          setSwitchState('failed');
          setError(`Stream switch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

      } catch (error) {
        // Check if this was an abort
        if (error instanceof Error && error.name === 'AbortError') {
          console.log('🛑 WEBRTC: Stream switch operation was aborted');
          return;
        }

        console.error('❌ WEBRTC: Stream switch failed after all attempts:', error);
        setSwitchState('failed');
        setError(`Stream switch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        
        // Final fallback retry after longer delay
        setTimeout(async () => {
          // console.log('🔄 WEBRTC: Final fallback retry...');
          setSwitchState('retrying');
          setError('Final retry attempt...');
          
          try {
            await initializeViewer(true); // Force fallback retry
            setSwitchState('idle');
            setError(null);
            // console.log('✅ WEBRTC: Fallback retry succeeded');
            
            // Restart viewing session for points tracking
            socket.emit('join-as-viewer');
            // console.log('🎯 WEBRTC: Restarted viewing session for points tracking (fallback)');
          } catch (retryError) {
            console.error('❌ WEBRTC: Final retry failed:', retryError);
            setSwitchState('failed');
            setError('Connection failed. Please refresh the page.');
          }
        }, 5000);
      }
    };

    const handleTestStreamRequest = async () => {
      // console.log('🧪 WEBRTC: Test stream requested via fallback');
      // The StreamSwitchManager will handle this internally via fallback strategies
    };

    const handleTestPatternStream = async (data: { streamerId: string, testConfig: { pattern: string, resolution: string, frameRate: number }, isViewBot?: boolean }) => {
      // console.log('🎨 WEBRTC: Test pattern stream requested:', data);
      
      try {
        // Skip if already processing this stream
        if (currentStreamIdRef.current === data.streamerId) {
          // console.log('✅ WEBRTC: Already displaying this test pattern');
          return;
        }
        
        const streamType = data.isViewBot ? 'ViewBot' : 'Test pattern';
        // console.log(`🎨 WEBRTC: Starting client-side ${streamType} generation`);
        setSwitchState('switching');
        setError(`Generating ${streamType.toLowerCase()}...`);
        // ViewBot streams are now real WebRTC streams, not fallback patterns
        setIsFallbackMode(false); // ViewBot streams are handled like regular WebRTC streams
        
        // Update current stream ID immediately
        currentStreamIdRef.current = data.streamerId;
        
        // Clean up existing MediaSoup connection
        if (mediasoupClientRef.current) {
          // console.log(`🧹 WEBRTC: Cleaning up MediaSoup connection for ${streamType}`);
          await mediasoupClientRef.current.cleanup();
          mediasoupClientRef.current = null;
        }
        
        // Generate test pattern directly in video element
        await generateTestPattern(data.testConfig);
        
        setIsConnected(true);
        setSwitchState('idle');
        setError(null);
        // console.log(`✅ WEBRTC: ${streamType} generation completed`);
        
      } catch (error) {
        console.error(`❌ WEBRTC: ${data.isViewBot ? 'ViewBot' : 'Test pattern'} generation failed:`, error);
        setSwitchState('failed');
        setError(`${data.isViewBot ? 'ViewBot' : 'Test pattern'} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    };


    const handleStreamEnded = async (data?: { reason?: string, previousStreamer?: string, newStreamer?: string }) => {
      console.log('🔔 WEBRTC: Stream ended event received:', data);

      // Clean up video display
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        console.log('🧹 WEBRTC: Cleared video element');
      }

      // Reset state
      setError(null);
      setIsConnected(false);

      // If this is a takeover, prepare for the new stream
      if (data?.reason === 'takeover') {
        console.log(`🔄 WEBRTC: Takeover detected - old: ${data.previousStreamer}, new: ${data.newStreamer}`);

        // CRITICAL: Reset initialization flag to allow new connection
        isInitializingRef.current = false;

        // Clear current stream ID to allow reconnection
        // Note: The new currentStreamerId prop will trigger reconnection via useEffect
        // But we also clear this ref to ensure stream-ready can also trigger reconnection
        if (data.previousStreamer && currentStreamIdRef.current === data.previousStreamer) {
          console.log(`🧹 WEBRTC: Clearing currentStreamIdRef (was: ${currentStreamIdRef.current})`);
          currentStreamIdRef.current = null;
        }

        // Set loading state while waiting for new stream
        setIsLoading(true);
        setError('Switching to new stream...');
        setSwitchState('switching');

        if (mediasoupClientRef.current) {
          console.log('🧹 WEBRTC: Takeover detected, cleaning up consumers before new stream');
          try {
            await mediasoupClientRef.current.cleanup();
            mediasoupClientRef.current = null;
            console.log('✅ WEBRTC: Takeover cleanup completed');
          } catch (error) {
            console.error('❌ WEBRTC: Takeover cleanup failed:', error);
          }
        }
      } else {
        // For normal stream ending (like disconnect), also clean up
        console.log('🧹 WEBRTC: Stream ended normally, cleaning up consumers');
        currentStreamIdRef.current = null;
        isInitializingRef.current = false;
        setSwitchState('idle');

        if (mediasoupClientRef.current) {
          try {
            await mediasoupClientRef.current.cleanup();
            mediasoupClientRef.current = null;
            console.log('✅ WEBRTC: Normal stream end cleanup completed');
          } catch (error) {
            console.error('❌ WEBRTC: Normal stream end cleanup failed:', error);
          }
        }
      }
    };

    socket.on('new-streamer', handleStreamSwitch);
    socket.on('stream-ready', handleStreamReady);
    socket.on('test-stream-available', handleTestStreamRequest);
    socket.on('test-pattern-stream', handleTestPatternStream);
    socket.on('stream-ended', handleStreamEnded);
    
    // console.log('✅ WEBRTC: Event listeners registered (simple mode)');

    return () => {
      // console.log('🧹 WEBRTC: Cleaning up event listeners');
      socket.off('new-streamer', handleStreamSwitch);
      socket.off('stream-ready', handleStreamReady);
      socket.off('test-stream-available', handleTestStreamRequest);
      socket.off('test-pattern-stream', handleTestPatternStream);
      socket.off('stream-ended', handleStreamEnded);
    };
  }, [socket]); // Remove isActive dependency so events are always listened to

  const generateTestPattern = async (testConfig: { pattern: string, resolution: string, frameRate: number }) => {
    // console.log('🎨 WEBRTC: Generating test pattern:', testConfig);
    
    if (!videoRef.current) {
      throw new Error('Video element not available');
    }
    
    const video = videoRef.current;
    
    // Parse resolution
    const [width, height] = testConfig.resolution.split('x').map(Number);
    const frameRate = testConfig.frameRate || 30;
    
    // Create canvas for pattern generation
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Cannot get canvas context');
    }
    
    // console.log(`🎨 WEBRTC: Creating ${testConfig.pattern} pattern at ${width}x${height} @ ${frameRate}fps`);
    
    // Generate different patterns based on configuration
    let frameCount = 0;
    const startTime = Date.now();
    
    const drawFrame = () => {
      const elapsed = Date.now() - startTime;
      const currentFrame = Math.floor(elapsed / (1000 / frameRate));
      
      if (currentFrame <= frameCount) {
        return; // Skip if we're ahead of schedule
      }
      
      frameCount = currentFrame;
      
      // Clear canvas
      ctx.clearRect(0, 0, width, height);
      
      switch (testConfig.pattern) {
        case 'color-bars':
          drawColorBars(ctx, width, height);
          break;
        case 'moving-text':
          drawMovingText(ctx, width, height, elapsed);
          break;
        case 'clock':
          drawClock(ctx, width, height);
          break;
        case 'noise':
          drawNoise(ctx, width, height);
          break;
        case 'gradient':
          drawGradient(ctx, width, height, elapsed);
          break;
        default:
          drawSolidColor(ctx, width, height, '#808080');
      }
      
      // Add frame counter and uptime
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(10, 10, 300, 60);
      ctx.fillStyle = 'white';
      ctx.font = '16px monospace';
      ctx.fillText(`OneStreamer Test Pattern`, 20, 30);
      ctx.fillText(`Frame: ${frameCount} | Uptime: ${Math.floor(elapsed / 1000)}s`, 20, 50);
    };
    
    // Start animation loop
    const animationId = setInterval(drawFrame, 1000 / frameRate);
    
    // Convert canvas to video stream
    const stream = canvas.captureStream(frameRate);
    
    // Set video source
    video.srcObject = stream;
    video.muted = true; // Test patterns don't have audio
    
    // Store animation ID for cleanup
    (video as any)._testPatternAnimation = animationId;
    
    // Wait for video to load and play
    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
        resolve();
      };
      
      const onError = (e: Event) => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
        reject(new Error('Test pattern video failed to load'));
      };
      
      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('error', onError);
      
      if (video.readyState >= 1) {
        onLoadedMetadata();
      }
    });
    
    // Attempt to play
    try {
      await video.play();
      setPlaybackState('playing');
      // console.log('✅ WEBRTC: Test pattern video playing');
    } catch (error) {
      console.warn('⚠️ WEBRTC: Test pattern autoplay failed, requiring user interaction');
      setPlaybackState('paused');
      setupUserInteractionHandlers(video);
    }
  };
  
  // Pattern drawing functions
  const drawColorBars = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const colors = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
    const barWidth = width / colors.length;
    
    colors.forEach((color, index) => {
      ctx.fillStyle = color;
      ctx.fillRect(index * barWidth, 0, barWidth, height);
    });
  };
  
  const drawMovingText = (ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number) => {
    ctx.fillStyle = '#000080';
    ctx.fillRect(0, 0, width, height);
    
    ctx.fillStyle = 'white';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    
    const text = `OneStreamer Test • ${Math.floor(elapsed / 1000)}s`;
    const x = width / 2;
    const y = height / 2 + Math.sin(elapsed / 1000) * 50;
    
    ctx.fillText(text, x, y);
  };
  
  const drawClock = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.fillStyle = '#001122';
    ctx.fillRect(0, 0, width, height);
    
    const now = new Date();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 64px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(now.toLocaleTimeString(), width / 2, height / 2 - 20);
    
    ctx.font = 'bold 32px monospace';
    ctx.fillText(now.toLocaleDateString(), width / 2, height / 2 + 40);
  };
  
  const drawNoise = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
      const noise = Math.random() * 255;
      data[i] = noise;     // Red
      data[i + 1] = noise; // Green
      data[i + 2] = noise; // Blue
      data[i + 3] = 255;   // Alpha
    }
    
    ctx.putImageData(imageData, 0, 0);
  };
  
  const drawGradient = (ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number) => {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    const hue = (elapsed / 50) % 360;
    gradient.addColorStop(0, `hsl(${hue}, 100%, 50%)`);
    gradient.addColorStop(0.5, `hsl(${(hue + 120) % 360}, 100%, 50%)`);
    gradient.addColorStop(1, `hsl(${(hue + 240) % 360}, 100%, 50%)`);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  };
  
  const drawSolidColor = (ctx: CanvasRenderingContext2D, width: number, height: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
  };

  const cleanup = async () => {
    // console.log('🧹 WEBRTC: Cleaning up WebRTC viewer');
    
    // Clear any pending initialization
    if (initTimeoutRef.current) {
      clearTimeout(initTimeoutRef.current);
      initTimeoutRef.current = null;
    }
    
    // Reset initialization flag
    isInitializingRef.current = false;
    
    if (mediasoupClientRef.current) {
      await mediasoupClientRef.current.cleanup();
      mediasoupClientRef.current = null;
    }

    if (streamSwitchManagerRef.current) {
      streamSwitchManagerRef.current.cleanup();
      streamSwitchManagerRef.current = null;
    }
    
    if (videoRef.current) {
      // Clean up test pattern animation if it exists
      if ((videoRef.current as any)._testPatternAnimation) {
        clearInterval((videoRef.current as any)._testPatternAnimation);
        (videoRef.current as any)._testPatternAnimation = null;
        // console.log('🧹 WEBRTC: Test pattern animation cleaned up');
      }
      
      // Pause before clearing to avoid play interruption errors
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.load(); // Reset the video element state
    }
    
    setIsConnected(false);
    setIsLoading(false);
    setPlaybackState('loading');
    setAutoPlayAttempts(0);
    setUserInteracted(false);
    setConnectionState('disconnected');
    setReconnectionAttempts(0);
    
    // Clear any pending play retry
    if (playRetryTimeoutRef.current) {
      clearTimeout(playRetryTimeoutRef.current);
      playRetryTimeoutRef.current = null;
    }
  };

  const cleanupSync = () => {
    // console.log('🧹 WEBRTC: Synchronous cleanup WebRTC viewer');
    
    // Clear any pending initialization
    if (initTimeoutRef.current) {
      clearTimeout(initTimeoutRef.current);
      initTimeoutRef.current = null;
    }
    
    // Reset flags
    isInitializingRef.current = false;
    isSwitchingRef.current = false;
    
    if (mediasoupClientRef.current) {
      // Fire and forget async cleanup
      mediasoupClientRef.current.cleanup().catch(console.error);
      mediasoupClientRef.current = null;
    }
    
    if (videoRef.current) {
      // Clean up test pattern animation if it exists
      if ((videoRef.current as any)._testPatternAnimation) {
        clearInterval((videoRef.current as any)._testPatternAnimation);
        (videoRef.current as any)._testPatternAnimation = null;
        // console.log('🧹 WEBRTC: Test pattern animation cleaned up (sync)');
      }
      
      // Pause before clearing to avoid play interruption errors
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.load(); // Reset the video element state
    }
    
    setIsConnected(false);
    setIsLoading(false);
    setError(null);
    setPlaybackState('loading');
    setAutoPlayAttempts(0);
    setUserInteracted(false);
    setConnectionState('disconnected');
    setReconnectionAttempts(0);
    setSwitchState('idle');
    
    // Clear any pending play retry
    if (playRetryTimeoutRef.current) {
      clearTimeout(playRetryTimeoutRef.current);
      playRetryTimeoutRef.current = null;
    }
  };

  const handleVideoClick = async () => {
    const video = videoRef.current;
    if (!video) return;

    // Handle paused video - need to play
    if (video.paused) {
      setUserInteracted(true);

      // iOS just needs unmute and play
      if (isIOS()) {
        video.muted = false;
        video.volume = volume;
        // Persist unmuted state so it's preserved during stream switches
        setIsMuted(false);
        CookieService.setCookie(COOKIE_NAMES.MUTED, false);
      }

      video.play().catch(e => {
        console.error('❌ WEBRTC: Manual play failed:', e);
        setError('Unable to play stream');
      });
    }
    // Handle playing but muted video (muted autoplay succeeded) - need to unmute
    else if (video.muted && !userInteracted) {
      console.log('🔊 WEBRTC: User clicked to unmute muted autoplay');
      setUserInteracted(true);
      video.muted = false;
      video.volume = volume;
      // Persist unmuted state so it's preserved during stream switches
      setIsMuted(false);
      CookieService.setCookie(COOKIE_NAMES.MUTED, false);
    }
    // Show controls on video click
    showControlsTemporary();
  };

  const togglePause = () => {
    if (!videoRef.current) return;
    
    // Mark user as interacted when they use pause/play controls
    if (!userInteracted) {
      setUserInteracted(true);
    }
    
    if (isPaused) {
      videoRef.current.play().then(() => {
        setIsPaused(false);
        setPlaybackState('playing');
      }).catch(e => {
        console.error('❌ WEBRTC: Play failed:', e);
        setPlaybackState('failed');
      });
    } else {
      videoRef.current.pause();
      setIsPaused(true);
      setPlaybackState('paused');
    }
  };

  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    
    // Save volume to cookie
    CookieService.setCookie(COOKIE_NAMES.VOLUME, newVolume);
    
    // Update muted state
    const muted = newVolume === 0;
    setIsMuted(muted);
    CookieService.setCookie(COOKIE_NAMES.MUTED, muted);
    
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = muted;
      
      // First time volume is changed, ensure user has interacted
      if (!userInteracted) {
        setUserInteracted(true);
      }
    }
  };

  const showControlsTemporary = () => {
    setShowControls(true);
    
    // Clear existing timeout
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    
    // Hide controls after 3 seconds
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  };

  const handleMouseMove = () => {
    // Show controls on mouse movement, but don't change interaction state
    // This prevents autoplay issues when just moving mouse over video
    showControlsTemporary();
  };

  const toggleFullscreen = async () => {
    const videoContainer = videoRef.current?.parentElement;
    if (!videoContainer) return;

    try {
      if (!isFullscreen) {
        // Enter fullscreen
        if (videoContainer.requestFullscreen) {
          await videoContainer.requestFullscreen();
        } else if ((videoContainer as any).webkitRequestFullscreen) {
          await (videoContainer as any).webkitRequestFullscreen();
        } else if ((videoContainer as any).mozRequestFullScreen) {
          await (videoContainer as any).mozRequestFullScreen();
        } else if ((videoContainer as any).msRequestFullscreen) {
          await (videoContainer as any).msRequestFullscreen();
        }
      } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        } else if ((document as any).mozCancelFullScreen) {
          await (document as any).mozCancelFullScreen();
        } else if ((document as any).msExitFullscreen) {
          await (document as any).msExitFullscreen();
        }
      }
    } catch (error) {
      console.error('Fullscreen toggle failed:', error);
    }
  };

  const handleRetry = async () => {
    await cleanup();
    if (socket?.connected) { // Remove isActive requirement for retry
      initializeViewer(true); // Force init on manual retry
    }
  };

  const handleExitFallback = async () => {
    if (streamSwitchManagerRef.current && isFallbackMode) {
      // console.log('🔧 WEBRTC: Attempting to exit fallback mode');
      
      try {
        const success = await streamSwitchManagerRef.current.exitFallbackMode();
        if (success) {
          setIsFallbackMode(false);
          setError(null);
          // console.log('✅ WEBRTC: Successfully exited fallback mode');
          
          // Reinitialize viewer with normal operation
          await initializeViewer(true); // Force init for fallback exit
        } else {
          console.warn('⚠️ WEBRTC: Failed to exit fallback mode');
          setError('Unable to exit fallback mode');
        }
      } catch (error) {
        console.error('❌ WEBRTC: Error exiting fallback mode:', error);
        setError(`Fallback exit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  };

  return (
    <div className={`webrtc-viewer ${className}`} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Canvas Effect Overlay - Only render when there's an active stream or connection */}
      {(isActive || isConnected) && (
        <CanvasEffectOverlay
          videoRef={videoRef}
          socket={socket}
          isActive={isActive || isConnected}
          className="stream-effects-overlay"
        />
      )}
      
      {isLoading && (
        <div className="webrtc-loading">
          <div className="loading-spinner"></div>
          <p>Connecting to stream...</p>
        </div>
      )}
      
      {error && (
        <div className="webrtc-error">
          <p>⚠️ {error}</p>
          {/* iOS-specific error handling */}
          {isIOS() && (
            <p style={{ fontSize: '14px', opacity: 0.8, marginTop: '10px' }}>
              {error.includes('Tap') ? '👆 Tap anywhere on the screen' : 
               'iOS Safari requires user interaction to start streaming'}
            </p>
          )}
          <button 
            onClick={handleRetry}
            className="retry-button"
            style={isIOS() ? { 
              padding: '12px 24px', 
              fontSize: '16px',
              backgroundColor: '#007AFF' // iOS blue
            } : {}}
          >
            {isIOS() ? 'Tap to Connect' : 'Retry Connection'}
          </button>
        </div>
      )}


      {/* Playback Status Overlay */}
      {isConnected && playbackState === 'paused' && (
        <div className="playback-overlay" style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          zIndex: 10,
          cursor: 'pointer'
        }}
        onClick={retryPlayback}
        >
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>▶️</div>
          <p style={{ textAlign: 'center', margin: '10px', fontSize: '18px' }}>
            {isIOS() ? 'Tap to start stream' : 'Click to play stream'}
          </p>
          <p style={{ textAlign: 'center', margin: '5px', fontSize: '14px', opacity: 0.7 }}>
            {isIOS() ? 'iOS requires user interaction to play video' : 'Auto-play was blocked by your browser'}
          </p>
        </div>
      )}

      {/* Muted Audio Indicator - Show in non-theatre mode, TheatreMuteIndicator handles theatre mode */}
      {isConnected && playbackState === 'playing' && videoRef.current?.muted && !userInteracted && !document.querySelector('.App.theatre-mode') && (
        <div 
          className="muted-audio-indicator" 
          style={{
            position: 'absolute',
            bottom: '250px', // Moved much higher to avoid any overlap
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0, 0, 0, 0.9)',
            color: 'white',
            padding: '12px 20px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            cursor: 'pointer',
            zIndex: 500,
            animation: 'pulse 2s infinite',
            backdropFilter: 'blur(4px)',
            pointerEvents: 'auto',
            width: 'auto',
            height: 'auto',
            maxWidth: '300px'
          }}
          onClick={() => {
            if (videoRef.current) {
              videoRef.current.muted = false;
              setUserInteracted(true);
              handleVolumeChange(0.8); // Set to 80% volume
            }
          }}
        >
          <span style={{ fontSize: '24px', flexShrink: 0 }}>🔇</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <p style={{ margin: 0, fontSize: '14px', fontWeight: 'bold', whiteSpace: 'nowrap' }}>Click to unmute</p>
            <p style={{ margin: 0, fontSize: '12px', opacity: 0.8, whiteSpace: 'nowrap' }}>Audio is currently muted</p>
          </div>
        </div>
      )}

      {/* Stream Switch Status Overlay */}
      {switchState !== 'idle' && (
        <div className="stream-switch-status" style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: switchState === 'failed' ? 'rgba(139, 0, 0, 0.8)' : 'rgba(33, 150, 243, 0.8)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          zIndex: 12
        }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>
            {switchState === 'switching' ? '🔄' : 
             switchState === 'retrying' ? '⏳' : 
             switchState === 'fallback' ? '🔧' : '❌'}
          </div>
          <p style={{ textAlign: 'center', margin: '10px', fontSize: '18px' }}>
            {switchState === 'switching' ? (isIOS() ? 'Connecting...' : 'Switching Stream...') :
             switchState === 'retrying' ? (isIOS() ? 'Reconnecting...' : 'Retrying Stream Switch...') :
             switchState === 'fallback' ? 'Fallback Mode Active' :
             (isIOS() ? 'Connection Failed' : 'Stream Switch Failed')}
          </p>
          {isFallbackMode && (
            <p style={{ textAlign: 'center', margin: '5px', fontSize: '14px', opacity: 0.8 }}>
              Running with reduced functionality
            </p>
          )}
        </div>
      )}

      {/* Fallback Mode Indicator */}
      {isFallbackMode && switchState === 'idle' && (
        <div style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          background: 'rgba(255, 152, 0, 0.9)',
          color: 'white',
          padding: '5px 10px',
          borderRadius: '4px',
          fontSize: '12px',
          zIndex: 25,
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span>🔧 Fallback Mode</span>
          <button
            onClick={handleExitFallback}
            style={{
              background: 'rgba(255, 255, 255, 0.2)',
              color: 'white',
              border: '1px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '3px',
              padding: '2px 6px',
              fontSize: '10px',
              cursor: 'pointer',
              transition: 'background 0.2s ease'
            }}
            onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.3)'}
            onMouseOut={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'}
          >
            Exit
          </button>
        </div>
      )}

      {/* Connection Recovery Overlay */}
      {connectionState === 'reconnecting' && (
        <div className="connection-recovery" style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(255, 165, 0, 0.8)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          zIndex: 15
        }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>🔄</div>
          <p style={{ textAlign: 'center', margin: '10px', fontSize: '18px' }}>
            Reconnecting to stream...
          </p>
          <p style={{ textAlign: 'center', margin: '5px', fontSize: '14px', opacity: 0.7 }}>
            Attempt {reconnectionAttempts} of 5
          </p>
          <button 
            onClick={handleForceReconnection}
            style={{
              background: '#ff8c00',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              cursor: 'pointer',
              marginTop: '15px',
              fontSize: '14px'
            }}
          >
            Force Reconnect
          </button>
        </div>
      )}

      {/* Playback Retry Indicator */}
      {isConnected && playbackState === 'failed' && (
        <div className="playback-failed" style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(139, 0, 0, 0.8)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          zIndex: 10
        }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>⚠️</div>
          <p style={{ textAlign: 'center', margin: '10px', fontSize: '18px' }}>
            Playback failed
          </p>
          <p style={{ textAlign: 'center', margin: '5px', fontSize: '14px', opacity: 0.7 }}>
            Attempted {autoPlayAttempts} times
          </p>
          <button 
            onClick={retryPlayback}
            style={{
              background: '#dc3545',
              color: 'white',
              border: 'none',
              padding: '12px 24px',
              borderRadius: '6px',
              cursor: 'pointer',
              marginTop: '15px',
              fontSize: '16px'
            }}
          >
            Try Again
          </button>
        </div>
      )}
      
      <video
        ref={videoRef}
        className="webrtc-video"
        controls={false}
        autoPlay
        playsInline
        muted={true} // Always start muted for autoplay to work
        {...(isIOS() && {
          'webkit-playsinline': 'true',
          'x-webkit-airplay': 'allow'
        } as any)}
        crossOrigin="anonymous"
        preload="auto"
        onClick={(e) => {
          // Don't handle video clicks if canvas debug mode might be active
          // The canvas overlay will handle its own clicks when in debug mode
          handleVideoClick();
        }}
        onMouseMove={handleMouseMove}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#000',
          objectFit: 'contain', // Changed to contain to show full frame without cropping
          display: isConnected && (playbackState === 'playing' || playbackState === 'paused') ? 'block' : 'none',
          position: 'relative',
          zIndex: 1, // Lower z-index than canvas overlay (which is 1000+)
          // Mobile Chrome specific fixes
          WebkitTransform: 'translateZ(0)', // Force hardware acceleration
          transform: 'translateZ(0)',
          WebkitBackfaceVisibility: 'hidden',
          backfaceVisibility: 'hidden'
        }}
      />

      {/* Custom Video Controls */}
      {isConnected && playbackState === 'playing' && showControls && (
        <div 
          className="video-controls"
          style={{
            position: 'absolute',
            bottom: '20px',
            left: '20px',
            right: '20px',
            background: 'rgba(0, 0, 0, 0.8)',
            borderRadius: '8px',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            zIndex: 30,
            backdropFilter: 'blur(4px)'
          }}
          onMouseMove={handleMouseMove}
        >
          {/* Play/Pause Button */}
          <button
            onClick={togglePause}
            style={{
              background: 'none',
              border: 'none',
              color: 'white',
              fontSize: '24px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              transition: 'background 0.2s ease'
            }}
            onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.background = 'none'}
          >
            {isPaused ? '▶️' : '⏸️'}
          </button>

          {/* Volume Control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => handleVolumeChange(volume === 0 ? 0.8 : 0)}
              style={{
                background: 'none',
                border: 'none',
                color: 'white',
                fontSize: '20px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '4px'
              }}
            >
              {volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              style={{
                width: '80px',
                height: '4px',
                background: '#444',
                borderRadius: '2px',
                outline: 'none',
                cursor: 'pointer'
              }}
            />
          </div>

          {/* Live Indicator */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#ff4444',
                animation: 'pulse 2s infinite'
              }}
            />
            <span style={{ color: 'white', fontSize: '14px', fontWeight: 'bold' }}>LIVE</span>
          </div>

          {/* Fullscreen Button */}
          <button
            onClick={toggleFullscreen}
            style={{
              background: 'none',
              border: 'none',
              color: 'white',
              fontSize: '20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              transition: 'background 0.2s ease',
              marginLeft: '8px'
            }}
            onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.background = 'none'}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? '⊡' : '⊞'}
          </button>
        </div>
      )}
      
      {!isLoading && !error && !isConnected && (
        <div className="webrtc-waiting">
          <p>Waiting for stream...</p>
        </div>
      )}


      {/* Performance Monitor */}
      {showPerformanceMonitor && (
        <PerformanceMonitorComponent
          peerConnection={peerConnection}
          isActive={isConnected}
          showDetailed={process.env.NODE_ENV === 'development'}
        />
      )}
    </div>
  );
};

export default WebRTCViewer;