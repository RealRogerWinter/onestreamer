import React, { useState, useEffect } from 'react';
import './AdminDashboardV3.css';

interface AdminDashboardV3Props {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

interface DashboardData {
  services: {
    stream: any;
    takeover: any;
  };
  cooldowns: Array<{
    socketId: string;
    remaining: number;
    reason: string;
  }>;
  timestamp: string;
}

interface QuickStat {
  label: string;
  value: string | number;
  icon: string;
  trend?: 'up' | 'down' | 'stable';
  color?: string;
}

const AdminDashboardV3: React.FC<AdminDashboardV3Props> = ({ makeApiCall, addLog }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);

  const fetchDashboardData = async () => {
    try {
      const result = await makeApiCall('/admin/dashboard');
      setData(result);
      setLoading(false);
    } catch (error) {
      setLoading(false);
      addLog(`Failed to fetch dashboard data: ${error}`);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(fetchDashboardData, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const handleQuickAction = async (action: string) => {
    switch (action) {
      case 'clear-stream':
        if (!window.confirm('Are you sure you want to clear the current stream?')) return;
        try {
          await makeApiCall('/admin/clear-stream', { method: 'POST' });
          addLog('Stream cleared successfully');
          fetchDashboardData();
        } catch (error) {
          addLog(`Failed to clear stream: ${error}`);
        }
        break;
      
      case 'reset-cooldowns':
        if (!window.confirm('Are you sure you want to reset all cooldowns?')) return;
        try {
          await makeApiCall('/admin/reset-cooldowns', { method: 'POST' });
          addLog('All cooldowns reset successfully');
          fetchDashboardData();
        } catch (error) {
          addLog(`Failed to reset cooldowns: ${error}`);
        }
        break;
    }
  };

  const handleRemoveCooldown = async (socketId: string) => {
    try {
      await makeApiCall('/admin/remove-cooldown', {
        method: 'POST',
        body: JSON.stringify({ socketId })
      });
      addLog(`Cooldown removed for ${socketId}`);
      fetchDashboardData();
    } catch (error) {
      addLog(`Failed to remove cooldown: ${error}`);
    }
  };

  if (loading) {
    return <div className="dashboard-v3-loading">Loading dashboard...</div>;
  }

  if (!data) {
    return <div className="dashboard-v3-error">Failed to load dashboard data</div>;
  }

  const { services } = data;

  // Calculate quick stats
  const quickStats: QuickStat[] = [
    {
      label: 'Stream Status',
      value: services.stream?.isActive ? 'Active' : 'Inactive',
      icon: '📡',
      color: services.stream?.isActive ? '#4caf50' : '#9e9e9e'
    },
    {
      label: 'Active Viewers',
      value: services.stream?.viewerCount || 0,
      icon: '👥',
      trend: 'up',
      color: '#2196f3'
    },
    {
      label: 'Stream Duration',
      value: services.stream?.duration || '00:00:00',
      icon: '⏱️',
      color: '#00bcd4'
    },
    {
      label: 'Active Cooldowns',
      value: data.cooldowns?.length || 0,
      icon: '⏳',
      trend: data.cooldowns?.length > 5 ? 'up' : 'down',
      color: '#ff5722'
    }
  ];

  return (
    <div className="dashboard-v3">
      {/* Dashboard Header */}
      <div className="dashboard-v3-header">
        <div className="dashboard-title">
          <h1>Dashboard Overview</h1>
          <span className="dashboard-subtitle">Real-time system monitoring and control</span>
        </div>
        
        <div className="dashboard-controls">
          <div className="auto-refresh-toggle">
            <input
              type="checkbox"
              id="auto-refresh"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <label htmlFor="auto-refresh">Auto Refresh</label>
          </div>
          <button className="refresh-btn" onClick={fetchDashboardData}>
            🔄 Refresh Now
          </button>
        </div>
      </div>

      {/* Quick Stats Grid */}
      <div className="quick-stats-grid">
        {quickStats.map((stat, index) => (
          <div
            key={index}
            className={`stat-card ${selectedMetric === stat.label ? 'selected' : ''}`}
            onClick={() => setSelectedMetric(stat.label)}
            style={{ borderColor: stat.color }}
          >
            <div className="stat-icon" style={{ color: stat.color }}>
              {stat.icon}
            </div>
            <div className="stat-content">
              <div className="stat-label">{stat.label}</div>
              <div className="stat-value" style={{ color: stat.color }}>
                {stat.value}
                {stat.trend && (
                  <span className={`trend-indicator ${stat.trend}`}>
                    {stat.trend === 'up' ? '↑' : stat.trend === 'down' ? '↓' : '→'}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="quick-actions-section">
        <h2>Quick Actions</h2>
        <div className="quick-actions-grid">
          <button 
            className="quick-action-card stream"
            onClick={() => handleQuickAction('clear-stream')}
          >
            <span className="action-icon">🗑️</span>
            <span className="action-label">Clear Stream</span>
            <span className="action-desc">Reset current stream data</span>
          </button>

          <button 
            className="quick-action-card cooldowns"
            onClick={() => handleQuickAction('reset-cooldowns')}
          >
            <span className="action-icon">⏰</span>
            <span className="action-label">Reset Cooldowns</span>
            <span className="action-desc">Clear all active cooldowns</span>
          </button>

          <button
            className="quick-action-card logs"
            onClick={() => addLog('Opening system logs...')}
          >
            <span className="action-icon">📝</span>
            <span className="action-label">View Logs</span>
            <span className="action-desc">Check system logs</span>
          </button>
        </div>
      </div>

      {/* Service Status Cards */}
      <div className="services-section">
        <h2>Service Status</h2>
        <div className="services-grid">
          {/* Stream Service */}
          <div className="service-card">
            <div className="service-header">
              <h3>📡 Stream Service</h3>
              <span className={`service-status ${services.stream?.isActive ? 'active' : 'inactive'}`}>
                {services.stream?.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="service-details">
              <div className="detail-row">
                <span>Room ID:</span>
                <code>{services.stream?.roomId || 'N/A'}</code>
              </div>
              <div className="detail-row">
                <span>Streamer:</span>
                <span>{services.stream?.streamerName || 'None'}</span>
              </div>
              <div className="detail-row">
                <span>Viewers:</span>
                <span>{services.stream?.viewerCount || 0}</span>
              </div>
              <div className="detail-row">
                <span>Duration:</span>
                <span>{services.stream?.duration || '00:00:00'}</span>
              </div>
              <div className="detail-row">
                <span>Quality:</span>
                <span>{services.stream?.quality || 'N/A'}</span>
              </div>
            </div>
          </div>

          {/* Takeover Service */}
          <div className="service-card">
            <div className="service-header">
              <h3>🎮 Takeover Service</h3>
              <span className={`service-status ${services.takeover?.isActive ? 'active' : 'inactive'}`}>
                {services.takeover?.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="service-details">
              <div className="detail-row">
                <span>Mode:</span>
                <span>{services.takeover?.mode || 'Standard'}</span>
              </div>
              <div className="detail-row">
                <span>Controller:</span>
                <span>{services.takeover?.controller || 'None'}</span>
              </div>
              <div className="detail-row">
                <span>Session Time:</span>
                <span>{services.takeover?.sessionTime || '00:00'}</span>
              </div>
              <div className="detail-row">
                <span>Queue:</span>
                <span>{services.takeover?.queueLength || 0} waiting</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Active Cooldowns */}
      {data.cooldowns && data.cooldowns.length > 0 && (
        <div className="cooldowns-section">
          <div className="section-header">
            <h2>Active Cooldowns ({data.cooldowns.length})</h2>
            <button 
              className="clear-all-btn"
              onClick={() => handleQuickAction('reset-cooldowns')}
            >
              Clear All
            </button>
          </div>
          <div className="cooldowns-list">
            {data.cooldowns.map((cooldown, index) => (
              <div key={index} className="cooldown-item">
                <div className="cooldown-info">
                  <span className="socket-id">{cooldown.socketId}</span>
                  <span className="cooldown-reason">{cooldown.reason}</span>
                </div>
                <div className="cooldown-actions">
                  <span className="remaining-time">
                    {Math.ceil(cooldown.remaining / 1000)}s
                  </span>
                  <button
                    className="remove-cooldown-btn"
                    onClick={() => handleRemoveCooldown(cooldown.socketId)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity Feed */}
      <div className="activity-feed">
        <h2>Recent Activity</h2>
        <div className="activity-list">
          <div className="activity-item">
            <span className="activity-time">{new Date().toLocaleTimeString()}</span>
            <span className="activity-text">Dashboard refreshed</span>
          </div>
          {/* Additional activity items would be populated here */}
        </div>
      </div>

      {/* Last Update */}
      <div className="dashboard-footer">
        <span className="last-update">
          Last updated: {new Date(data.timestamp).toLocaleString()}
        </span>
      </div>
    </div>
  );
};

export default AdminDashboardV3;