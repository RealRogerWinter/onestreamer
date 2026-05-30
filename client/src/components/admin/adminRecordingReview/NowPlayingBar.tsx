import React from 'react';

interface NowPlayingBarProps {
  currentStreamer: any;
  formatTime: (ms: number) => string;
  formatDuration: (ms: number) => string;
}

// The "NOW PLAYING" indicator shown above the video. DOM is a verbatim move
// from AdminRecordingReview.
const NowPlayingBar: React.FC<NowPlayingBarProps> = ({
  currentStreamer,
  formatTime,
  formatDuration,
}) => {
  return (
    <div className="now-playing-bar" style={{ borderLeftColor: currentStreamer.color }}>
      <div className="now-playing-left">
        <span className="now-playing-label">NOW PLAYING</span>
        <span className="now-playing-icon">{currentStreamer.platformIcon}</span>
        <span className="now-playing-name">{currentStreamer.displayName}</span>
        {currentStreamer.isActive && <span className="live-indicator">LIVE</span>}
      </div>
      <div className="now-playing-right">
        <div className="now-playing-times">
          <span className="time-label">Started:</span>
          <span className="time-value">{formatTime(currentStreamer.absoluteStartTime)}</span>
          <span className="time-separator">-</span>
          <span className="time-label">Ends:</span>
          <span className="time-value">{formatTime(currentStreamer.absoluteEndTime)}</span>
        </div>
        <div className="now-playing-duration">
          <span className="duration-label">Duration:</span>
          <span className="duration-value">{formatDuration(currentStreamer.segmentDurationMs)}</span>
        </div>
      </div>
      <div className="now-playing-progress">
        <div
          className="progress-fill"
          style={{
            width: `${currentStreamer.progressWithinSegment * 100}%`,
            backgroundColor: currentStreamer.color
          }}
        />
      </div>
    </div>
  );
};

export default NowPlayingBar;
