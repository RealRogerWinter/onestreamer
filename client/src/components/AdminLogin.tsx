import React, { useState } from 'react';

interface AdminLoginProps {
  onLogin: (adminKey: string) => void;
}

const AdminLogin: React.FC<AdminLoginProps> = ({ onLogin }) => {
  const [adminKey, setAdminKey] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      // Test the admin key by making a simple API call
      const response = await fetch(`${process.env.REACT_APP_SERVER_URL || 'http://localhost:8080'}/admin/dashboard`, {
        headers: {
          'x-admin-key': adminKey
        }
      });

      if (response.ok) {
        onLogin(adminKey);
      } else {
        const data = await response.json();
        setError(data.error || 'Invalid admin key');
      }
    } catch (error) {
      setError('Unable to connect to server');
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickLogin = () => {
    setAdminKey('***REMOVED-ADMIN-KEY***');
  };

  return (
    <div className="admin-login">
      <div className="login-info">
        <h3>Administrator Access</h3>
        <p>Enter the admin key to access the control panel</p>
      </div>

      <form onSubmit={handleSubmit} className="login-form">
        <div className="form-group">
          <label htmlFor="adminKey">Admin Key:</label>
          <input
            type="password"
            id="adminKey"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="Enter admin key..."
            disabled={isLoading}
            autoFocus
          />
        </div>

        {error && (
          <div className="error-message">{error}</div>
        )}

        <div className="form-actions">
          <button 
            type="submit" 
            disabled={!adminKey.trim() || isLoading}
            className="login-button"
          >
            {isLoading ? 'Authenticating...' : 'Login'}
          </button>
        </div>

        <div className="quick-access">
          <p className="dev-note">
            <small>Development: Current key is <code>***REMOVED-ADMIN-KEY***</code></small>
          </p>
          <button 
            type="button" 
            onClick={handleQuickLogin}
            className="quick-login-button"
          >
            Use Current Key
          </button>
        </div>
      </form>
    </div>
  );
};

export default AdminLogin;