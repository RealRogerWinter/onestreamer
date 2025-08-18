import React, { useState, useEffect } from 'react';
import './ViewerStats.css';

interface ViewerStatsProps {
  viewerCount: number;
  hasActiveStream: boolean;
  streamDuration: number;
  streamStartTime?: number | null;
  streamerDisplayName?: string | null;
}

const ViewerStats: React.FC<ViewerStatsProps> = ({
  viewerCount,
  hasActiveStream,
  streamDuration: initialDuration,
  streamStartTime,
  streamerDisplayName
}) => {
  const [streamDuration, setStreamDuration] = useState(initialDuration);

  useEffect(() => {
    // Update duration every second if stream is active
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

  const formatDuration = (milliseconds: number): string => {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  };

  return (
    <div className="viewer-stats-container">
      <div className="viewer-stats">
        <div className="stat">
          <span className="stat-icon">👥</span>
          <span className="stat-label">Viewers</span>
          <span className="stat-value">{viewerCount}</span>
        </div>
        
        {hasActiveStream && streamerDisplayName && (
          <div className="stat">
            <span className="stat-icon">🎙️</span>
            <span className="stat-label">Current Streamer</span>
            <span className="stat-value">{streamerDisplayName}</span>
          </div>
        )}
        
        <div className="stat">
          <span className="stat-icon">📺</span>
          <span className="stat-label">Status</span>
          <span className={`stat-value ${hasActiveStream ? 'live' : 'offline'}`}>
            {hasActiveStream ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
        
        {hasActiveStream && streamStartTime && (
          <div className="stat">
            <span className="stat-icon">⏱️</span>
            <span className="stat-label">Duration</span>
            <span className="stat-value">{formatDuration(streamDuration)}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default ViewerStats;