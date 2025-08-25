import React, { useState, useRef } from 'react';
import authService from '../services/AuthService';
import CloudflareTurnstile from './CloudflareTurnstile';
import { TURNSTILE_SITE_KEY } from '../config/turnstile';
import Tutorial from './Tutorial';
import './Auth.css';

interface SignupProps {
  onSuccess?: () => void;
  onSwitchToLogin?: () => void;
  onClose?: () => void;
}

const Signup: React.FC<SignupProps> = ({ onSuccess, onSwitchToLogin, onClose }) => {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showVerificationMessage, setShowVerificationMessage] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [turnstileKey, setTurnstileKey] = useState(0); // Add key to force re-render of Turnstile

  const validateForm = (): boolean => {
    if (!email || !username || !password || !confirmPassword) {
      setError('All fields are required');
      return false;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address');
      return false;
    }

    if (username.length < 3 || username.length > 20) {
      setError('Username must be between 3 and 20 characters');
      return false;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setError('Username can only contain letters, numbers, and underscores');
      return false;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters long');
      return false;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!validateForm()) {
      return;
    }

    if (!turnstileToken) {
      setError('Please complete the security verification');
      return;
    }

    setLoading(true);

    try {
      await authService.signup(email, username, password, turnstileToken);
      setShowVerificationMessage(true);
      if (onSuccess) {
        setTimeout(onSuccess, 2000);
      }
    } catch (err: any) {
      setError(err.message || 'Signup failed. Please try again.');
      // Reset Turnstile widget by changing its key, which forces a re-render
      setTurnstileToken(null);
      setTurnstileKey(prev => prev + 1); // Force Turnstile widget to re-render
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignup = () => {
    authService.googleLogin();
  };

  const handleShowTerms = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowTermsModal(true);
  };

  const handleCloseTerms = () => {
    setShowTermsModal(false);
  };

  if (showVerificationMessage) {
    return (
      <div className="auth-container" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
        <div className="auth-card">
          <h2>Check Your Email</h2>
          <p className="verification-message">
            We've sent a verification email to <strong>{email}</strong>.
            Please check your inbox and click the verification link to activate your account.
          </p>
          <button 
            className="auth-button auth-button-secondary"
            onClick={onSwitchToLogin}
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
        <h2>Create Account</h2>
        <p className="auth-subtitle">Join OneStreamer to start streaming</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={loading}
              required
            />
          </div>

          <div className="auth-form-group">
            <label htmlFor="username">Username</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Choose a username"
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
              placeholder="At least 6 characters"
              disabled={loading}
              required
            />
          </div>

          <div className="auth-form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              type="password"
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              disabled={loading}
              required
            />
          </div>

          <CloudflareTurnstile
            key={turnstileKey}
            siteKey={TURNSTILE_SITE_KEY}
            onVerify={(token) => setTurnstileToken(token)}
            onError={(error) => setError('Security verification failed. Please try again.')}
            onExpire={() => setTurnstileToken(null)}
            theme="auto"
            size="normal"
          />

          <div className="auth-terms-agreement">
            <p style={{ fontSize: '12px', color: '#666', textAlign: 'center', margin: '10px 0' }}>
              By signing up you agree to the OneStreamer{' '}
              <a 
                href="#" 
                onClick={handleShowTerms}
                style={{ color: '#0066cc', textDecoration: 'underline' }}
              >
                Terms of Service
              </a>
            </p>
          </div>

          <button 
            type="submit" 
            className="auth-button auth-button-primary"
            disabled={loading}
          >
            {loading ? 'Creating Account...' : 'Sign Up'}
          </button>
        </form>

        <div className="auth-divider">
          <span>OR</span>
        </div>

        <button 
          onClick={handleGoogleSignup}
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
            Already have an account?{' '}
            <button 
              className="auth-link"
              onClick={onSwitchToLogin}
              disabled={loading}
            >
              Sign In
            </button>
          </p>
        </div>
      </div>
      
      {showTermsModal && (
        <Tutorial 
          isOpen={showTermsModal} 
          onClose={handleCloseTerms}
          defaultTab="terms"
        />
      )}
    </div>
  );
};

export default Signup;