import React, { useEffect, useState } from 'react';
import authService from '../services/AuthService';
import './Auth.css';

interface EmailVerificationProps {
  onClose: () => void;
  onSuccess: () => void;
}

const EmailVerification: React.FC<EmailVerificationProps> = ({ onClose, onSuccess }) => {
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [message, setMessage] = useState('Verifying your email...');

  useEffect(() => {
    // Only run once on mount
    let isMounted = true;
    
    const verifyEmail = async () => {
      // Extract token from URL path
      const path = window.location.pathname;
      console.log('📧 EmailVerification Component - Current path:', path);
      
      // Check if we're on a verify-email path
      if (!path.startsWith('/verify-email/')) {
        console.log('📧 Component mounted but not on verification path, closing...');
        // Don't show error, just close the component
        if (isMounted) {
          onClose();
        }
        return;
      }
      
      // Extract token - everything after /verify-email/
      const token = path.substring('/verify-email/'.length);
      
      if (!token || token.length === 0) {
        console.error('📧 No token found in path:', path);
        setStatus('error');
        setMessage('Invalid verification link - no token provided');
        return;
      }
      
      console.log('📧 Token extracted:', token, 'Length:', token.length);

      try {
        await authService.verifyEmail(token);
        setStatus('success');
        setMessage('Email verified successfully! You can now use all features.');
        
        // Clear the URL
        window.history.replaceState({}, document.title, '/');
        
        // Refresh user profile to update verification status
        await authService.getProfile();
        
        // Call success callback after a short delay
        setTimeout(() => {
          onSuccess();
        }, 2000);
      } catch (error: any) {
        console.error('📧 Verification API error:', error);
        console.error('📧 Error response:', error.response);
        console.error('📧 Error data:', error.response?.data);
        setStatus('error');
        const errorMessage = error.response?.data?.error || error.message || 'Failed to verify email. The link may be invalid or expired.';
        setMessage(errorMessage);
      }
    };

    verifyEmail();
    
    return () => {
      isMounted = false;
    };
  }, []); // Remove onSuccess from dependencies to prevent re-runs

  return (
    <div className="auth-container" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="auth-card">
        <h2>Email Verification</h2>
        
        <div style={{ textAlign: 'center', padding: '20px' }}>
          {status === 'verifying' && (
            <>
              <div className="loading-spinner" style={{ 
                width: '40px', 
                height: '40px', 
                border: '4px solid #f3f3f3',
                borderTop: '4px solid #667eea',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
                margin: '20px auto'
              }}></div>
              <p style={{ color: '#666' }}>{message}</p>
            </>
          )}
          
          {status === 'success' && (
            <>
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>✅</div>
              <p style={{ color: '#28a745', fontWeight: 'bold' }}>{message}</p>
            </>
          )}
          
          {status === 'error' && (
            <>
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>❌</div>
              <p style={{ color: '#dc3545', fontWeight: 'bold', marginBottom: '20px' }}>{message}</p>
              <button 
                className="auth-button auth-button-primary"
                onClick={onClose}
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default EmailVerification;