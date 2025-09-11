import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './OAuthUsernameSelection.css';

interface OAuthUsernameSelectionProps {
  onClose?: () => void;
}

const OAuthUsernameSelection: React.FC<OAuthUsernameSelectionProps> = ({ onClose }) => {
  const [username, setUsername] = useState('');
  const [suggestedUsername, setSuggestedUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [tempToken, setTempToken] = useState('');
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    // Extract temp token from URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get('tempToken');
    
    if (token) {
      setTempToken(token);
      
      // Decode the token to get user info (without verification since it's just for display)
      try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        
        const decoded = JSON.parse(jsonPayload);
        setSuggestedUsername(decoded.suggestedUsername || '');
        setUsername(decoded.suggestedUsername || '');
        setEmail(decoded.email || '');
        setDisplayName(decoded.displayName || '');
      } catch (e) {
        console.error('Failed to decode temp token:', e);
        setError('Invalid registration token. Please try signing in again.');
      }
    } else {
      setError('No registration token found. Please try signing in again.');
    }
  }, []);

  const validateUsername = (value: string): string => {
    if (value.length < 3) {
      return 'Username must be at least 3 characters long';
    }
    if (value.length > 20) {
      return 'Username must be 20 characters or less';
    }
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return 'Username can only contain letters, numbers, and underscores';
    }
    return '';
  };

  // Check username availability with debouncing
  useEffect(() => {
    if (!username || username === suggestedUsername) {
      setUsernameAvailable(null);
      return;
    }

    const validationError = validateUsername(username);
    if (validationError) {
      setUsernameAvailable(null);
      return;
    }

    const checkTimer = setTimeout(async () => {
      setIsCheckingUsername(true);
      try {
        const response = await fetch(`/auth/check-username/${encodeURIComponent(username)}`);
        const data = await response.json();
        setUsernameAvailable(data.available);
        if (!data.available && data.error) {
          setError(data.error);
        }
      } catch (err) {
        console.error('Failed to check username:', err);
      } finally {
        setIsCheckingUsername(false);
      }
    }, 500); // Debounce for 500ms

    return () => clearTimeout(checkTimer);
  }, [username, suggestedUsername]);

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUsername(value);
    setUsernameAvailable(null);
    
    // Clear error when user starts typing
    if (error && !error.includes('try again')) {
      setError('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate username
    const validationError = validateUsername(username);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/auth/complete-oauth-registration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tempToken,
          username
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to complete registration');
      }

      // Store tokens
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('refresh_token', data.refreshToken);
      
      // Update auth service
      await authService.handleOAuthCallback();
      
      // Redirect to home page
      window.location.href = '/';
    } catch (err: any) {
      setError(err.message || 'Failed to complete registration. Please try again.');
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    // Clear any temporary data and redirect to home
    window.location.href = '/';
  };

  return (
    <div className="oauth-username-selection-overlay">
      <div className="oauth-username-selection-modal">
        <h2>Complete Your Registration</h2>
        <p className="welcome-message">
          Welcome{displayName ? `, ${displayName}` : ''}! Please choose a username for your account.
        </p>
        
        {email && (
          <p className="email-info">
            Signing up with: <strong>{email}</strong>
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={handleUsernameChange}
              placeholder="Choose your username"
              disabled={isLoading}
              autoFocus
              maxLength={20}
            />
            <small className="field-hint">
              3-20 characters, letters, numbers, and underscores only
              {isCheckingUsername && ' • Checking...'}
              {!isCheckingUsername && usernameAvailable === true && username !== suggestedUsername && (
                <span style={{ color: '#4ade80', marginLeft: '8px' }}>✓ Available</span>
              )}
              {!isCheckingUsername && usernameAvailable === false && (
                <span style={{ color: '#f87171', marginLeft: '8px' }}>✗ Already taken</span>
              )}
            </small>
          </div>

          {error && !usernameAvailable && (
            <div className="error-message">
              {error}
            </div>
          )}

          <div className="button-group">
            <button
              type="button"
              onClick={handleCancel}
              disabled={isLoading}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !username || !!error || isCheckingUsername || usernameAvailable === false}
              className="btn-primary"
            >
              {isLoading ? 'Creating Account...' : 'Complete Registration'}
            </button>
          </div>
        </form>

        <p className="privacy-note">
          By completing registration, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
};

export default OAuthUsernameSelection;