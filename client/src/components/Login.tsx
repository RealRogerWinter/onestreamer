import React, { useState } from 'react';
import authService from '../services/AuthService';
import './Auth.css';

interface LoginProps {
  onSuccess?: () => void;
  onSwitchToSignup?: () => void;
  onClose?: () => void;
}

const Login: React.FC<LoginProps> = ({ onSuccess, onSwitchToSignup, onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetMessage, setResetMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Email and password are required');
      return;
    }

    setLoading(true);

    try {
      await authService.login(email, password);
      if (onSuccess) {
        onSuccess();
      }
    } catch (err: any) {
      setError(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    authService.googleLogin();
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResetMessage('');

    if (!resetEmail) {
      setError('Please enter your email address');
      return;
    }

    setLoading(true);

    try {
      await authService.requestPasswordReset(resetEmail);
      setResetMessage('Password reset instructions have been sent to your email.');
      setTimeout(() => {
        setShowForgotPassword(false);
        setResetMessage('');
      }, 3000);
    } catch (err: any) {
      setError('Failed to send reset email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (showForgotPassword) {
    return (
      <div className="auth-container" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
        <div className="auth-card">
          <h2>Reset Password</h2>
          <p className="auth-subtitle">Enter your email to receive reset instructions</p>

          {error && <div className="auth-error">{error}</div>}
          {resetMessage && <div className="auth-success">{resetMessage}</div>}

          <form onSubmit={handleForgotPassword} className="auth-form">
            <div className="auth-form-group">
              <label htmlFor="resetEmail">Email</label>
              <input
                type="email"
                id="resetEmail"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={loading}
                required
              />
            </div>

            <button 
              type="submit" 
              className="auth-button auth-button-primary"
              disabled={loading}
            >
              {loading ? 'Sending...' : 'Send Reset Email'}
            </button>

            <button 
              type="button"
              className="auth-button auth-button-secondary"
              onClick={() => setShowForgotPassword(false)}
              disabled={loading}
            >
              Back to Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="auth-card">
        <h2>Welcome Back</h2>
        <p className="auth-subtitle">Sign in to your OneStreamer account</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-form-group">
            <label htmlFor="email">Email or Username</label>
            <input
              type="text"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email or username"
              disabled={loading}
              required
            />
          </div>

          <div className="auth-form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              disabled={loading}
              required
            />
          </div>

          <div className="auth-form-actions">
            <button 
              type="button"
              className="auth-link"
              onClick={() => setShowForgotPassword(true)}
              disabled={loading}
            >
              Forgot password?
            </button>
          </div>

          <button 
            type="submit" 
            className="auth-button auth-button-primary"
            disabled={loading}
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="auth-divider">
          <span>OR</span>
        </div>

        <button 
          onClick={handleGoogleLogin}
          className="auth-button auth-button-google"
          disabled={loading}
        >
          <svg className="google-icon" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>

        <div className="auth-footer">
          <p>
            Don't have an account?{' '}
            <button 
              className="auth-link"
              onClick={onSwitchToSignup}
              disabled={loading}
            >
              Sign Up
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;