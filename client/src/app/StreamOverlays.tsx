/**
 * Presentational overlay components extracted verbatim from App.tsx.
 *
 * These are pure, prop-driven renders of the takeover and transition
 * overlays that previously lived inline in AppContent's JSX. No state, no
 * effects, no context — the parent still owns showTakeoverOverlay /
 * takeoverMessage / showTransitionOverlay / transitionMessage (from
 * useStreamState) and passes them down. The emoji/title branching and the
 * exact DOM/classNames are copied unchanged so the rendered markup is
 * byte-identical to the original.
 */

interface TakeoverOverlayProps {
  show: boolean;
  message: string;
}

export function TakeoverOverlay({ show, message }: TakeoverOverlayProps) {
  if (!show) return null;
  return (
    <div className="takeover-overlay">
      <div className="takeover-content">
        <div className="takeover-icon">
          {message.includes('Kill Switch') ? '💥' :
           message.includes('Connection') ? '🔌' : '🚫'}
        </div>
        <h1 className="takeover-title">
          {message.includes('Kill Switch') ? 'Kill Switch Activated!' :
           message.includes('Connection') ? 'Connection Lost!' : 'Stream Takeover!'}
        </h1>
        <p className="takeover-message">{message}</p>
        <div className="takeover-transition-info">
          <div className="transition-arrow">↓</div>
          <p className="takeover-countdown">Switching to Viewer Mode...</p>
        </div>
      </div>
    </div>
  );
}

interface TransitionOverlayProps {
  show: boolean;
  message: string;
}

export function TransitionOverlay({ show, message }: TransitionOverlayProps) {
  if (!show) return null;
  return (
    <div className="takeover-overlay takeover-transition">
      <div className="transition-content">
        <div className="transition-icon">🎬</div>
        <h1 className="transition-title">Going Live!</h1>
        <p className="transition-message">{message}</p>
      </div>
    </div>
  );
}
