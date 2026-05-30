import React from 'react';

/**
 * "VIEWING PROCESSED STREAM" badge shown to the broadcaster when the streamer
 * view manager switches into self-stream mode.
 *
 * Pure presentational fragment extracted verbatim from WebRTCStreamer. The
 * parent decides when to render it (streaming + self-stream mode) and passes
 * the active-effects count; this component owns only the styled badge markup.
 */

interface ViewModeIndicatorProps {
  visible: boolean;
  activeEffectsCount: number;
}

export const ViewModeIndicator: React.FC<ViewModeIndicatorProps> = ({ visible, activeEffectsCount }) => {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: '10px',
        right: '10px',
        background: 'rgba(255, 107, 107, 0.9)',
        color: 'white',
        padding: '8px 12px',
        borderRadius: '20px',
        fontSize: '12px',
        fontWeight: 'bold',
        zIndex: 1000,
        pointerEvents: 'none',
        boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
        animation: 'pulse 2s infinite',
      }}
    >
      🔴 VIEWING PROCESSED STREAM ({activeEffectsCount})
    </div>
  );
};
