import React from 'react';
import { TranscriptionHistory } from './types';

interface HistoryTableProps {
  history: TranscriptionHistory[];
  formatDuration: (seconds?: number) => string;
  viewTranscript: (sessionId: string) => void;
}

const HistoryTable: React.FC<HistoryTableProps> = ({
  history,
  formatDuration,
  viewTranscript,
}) => {
  return (
    <div className="transcription-history">
      <h4>Transcription History</h4>
      <div className="history-table-container">
        <table className="history-table">
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Streamer</th>
              <th>Start Time</th>
              <th>Duration</th>
              <th>Words</th>
              <th>Language</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {history.length > 0 ? (
              history.map(session => (
                <tr key={session.id}>
                  <td>{session.id.substring(0, 8)}...</td>
                  <td>{session.streamer_id || 'Unknown'}</td>
                  <td>{new Date(session.start_time).toLocaleString()}</td>
                  <td>{formatDuration(session.duration)}</td>
                  <td>{session.word_count || 0}</td>
                  <td>{session.language || 'auto'}</td>
                  <td>
                    <span className={`status-badge status-${session.status}`}>
                      {session.status}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn btn-small"
                      onClick={() => viewTranscript(session.id)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="empty-row">No transcriptions found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default HistoryTable;
