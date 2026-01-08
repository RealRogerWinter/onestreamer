import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './UserManagement.css';

interface AdminUser {
  id: number;
  email: string;
  username: string;
  created_at: string;
  last_login: string | null;
  is_verified: boolean;
  is_admin: boolean;
  is_moderator: boolean;
  is_banned: boolean;
}

interface UserManagementProps {
  addLog: (message: string) => void;
}

const UserManagement: React.FC<UserManagementProps> = ({ addLog }) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async (search?: string) => {
    try {
      setLoading(true);
      setError(null);
      const userData = await authService.getUsers(search || searchTerm);
      setUsers(userData);
      addLog(`Loaded ${userData.length} users`);
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to load users';
      setError(errorMsg);
      addLog(`Error loading users: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    loadUsers(searchTerm);
  };

  const handlePromoteUser = async (userId: number, username: string) => {
    if (!window.confirm(`Are you sure you want to promote ${username} to admin?`)) {
      return;
    }

    try {
      await authService.promoteUser(userId);
      addLog(`Promoted ${username} to admin`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to promote user';
      setError(errorMsg);
      addLog(`Error promoting user: ${errorMsg}`);
    }
  };

  const handlePromoteModerator = async (userId: number, username: string) => {
    if (!window.confirm(`Are you sure you want to promote ${username} to moderator?`)) {
      return;
    }

    try {
      await authService.promoteModerator(userId);
      addLog(`Promoted ${username} to moderator`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to promote user to moderator';
      setError(errorMsg);
      addLog(`Error promoting user to moderator: ${errorMsg}`);
    }
  };

  const handleDemoteModerator = async (userId: number, username: string) => {
    if (!window.confirm(`Are you sure you want to demote ${username} from moderator?`)) {
      return;
    }

    try {
      await authService.demoteModerator(userId);
      addLog(`Demoted ${username} from moderator`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to demote user from moderator';
      setError(errorMsg);
      addLog(`Error demoting user from moderator: ${errorMsg}`);
    }
  };

  const handleDemoteUser = async (userId: number, username: string) => {
    if (!window.confirm(`Are you sure you want to demote ${username} from admin?`)) {
      return;
    }

    try {
      await authService.demoteUser(userId);
      addLog(`Demoted ${username} from admin`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to demote user';
      setError(errorMsg);
      addLog(`Error demoting user: ${errorMsg}`);
    }
  };

  const handleBanUser = async (userId: number, username: string) => {
    if (!window.confirm(`Are you sure you want to ban ${username}?`)) {
      return;
    }

    try {
      await authService.banUser(userId);
      addLog(`Banned ${username}`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to ban user';
      setError(errorMsg);
      addLog(`Error banning user: ${errorMsg}`);
    }
  };

  const handleUnbanUser = async (userId: number, username: string) => {
    try {
      await authService.unbanUser(userId);
      addLog(`Unbanned ${username}`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to unban user';
      setError(errorMsg);
      addLog(`Error unbanning user: ${errorMsg}`);
    }
  };

  const handleDeleteUser = async (userId: number, username: string) => {
    if (!window.confirm(`Are you sure you want to DELETE ${username}? This action cannot be undone!`)) {
      return;
    }

    if (!window.confirm(`This will permanently delete all data for ${username}. Type "DELETE" to confirm.`)) {
      return;
    }

    try {
      await authService.deleteUser(userId);
      addLog(`Deleted user ${username}`);
      await loadUsers(); // Refresh the list
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Failed to delete user';
      setError(errorMsg);
      addLog(`Error deleting user: ${errorMsg}`);
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleDateString();
  };

  const getUserBadges = (user: AdminUser) => {
    const badges = [];
    if (user.is_admin) badges.push('Admin');
    if (user.is_moderator) badges.push('Moderator');
    if (user.is_banned) badges.push('Banned');
    if (user.is_verified) badges.push('Verified');
    return badges;
  };

  return (
    <div className="user-management">
      <div className="user-management-header">
        <h3>User Management</h3>
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder="Search users by email or username..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
          <button type="submit" className="search-btn">Search</button>
          <button type="button" onClick={() => { setSearchTerm(''); loadUsers(''); }} className="clear-btn">
            Clear
          </button>
        </form>
      </div>

      {error && (
        <div className="error-message">
          <strong>Error:</strong> {error}
          <button onClick={() => setError(null)} className="error-close">×</button>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading users...</div>
      ) : (
        <>
          <div className="users-summary">
            <span>Showing {users.length} users</span>
            <button onClick={() => loadUsers()} className="refresh-btn">Refresh</button>
          </div>

          <div className="users-table-container">
            <table className="users-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={user.is_banned ? 'banned-user' : ''}>
                    <td>{user.id}</td>
                    <td>{user.username}</td>
                    <td>{user.email}</td>
                    <td>
                      <div className="user-badges">
                        {getUserBadges(user).map((badge) => (
                          <span key={badge} className={`badge ${badge.toLowerCase()}`}>
                            {badge}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{formatDate(user.created_at)}</td>
                    <td>{formatDate(user.last_login)}</td>
                    <td>
                      <div className="user-actions">
                        {!user.is_admin ? (
                          <>
                            <button
                              onClick={() => handlePromoteUser(user.id, user.username)}
                              className="action-btn promote-btn"
                              title="Promote to Admin"
                            >
                              ↑ Admin
                            </button>
                            {!user.is_moderator ? (
                              <button
                                onClick={() => handlePromoteModerator(user.id, user.username)}
                                className="action-btn promote-btn"
                                title="Promote to Moderator"
                              >
                                ↑ Mod
                              </button>
                            ) : (
                              <button
                                onClick={() => handleDemoteModerator(user.id, user.username)}
                                className="action-btn demote-btn"
                                title="Demote from Moderator"
                              >
                                ↓ Mod
                              </button>
                            )}
                          </>
                        ) : (
                          user.id !== authService.getUser()?.id && (
                            <button
                              onClick={() => handleDemoteUser(user.id, user.username)}
                              className="action-btn demote-btn"
                              title="Demote from Admin"
                            >
                              ↓ Demote
                            </button>
                          )
                        )}

                        {!user.is_banned ? (
                          user.id !== authService.getUser()?.id && (
                            <button
                              onClick={() => handleBanUser(user.id, user.username)}
                              className="action-btn ban-btn"
                              title="Ban User"
                            >
                              🚫 Ban
                            </button>
                          )
                        ) : (
                          <button
                            onClick={() => handleUnbanUser(user.id, user.username)}
                            className="action-btn unban-btn"
                            title="Unban User"
                          >
                            ✓ Unban
                          </button>
                        )}

                        {user.id !== authService.getUser()?.id && (
                          <button
                            onClick={() => handleDeleteUser(user.id, user.username)}
                            className="action-btn delete-btn"
                            title="Delete User"
                          >
                            🗑️ Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={7} className="no-users">
                      No users found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default UserManagement;