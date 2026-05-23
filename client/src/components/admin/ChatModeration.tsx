import React, { useState, useEffect } from 'react';
import authService from '../../services/AuthService';
import './ChatModeration.css';

interface BannedUser {
  username: string;
  bannedAt: string;
  bannedBy?: string;
  reason?: string;
}

interface TimedOutUser {
  username: string;
  endTime: number;
  reason?: string;
  timedOutBy?: string;
  startTime: number;
}

interface ChatModerationProps {
  addLog: (message: string) => void;
}

const ChatModeration: React.FC<ChatModerationProps> = ({ addLog }) => {
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([]);
  const [timedOutUsers, setTimedOutUsers] = useState<TimedOutUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);
  
  // Form states
  const [banUsername, setBanUsername] = useState('');
  const [banReason, setBanReason] = useState('');
  const [timeoutUsername, setTimeoutUsername] = useState('');
  const [timeoutDuration, setTimeoutDuration] = useState(60);
  const [timeoutReason, setTimeoutReason] = useState('');

  useEffect(() => {
    fetchModerationData();
    
    // Set up auto-refresh every 5 seconds
    const interval = setInterval(() => {
      fetchModerationData();
    }, 5000);
    
    setRefreshInterval(interval);
    
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, []);

  const fetchModerationData = async () => {
    try {
      const token = authService.getToken();
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/admin/moderation`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setBannedUsers(data.bannedUsers || []);
        
        // Filter out expired timeouts
        const currentTime = Date.now();
        const activeTimeouts = (data.timedOutUsers || []).filter((user: TimedOutUser) => 
          user.endTime > currentTime
        );
        setTimedOutUsers(activeTimeouts);
        
        addLog(`Loaded moderation data: ${data.bannedUsers?.length || 0} bans, ${activeTimeouts.length} active timeouts`);
      } else {
        throw new Error('Failed to fetch moderation data');
      }
    } catch (error) {
      console.error('Error fetching moderation data:', error);
      addLog('Error loading moderation data');
    } finally {
      setLoading(false);
    }
  };

  const handleBan = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!banUsername.trim()) {
      alert('Please enter a username to ban');
      return;
    }
    
    try {
      const token = authService.getToken();
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/admin/ban`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          username: banUsername.trim(),
          reason: banReason.trim() || 'No reason provided'
        })
      });
      
      if (response.ok) {
        addLog(`Successfully banned user: ${banUsername}`);
        setBanUsername('');
        setBanReason('');
        fetchModerationData();
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to ban user');
      }
    } catch (error) {
      console.error('Error banning user:', error);
      alert(error instanceof Error ? error.message : 'Failed to ban user');
      addLog(`Error banning user: ${error}`);
    }
  };

  const handleTimeout = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!timeoutUsername.trim()) {
      alert('Please enter a username to timeout');
      return;
    }
    
    if (timeoutDuration <= 0) {
      alert('Please enter a valid timeout duration');
      return;
    }
    
    try {
      const token = authService.getToken();
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/admin/timeout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          username: timeoutUsername.trim(),
          duration: timeoutDuration,
          reason: timeoutReason.trim() || 'No reason provided'
        })
      });
      
      if (response.ok) {
        addLog(`Successfully timed out user: ${timeoutUsername} for ${timeoutDuration} seconds`);
        setTimeoutUsername('');
        setTimeoutDuration(60);
        setTimeoutReason('');
        fetchModerationData();
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to timeout user');
      }
    } catch (error) {
      console.error('Error timing out user:', error);
      alert(error instanceof Error ? error.message : 'Failed to timeout user');
      addLog(`Error timing out user: ${error}`);
    }
  };

  const handleUnban = async (username: string) => {
    if (!window.confirm(`Are you sure you want to unban ${username}?`)) {
      return;
    }
    
    try {
      const token = authService.getToken();
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/admin/unban`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      });
      
      if (response.ok) {
        addLog(`Successfully unbanned user: ${username}`);
        fetchModerationData();
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to unban user');
      }
    } catch (error) {
      console.error('Error unbanning user:', error);
      alert(error instanceof Error ? error.message : 'Failed to unban user');
      addLog(`Error unbanning user: ${error}`);
    }
  };

  const handleRemoveTimeout = async (username: string) => {
    if (!window.confirm(`Are you sure you want to remove timeout for ${username}?`)) {
      return;
    }
    
    try {
      const token = authService.getToken();
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/admin/remove-timeout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username })
      });
      
      if (response.ok) {
        addLog(`Successfully removed timeout for user: ${username}`);
        fetchModerationData();
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove timeout');
      }
    } catch (error) {
      console.error('Error removing timeout:', error);
      alert(error instanceof Error ? error.message : 'Failed to remove timeout');
      addLog(`Error removing timeout: ${error}`);
    }
  };

  const formatTimeRemaining = (endTime: number): string => {
    const remaining = Math.max(0, endTime - Date.now());
    const seconds = Math.floor(remaining / 1000);
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

  if (loading) {
    return <div className="chat-moderation-loading">Loading moderation data...</div>;
  }

  return (
    <div className="chat-moderation">
      <div className="moderation-header">
        <h3>Chat Moderation</h3>
        <button 
          className="btn btn-secondary refresh-btn"
          onClick={fetchModerationData}
        >
          🔄 Refresh
        </button>
      </div>

      <div className="moderation-forms">
        <div className="moderation-form">
          <h4>Ban User</h4>
          <form onSubmit={handleBan}>
            <input
              type="text"
              placeholder="Username"
              value={banUsername}
              onChange={(e) => setBanUsername(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Reason (optional)"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
            />
            <button type="submit" className="btn btn-danger">
              Ban User
            </button>
          </form>
        </div>

        <div className="moderation-form">
          <h4>Timeout User</h4>
          <form onSubmit={handleTimeout}>
            <input
              type="text"
              placeholder="Username"
              value={timeoutUsername}
              onChange={(e) => setTimeoutUsername(e.target.value)}
              required
            />
            <input
              type="number"
              placeholder="Duration (seconds)"
              value={timeoutDuration}
              onChange={(e) => setTimeoutDuration(parseInt(e.target.value) || 60)}
              min="1"
              required
            />
            <input
              type="text"
              placeholder="Reason (optional)"
              value={timeoutReason}
              onChange={(e) => setTimeoutReason(e.target.value)}
            />
            <button type="submit" className="btn btn-warning">
              Timeout User
            </button>
          </form>
        </div>
      </div>

      <div className="moderation-lists">
        <div className="banned-users">
          <h4>Banned Users ({bannedUsers.length})</h4>
          {bannedUsers.length > 0 ? (
            <table className="moderation-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Banned At</th>
                  <th>Reason</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bannedUsers.map((user, index) => (
                  <tr key={index}>
                    <td className="username-cell">{user.username}</td>
                    <td>{new Date(user.bannedAt).toLocaleString()}</td>
                    <td>{user.reason || 'No reason provided'}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-success"
                        onClick={() => handleUnban(user.username)}
                      >
                        Unban
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="no-data">No banned users</p>
          )}
        </div>

        <div className="timed-out-users">
          <h4>Active Timeouts ({timedOutUsers.length})</h4>
          {timedOutUsers.length > 0 ? (
            <table className="moderation-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Time Remaining</th>
                  <th>Reason</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {timedOutUsers.map((user, index) => (
                  <tr key={index}>
                    <td className="username-cell">{user.username}</td>
                    <td className="time-remaining">
                      {formatTimeRemaining(user.endTime)}
                    </td>
                    <td>{user.reason || 'No reason provided'}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-success"
                        onClick={() => handleRemoveTimeout(user.username)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="no-data">No active timeouts</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatModeration;