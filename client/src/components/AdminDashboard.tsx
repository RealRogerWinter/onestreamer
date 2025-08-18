import React, { useState, useEffect } from 'react';

interface AdminDashboardProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

interface DashboardData {
  services: {
    stream: any;
    viewBot: any;
    takeover: any;
  };
  cooldowns: Array<{
    socketId: string;
    remaining: number;
    reason: string;
  }>;
  timestamp: string;
}

const AdminDashboard: React.FC<AdminDashboardProps> = ({ makeApiCall, addLog }) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

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

  const handleClearStream = async () => {
    if (!window.confirm('Are you sure you want to clear the current stream?')) {
      return;
    }

    try {
      await makeApiCall('/admin/clear-stream', { method: 'POST' });
      addLog('Stream cleared successfully');
      fetchDashboardData();
    } catch (error) {
      addLog(`Failed to clear stream: ${error}`);
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

  const handleResetAllCooldowns = async () => {
    if (!window.confirm('Are you sure you want to reset all cooldowns?')) {
      return;
    }

    try {
      await makeApiCall('/admin/reset-cooldowns', { method: 'POST' });
      addLog('All cooldowns reset successfully');
      fetchDashboardData();
    } catch (error) {
      addLog(`Failed to reset cooldowns: ${error}`);
    }
  };

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  if (!data) {
    return <div className="error">Failed to load dashboard data</div>;
  }

  const { services } = data;

  return (
    <div className="admin-dashboard">
      <div className="dashboard-header">
        <h3>System Overview</h3>
        <div className="dashboard-controls">
          <label className="auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (5s)
          </label>
          <button onClick={fetchDashboardData}>🔄 Refresh</button>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Stream Status */}
        <div className="dashboard-card">
          <div className="card-header">
            <h4>📺 Current Stream</h4>
            <span className={`status ${services.stream.hasActiveStream ? 'active' : 'inactive'}`}>
              {services.stream.hasActiveStream ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <div className="card-content">
            {services.stream.hasActiveStream ? (
              <>
                <div className="info-row">
                  <span>Stream ID:</span>
                  <code>{services.stream.streamerId}</code>
                </div>
                <div className="info-row">
                  <span>Type:</span>
                  <span>{services.stream.streamType}</span>
                </div>
                <div className="info-row">
                  <span>Viewers:</span>
                  <span>{services.stream.viewerCount}</span>
                </div>
                <div className="info-row">
                  <span>Duration:</span>
                  <span>{Math.floor(services.stream.streamDuration / 1000)}s</span>
                </div>
                <button 
                  className="danger-button"
                  onClick={handleClearStream}
                >
                  🚫 End Stream
                </button>
              </>
            ) : (
              <p>No active stream</p>
            )}
          </div>
        </div>

        {/* ViewBot System */}
        <div className="dashboard-card">
          <div className="card-header">
            <h4>🤖 ViewBot System</h4>
            <span className={`status ${services.viewBot?.totalBots > 0 ? 'active' : 'inactive'}`}>
              {services.viewBot?.totalBots > 0 ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
          <div className="card-content">
            {services.viewBot?.totalBots > 0 ? (
              <>
                <div className="info-row">
                  <span>Total Bots:</span>
                  <span>{services.viewBot.totalBots}</span>
                </div>
                <div className="info-row">
                  <span>Streaming:</span>
                  <span>{services.viewBot.streamingBots}</span>
                </div>
                <div className="info-row">
                  <span>Connected:</span>
                  <span>{services.viewBot.connectedBots}</span>
                </div>
                <div className="info-row">
                  <span>Rotation:</span>
                  <span className={services.viewBot.rotationEnabled ? 'active' : 'inactive'}>
                    {services.viewBot.rotationEnabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                </div>
              </>
            ) : (
              <p>No ViewBots active</p>
            )}
          </div>
        </div>

        {/* ViewBot Rotation System */}
        <div className="dashboard-card">
          <div className="card-header">
            <h4>🔄 ViewBot Rotation</h4>
            <span className={`status ${services.viewBot?.rotationEnabled ? 'active' : 'inactive'}`}>
              {services.viewBot?.rotationEnabled ? 'ENABLED' : 'DISABLED'}
            </span>
          </div>
          <div className="card-content">
            {services.viewBot?.rotationEnabled ? (
              <>
                <div className="info-row">
                  <span>Current Live Bot:</span>
                  <code>{services.viewBot.currentLiveBot ? services.viewBot.currentLiveBot.substring(0, 12) + '...' : 'None'}</code>
                </div>
                <div className="info-row">
                  <span>Available Bots:</span>
                  <span>{services.viewBot.availableBots || 0}</span>
                </div>
                <div className="info-row">
                  <span>Next Rotation:</span>
                  <span className="countdown-display">
                    {services.viewBot.timeToNextRotationFormatted || 'N/A'}
                  </span>
                </div>
                <div className="info-row">
                  <span>Real Streamer:</span>
                  <span className={services.viewBot.realStreamerActive ? 'active' : 'inactive'}>
                    {services.viewBot.realStreamerActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
              </>
            ) : (
              <p>Manual control only</p>
            )}
          </div>
        </div>

        {/* Takeover Service */}
        <div className="dashboard-card">
          <div className="card-header">
            <h4>⏱️ Takeover Service</h4>
            <span className="status active">RUNNING</span>
          </div>
          <div className="card-content">
            <div className="info-row">
              <span>Cooldown:</span>
              <span>{services.takeover.cooldownSeconds}s</span>
            </div>
            <div className="info-row">
              <span>Active Cooldowns:</span>
              <span>{data.cooldowns.length}</span>
            </div>
            {data.cooldowns.length > 0 && (
              <button 
                className="danger-button"
                onClick={handleResetAllCooldowns}
              >
                🔥 Reset All Cooldowns
              </button>
            )}
          </div>
        </div>

        {/* Active Cooldowns */}
        {data.cooldowns.length > 0 && (
          <div className="dashboard-card cooldowns-card">
            <div className="card-header">
              <h4>🚫 Active Cooldowns</h4>
              <span className="count">{data.cooldowns.length}</span>
            </div>
            <div className="card-content">
              {data.cooldowns.map((cooldown) => (
                <div key={cooldown.socketId} className="cooldown-item">
                  <div className="cooldown-info">
                    <div className="socket-id">
                      <code>{cooldown.socketId}</code>
                    </div>
                    <div className="cooldown-details">
                      <span className="time">{cooldown.remaining}s remaining</span>
                      <span className="reason">{cooldown.reason}</span>
                    </div>
                  </div>
                  <button 
                    className="remove-button"
                    onClick={() => handleRemoveCooldown(cooldown.socketId)}
                    title="Remove cooldown"
                  >
                    ❌
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* System Info */}
        <div className="dashboard-card">
          <div className="card-header">
            <h4>💻 System Info</h4>
          </div>
          <div className="card-content">
            <div className="info-row">
              <span>Server Time:</span>
              <span>{new Date(data.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="info-row">
              <span>Environment:</span>
              <span>Development</span>
            </div>
            <div className="info-row">
              <span>Version:</span>
              <span>1.0.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;