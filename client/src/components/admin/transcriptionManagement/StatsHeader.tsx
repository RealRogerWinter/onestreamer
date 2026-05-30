import React from 'react';
import { TranscriptionStats } from './types';

interface StatsHeaderProps {
  stats: TranscriptionStats;
}

const StatsHeader: React.FC<StatsHeaderProps> = ({ stats }) => {
  return (
    <div className="transcription-header">
      <h3>🎙️ Transcription Management</h3>
      <div className="transcription-stats">
        <span className="stat">
          <strong>Active:</strong> {stats.activeCount}
        </span>
        <span className="stat">
          <strong>Total Words:</strong> {stats.totalWords}
        </span>
        <span className="stat">
          <strong>Model:</strong> base
        </span>
        <span className="stat">
          <strong>Buffer:</strong>
          <span className={`buffer-indicator ${stats.bufferHealth}`}>
            {stats.bufferHealth === 'good' ? '✓' : stats.bufferHealth === 'warning' ? '⚠' : stats.bufferHealth === 'error' ? '✗' : '?'}
          </span>
        </span>
      </div>
    </div>
  );
};

export default StatsHeader;
