import React, { useState, useEffect } from 'react';
import PermissionSetupModal from '../PermissionSetupModal';
import PermissionService, { MediaPermissions } from '../../services/PermissionService';
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
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [permissions, setPermissions] = useState<MediaPermissions>({
    camera: 'checking',
    microphone: 'checking',
    lastChecked: Date.now()
  });
  const [permissionStream, setPermissionStream] = useState<MediaStream | null>(null);

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
    
    // Check permissions state for mobile
    const canStream = PermissionService.canStream(permissions);
    if (!canStream && !hasActiveStream) {
      if (permissions.camera === 'denied' || permissions.microphone === 'denied') {
        return '🔒 Permissions Required';
      }
      return '🎤 Setup Permissions';
    }
    
    if (hasActiveStream) {
      return 'Take Over Stream';
    }
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

  const isTakeOverDisabled = cooldownRemaining > 0 || !isConnected;

  return (
    <div className="stream-controls">
      {isStreaming ? (
        <button 
          className="control-button stop-button"
          onClick={handleStreamAction}
        >
          Stop Streaming
        </button>
      ) : (
        <div>
          {/* Permission Status Indicator for Mobile */}
          {!hasActiveStream && isMobile && (
            <div className="mobile-permission-status">
              {permissions.camera === 'granted' && permissions.microphone === 'granted' ? (
                <span className="permission-ready">✅ Ready to stream</span>
              ) : permissions.camera === 'denied' || permissions.microphone === 'denied' ? (
                <span className="permission-denied">🔒 Camera/mic access blocked</span>
              ) : permissions.camera === 'checking' || permissions.microphone === 'checking' ? (
                <span className="permission-checking">⏳ Checking permissions...</span>
              ) : (
                <span className="permission-required">🎤 Camera/mic setup required</span>
              )}
            </div>
          )}
          <button
            className={`control-button take-over-button ${isTakeOverDisabled ? 'disabled' : ''} ${!PermissionService.canStream(permissions) && !hasActiveStream ? 'permission-required' : ''}`}
            onClick={handleStreamAction}
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
        
        {/* Mobile utility buttons moved to MobileHeader hamburger menu */}
      </div>
      
      {/* Permission Setup Modal */}
      <PermissionSetupModal
        isOpen={showPermissionModal}
        onClose={() => setShowPermissionModal(false)}
        onPermissionsGranted={handlePermissionsGranted}
        requiredPermissions={{ camera: true, microphone: true }}
      />
    </div>
  );
};

export default StreamControls;