import React, { useEffect } from 'react';
import authService from '../../services/AuthService';

const OAuthCallback: React.FC = () => {
  useEffect(() => {
    const handleCallback = async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      const refreshToken = params.get('refreshToken');
      const error = params.get('error');

      if (error) {
        console.error('OAuth error:', error);
        window.location.href = '/';
        return;
      }

      if (token && refreshToken) {
        // Store tokens in localStorage
        localStorage.setItem('auth_token', token);
        localStorage.setItem('refresh_token', refreshToken);
        
        // Update auth service
        await authService.handleOAuthCallback();
        
        // Redirect to home page
        window.location.href = '/';
      } else {
        console.error('Missing tokens in OAuth callback');
        window.location.href = '/';
      }
    };

    handleCallback();
  }, []);

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100vh',
      color: '#fff'
    }}>
      <div>
        <h2>Completing sign in...</h2>
        <p>Please wait while we complete your authentication.</p>
      </div>
    </div>
  );
};

export default OAuthCallback;