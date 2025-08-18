import React, { useState, useEffect } from 'react';
import { useMainSocket } from '../contexts/SocketContext';
import './ConnectionMonitor.css';

interface Connection {
  id: string;
  connected: boolean;
  rooms: string[];
  handshake: {
    address: string;
    time: string;
    headers: string;
  };
}

interface EnhancedSession {
  socketId: string;
  ipAddress: string;
  userAgent: string;
  connectedAt: number;
  lastSeen: number;
  isActive: boolean;
  connectionCount: number;
  totalConnections: number;
  chatUsername?: string;
  chatColor?: string;
  userId?: number;
  authenticatedUser?: {
    id: number;
    username: string;
    email: string;
  };
  stats?: {
    chatMessageCount: number;
    streamTime: number;
    viewTime: number;
    streamCount: number;
    lastStreamAt: string | null;
  };
}

interface ConnectionData {
  totalConnections: number;
  connections: Connection[];
  sessions: EnhancedSession[];
  uniqueViewers: number;
  activeSessions: number;
  streamStatus: {
    hasActiveStream: boolean;
    streamerId: string | null;
    streamType: string | null;
    viewerCount: number;
    streamStartTime: number | null;
    streamDuration: number;
  };
  stats?: {
    totalSessions: number;
    uniqueViewers: number;
    totalSockets: number;
    activeSessions: number;
  };
}

interface ConnectionMonitorProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

const ConnectionMonitor: React.FC<ConnectionMonitorProps> = ({ makeApiCall, addLog }) => {
  const { socket, connected } = useMainSocket();
  const [data, setData] = useState<ConnectionData>({
    totalConnections: 0,
    connections: [],
    sessions: [],
    uniqueViewers: 0,
    activeSessions: 0,
    streamStatus: {
      hasActiveStream: false,
      streamerId: null,
      streamType: null,
      viewerCount: 0,
      streamStartTime: null,
      streamDuration: 0
    }
  });
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [userTypeFilter, setUserTypeFilter] = useState('');
  const [sortBy, setSortBy] = useState('connected');
  const [selectedConnection, setSelectedConnection] = useState<EnhancedSession | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  const fetchConnections = async () => {
    try {
      const result = await makeApiCall('/admin/connections');
      setData(result);
      setLoading(false);
    } catch (error) {
      setLoading(false);
      addLog(`Failed to fetch connections: ${error}`);
    }
  };

  useEffect(() => {
    fetchConnections();
  }, []);

  // Setup WebSocket listeners for real-time updates
  useEffect(() => {
    if (!socket || !connected) return;

    socket.on('user-connected', () => {
      addLog('New user connected');
      fetchConnections();
    });
    
    socket.on('user-disconnected', () => {
      addLog('User disconnected');
      fetchConnections();
    });
    
    socket.on('stream-started', () => {
      addLog('Stream started');
      fetchConnections();
    });
    
    socket.on('stream-ended', () => {
      addLog('Stream ended');
      fetchConnections();
    });

    return () => {
      socket.off('user-connected');
      socket.off('user-disconnected');
      socket.off('stream-started');
      socket.off('stream-ended');
    };
  }, [socket, connected]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchConnections, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const getConnectionStatus = (session: EnhancedSession): string => {
    if (data.streamStatus?.streamerId === session.socketId) {
      return 'streaming';
    }
    if (!session.isActive) {
      return 'disconnected';
    }
    if (Date.now() - session.lastSeen > 60000) {
      return 'idle';
    }
    return 'active';
  };

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const parseUserAgent = (ua: string): string => {
    if (!ua || typeof ua !== 'string') return 'Unknown device';
    
    if (ua.includes('Chrome')) return 'Chrome Browser';
    if (ua.includes('Firefox')) return 'Firefox Browser';
    if (ua.includes('Safari')) return 'Safari Browser';
    if (ua.includes('Edge')) return 'Edge Browser';
    if (ua.includes('Mobile')) return 'Mobile Device';
    
    return ua.length > 30 ? ua.substring(0, 30) + '...' : ua;
  };

  const handleKickConnection = async (socketId: string) => {
    if (!window.confirm('Are you sure you want to disconnect this user?')) return;
    
    try {
      // Use API call instead of socket for admin actions
      await makeApiCall('/admin/force-disconnect', {
        method: 'POST',
        body: JSON.stringify({ socketId })
      });
      
      addLog(`Kicked connection: ${socketId}`);
      setTimeout(fetchConnections, 500);
    } catch (error) {
      addLog(`Failed to kick connection: ${error}`);
    }
  };

  const handleSendMessage = async (socketId: string) => {
    const message = window.prompt('Enter message to send to this user:');
    if (!message) return;
    
    try {
      // Use API call instead of socket for admin actions
      await makeApiCall('/admin/send-message', {
        method: 'POST',
        body: JSON.stringify({ 
          socketId,
          message 
        })
      });
      
      addLog(`Sent message to: ${socketId}`);
    } catch (error) {
      addLog(`Failed to send message: ${error}`);
    }
  };

  const handleExportData = () => {
    const csvContent = [
      ['Status', 'User Type', 'Chat Username', 'IP Address', 'Socket ID', 'Messages', 'Session Duration', 'Connected At'],
      ...filteredSessions.map(session => [
        getConnectionStatus(session),
        session.authenticatedUser ? 'authenticated' : 'anonymous',
        session.chatUsername || 'Anonymous',
        session.ipAddress,
        session.socketId,
        session.stats?.chatMessageCount || 0,
        formatDuration(Date.now() - session.connectedAt),
        new Date(session.connectedAt).toISOString()
      ])
    ].map(row => row.join(',')).join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `connections_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
    
    addLog('Exported connection data to CSV');
  };

  const showConnectionDetails = (session: EnhancedSession) => {
    setSelectedConnection(session);
    setShowDetailModal(true);
  };

  // Filter and sort sessions
  const filteredSessions = data.sessions
    .filter(session => {
      // Search filter
      if (searchTerm) {
        const search = searchTerm.toLowerCase();
        if (!session.socketId.toLowerCase().includes(search) &&
            !session.ipAddress.toLowerCase().includes(search) &&
            !(session.chatUsername?.toLowerCase().includes(search)) &&
            !(session.authenticatedUser?.username.toLowerCase().includes(search))) {
          return false;
        }
      }
      
      // Status filter
      if (statusFilter) {
        const status = getConnectionStatus(session);
        if (status !== statusFilter) return false;
      }
      
      // User type filter
      if (userTypeFilter) {
        const isAuthenticated = !!session.authenticatedUser;
        if (userTypeFilter === 'authenticated' && !isAuthenticated) return false;
        if (userTypeFilter === 'anonymous' && isAuthenticated) return false;
      }
      
      return true;
    })
    .sort((a, b) => {
      switch(sortBy) {
        case 'connected':
          return b.connectedAt - a.connectedAt;
        case 'activity':
          return b.lastSeen - a.lastSeen;
        case 'messages':
          return (b.stats?.chatMessageCount || 0) - (a.stats?.chatMessageCount || 0);
        case 'duration':
          return (Date.now() - a.connectedAt) - (Date.now() - b.connectedAt);
        default:
          return 0;
      }
    });

  // Calculate statistics
  const stats = {
    totalConnections: data.totalConnections,
    uniqueUsers: data.uniqueViewers,
    // Count unique authenticated users (by userId)
    authenticatedUsers: new Set(
      data.sessions
        .filter(s => s.userId && s.userId > 0)
        .map(s => s.userId)
    ).size,
    activeStreamers: data.sessions.filter(s => getConnectionStatus(s) === 'streaming').length,
    totalViewers: data.streamStatus?.viewerCount || 0,
    chatParticipants: data.sessions.filter(s => (s.stats?.chatMessageCount || 0) > 0).length
  };

  if (loading) {
    return <div className="loading">Loading connections...</div>;
  }

  return (
    <div className="connection-monitor-enhanced">
      {/* Header */}
      <div className="monitor-header">
        <div className="header-title">
          <h3>🔌 Connections Manager</h3>
          {autoRefresh && <span className="refresh-indicator">🔄</span>}
        </div>
        <div className="header-actions">
          <button onClick={handleExportData} className="btn btn-secondary">
            📊 Export Data
          </button>
          <button onClick={fetchConnections} className="btn btn-primary">
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Statistics Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.totalConnections}</div>
          <div className="stat-label">Total Connections</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.uniqueUsers}</div>
          <div className="stat-label">Unique Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.authenticatedUsers}</div>
          <div className="stat-label">Authenticated</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.activeStreamers}</div>
          <div className="stat-label">Active Streamers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.totalViewers}</div>
          <div className="stat-label">Total Viewers</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.chatParticipants}</div>
          <div className="stat-label">Chat Participants</div>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="filters-bar">
        <div className="filter-group">
          <label className="filter-label">Search</label>
          <input 
            type="text" 
            className="filter-input" 
            placeholder="Username, IP, Socket ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <label className="filter-label">Status</label>
          <select 
            className="filter-input" 
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="streaming">Streaming</option>
            <option value="idle">Idle</option>
            <option value="disconnected">Disconnected</option>
          </select>
        </div>
        <div className="filter-group">
          <label className="filter-label">User Type</label>
          <select 
            className="filter-input"
            value={userTypeFilter}
            onChange={(e) => setUserTypeFilter(e.target.value)}
          >
            <option value="">All Users</option>
            <option value="authenticated">Authenticated</option>
            <option value="anonymous">Anonymous</option>
          </select>
        </div>
        <div className="filter-group">
          <label className="filter-label">Sort By</label>
          <select 
            className="filter-input"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="connected">Connection Time</option>
            <option value="activity">Last Activity</option>
            <option value="messages">Chat Messages</option>
            <option value="duration">Session Duration</option>
          </select>
        </div>
        <div className="filter-group">
          <label className="auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (5s)
          </label>
        </div>
      </div>

      {/* Connections Table */}
      <div className="connections-table-container">
        <table className="connections-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>User Identity</th>
              <th>Chat Name</th>
              <th>IP Address</th>
              <th>Connection Info</th>
              <th>Activity</th>
              <th>Session Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredSessions.length > 0 ? (
              filteredSessions.map((session) => {
                const status = getConnectionStatus(session);
                return (
                  <tr key={session.socketId}>
                    <td>
                      <span className={`status-badge status-${status}`}>
                        {status}
                      </span>
                    </td>
                    <td>
                      {session.authenticatedUser ? (
                        <span className="user-badge authenticated">
                          👤 {session.authenticatedUser.username}
                        </span>
                      ) : session.userId && session.userId > 0 ? (
                        <span className="user-badge authenticated">
                          👤 User #{session.userId}
                        </span>
                      ) : (
                        <span className="user-badge anonymous">
                          👻 Anonymous
                        </span>
                      )}
                    </td>
                    <td>
                      <span 
                        className="chat-username"
                        style={{
                          backgroundColor: `${session.chatColor || '#718096'}20`,
                          color: session.chatColor || '#718096'
                        }}
                      >
                        {status === 'streaming' ? '📹' : '💬'} {session.chatUsername || 'Anonymous'}
                      </span>
                    </td>
                    <td>
                      <span className="ip-address">{session.ipAddress}</span>
                    </td>
                    <td>
                      <div className="socket-id">{session.socketId.substring(0, 12)}...</div>
                      <div className="device-info" title={session.userAgent}>
                        {parseUserAgent(session.userAgent)}
                      </div>
                    </td>
                    <td>
                      <div>💬 {session.stats?.chatMessageCount || 0} messages</div>
                      <div>👁️ {formatDuration(session.stats?.viewTime || 0)} viewed</div>
                    </td>
                    <td>
                      <span className="duration">
                        {formatDuration(Date.now() - session.connectedAt)}
                      </span>
                    </td>
                    <td>
                      <div className="connection-actions">
                        <button 
                          className="action-btn btn-info" 
                          onClick={() => showConnectionDetails(session)}
                          title="View Details"
                        >
                          👁️
                        </button>
                        <button 
                          className="action-btn btn-message"
                          onClick={() => handleSendMessage(session.socketId)}
                          title="Send Message"
                        >
                          💬
                        </button>
                        <button 
                          className="action-btn btn-kick"
                          onClick={() => handleKickConnection(session.socketId)}
                          title="Disconnect"
                        >
                          🚫
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={8} className="no-data">
                  {searchTerm || statusFilter || userTypeFilter 
                    ? 'No connections match your filters' 
                    : 'No connections found'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Detail Modal */}
      {showDetailModal && selectedConnection && (
        <div className="detail-modal active">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title">Connection Details</h2>
              <button 
                className="modal-close" 
                onClick={() => setShowDetailModal(false)}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-section">
                <div className="detail-label">Connection Identity</div>
                <div className="detail-value">
                  <div>Socket ID: {selectedConnection.socketId}</div>
                  <div>IP Address: {selectedConnection.ipAddress}</div>
                  <div>User Type: {selectedConnection.authenticatedUser ? 'Authenticated' : 'Anonymous'}</div>
                  {selectedConnection.authenticatedUser && (
                    <>
                      <div>User ID: {selectedConnection.authenticatedUser.id}</div>
                      <div>Username: {selectedConnection.authenticatedUser.username}</div>
                      <div>Email: {selectedConnection.authenticatedUser.email}</div>
                    </>
                  )}
                </div>
              </div>
              
              <div className="detail-section">
                <div className="detail-label">Chat Information</div>
                <div className="detail-value">
                  <div>Username: {selectedConnection.chatUsername || 'Anonymous'}</div>
                  <div>Color: <span style={{color: selectedConnection.chatColor}}>{selectedConnection.chatColor}</span></div>
                  <div>Messages Sent: {selectedConnection.stats?.chatMessageCount || 0}</div>
                </div>
              </div>
              
              <div className="detail-section">
                <div className="detail-label">Session Metrics</div>
                <div className="metrics-grid">
                  <div className="metric-item">
                    <div className="metric-value">
                      {formatDuration(Date.now() - selectedConnection.connectedAt)}
                    </div>
                    <div className="metric-label">Session Duration</div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-value">
                      {formatDuration(selectedConnection.stats?.viewTime || 0)}
                    </div>
                    <div className="metric-label">View Time</div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-value">
                      {formatDuration(selectedConnection.stats?.streamTime || 0)}
                    </div>
                    <div className="metric-label">Stream Time</div>
                  </div>
                  <div className="metric-item">
                    <div className="metric-value">
                      {selectedConnection.stats?.chatMessageCount || 0}
                    </div>
                    <div className="metric-label">Chat Messages</div>
                  </div>
                </div>
              </div>
              
              <div className="detail-section">
                <div className="detail-label">Device Information</div>
                <div className="detail-value">
                  <div style={{wordBreak: 'break-all'}}>{selectedConnection.userAgent}</div>
                </div>
              </div>
              
              <div className="detail-section">
                <div className="detail-label">Timestamps</div>
                <div className="detail-value">
                  <div>Connected: {new Date(selectedConnection.connectedAt).toLocaleString()}</div>
                  <div>Last Activity: {new Date(selectedConnection.lastSeen).toLocaleString()}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectionMonitor;