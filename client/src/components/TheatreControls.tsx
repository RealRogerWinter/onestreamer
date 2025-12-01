import React, { useState, useEffect, useRef } from 'react';
import StreamerSettings, { StreamerSettingsConfig } from './StreamerSettings';
import TheatreMuteIndicator from './TheatreMuteIndicator';
import BuffDisplay from './BuffDisplay';
import PermissionSetupModal from './PermissionSetupModal';
import { ClipCreationModal } from './clips';
import PermissionService, { MediaPermissions } from '../services/PermissionService';
import './TheatreControls.css';

interface TheatreControlsProps {
  isStreaming: boolean;
  hasActiveStream: boolean;
  cooldownRemaining: number;
  isConnected: boolean;
  streamerSettings: StreamerSettingsConfig;
  onSettingsChange: (settings: StreamerSettingsConfig) => void;
  onExitTheatre: () => void;
  onTakeOver: () => void;
  onStopStream: () => void;
  onVisibilityChange?: (visible: boolean) => void;
  currentUserId?: string;
  streamerBuffs?: any[];
}

const TheatreControls: React.FC<TheatreControlsProps> = ({
  isStreaming,
  hasActiveStream,
  cooldownRemaining,
  isConnected,
  streamerSettings,
  onSettingsChange,
  onExitTheatre,
  onTakeOver,
  onStopStream,
  onVisibilityChange,
  currentUserId,
  streamerBuffs = [],
}) => {
  const [isActive, setIsActive] = useState(false); // Start with controls hidden
  const [showSettings, setShowSettings] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [userHasUnmuted, setUserHasUnmuted] = useState(false);
  const [showTakeoverTooltip, setShowTakeoverTooltip] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [permissions, setPermissions] = useState<MediaPermissions>({
    camera: 'checking',
    microphone: 'checking',
    lastChecked: Date.now()
  });
  const [permissionStream, setPermissionStream] = useState<MediaStream | null>(null);
  const [showClipModal, setShowClipModal] = useState(false);
  const [clipStatus, setClipStatus] = useState<{ available: boolean; isRecording: boolean } | null>(null);
  const hideTimeout = useRef<NodeJS.Timeout | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Reset tooltip visibility when stream status changes
  useEffect(() => {
    setShowTakeoverTooltip(true);
  }, [hasActiveStream, isStreaming]);

  // Check permissions on mount and periodically
  useEffect(() => {
    const checkPermissions = async () => {
      const perms = await PermissionService.checkPermissions();
      setPermissions(perms);
    };
    
    checkPermissions();
    // Recheck permissions every 5 seconds
    const interval = setInterval(checkPermissions, 5000);
    
    return () => {
      clearInterval(interval);
      // Clean up permission stream if exists
      if (permissionStream) {
        PermissionService.releaseStream(permissionStream);
      }
    };
  }, []);

  // Check clip availability - always poll since recording happens server-side
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

    // Always check clip status on mount and periodically
    checkClipStatus();
    const interval = setInterval(checkClipStatus, 10000); // Check every 10s
    return () => clearInterval(interval);
  }, []);

  // Notify parent when visibility changes
  useEffect(() => {
    if (onVisibilityChange) {
      onVisibilityChange(isActive);
    }
  }, [isActive, onVisibilityChange]);

  useEffect(() => {
    // Show controls when hovering over stream OR theatre controls/admin panels
    let isOverInteractiveArea = false;
    
    const handleAreaMouseEnter = () => {
      isOverInteractiveArea = true;
      setIsActive(true);
      
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
      }
      
      hideTimeout.current = setTimeout(() => {
        if (isOverInteractiveArea) {
          setIsActive(false);
        }
      }, 3000);
    };
    
    const handleAreaMouseMove = () => {
      if (!isOverInteractiveArea) return;
      
      setIsActive(true);
      
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
      }
      
      hideTimeout.current = setTimeout(() => {
        setIsActive(false);
      }, 3000);
    };
    
    const handleAreaMouseLeave = (e: Event) => {
      // Check if we're moving to another interactive area
      const mouseEvent = e as MouseEvent;
      const relatedTarget = mouseEvent.relatedTarget as HTMLElement;
      if (relatedTarget) {
        const isGoingToControls = relatedTarget.closest('.theatre-controls-wrapper, .theatre-admin-controls, .theatre-settings-dropdown-bottom');
        if (isGoingToControls) {
          return; // Don't hide if moving to controls
        }
      }
      
      isOverInteractiveArea = false;
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
      }
      setIsActive(false);
    };
    
    // Find and attach listeners to interactive areas
    const attachListeners = () => {
      const streamViewer = document.querySelector('.stream-viewer-container');
      const adminControls = document.querySelector('.theatre-admin-controls');
      const theatreControls = document.querySelector('.theatre-controls-wrapper');
      
      if (streamViewer) {
        streamViewer.addEventListener('mouseenter', handleAreaMouseEnter);
        streamViewer.addEventListener('mousemove', handleAreaMouseMove);
        streamViewer.addEventListener('mouseleave', handleAreaMouseLeave);
      }
      
      // Also attach to admin controls if they exist
      if (adminControls) {
        adminControls.addEventListener('mouseenter', handleAreaMouseEnter);
        adminControls.addEventListener('mousemove', handleAreaMouseMove);
        adminControls.addEventListener('mouseleave', handleAreaMouseLeave);
      }
      
      // And theatre controls themselves
      if (theatreControls) {
        theatreControls.addEventListener('mouseenter', handleAreaMouseEnter);
        theatreControls.addEventListener('mousemove', handleAreaMouseMove);
      }
      
      return streamViewer !== null;
    };
    
    // Try to attach immediately and retry if needed
    if (!attachListeners()) {
      const retryInterval = setInterval(() => {
        if (attachListeners()) {
          clearInterval(retryInterval);
        }
      }, 100);
      
      // Clean up retry interval after 5 seconds
      setTimeout(() => clearInterval(retryInterval), 5000);
    }
    
    // Re-attach listeners when DOM changes (for admin controls that appear later)
    const observer = new MutationObserver(() => {
      attachListeners();
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Find video element and track its state
    const findVideo = () => {
      const video = document.querySelector('video');
      if (video) {
        videoRef.current = video;
        setIsPlaying(!video.paused);
        setIsMuted(video.muted);
        setVolume(video.volume * 100);
        
        // Trigger userInteracted flag in WebRTCViewer when unmuted via our controls
        const muteIndicator = document.querySelector('.muted-audio-indicator') as HTMLElement;
        if (!video.muted && muteIndicator) {
          // Simulate click to set userInteracted flag
          muteIndicator.click();
        }
      }
    };
    
    findVideo();
    const interval = setInterval(findVideo, 500); // Check more frequently

    return () => {
      const streamViewerCleanup = document.querySelector('.stream-viewer-container');
      const adminControlsCleanup = document.querySelector('.theatre-admin-controls');
      const theatreControlsCleanup = document.querySelector('.theatre-controls-wrapper');
      
      if (streamViewerCleanup) {
        streamViewerCleanup.removeEventListener('mouseenter', handleAreaMouseEnter);
        streamViewerCleanup.removeEventListener('mousemove', handleAreaMouseMove);
        streamViewerCleanup.removeEventListener('mouseleave', handleAreaMouseLeave);
      }
      
      if (adminControlsCleanup) {
        adminControlsCleanup.removeEventListener('mouseenter', handleAreaMouseEnter);
        adminControlsCleanup.removeEventListener('mousemove', handleAreaMouseMove);
        adminControlsCleanup.removeEventListener('mouseleave', handleAreaMouseLeave);
      }
      
      if (theatreControlsCleanup) {
        theatreControlsCleanup.removeEventListener('mouseenter', handleAreaMouseEnter);
        theatreControlsCleanup.removeEventListener('mousemove', handleAreaMouseMove);
      }
      
      observer.disconnect();
      clearInterval(interval);
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current);
      }
    };
  }, []);

  const getStreamButtonText = () => {
    if (!isConnected) return 'Connecting...';
    if (isStreaming) return 'Stop Streaming';
    if (cooldownRemaining > 0 && !hasActiveStream) return `Cooldown: ${cooldownRemaining}s`;
    
    // Check permissions state
    const canStream = PermissionService.canStream(permissions);
    if (!canStream && !hasActiveStream) {
      if (permissions.camera === 'denied' || permissions.microphone === 'denied') {
        return '🔒 Permissions Required';
      }
      return '🎤 Setup Permissions';
    }
    
    if (hasActiveStream) return 'Take Over Stream';
    return 'Start Streaming';
  };

  const handleStreamAction = async () => {
    if (isStreaming) {
      // Stop streaming - always allowed
      onStopStream();
      // Clean up permission stream if exists
      if (permissionStream) {
        PermissionService.releaseStream(permissionStream);
        setPermissionStream(null);
      }
    } else {
      // Check if permissions are granted before streaming
      const canStream = PermissionService.canStream(permissions);
      
      if (!canStream) {
        // Show permission modal to get permissions
        setShowPermissionModal(true);
      } else {
        // Permissions already granted, proceed with streaming
        onTakeOver();
      }
    }
  };

  const handlePermissionsGranted = (stream: MediaStream) => {
    // Store the stream for later use
    setPermissionStream(stream);
    // Update permissions state
    setPermissions({
      camera: 'granted',
      microphone: 'granted',
      lastChecked: Date.now()
    });
    // Close modal
    setShowPermissionModal(false);
    // Now proceed with streaming
    onTakeOver();
  };

  const handlePlayPause = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  const handleMuteToggle = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
      if (!videoRef.current.muted) {
        setUserHasUnmuted(true);
        if (volume === 0) {
          setVolume(50);
          videoRef.current.volume = 0.5;
        }
      }
    }
  };
  
  const handleUnmuteClick = () => {
    if (videoRef.current) {
      videoRef.current.muted = false;
      setIsMuted(false);
      setUserHasUnmuted(true);
      if (volume === 0) {
        setVolume(80);
        videoRef.current.volume = 0.8;
      }
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseInt(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume / 100;
      if (newVolume === 0) {
        videoRef.current.muted = true;
        setIsMuted(true);
      } else if (videoRef.current.muted) {
        videoRef.current.muted = false;
        setIsMuted(false);
        setUserHasUnmuted(true);
      }
    }
  };

  const handleFullscreenToggle = () => {
    if (!document.fullscreenElement) {
      // Enter fullscreen
      const elem = document.documentElement;
      if (elem.requestFullscreen) {
        elem.requestFullscreen();
      } else if ((elem as any).webkitRequestFullscreen) {
        (elem as any).webkitRequestFullscreen();
      } else if ((elem as any).mozRequestFullScreen) {
        (elem as any).mozRequestFullScreen();
      } else if ((elem as any).msRequestFullscreen) {
        (elem as any).msRequestFullscreen();
      }
      setIsFullscreen(true);
    } else {
      // Exit fullscreen
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).mozCancelFullScreen) {
        (document as any).mozCancelFullScreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('msfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('msfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Add click handler that prevents propagation issues
  const handleWrapperClick = (e: React.MouseEvent) => {
    // If clicking on the wrapper itself (not a button), don't do anything
    if (e.target === e.currentTarget) {
      e.stopPropagation();
      // Don't prevent default - let the click pass through
      return;
    }
  };

  return (
    <>
      <div 
        className={`theatre-controls-wrapper ${isActive ? 'active' : ''}`}
        onClick={handleWrapperClick}
        style={{ pointerEvents: 'none' }} // Explicitly set pointer-events inline
      >
        {/* Status Effects Overlay - Left Side */}
        <div className={`theatre-status-effects ${isActive ? 'visible' : ''}`}>
          <BuffDisplay 
            showStreamerBuffs={true}
            className="theatre-buffs-overlay"
            isCurrentUserStreaming={isStreaming}
            currentUserId={currentUserId}
            initialBuffs={streamerBuffs}
          />
        </div>
        
        {/* Top Bar */}
        <div className="theatre-top-bar">
        <div className="theatre-controls-left">
          {/* Empty for now - can add other controls later */}
        </div>

        <div className="theatre-controls-right">
          {/* Exit Theatre Mode */}
          <button
            className="exit-theatre-btn"
            onClick={onExitTheatre}
            title="Exit Theatre Mode"
          >
            ✕ Exit Theatre
          </button>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="theatre-bottom-bar">
        {/* Playback Controls */}
        <div className="theatre-playback-section">
          {/* Play/Pause Button */}
          <button
            className="theatre-playback-btn"
            onClick={handlePlayPause}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>

          {/* Volume Controls */}
          <div className="theatre-volume-controls">
            <button
              className="theatre-volume-btn"
              onClick={handleMuteToggle}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'}
            </button>
            <input
              type="range"
              className="theatre-volume-slider"
              min="0"
              max="100"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              title="Volume"
            />
            <span className="theatre-volume-label">{isMuted ? 0 : volume}%</span>
          </div>

          {/* Fullscreen Button */}
          <button
            className="theatre-fullscreen-btn"
            onClick={handleFullscreenToggle}
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
          >
            {isFullscreen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>

          {/* Clip Button - available to all users */}
          <button
            className="theatre-clip-btn"
            onClick={() => setShowClipModal(true)}
            title={clipStatus?.available ? "Create a clip of the last 30-120 seconds" : "Clips not available right now"}
            disabled={!clipStatus?.available}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="6" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/>
              <line x1="20" y1="4" x2="8.12" y2="15.88"/>
              <line x1="14.47" y1="14.48" x2="20" y2="20"/>
              <line x1="8.12" y1="8.12" x2="12" y2="12"/>
            </svg>
            <span>Clip</span>
          </button>
        </div>

        {/* Stream Controls */}
        <div className="theatre-stream-controls">
          {/* Cooldown Badge */}
          {cooldownRemaining > 0 && (
            <div className="theatre-cooldown-badge">
              ⏱️ {cooldownRemaining}s
            </div>
          )}
          
          {/* Streamer Settings Button */}
          <button
            className="theatre-control-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Streamer Settings"
          >
            ⚙️ Streamer Settings
          </button>
          
          {/* Permission Status Indicator */}
          {!isStreaming && !hasActiveStream && (
            <div className="permission-status-indicator">
              {permissions.camera === 'granted' && permissions.microphone === 'granted' ? (
                <span className="permission-ready">✅ Ready to stream</span>
              ) : permissions.camera === 'denied' || permissions.microphone === 'denied' ? (
                <span className="permission-denied">🔒 Permissions blocked</span>
              ) : permissions.camera === 'checking' || permissions.microphone === 'checking' ? (
                <span className="permission-checking">⏳ Checking...</span>
              ) : (
                <span className="permission-required">🎤 Setup required</span>
              )}
            </div>
          )}
          
          {/* Main Stream Control Button with Tooltip */}
          <div className="theatre-control-btn-wrapper">
            <button
              className={`theatre-control-btn ${isStreaming ? 'danger' : hasActiveStream && !isStreaming ? 'takeover' : !PermissionService.canStream(permissions) && !hasActiveStream ? 'permission-required' : 'primary'}`}
              onClick={handleStreamAction}
              disabled={!isConnected || (!isStreaming && cooldownRemaining > 0)}
              title={
                isStreaming ? "Stop your stream" : 
                hasActiveStream && !isStreaming ? "Take control of the stream! Anyone can become the streamer." : 
                !PermissionService.canStream(permissions) ? "Grant camera and microphone permissions to stream" :
                ""
              }
            >
              {isStreaming && (
                <span className="stop-icon">⏹️</span>
              )}
              {hasActiveStream && !isStreaming && (
                <span className="takeover-icon">🎬</span>
              )}
              {!PermissionService.canStream(permissions) && !hasActiveStream && !isStreaming && (
                <span className="permission-icon">🔓</span>
              )}
              {getStreamButtonText()}
            </button>
            {hasActiveStream && !isStreaming && showTakeoverTooltip && (
              <div className="theatre-takeover-tooltip">
                <button 
                  className="tooltip-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTakeoverTooltip(false);
                  }}
                  title="Close tooltip"
                >
                  ✕
                </button>
                <div className="tooltip-arrow"></div>
                <div className="tooltip-content">
                  <strong>🎬 Take Over Stream</strong>
                  <p>Anyone can take control and become the streamer!</p>
                  <p className="tooltip-hint">Click to start streaming immediately</p>
                </div>
              </div>
            )}
          </div>

          {/* Stream Status */}
          {isStreaming && (
            <div className="theatre-status-badge streaming">
              • LIVE
            </div>
          )}
          {hasActiveStream && !isStreaming && (
            <div className="theatre-status-badge viewing">
              VIEWING
            </div>
          )}
        </div>
      </div>
      
    </div>
    
    {/* Settings Panel Dropdown - OUTSIDE the wrapper to avoid pointer-events issues */}
    {showSettings && (
      <div className="theatre-settings-dropdown-bottom">
        <div className="theatre-settings-header">
          <h3>Streamer Settings</h3>
          <button
            className="theatre-settings-close"
            onClick={() => setShowSettings(false)}
          >
            ✕
          </button>
        </div>
        <StreamerSettings
          settings={streamerSettings}
          onSettingsChange={onSettingsChange}
          isStreaming={isStreaming}
          compact={false}
        />
      </div>
    )}
    
    {/* New Mute Indicator - Shows when muted and user hasn't interacted */}
    {isMuted && !userHasUnmuted && (
      <TheatreMuteIndicator onUnmute={handleUnmuteClick} />
    )}
    
    {/* Permission Setup Modal */}
    <PermissionSetupModal
      isOpen={showPermissionModal}
      onClose={() => setShowPermissionModal(false)}
      onPermissionsGranted={handlePermissionsGranted}
      requiredPermissions={{ camera: true, microphone: true }}
    />

    {/* Clip Creation Modal */}
    {showClipModal && (
      <ClipCreationModal
        onClose={() => setShowClipModal(false)}
        onSuccess={(clipId) => {
          console.log('Clip created:', clipId);
          // Could show a toast notification here
        }}
      />
    )}
  </>
  );
};

export default TheatreControls;