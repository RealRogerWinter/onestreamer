import React, { useState, useEffect } from 'react';
import authService from '../../services/AuthService';
import './IPBanManagement.css';

interface BannedIP {
  ip_address: string;
  banned_by_username: string;
  banned_at: string;
  reason: string;
  permanent: boolean;
  expires_at: string | null;
}

interface StreamerConnection {
  id: number;
  streamer_id: string;
  streamer_name: string;
  ip_address: string;
  connected_at: string;
  disconnected_at: string | null;
  stream_duration: number | null;
  connection_type: string;
  was_banned: boolean;
  disconnect_reason: string | null;
}

interface IPBanManagementProps {
  addLog: (message: string) => void;
}

const IPBanManagement: React.FC<IPBanManagementProps> = ({ addLog }) => {
  const [bannedIPs, setBannedIPs] = useState<BannedIP[]>([]);
  const [streamerHistory, setStreamerHistory] = useState<StreamerConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'banned' | 'history' | 'manual'>('banned');
  const [manualIP, setManualIP] = useState('');
  const [banReason, setBanReason] = useState('Manual ban by admin');
  const [isPermanent, setIsPermanent] = useState(true);
  const [expiresIn, setExpiresIn] = useState(24); // hours
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStreamer, setSelectedStreamer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    loadBannedIPs();
    loadStreamerHistory();
  }, []);

  const loadBannedIPs = async () => {
    try {
      setLoading(true);
      const token = authService.getToken();
      const response = await fetch('/api/admin/banned-ips', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setBannedIPs(data.bannedIPs || []);
        addLog(`Loaded ${data.bannedIPs?.length || 0} banned IPs`);
      } else {
        throw new Error('Failed to load banned IPs');
      }
    } catch (err: any) {
      setError('Failed to load banned IPs');
      addLog(`Error loading banned IPs: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loadStreamerHistory = async () => {
    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/streamer-connections', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setStreamerHistory(data.connections || []);
      }
    } catch (err: any) {
      console.error('Failed to load streamer history:', err);
    }
  };

  const handleUnbanIP = async (ip: string) => {
    if (!window.confirm(`Are you sure you want to unban IP ${ip}?`)) {
      return;
    }

    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/unban-ip', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ip })
      });

      if (response.ok) {
        setSuccessMessage(`Successfully unbanned IP: ${ip}`);
        addLog(`Unbanned IP: ${ip}`);
        await loadBannedIPs();
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        throw new Error('Failed to unban IP');
      }
    } catch (err: any) {
      setError(`Failed to unban IP: ${err.message}`);
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleManualBan = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!manualIP.trim()) {
      setError('Please enter an IP address');
      return;
    }

    // Basic IP validation
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(manualIP)) {
      setError('Invalid IP address format');
      return;
    }

    try {
      const token = authService.getToken();
      const expiresAt = !isPermanent 
        ? new Date(Date.now() + expiresIn * 60 * 60 * 1000).toISOString()
        : null;

      const response = await fetch('/api/admin/ban-ip-manual', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ip: manualIP,
          reason: banReason,
          permanent: isPermanent,
          expiresAt
        })
      });

      if (response.ok) {
        setSuccessMessage(`Successfully banned IP: ${manualIP}`);
        addLog(`Manually banned IP: ${manualIP} - Reason: ${banReason}`);
        setManualIP('');
        setBanReason('Manual ban by admin');
        await loadBannedIPs();
        setActiveTab('banned');
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to ban IP');
      }
    } catch (err: any) {
      setError(`Failed to ban IP: ${err.message}`);
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleBanFromHistory = async (ip: string, streamerId: string) => {
    if (!window.confirm(`Ban IP ${ip} (used by ${streamerId})?`)) {
      return;
    }

    try {
      const token = authService.getToken();
      const response = await fetch('/api/admin/ban-ip-manual', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ip,
          reason: `Banned from history - Streamer: ${streamerId}`,
          permanent: true
        })
      });

      if (response.ok) {
        setSuccessMessage(`Successfully banned IP: ${ip}`);
        addLog(`Banned IP from history: ${ip} (${streamerId})`);
        await loadBannedIPs();
        await loadStreamerHistory();
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        throw new Error('Failed to ban IP');
      }
    } catch (err: any) {
      setError(`Failed to ban IP: ${err.message}`);
      setTimeout(() => setError(null), 3000);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return 'N/A';
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

  const filteredBannedIPs = bannedIPs
    .filter(ban => ban.ip_address !== '127.0.0.1' && ban.ip_address !== '::1') // Exclude localhost
    .filter(ban =>
      ban.ip_address.includes(searchTerm) ||
      ban.banned_by_username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ban.reason.toLowerCase().includes(searchTerm.toLowerCase())
    );

  const filteredHistory = streamerHistory
    .filter(conn => conn.ip_address !== '127.0.0.1' && conn.ip_address !== '::1') // Exclude localhost
    .filter(conn => !selectedStreamer || conn.streamer_id === selectedStreamer);

  const uniqueStreamers = Array.from(new Set(
    streamerHistory
      .filter(conn => conn.ip_address !== '127.0.0.1' && conn.ip_address !== '::1')
      .map(conn => conn.streamer_id)
  ));

  return (
    <div className="ip-ban-management">
      <div className="ip-ban-header">
        <h2>IP Ban Management</h2>
        <div className="header-stats">
          <span className="stat-item">
            <strong>{bannedIPs.length}</strong> Banned IPs
          </span>
          <span className="stat-item">
            <strong>{uniqueStreamers.length}</strong> Unique Streamers
          </span>
        </div>
      </div>

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

      <div className="ip-ban-tabs">
        <button 
          className={`tab-btn ${activeTab === 'banned' ? 'active' : ''}`}
          onClick={() => setActiveTab('banned')}
        >
          Banned IPs
        </button>
        <button 
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          Streamer History
        </button>
        <button 
          className={`tab-btn ${activeTab === 'manual' ? 'active' : ''}`}
          onClick={() => setActiveTab('manual')}
        >
          Manual Ban
        </button>
      </div>

      <div className="ip-ban-content">
        {loading ? (
          <div className="loading">Loading...</div>
        ) : (
          <>
            {activeTab === 'banned' && (
              <div className="banned-ips-section">
                <div className="section-controls">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search IPs, users, or reasons..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                  <button 
                    className="refresh-btn"
                    onClick={loadBannedIPs}
                  >
                    Refresh
                  </button>
                </div>

                {filteredBannedIPs.length === 0 ? (
                  <div className="empty-state">
                    <p>No banned IPs found</p>
                  </div>
                ) : (
                  <div className="banned-ips-table">
                    <table>
                      <thead>
                        <tr>
                          <th>IP Address</th>
                          <th>Banned By</th>
                          <th>Date</th>
                          <th>Reason</th>
                          <th>Type</th>
                          <th>Expires</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredBannedIPs.map((ban) => (
                          <tr key={ban.ip_address}>
                            <td className="ip-cell">{ban.ip_address}</td>
                            <td>{ban.banned_by_username}</td>
                            <td>{formatDate(ban.banned_at)}</td>
                            <td>{ban.reason}</td>
                            <td>
                              <span className={`ban-type ${ban.permanent ? 'permanent' : 'temporary'}`}>
                                {ban.permanent ? 'Permanent' : 'Temporary'}
                              </span>
                            </td>
                            <td>
                              {ban.permanent ? 'Never' : formatDate(ban.expires_at!)}
                            </td>
                            <td>
                              <button
                                className="unban-btn"
                                onClick={() => handleUnbanIP(ban.ip_address)}
                              >
                                Unban
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'history' && (
              <div className="history-section">
                <div className="section-controls">
                  <select
                    className="streamer-select"
                    value={selectedStreamer || ''}
                    onChange={(e) => setSelectedStreamer(e.target.value || null)}
                  >
                    <option value="">All Streamers</option>
                    {uniqueStreamers.map(streamerId => (
                      <option key={streamerId} value={streamerId}>
                        {streamerId}
                      </option>
                    ))}
                  </select>
                  <button 
                    className="refresh-btn"
                    onClick={loadStreamerHistory}
                  >
                    Refresh
                  </button>
                </div>

                {filteredHistory.length === 0 ? (
                  <div className="empty-state">
                    <p>No streamer history found</p>
                  </div>
                ) : (
                  <div className="history-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Streamer</th>
                          <th>IP Address</th>
                          <th>Connected</th>
                          <th>Disconnected</th>
                          <th>Duration</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredHistory.map((conn) => (
                          <tr key={conn.id} className={conn.was_banned ? 'banned-row' : ''}>
                            <td>{conn.streamer_name || conn.streamer_id}</td>
                            <td className="ip-cell">{conn.ip_address}</td>
                            <td>{formatDate(conn.connected_at)}</td>
                            <td>{conn.disconnected_at ? formatDate(conn.disconnected_at) : 'Active'}</td>
                            <td>{formatDuration(conn.stream_duration)}</td>
                            <td>{conn.connection_type}</td>
                            <td>
                              {conn.was_banned ? (
                                <span className="status-banned">Banned</span>
                              ) : conn.disconnected_at ? (
                                <span className="status-ended">Ended</span>
                              ) : (
                                <span className="status-active">Active</span>
                              )}
                            </td>
                            <td>
                              {!conn.was_banned && !bannedIPs.find(b => b.ip_address === conn.ip_address) && (
                                <button
                                  className="ban-btn-small"
                                  onClick={() => handleBanFromHistory(conn.ip_address, conn.streamer_id)}
                                >
                                  Ban IP
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'manual' && (
              <div className="manual-ban-section">
                <form onSubmit={handleManualBan} className="manual-ban-form">
                  <div className="form-group">
                    <label htmlFor="ip-address">IP Address</label>
                    <input
                      id="ip-address"
                      type="text"
                      className="form-input"
                      placeholder="e.g., 192.168.1.1"
                      value={manualIP}
                      onChange={(e) => setManualIP(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="ban-reason">Reason</label>
                    <input
                      id="ban-reason"
                      type="text"
                      className="form-input"
                      placeholder="Reason for ban"
                      value={banReason}
                      onChange={(e) => setBanReason(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={isPermanent}
                        onChange={(e) => setIsPermanent(e.target.checked)}
                      />
                      Permanent Ban
                    </label>
                  </div>

                  {!isPermanent && (
                    <div className="form-group">
                      <label htmlFor="expires-in">Expires In (hours)</label>
                      <input
                        id="expires-in"
                        type="number"
                        className="form-input"
                        min="1"
                        value={expiresIn}
                        onChange={(e) => setExpiresIn(parseInt(e.target.value))}
                      />
                    </div>
                  )}

                  <button type="submit" className="submit-btn">
                    Ban IP Address
                  </button>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default IPBanManagement;