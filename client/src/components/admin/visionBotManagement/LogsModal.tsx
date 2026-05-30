import React from 'react';
import { VisionBotLog, formatTimestamp } from './types';

interface LogsModalProps {
  logs: VisionBotLog[];
  onRefresh: () => void;
  onClose: () => void;
}

const LogsModal: React.FC<LogsModalProps> = ({ logs, onRefresh, onClose }) => (
  <div className="vb-modal-overlay" onClick={onClose}>
    <div className="vb-modal" onClick={e => e.stopPropagation()}>
      <div className="vb-modal-header">
        <h3>VisionBot live logs</h3>
        <div>
          <button
            className="vb-btn vb-btn-secondary"
            onClick={onRefresh}
          >
            Refresh
          </button>
          <button
            className="vb-btn vb-btn-secondary"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <div className="vb-modal-body">
        {logs.length === 0 ? (
          <div className="vb-empty">No logs yet.</div>
        ) : (
          <div className="vb-log-list">
            {logs.map((log, i) => {
              const type = log.eventType || log.event || 'log';
              return (
                <div key={i} className={`vb-log-entry vb-log-${type.toLowerCase()}`}>
                  <div className="vb-log-head">
                    <span className="vb-log-type">{type}</span>
                    <span className="vb-log-time">
                      {formatTimestamp(log.timestamp)}
                    </span>
                  </div>
                  <pre className="vb-log-body">
                    {JSON.stringify(log.data ?? log, null, 2)}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="vb-modal-footer">
        <small>Auto-refreshing every 3s while open.</small>
      </div>
    </div>
  </div>
);

export default LogsModal;
