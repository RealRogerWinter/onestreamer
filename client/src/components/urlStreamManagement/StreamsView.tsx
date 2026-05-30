import React from 'react';
import {
  Link2,
  Activity,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  Clock,
  Settings,
  Square,
} from 'lucide-react';
import { URLStream, formatUptime, getPlatformStyle, getHealthColor } from './types';

interface StreamsViewProps {
  streams: URLStream[];
  handleStopStream: (urlId: string) => void;
}

// The "Active Streams" tab content. Markup preserved verbatim from the original.
const StreamsView: React.FC<StreamsViewProps> = ({ streams, handleStopStream }) => {
  return (
    <div className="streams-list">
      {streams.length === 0 ? (
        <div className="empty-state">
          <Link2 size={48} />
          <h3>No active URL streams</h3>
          <p>Enter a stream URL above to start relaying</p>
        </div>
      ) : (
        <div className="streams-grid">
          {streams.map((stream) => {
            const platformStyle = getPlatformStyle(stream.platform);
            return (
              <div key={stream.urlId} className="stream-card">
                <div className="stream-header">
                  <span
                    className="platform-tag"
                    style={{ background: platformStyle.bg, color: platformStyle.color }}
                  >
                    {stream.platform}
                  </span>
                  <span className={`status-tag ${stream.status}`}>
                    {stream.status === 'streaming' && <><Activity size={12} /> Live</>}
                    {stream.status === 'connecting' && <><RefreshCw size={12} className="spin" /> Connecting</>}
                    {stream.status === 'reconnecting' && <><RefreshCw size={12} className="spin" /> Reconnecting</>}
                    {stream.status === 'error' && <><AlertCircle size={12} /> Error</>}
                  </span>
                </div>

                <h4 className="stream-name">{stream.displayName || 'URL Stream'}</h4>

                <div className="stream-url">
                  <ExternalLink size={12} />
                  <a href={stream.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {stream.sourceUrl.length > 40
                      ? stream.sourceUrl.substring(0, 40) + '...'
                      : stream.sourceUrl}
                  </a>
                </div>

                <div className="stream-stats">
                  <div className="stat">
                    <Clock size={14} />
                    <span>{formatUptime(stream.uptime)}</span>
                  </div>
                  <div className="stat">
                    <Settings size={14} />
                    <span>{stream.quality}</span>
                  </div>
                  {stream.health && (
                    <div className="stat health">
                      <Activity size={14} />
                      <span style={{ color: getHealthColor(stream.health.overall) }}>
                        {stream.health.overall}%
                      </span>
                    </div>
                  )}
                </div>

                {stream.reconnectAttempts > 0 && (
                  <div className="reconnect-info">
                    Reconnect attempts: {stream.reconnectAttempts}
                  </div>
                )}

                <button
                  className="stop-btn"
                  onClick={() => handleStopStream(stream.urlId)}
                >
                  <Square size={14} />
                  Stop
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default StreamsView;
