import React, { useEffect, useState } from 'react';

/**
 * Props for the VideoControls overlay shown on top of a streaming <video> element.
 *
 * Visibility (`showControls`) and core playback state (`volume`, `isMuted`, `isPaused`)
 * are owned by the parent so they can be shared with the WebRTC / stream-switching
 * logic. Fullscreen state is owned internally because it is a pure UI concern
 * driven by the browser fullscreen API.
 */
export interface VideoControlsProps {
  /**
   * Ref to the underlying <video> element. Used to derive the container element
   * for the fullscreen toggle (matches the original behavior of fullscreening
   * `videoRef.current.parentElement`).
   */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Whether the controls overlay is currently visible. */
  showControls: boolean;
  /** Current volume in [0, 1]. */
  volume: number;
  /** Whether the stream is currently paused. */
  isPaused: boolean;
  /** Toggle play/pause. */
  onTogglePause: () => void;
  /** Called when the user adjusts the volume slider or clicks the mute toggle. */
  onVolumeChange: (newVolume: number) => void;
  /** Called whenever the mouse moves over the controls, to reset the auto-hide timer. */
  onMouseMove: () => void;
}

/**
 * Custom overlay controls for the WebRTC viewer's <video> element.
 *
 * Replaces the previous inline JSX block in WebRTCViewer.tsx. Owns its own
 * fullscreen state and fullscreen API integration; all other state is lifted
 * to the parent component.
 */
const VideoControls: React.FC<VideoControlsProps> = ({
  videoRef,
  showControls,
  volume,
  isPaused,
  onTogglePause,
  onVolumeChange,
  onMouseMove,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Track fullscreen changes via the cross-vendor fullscreen events.
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

  if (!showControls) return null;

  return (
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
      onMouseMove={onMouseMove}
    >
      {/* Play/Pause Button */}
      <button
        onClick={onTogglePause}
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
          onClick={() => onVolumeChange(volume === 0 ? 0.8 : 0)}
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
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
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
  );
};

export default VideoControls;
