import React from 'react';
import './TheatreMuteIndicator.css';

interface TheatreMuteIndicatorProps {
  onUnmute: () => void;
}

const TheatreMuteIndicator: React.FC<TheatreMuteIndicatorProps> = ({ onUnmute }) => {
  return (
    <button 
      className="theatre-mute-indicator"
      onClick={onUnmute}
      aria-label="Click to unmute"
    >
      <div className="mute-indicator-content">
        <span className="mute-icon">🔇</span>
        <div className="mute-text">
          <div className="mute-title">Click to unmute</div>
          <div className="mute-subtitle">Audio is currently muted</div>
        </div>
      </div>
    </button>
  );
};

export default TheatreMuteIndicator;