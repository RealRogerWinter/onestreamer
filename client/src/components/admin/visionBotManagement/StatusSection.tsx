import React from 'react';
import { VisionBotStatus } from './types';

interface StatusSectionProps {
  status: VisionBotStatus | null;
  busy: boolean;
  visionEnabledCount: number;
  visionEligibleCount: number;
  onEnable: () => void;
  onDisable: () => void;
  onOpenLogs: () => void;
  onRefresh: () => void;
}

const StatusSection: React.FC<StatusSectionProps> = ({
  status,
  busy,
  visionEnabledCount,
  visionEligibleCount,
  onEnable,
  onDisable,
  onOpenLogs,
  onRefresh,
}) => (
  <div className="vb-section">
    <div className="vb-status-row">
      <div className="vb-status-block">
        <div className="vb-label">Service</div>
        <span className={`vb-badge ${status?.enabled ? 'on' : 'off'}`}>
          {status?.enabled ? '● Enabled' : '○ Disabled'}
        </span>
      </div>
      <div className="vb-status-block">
        <div className="vb-label">Runtime</div>
        <span className={`vb-badge ${status?.isActive ? 'on' : 'off'}`}>
          {status?.isActive ? '● Active' : '○ Idle'}
        </span>
      </div>
      <div className="vb-status-block">
        <div className="vb-label">Current Stream</div>
        <div className="vb-value">{status?.currentStreamerId || '—'}</div>
      </div>
      <div className="vb-status-block">
        <div className="vb-label">In flight</div>
        <div className="vb-value">{status?.in_flight ? 'yes' : 'no'}</div>
      </div>
      <div className="vb-status-block">
        <div className="vb-label">Vision-enabled bots</div>
        <div className="vb-value">
          {visionEnabledCount} / {visionEligibleCount} eligible
        </div>
      </div>
    </div>

    <div className="vb-actions">
      {!status?.enabled ? (
        <button
          className="vb-btn vb-btn-primary"
          onClick={onEnable}
          disabled={busy}
        >
          ▶ Enable VisionBot
        </button>
      ) : (
        <button
          className="vb-btn vb-btn-danger"
          onClick={onDisable}
          disabled={busy}
        >
          ■ Disable VisionBot
        </button>
      )}
      <button
        className="vb-btn vb-btn-secondary"
        onClick={onOpenLogs}
      >
        📋 Live Logs
      </button>
      <button
        className="vb-btn vb-btn-secondary"
        onClick={onRefresh}
        disabled={busy}
      >
        🔄 Refresh
      </button>
    </div>
  </div>
);

export default StatusSection;
