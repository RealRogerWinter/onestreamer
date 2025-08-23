import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './StreamingLogs.css';

interface StreamingLog {
  id: number;
  session_id: string;
  streamer_id: string;
  streamer_name: string;
  username?: string;
  email?: string;
  user_id: number;
  ip_address: string;
  user_agent: string;
  stream_type: string;
  started_at: string;
  ended_at: string | null;
  duration: number | null;
  current_duration: number;
  viewer_peak: number;
  is_viewbot: boolean;
  is_banned: boolean;
  disconnect_reason: string | null;
  status: 'active' | 'ended';
}

interface StreamingStats {
  total_sessions: number;
  unique_ips: number;
  unique_users: number;
  avg_duration: number;
  max_viewers: number;
  banned_sessions: number;
  active_sessions: number;
}

interface StreamingLogsProps {
  addLog: (message: string) => void;
}

const StreamingLogs: React.FC<StreamingLogsProps> = ({ addLog }) => {
  const [logs, setLogs] = useState<StreamingLog[]>([]);
  const [stats, setStats] = useState<StreamingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active' | 'ended'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [includeViewbots, setIncludeViewbots] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    loadLogs();
    loadStats();
  }, [filter, includeViewbots]);

  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(() => {
      loadLogs();
      loadStats();
    }, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, [autoRefresh, filter, includeViewbots]);

  const loadLogs = async () => {
    try {
      setLoading(true);
      const token = authService.getToken();
      
      const params = new URLSearchParams({
        limit: '200',
        activeOnly: filter === 'active' ? 'true' : 'false',
        includeViewbots: includeViewbots ? 'true' : 'false'
      });

      const response = await fetch(`/api/admin/streaming-logs?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setLogs(data.logs || []);
        addLog(`Loaded ${data.logs?.length || 0} streaming logs (${data.active} active)`);
      } else {
        throw new Error('Failed to load streaming logs');
      }
    } catch (err: any) {
      setError('Failed to load streaming logs');
      addLog(`Error loading streaming logs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/streaming-logs/stats', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setStats(data.stats);
      }
    } catch (err: any) {
      console.error('Failed to load stats:', err);
    }
  };

  const handleBanIP = async (log: StreamingLog) => {
    if (!window.confirm(`Ban IP ${log.ip_address} (${log.streamer_name || log.streamer_id})?`)) {
      return;
    }

    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/streaming-logs/ban-ip', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ip: log.ip_address,
          sessionId: log.session_id,
          reason: `Banned from streaming logs - ${log.streamer_name || log.streamer_id}`
        })
      });

      if (response.ok) {
        setSuccessMessage(`Successfully banned IP: ${log.ip_address}`);
        addLog(`Banned IP from logs: ${log.ip_address} (${log.streamer_name})`);
        await loadLogs();
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        throw new Error('Failed to ban IP');
      }
    } catch (err: any) {
      setError(`Failed to ban IP: ${err.message}`);
      setTimeout(() => setError(null), 3000);
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (seconds === null || seconds === undefined) return 'N/A';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString();
  };

  const getStatusColor = (log: StreamingLog) => {
    if (log.is_banned) return 'status-banned';
    if (log.status === 'active') return 'status-active';
    return 'status-ended';
  };

  const getStatusText = (log: StreamingLog) => {
    if (log.is_banned) return 'Banned';
    if (log.status === 'active') return 'Live';
    return 'Ended';
  };

  const filteredLogs = logs
    .filter(log => log.ip_address !== '127.0.0.1' && log.ip_address !== '::1') // Exclude localhost
    .filter(log => {
      if (filter === 'active' && log.status !== 'active') return false;
      if (filter === 'ended' && log.status !== 'ended') return false;
      
      if (searchTerm) {
        const search = searchTerm.toLowerCase();
        return (
          log.ip_address.includes(search) ||
          (log.streamer_name && log.streamer_name.toLowerCase().includes(search)) ||
          (log.username && log.username.toLowerCase().includes(search)) ||
          log.streamer_id.toLowerCase().includes(search)
        );
      }
      
      return true;
    });

  return (
    <div className="streaming-logs">
      <div className="streaming-logs-header">
        <h2>Streaming Logs</h2>
        <div className="header-controls">
          <label className="auto-refresh-toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <label className="viewbot-toggle">
            <input
              type="checkbox"
              checked={includeViewbots}
              onChange={(e) => setIncludeViewbots(e.target.checked)}
            />
            Include ViewBots
          </label>
          <button 
            className="refresh-btn"
            onClick={() => { loadLogs(); loadStats(); }}
          >
            🔄 Refresh
          </button>
        </div>
      </div>

      {stats && (
        <div className="streaming-stats">
          <div className="stat-card">
            <span className="stat-value">{stats.active_sessions}</span>
            <span className="stat-label">Active Now</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.total_sessions}</span>
            <span className="stat-label">Total Sessions</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.unique_ips}</span>
            <span className="stat-label">Unique IPs</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.unique_users}</span>
            <span className="stat-label">Unique Users</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{formatDuration(Math.floor(stats.avg_duration))}</span>
            <span className="stat-label">Avg Duration</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.max_viewers}</span>
            <span className="stat-label">Peak Viewers</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.banned_sessions}</span>
            <span className="stat-label">Banned</span>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="alert alert-success">
          {successMessage}
        </div>
      )}

      <div className="logs-controls">
        <div className="filter-tabs">
          <button 
            className={`filter-tab ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All Sessions
          </button>
          <button 
            className={`filter-tab ${filter === 'active' ? 'active' : ''}`}
            onClick={() => setFilter('active')}
          >
            Active Only
          </button>
          <button 
            className={`filter-tab ${filter === 'ended' ? 'active' : ''}`}
            onClick={() => setFilter('ended')}
          >
            Ended Only
          </button>
        </div>
        <input
          type="text"
          className="search-input"
          placeholder="Search by IP, name, or ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="logs-content">
        {loading && !logs.length ? (
          <div className="loading">Loading streaming logs...</div>
        ) : filteredLogs.length === 0 ? (
          <div className="empty-state">
            <p>No streaming logs found</p>
            {filter === 'active' && <span>No active streams at the moment</span>}
          </div>
        ) : (
          <div className="logs-table">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Streamer</th>
                  <th>IP Address</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Duration</th>
                  <th>Viewers</th>
                  <th>Type</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.session_id} className={log.is_banned ? 'banned-row' : ''}>
                    <td>
                      <span className={`status-badge ${getStatusColor(log)}`}>
                        {getStatusText(log)}
                      </span>
                    </td>
                    <td className="streamer-cell">
                      <div className="streamer-info">
                        <span className="streamer-name">
                          {log.username || log.streamer_name || log.streamer_id}
                        </span>
                        {log.is_viewbot && <span className="viewbot-badge">Bot</span>}
                        {log.email && (
                          <span className="streamer-email">{log.email}</span>
                        )}
                      </div>
                    </td>
                    <td className="ip-cell">{log.ip_address}</td>
                    <td className="time-cell">
                      <div className="time-info">
                        <span className="time-main">{formatTime(log.started_at)}</span>
                        <span className="time-date">{new Date(log.started_at).toLocaleDateString()}</span>
                      </div>
                    </td>
                    <td className="time-cell">
                      {log.ended_at ? (
                        <div className="time-info">
                          <span className="time-main">{formatTime(log.ended_at)}</span>
                          <span className="time-date">{new Date(log.ended_at).toLocaleDateString()}</span>
                        </div>
                      ) : (
                        <span className="live-indicator">LIVE</span>
                      )}
                    </td>
                    <td>
                      {log.status === 'active' 
                        ? formatDuration(log.current_duration)
                        : formatDuration(log.duration)
                      }
                    </td>
                    <td className="viewers-cell">
                      {log.viewer_peak > 0 ? log.viewer_peak : '-'}
                    </td>
                    <td>{log.stream_type || 'Standard'}</td>
                    <td>
                      {!log.is_banned && !log.is_viewbot && (
                        <button
                          className="ban-btn"
                          onClick={() => handleBanIP(log)}
                          title="Ban this IP address"
                        >
                          Ban IP
                        </button>
                      )}
                      {log.disconnect_reason && (
                        <span className="disconnect-reason" title={log.disconnect_reason}>
                          ⚠️
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default StreamingLogs;