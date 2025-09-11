import React, { useState, useEffect } from 'react';
import PermissionService, { MediaPermissions, PermissionState } from '../services/PermissionService';
import './PermissionSetupModal.css';

interface PermissionSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPermissionsGranted: (stream: MediaStream) => void;
  requiredPermissions?: {
    camera: boolean;
    microphone: boolean;
  };
}

const PermissionSetupModal: React.FC<PermissionSetupModalProps> = ({
  isOpen,
  onClose,
  onPermissionsGranted,
  requiredPermissions = { camera: true, microphone: true }
}) => {
  const [permissions, setPermissions] = useState<MediaPermissions>({
    camera: 'checking',
    microphone: 'checking',
    lastChecked: Date.now()
  });
  const [isRequesting, setIsRequesting] = useState(false);
  const [testStream, setTestStream] = useState<MediaStream | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    if (isOpen) {
      checkCurrentPermissions();
    }
    
    return () => {
      // Cleanup test stream when modal closes
      if (testStream) {
        PermissionService.releaseStream(testStream);
        setTestStream(null);
      }
    };
  }, [isOpen]);

  const checkCurrentPermissions = async () => {
    const currentPermissions = await PermissionService.checkPermissions(false);
    setPermissions(currentPermissions);
    
    // If permissions are already granted, auto-proceed
    if (PermissionService.canStream(currentPermissions)) {
      handleRequestPermissions();
    }
  };

  const handleRequestPermissions = async () => {
    setIsRequesting(true);
    setShowInstructions(false);
    
    const result = await PermissionService.requestPermissions(
      requiredPermissions.camera,
      requiredPermissions.microphone
    );
    
    setPermissions(result.permissions);
    setIsRequesting(false);
    
    if (result.success && result.stream) {
      setTestStream(result.stream);
      
      // Auto-proceed after a short delay to show success
      setTimeout(() => {
        onPermissionsGranted(result.stream!);
        onClose();
      }, 1500);
    } else if (result.permissions.camera === 'denied' || result.permissions.microphone === 'denied') {
      setShowInstructions(true);
    }
  };

  const getStatusIcon = (state: PermissionState) => {
    switch (state) {
      case 'granted':
        return '✅';
      case 'denied':
        return '❌';
      case 'prompt':
        return '❓';
      case 'checking':
        return '⏳';
      case 'error':
        return '⚠️';
      default:
        return '❓';
    }
  };

  const getStatusClass = (state: PermissionState) => {
    switch (state) {
      case 'granted':
        return 'status-granted';
      case 'denied':
        return 'status-denied';
      case 'prompt':
        return 'status-prompt';
      case 'checking':
        return 'status-checking';
      case 'error':
        return 'status-error';
      default:
        return '';
    }
  };

  if (!isOpen) return null;

  const canProceed = PermissionService.canStream(permissions);
  const hasError = permissions.camera === 'error' || permissions.microphone === 'error';
  const isDenied = permissions.camera === 'denied' || permissions.microphone === 'denied';

  return (
    <div className="permission-modal-overlay">
      <div className="permission-modal">
        <div className="permission-modal-header">
          <h2>🎥 Stream Setup</h2>
          <button className="permission-modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="permission-modal-content">
          {!canProceed && (
            <div className="permission-intro">
              <p>To go live, we need access to your camera and microphone.</p>
              <p className="permission-note">Your privacy is important. Permissions are only used when you're actively streaming.</p>
            </div>
          )}
          
          <div className="permission-status-list">
            {requiredPermissions.camera && (
              <div className={`permission-status-item ${getStatusClass(permissions.camera)}`}>
                <span className="permission-icon">{getStatusIcon(permissions.camera)}</span>
                <span className="permission-label">Camera</span>
                <span className="permission-state">
                  {permissions.camera === 'granted' ? 'Ready' :
                   permissions.camera === 'denied' ? 'Blocked' :
                   permissions.camera === 'checking' ? 'Checking...' :
                   permissions.camera === 'error' ? 'Error' :
                   'Permission needed'}
                </span>
              </div>
            )}
            
            {requiredPermissions.microphone && (
              <div className={`permission-status-item ${getStatusClass(permissions.microphone)}`}>
                <span className="permission-icon">{getStatusIcon(permissions.microphone)}</span>
                <span className="permission-label">Microphone</span>
                <span className="permission-state">
                  {permissions.microphone === 'granted' ? 'Ready' :
                   permissions.microphone === 'denied' ? 'Blocked' :
                   permissions.microphone === 'checking' ? 'Checking...' :
                   permissions.microphone === 'error' ? 'Error' :
                   'Permission needed'}
                </span>
              </div>
            )}
          </div>
          
          {permissions.errorMessage && (
            <div className="permission-error-message">
              <span className="error-icon">⚠️</span>
              {permissions.errorMessage}
            </div>
          )}
          
          {canProceed && (
            <div className="permission-success-message">
              <span className="success-icon">🎉</span>
              Great! Your camera and microphone are ready. You can now go live!
            </div>
          )}
          
          {isDenied && showInstructions && (
            <div className="permission-instructions">
              <h3>How to Enable Permissions:</h3>
              <pre>{PermissionService.getPermissionInstructions()}</pre>
              <p className="permission-help-note">
                After allowing permissions, you may need to refresh the page.
              </p>
            </div>
          )}
          
          {hasError && !isDenied && (
            <div className="permission-troubleshoot">
              <h3>Troubleshooting:</h3>
              <ul>
                <li>Make sure your camera and microphone are connected</li>
                <li>Close other apps that might be using your camera</li>
                <li>Try refreshing the page</li>
                <li>Check your browser's privacy settings</li>
              </ul>
            </div>
          )}
        </div>
        
        <div className="permission-modal-footer">
          {!canProceed && !isDenied && (
            <button
              className="permission-request-btn"
              onClick={handleRequestPermissions}
              disabled={isRequesting}
            >
              {isRequesting ? (
                <>⏳ Requesting Permissions...</>
              ) : (
                <>🎤 Grant Camera & Microphone Access</>
              )}
            </button>
          )}
          
          {isDenied && (
            <div className="permission-denied-actions">
              <button
                className="permission-retry-btn"
                onClick={handleRequestPermissions}
                disabled={isRequesting}
              >
                Try Again
              </button>
              <button
                className="permission-instructions-btn"
                onClick={() => setShowInstructions(!showInstructions)}
              >
                {showInstructions ? 'Hide' : 'Show'} Instructions
              </button>
            </div>
          )}
          
          <button
            className="permission-cancel-btn"
            onClick={onClose}
          >
            {canProceed ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionSetupModal;