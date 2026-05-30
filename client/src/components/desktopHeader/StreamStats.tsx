import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { DesktopHeaderV2Props, formatDuration, formatTime, formatCountdown } from './types';

type StreamStatsProps = Pick<
  DesktopHeaderV2Props,
  | 'viewerCount'
  | 'hasActiveStream'
  | 'streamDuration'
  | 'streamStartTime'
  | 'streamerDisplayName'
  | 'isRandomRotation'
  | 'randomRotationPlatform'
  | 'randomRotationStreamerUrl'
  | 'randomRotationStreamerUsername'
  | 'randomRotationGame'
  | 'randomRotationViewers'
  | 'nextRotationAt'
  | 'currentRotationDuration'
  | 'isRotationLocked'
  | 'lockedRemainingMs'
> & {
  currentTime: Date;
};

const StreamStats: React.FC<StreamStatsProps> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName,
  isRandomRotation = false,
  randomRotationPlatform,
  randomRotationStreamerUrl,
  randomRotationStreamerUsername,
  randomRotationGame,
  randomRotationViewers,
  nextRotationAt,
  currentRotationDuration,
  isRotationLocked = false,
  lockedRemainingMs,
  currentTime,
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);
  const [showStreamerTooltip, setShowStreamerTooltip] = useState(false);
  const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const streamerCardRef = useRef<HTMLDivElement>(null);

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

  // Update countdown timer for rotation
  useEffect(() => {
    if (!isRandomRotation) {
      setCountdownRemaining(null);
      return;
    }

    // If locked, show the frozen time
    if (isRotationLocked && lockedRemainingMs !== null && lockedRemainingMs !== undefined) {
      setCountdownRemaining(lockedRemainingMs);
      return; // Don't update while locked
    }

    if (!nextRotationAt) {
      setCountdownRemaining(null);
      return;
    }

    const updateCountdown = () => {
      const remaining = nextRotationAt - Date.now();
      setCountdownRemaining(remaining > 0 ? remaining : 0);
    };

    // Update immediately
    updateCountdown();

    // Update every 100ms for smooth progress bar animation
    const interval = setInterval(updateCountdown, 100);
    return () => clearInterval(interval);
  }, [isRandomRotation, nextRotationAt, isRotationLocked, lockedRemainingMs]);

  // Update tooltip position when showing
  useEffect(() => {
    if (showStreamerTooltip && streamerCardRef.current) {
      const rect = streamerCardRef.current.getBoundingClientRect();
      setTooltipPosition({
        top: rect.bottom + 8,
        left: rect.left + rect.width / 2
      });
    }
  }, [showStreamerTooltip]);

  const getCountdownProgress = (): number => {
    if (!currentRotationDuration || countdownRemaining === null) return 0;
    const elapsed = currentRotationDuration - countdownRemaining;
    return Math.min(100, Math.max(0, (elapsed / currentRotationDuration) * 100));
  };

  return (
    <div className="header-v2-center">
      <div className="stream-stats-container">
        {/* Live Indicator */}
        <div className={`stat-card ${hasActiveStream ? 'live-active' : 'offline'}`}>
          <div className="stat-icon-wrapper">
            {hasActiveStream ? (
              <div className="live-indicator-modern">
                <span className="live-dot"></span>
                <span className="live-ripple"></span>
                <span className="live-ripple-2"></span>
              </div>
            ) : (
              <div className="offline-indicator"></div>
            )}
          </div>
          <div className="stat-info">
            <span className="stat-label">Status</span>
            <span className="stat-value">{hasActiveStream ? 'LIVE' : 'OFFLINE'}</span>
          </div>
        </div>

        {/* Viewers */}
        <div className="stat-card viewers-card">
          <div className="stat-icon-wrapper">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
              <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
            </svg>
          </div>
          <div className="stat-info">
            <span className="stat-label">Viewers</span>
            <span className="stat-value viewer-count">{(viewerCount ?? 0).toLocaleString()}</span>
          </div>
        </div>

        {/* Current Streamer */}
        {hasActiveStream && streamerDisplayName && (
          <div
            ref={streamerCardRef}
            className={`stat-card streamer-card ${showStreamerTooltip ? 'tooltip-active' : ''}`}
            onClick={(e) => {
              // Don't toggle if clicking the link
              if ((e.target as HTMLElement).tagName !== 'A' && !(e.target as HTMLElement).closest('a')) {
                setShowStreamerTooltip(!showStreamerTooltip);
              }
            }}
            onMouseEnter={() => setShowStreamerTooltip(true)}
            onMouseLeave={() => setShowStreamerTooltip(false)}
          >
            <div className="stat-icon-wrapper">
              {isRandomRotation && randomRotationPlatform ? (
                <div className="platform-icon">
                  {randomRotationPlatform === 'kick' ? '🟢' : '🟣'}
                </div>
              ) : (
                <div className="streamer-avatar">
                  {streamerDisplayName.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="stat-info">
              <span className="stat-label">Streaming</span>
              {isRandomRotation && randomRotationStreamerUrl && randomRotationStreamerUsername ? (
                <a
                  href={randomRotationStreamerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="stat-value streamer-name streamer-link"
                >
                  {randomRotationStreamerUsername}
                  <svg className="external-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/>
                  </svg>
                </a>
              ) : (
                <span className="stat-value streamer-name">{streamerDisplayName}</span>
              )}
            </div>
          </div>
        )}

        {/* Streamer Tooltip - Portal to body */}
        {showStreamerTooltip && hasActiveStream && streamerDisplayName && ReactDOM.createPortal(
          <div
            className="streamer-tooltip-portal"
            style={{
              position: 'fixed',
              top: tooltipPosition.top,
              left: tooltipPosition.left,
              transform: 'translateX(-50%)',
              zIndex: 99999
            }}
            onMouseEnter={() => setShowStreamerTooltip(true)}
            onMouseLeave={() => setShowStreamerTooltip(false)}
          >
            {isRandomRotation ? (
              <>
                <div className="tooltip-header">
                  <span className="tooltip-platform">
                    {randomRotationPlatform === 'kick' ? '🟢 Kick' : '🟣 Twitch'}
                  </span>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-label">Streamer:</span>
                  <span className="tooltip-value">{randomRotationStreamerUsername}</span>
                </div>
                {randomRotationGame && (
                  <div className="tooltip-row">
                    <span className="tooltip-label">Playing:</span>
                    <span className="tooltip-value">{randomRotationGame}</span>
                  </div>
                )}
                {randomRotationViewers !== null && randomRotationViewers !== undefined && (
                  <div className="tooltip-row">
                    <span className="tooltip-label">Viewers:</span>
                    <span className="tooltip-value">{randomRotationViewers.toLocaleString()}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="tooltip-header">
                  <span className="tooltip-platform">🔴 Live on OneStreamer</span>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-label">Streamer:</span>
                  <span className="tooltip-value">{streamerDisplayName}</span>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-label">Live for:</span>
                  <span className="tooltip-value">{formatDuration(streamDuration)}</span>
                </div>
              </>
            )}
          </div>,
          document.body
        )}

        {/* Duration */}
        {hasActiveStream && streamStartTime && (
          <div className="stat-card duration-card">
            <div className="stat-icon-wrapper">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 6v6l4 2"/>
              </svg>
            </div>
            <div className="stat-info">
              <span className="stat-label">Duration</span>
              <span className="stat-value duration-time">{formatDuration(streamDuration)}</span>
            </div>
          </div>
        )}

        {/* Countdown Timer - Only show during random rotation */}
        {isRandomRotation && countdownRemaining !== null && countdownRemaining > 0 && (
          <div className={`stat-card countdown-card ${isRotationLocked ? 'countdown-locked' : ''}`}>
            <div className="stat-icon-wrapper">
              {isRotationLocked ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 2h4"/>
                  <path d="M12 14l3-3"/>
                  <circle cx="12" cy="14" r="8"/>
                </svg>
              )}
            </div>
            <div className="stat-info countdown-info">
              <span className="stat-label">{isRotationLocked ? 'LOCKED' : 'Next Switch'}</span>
              <span className="stat-value countdown-time">{formatCountdown(countdownRemaining)}</span>
              <div className="countdown-progress-bar">
                <div
                  className={`countdown-progress-fill ${isRotationLocked ? 'countdown-progress-locked' : ''}`}
                  style={{ width: `${getCountdownProgress()}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Time */}
        <div className="stat-card time-card">
          <div className="stat-info">
            <span className="stat-value time-display">{formatTime(currentTime)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StreamStats;
