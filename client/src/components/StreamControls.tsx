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
      </div>
    </div>
  );
};

export default StreamControls;