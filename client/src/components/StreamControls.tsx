import React from 'react';
import './StreamControls.css';

interface StreamControlsProps {
  isStreaming: boolean;
  hasActiveStream: boolean;
  cooldownRemaining: number;
  cooldownType?: 'individual' | 'global' | null;
  wasTakenOver?: boolean;
  isConnected?: boolean;
  isForceDisconnected?: boolean;
  disconnectionReason?: string | null;
  isMobile?: boolean;
  onShowTutorial?: () => void;
  onShowBugReport?: () => void;
  onTakeOver: () => void;
  onStopStream: () => void;
}

const StreamControls: React.FC<StreamControlsProps> = ({
  isStreaming,
  hasActiveStream,
  cooldownRemaining,
  cooldownType = null,
  wasTakenOver = false,
  isConnected = true,
  isForceDisconnected = false,
  disconnectionReason = null,
  isMobile = false,
  onShowTutorial,
  onShowBugReport,
  onTakeOver,
  onStopStream
}) => {
  const getTakeOverButtonText = () => {
    if (!isConnected) {
      return 'Connecting...';
    }
    if (cooldownRemaining > 0) {
      if (cooldownType === 'individual') {
        return `Individual Cooldown: ${cooldownRemaining}s`;
      } else if (cooldownType === 'global') {
        return `Global Cooldown: ${cooldownRemaining}s`;
      }
      return wasTakenOver ? `Cooldown: ${cooldownRemaining}s` : `Wait ${cooldownRemaining}s`;
    }
    if (hasActiveStream) {
      return 'Take Over Stream';
    }
    return 'Start Streaming';
  };

  const isTakeOverDisabled = cooldownRemaining > 0 || !isConnected;

  return (
    <div className="stream-controls">
      {isStreaming ? (
        <button 
          className="control-button stop-button"
          onClick={onStopStream}
        >
          Stop Streaming
        </button>
      ) : (
        <div>
          <button
            className={`control-button take-over-button ${isTakeOverDisabled ? 'disabled' : ''}`}
            onClick={onTakeOver}
            disabled={isTakeOverDisabled}
          >
            {getTakeOverButtonText()}
          </button>
          {!isConnected && (
            <p className="takeover-cooldown-info" style={{ color: '#ff9800' }}>
              ⚠️ Connecting to server... Please wait.
            </p>
          )}
          {cooldownRemaining > 0 && (
            <p className="takeover-cooldown-info">
              {cooldownType === 'individual' ? (
                `Your stream was taken over. You can stream again in ${cooldownRemaining}s.`
              ) : cooldownType === 'global' ? (
                `New stream started. All users must wait ${cooldownRemaining}s before streaming.`
              ) : wasTakenOver ? (
                `Your stream was taken over. You can stream again in ${cooldownRemaining}s.`
              ) : (
                `Wait ${cooldownRemaining}s before you can stream.`
              )}
            </p>
          )}
        </div>
      )}
      
      <div className="controls-info">
        {isForceDisconnected && disconnectionReason && (
          <p className="disconnection-warning" style={{ color: '#ff4444', fontWeight: 'bold' }}>
            🚫 {disconnectionReason}
          </p>
        )}
        {isStreaming && (
          <p className="streaming-info">
            ⚠️ Others can take over your stream at any time
          </p>
        )}
        {!isStreaming && hasActiveStream && !isForceDisconnected && (
          <p className="takeover-info">
            Click "Take Over Stream" to disconnect the current streamer and go live
          </p>
        )}
        {!isStreaming && !hasActiveStream && !isForceDisconnected && (
          <p className="start-info">
            Click "Start Streaming" to go live and be the first streamer
          </p>
        )}
        
        {/* Mobile utility buttons */}
        {isMobile && (
          <div className="mobile-utility-buttons">
            <button 
              className="mobile-utility-btn help-btn"
              onClick={onShowTutorial}
              title="Tutorial & Help"
            >
              ?
            </button>
            <button 
              className="mobile-utility-btn bug-btn"
              onClick={onShowBugReport}
              title="Report a Bug"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 8h-1.81c-.45-.78-1.07-1.45-1.82-1.96l.93-.93a.996.996 0 1 0-1.41-1.41l-1.47 1.47C12.96 5.06 12.49 5 12 5s-.96.06-1.41.17L9.11 3.7A.996.996 0 1 0 7.7 5.11l.92.93C7.88 6.55 7.26 7.22 6.81 8H5c-.55 0-1 .45-1 1s.45 1 1 1h1.09c-.05.33-.09.66-.09 1v1H5c-.55 0-1 .45-1 1s.45 1 1 1h1v1c0 .34.04.67.09 1H5c-.55 0-1 .45-1 1s.45 1 1 1h1.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H19c.55 0 1-.45 1-1s-.45-1-1-1h-1.09c.05-.33.09-.66.09-1v-1h1c.55 0 1-.45 1-1s-.45-1-1-1h-1v-1c0-.34-.04-.67-.09-1H19c.55 0 1-.45 1-1s-.45-1-1-1zm-6 8h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1zm0-4h-2c-.55 0-1-.45-1-1s.45-1 1-1h2c.55 0 1 .45 1 1s-.45 1-1 1z"/>
              </svg>
            </button>
            <a 
              href="https://discord.gg/As5CA3ekYA" 
              target="_blank" 
              rel="noopener noreferrer"
              className="mobile-utility-btn discord-btn"
              title="Join our Discord"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
            </a>
          </div>
        )}
      </div>
    </div>
  );
};

export default StreamControls;