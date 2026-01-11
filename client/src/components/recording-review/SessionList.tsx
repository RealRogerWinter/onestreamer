import React from 'react';

interface RecordingSession {
  sessionId: string;
  streamerIdentity: string;
  streamerUsername: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: string;
  segmentCount: number;
  chatMessageCount: number;
  fileSizeBytes: number;
  hasB2Upload: boolean;
  createdAt: string;
}

interface SessionListProps {
  sessions: RecordingSession[];
  loading: boolean;
  page: number;
  totalPages: number;
  totalCount: number;
  streamerFilter: string;
  dateFrom: string;
  dateTo: string;
  onPageChange: (page: number) => void;
  onStreamerFilterChange: (value: string) => void;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  onPlaySession: (session: RecordingSession) => void;
  onDeleteSession: (sessionId: string) => void;
  onForceUpload: (sessionId: string) => void;
  onRefresh: () => void;
  formatDuration: (ms: number) => string;
  formatFileSize: (bytes: number) => string;
}

const SessionList: React.FC<SessionListProps> = ({
  sessions,
  loading,
  page,
  totalPages,
  totalCount,
  streamerFilter,
  dateFrom,
  dateTo,
  onPageChange,
  onStreamerFilterChange,
  onDateFromChange,
  onDateToChange,
  onPlaySession,
  onDeleteSession,
  onForceUpload,
  onRefresh,
  formatDuration,
  formatFileSize
}) => {
  const getStatusBadge = (status: string) => {
    const statusColors: Record<string, string> = {
      recording: 'status-recording',
      completed: 'status-completed',
      processing: 'status-processing',
      uploaded: 'status-uploaded',
      deleted: 'status-deleted'
    };
    return statusColors[status] || 'status-unknown';
  };

  const formatDate = (timestamp: number) => {
    if (!timestamp) return '--';
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="session-list">
      <div className="session-filters">
        <div className="filter-group">
          <label>Streamer</label>
          <input
            type="text"
            value={streamerFilter}
            onChange={(e) => onStreamerFilterChange(e.target.value)}
            placeholder="Filter by streamer..."
          />
        </div>
        <div className="filter-group">
          <label>From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => onDateFromChange(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <label>To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => onDateToChange(e.target.value)}
          />
        </div>
        <button className="refresh-btn" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="loading-state">Loading sessions...</div>
      ) : sessions.length === 0 ? (
        <div className="empty-state">
          <p>No recording sessions found</p>
          <p className="hint">Recording sessions will appear here when streams are recorded.</p>
        </div>
      ) : (
        <>
          <div className="session-table">
            <table>
              <thead>
                <tr>
                  <th>Date/Time</th>
                  <th>Streamer</th>
                  <th>Duration</th>
                  <th>Chat</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.sessionId}>
                    <td className="date-cell">
                      <div className="date-primary">{formatDate(session.startTime)}</div>
                    </td>
                    <td className="streamer-cell">
                      {session.streamerUsername || session.streamerIdentity || 'Unknown'}
                    </td>
                    <td className="duration-cell">
                      {formatDuration(session.durationMs)}
                    </td>
                    <td className="chat-cell">
                      {session.chatMessageCount > 0 ? (
                        <span className="chat-count">{session.chatMessageCount}</span>
                      ) : (
                        <span className="no-chat">--</span>
                      )}
                    </td>
                    <td className="size-cell">
                      {formatFileSize(session.fileSizeBytes)}
                    </td>
                    <td className="status-cell">
                      <span className={`status-badge ${getStatusBadge(session.status)}`}>
                        {session.status}
                      </span>
                      {session.hasB2Upload && (
                        <span className="b2-indicator" title="Uploaded to B2">B2</span>
                      )}
                    </td>
                    <td className="actions-cell">
                      <button
                        className="action-btn play"
                        onClick={() => onPlaySession(session)}
                        title="Play recording"
                      >
                        Play
                      </button>
                      {!session.hasB2Upload && session.status === 'completed' && (
                        <button
                          className="action-btn upload"
                          onClick={() => onForceUpload(session.sessionId)}
                          title="Upload to B2"
                        >
                          Upload
                        </button>
                      )}
                      <button
                        className="action-btn delete"
                        onClick={() => onDeleteSession(session.sessionId)}
                        title="Delete recording"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              Previous
            </button>
            <span className="page-info">
              Page {page} of {totalPages} ({totalCount} total)
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default SessionList;
