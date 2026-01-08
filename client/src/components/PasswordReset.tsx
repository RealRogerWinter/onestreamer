import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './Auth.css';

interface PasswordResetProps {
  onSuccess?: () => void;
  onClose?: () => void;
}

const PasswordReset: React.FC<PasswordResetProps> = ({ onSuccess, onClose }) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);

  useEffect(() => {
    // Extract token from URL path
    const path = window.location.pathname;
    const match = path.match(/^\/reset-password\/([a-fA-F0-9]+)$/);
    if (match && match[1]) {
      setResetToken(match[1]);
    } else {
      setError('Invalid or missing reset token');
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!resetToken) {
      setError('Invalid reset token');
      return;
    }

    if (!newPassword || !confirmPassword) {
      setError('Please fill in all fields');
      return;
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      await authService.resetPassword(resetToken, newPassword);
      setSuccess(true);
      
      // Redirect to home or login after 3 seconds
      setTimeout(() => {
        window.location.href = '/';
        if (onSuccess) {
          onSuccess();
        }
      }, 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to reset password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h2>Password Reset Successful!</h2>
          <div className="auth-success">
            Your password has been successfully reset. You will be redirected to the login page shortly.
          </div>
          <button 
            className="auth-button auth-button-primary"
            onClick={() => window.location.href = '/'}
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="auth-card">
        <h2>Reset Your Password</h2>
        <p className="auth-subtitle">Enter your new password below</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-form-group">
            <label htmlFor="newPassword">New Password</label>
            <input
              type="password"
              id="newPassword"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              disabled={loading || !resetToken}
              required
              minLength={6}
            />
          </div>

          <div className="auth-form-group">
            <label htmlFor="confirmPassword">Confirm New Password</label>
            <input
              type="password"
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              disabled={loading || !resetToken}
              required
              minLength={6}
            />
          </div>

          <button 
            type="submit" 
            className="auth-button auth-button-primary"
            disabled={loading || !resetToken}
          >
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>

          <button 
            type="button"
            className="auth-button auth-button-secondary"
            onClick={() => window.location.href = '/'}
            disabled={loading}
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
};

export default PasswordReset;