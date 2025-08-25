import React, { useState, useEffect } from 'react';
import axios from 'axios';
import authService from '../services/AuthService';
import './DeletionConfirmation.css';

interface DeletionConfirmationProps {
  onClose: () => void;
}

const DeletionConfirmation: React.FC<DeletionConfirmationProps> = ({ onClose }) => {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [countdown, setCountdown] = useState(10);

  useEffect(() => {
    const path = window.location.pathname;
    
    // Check if we're on a confirm-deletion path
    if (!path.startsWith('/confirm-deletion/')) {
      setStatus('error');
      setMessage('Invalid deletion confirmation URL');
      return;
    }

    // Extract token - everything after /confirm-deletion/
    const token = path.substring('/confirm-deletion/'.length);
    
    if (!token || token.length < 20) {
      setStatus('error');
      setMessage('Invalid deletion token');
      return;
    }

    // Confirm the deletion
    confirmDeletion(token);
  }, []);

  useEffect(() => {
    if (status === 'success' && countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else if (status === 'success' && countdown === 0) {
      // Log out and redirect
      handleLogout();
    }
  }, [status, countdown]);

  const confirmDeletion = async (token: string) => {
    try {
      const response = await axios.post(
        `${process.env.REACT_APP_API_URL || 'https://onestreamer.live'}/auth/confirm-deletion`,
        { token }
      );

      if (response.data.success) {
        setStatus('success');
        setMessage('Your account has been confirmed for deletion. You will be logged out in a moment...');
        
        // Clear local storage and session data immediately
        localStorage.clear();
        sessionStorage.clear();
        
        // Clear auth service data
        authService.logout();
      } else {
        setStatus('error');
        setMessage(response.data.error || 'Failed to confirm account deletion');
      }
    } catch (error: any) {
      setStatus('error');
      setMessage(error.response?.data?.error || 'Failed to confirm account deletion. The link may be expired or invalid.');
    }
  };

  const handleLogout = () => {
    // Final cleanup
    localStorage.clear();
    sessionStorage.clear();
    
    // Clear all cookies
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
    
    // Redirect to home page
    window.location.href = '/';
  };

  const handleClose = () => {
    window.location.href = '/';
    onClose();
  };

  return (
    <div className="deletion-confirmation-overlay">
      <div className="deletion-confirmation-modal">
        <div className="deletion-confirmation-content">
          {status === 'loading' && (
            <>
              <div className="deletion-spinner"></div>
              <h2>Confirming Account Deletion</h2>
              <p>Please wait while we process your request...</p>
            </>
          )}
          
          {status === 'success' && (
            <>
              <div className="deletion-success-icon">✓</div>
              <h2>Account Deletion Confirmed</h2>
              <div className="deletion-success-message">
                <p>{message}</p>
                <div className="deletion-warning">
                  <p><strong>Important:</strong></p>
                  <ul>
                    <li>Your account will be permanently deleted in 15 days</li>
                    <li>You can restore your account by logging in within the next 15 days</li>
                    <li>After 15 days, all your data will be permanently removed</li>
                  </ul>
                </div>
                <p className="deletion-countdown">
                  Logging out in {countdown} seconds...
                </p>
              </div>
            </>
          )}
          
          {status === 'error' && (
            <>
              <div className="deletion-error-icon">✕</div>
              <h2>Deletion Confirmation Failed</h2>
              <p className="deletion-error-message">{message}</p>
              <button className="btn btn-primary" onClick={handleClose}>
                Return to Home
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeletionConfirmation;