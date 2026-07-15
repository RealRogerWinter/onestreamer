import React from 'react';

/**
 * Pure presentational status overlays for WebRTCStreamer.
 *
 * These render exactly the markup that previously lived inline in the parent
 * component's JSX. They are deliberately logic-free: the parent still owns all
 * media-pipeline state and simply hands down the booleans/strings to render.
 * DOM, class names and text are preserved verbatim so the characterization
 * tests stay green without modification.
 */

interface StreamLoadingOverlayProps {
  isLoading: boolean;
}

export const StreamLoadingOverlay: React.FC<StreamLoadingOverlayProps> = ({ isLoading }) => {
  if (!isLoading) return null;
  return (
    <div className="webrtc-loading">
      <div className="loading-spinner"></div>
      <p>Starting stream...</p>
    </div>
  );
};

interface StreamErrorOverlayProps {
  error: string | null;
  /**
   * Optional manual-retry callback. When provided, a Retry button renders
   * under the error message (audit Plan 05, C3: a failed publish must surface
   * an error + retry instead of silently falling back to local preview).
   */
  onRetry?: () => void;
}

export const StreamErrorOverlay: React.FC<StreamErrorOverlayProps> = ({ error, onRetry }) => {
  if (!error) return null;
  return (
    <div className="webrtc-error">
      <p>⚠️ {error}</p>
      {onRetry && (
        <button className="retry-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
};

interface StreamIdlePreviewProps {
  show: boolean;
}

export const StreamIdlePreview: React.FC<StreamIdlePreviewProps> = ({ show }) => {
  if (!show) return null;
  return (
    <div className="webrtc-preview">
      <p>Click "Start Streaming" to begin broadcasting</p>
    </div>
  );
};
