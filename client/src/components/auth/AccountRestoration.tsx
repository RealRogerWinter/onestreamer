import React, { useState } from 'react';
import axios from 'axios';
import authService from '../../services/AuthService';
import './AccountRestoration.css';

interface AccountRestorationProps {
  userEmail: string;
  onRestore: () => void;
  onCancel: () => void;
}

const AccountRestoration: React.FC<AccountRestorationProps> = ({ userEmail, onRestore, onCancel }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRestore = async () => {
    setLoading(true);
    setError('');
    
    try {
      // We need to call the restore endpoint with the current user's credentials
      // Since they're already logged in, we just need to call the restore endpoint
      const token = authService.getToken();
      const response = await axios.post(
        `${process.env.REACT_APP_API_URL || 'https://onestreamer.live'}/auth/restore-account`,
        {
          email: userEmail,
          password: '' // We'll use token authentication instead
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );
      
      if (response.data.success) {
        // Update the user's status in local storage
        const user = authService.getUser();
        if (user) {
          user.accountStatus = 'active';
          delete user.account_status;
          localStorage.setItem('user', JSON.stringify(user));
        }
        onRestore();
      } else {
        setError(response.data.error || 'Failed to restore account');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to restore account');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      // Ensure logout completes before redirecting
      await authService.logout();
      // Clear all localStorage data to ensure complete session cleanup
      localStorage.clear();
      // Clear session storage as well
      sessionStorage.clear();
      // Redirect to home page
      window.location.href = '/';
    } catch (error) {
      console.error('Logout error:', error);
      // Even if the API call fails, still clear local data and redirect
      localStorage.clear();
      sessionStorage.clear();
      window.location.href = '/';
    }
  };

  return (
    <div className="restoration-overlay">
      <div className="restoration-modal">
        <div className="restoration-icon">⚠️</div>
        <h2>Account Pending Deletion</h2>
        
        <div className="restoration-content">
          <p>Your account is scheduled for deletion.</p>
          
          <div className="deletion-info">
            <p><strong>Important Information:</strong></p>
            <ul>
              <li>Your account has been marked for deletion</li>
              <li>All features are currently disabled</li>
              <li>Your data will be permanently deleted after the grace period</li>
              <li>You can restore your account now to cancel the deletion</li>
            </ul>
          </div>

          {error && (
            <div className="restoration-error">
              {error}
            </div>
          )}

          <div className="restoration-actions">
            <button 
              className="btn btn-success"
              onClick={handleRestore}
              disabled={loading}
            >
              {loading ? 'Restoring...' : 'Restore My Account'}
            </button>
            <button 
              className="btn btn-secondary"
              onClick={handleLogout}
              disabled={loading}
            >
              Logout
            </button>
          </div>

          <p className="restoration-note">
            If you wish to proceed with deletion, simply logout. Your account will be permanently deleted as scheduled.
          </p>
        </div>
      </div>
    </div>
  );
};

export default AccountRestoration;