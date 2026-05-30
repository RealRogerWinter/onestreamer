import React from 'react';
import {
  VisionBotStatus,
  DROP_REASON_LABELS,
  formatTimestamp,
  formatRelative,
} from './types';

interface StatsSectionProps {
  status: VisionBotStatus | null;
  cyclesAttempted: number;
  cyclesSucceeded: number;
  successPct: number | null;
}

const StatsSection: React.FC<StatsSectionProps> = ({
  status,
  cyclesAttempted,
  cyclesSucceeded,
  successPct,
}) => (
  <div className="vb-section">
    <h3>Cycle stats</h3>
    <div className="vb-stats-grid">
      <div className="vb-stat">
        <div className="vb-label">Attempted</div>
        <div className="vb-stat-num">{cyclesAttempted}</div>
      </div>
      <div className="vb-stat">
        <div className="vb-label">Succeeded</div>
        <div className="vb-stat-num">{cyclesSucceeded}</div>
        {successPct !== null && (
          <div className="vb-stat-sub">{successPct}% success</div>
        )}
      </div>
      <div className="vb-stat">
        <div className="vb-label">Last Groq latency</div>
        <div className="vb-stat-num">
          {status?.last_groq_latency_ms != null
            ? `${status.last_groq_latency_ms} ms`
            : '—'}
        </div>
      </div>
      <div className="vb-stat">
        <div className="vb-label">Consecutive failures</div>
        <div className={`vb-stat-num ${(status?.consecutive_failures ?? 0) > 0 ? 'warn' : ''}`}>
          {status?.consecutive_failures ?? 0}
        </div>
      </div>
      <div className="vb-stat">
        <div className="vb-label">Last success</div>
        <div className="vb-stat-num small">{formatRelative(status?.last_success_at)}</div>
        <div className="vb-stat-sub">{formatTimestamp(status?.last_success_at)}</div>
      </div>
      <div className="vb-stat">
        <div className="vb-label">Last 429</div>
        <div className="vb-stat-num small">{formatRelative(status?.last_groq_429_at)}</div>
        <div className="vb-stat-sub">{formatTimestamp(status?.last_groq_429_at)}</div>
      </div>
    </div>

    {status?.last_error_reason && (
      <div className="vb-error-line">
        <strong>Last error:</strong> {status.last_error_reason}
      </div>
    )}

    <h4 className="vb-subheader">Drops by reason</h4>
    <div className="vb-drops">
      {Object.keys(DROP_REASON_LABELS).map(reason => {
        const count = status?.cycles_dropped?.[reason] ?? 0;
        return (
          <div key={reason} className={`vb-drop ${count > 0 ? 'has' : 'zero'}`}>
            <div className="vb-drop-count">{count}</div>
            <div className="vb-drop-label">{DROP_REASON_LABELS[reason]}</div>
          </div>
        );
      })}
    </div>
  </div>
);

export default StatsSection;
