import React, { useState, useEffect } from 'react';
import { useMainSocket } from '../contexts/SocketContext';
import authService from '../services/AuthService';
import './BotsPanel.css';

interface ViewBotStatus {
  totalBots: number;
  streamingBots: number;
  connectedBots: number;
  rotationEnabled: boolean;
  currentLiveBot: string | null;
  currentLiveBotName: string | null;
  availableBots: number;
}

interface ChatBotStatus {
  totalBots: number;
  enabledBots: number;
  movieBotEnabled: boolean;
  globalPrompt?: string;
}

interface BotsPanelProps {
  // Optional props for future extensibility
}

const BotsPanel: React.FC<BotsPanelProps> = () => {
  const { socket } = useMainSocket();
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPanelVisible, setIsPanelVisible] = useState(() => {
    const saved = localStorage.getItem('botsPanelVisible');
    return saved !== null ? saved === 'true' : false;
  });
  
  // ViewBot state
  const [viewBotStatus, setViewBotStatus] = useState<ViewBotStatus>({
    totalBots: 0,
    streamingBots: 0,
    connectedBots: 0,
    rotationEnabled: false,
    currentLiveBot: null,
    currentLiveBotName: null,
    availableBots: 0
  });
  
  // ChatBot state
  const [chatBotStatus, setChatBotStatus] = useState<ChatBotStatus>({
    totalBots: 0,
    enabledBots: 0,
    movieBotEnabled: false
  });
  
  // Control states
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [activeSection, setActiveSection] = useState<'viewbot' | 'chatbot'>('viewbot');

  useEffect(() => {
    checkAdminStatus();
  }, []);

  useEffect(() => {
    localStorage.setItem('botsPanelVisible', isPanelVisible.toString());
  }, [isPanelVisible]);

  useEffect(() => {
    if (isAdmin && isPanelVisible) {
      fetchBotStatus();
      const interval = setInterval(fetchBotStatus, 5000); // Poll every 5 seconds
      return () => clearInterval(interval);
    }
  }, [isAdmin, isPanelVisible]);

  const checkAdminStatus = async () => {
    const token = authService.getToken();
    if (!token) {
      setIsAdmin(false);
      return;
    }

    try {
      const response = await fetch('/api/admin/verify', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        setIsAdmin(true);
      } else {
        setIsAdmin(false);
      }
    } catch (error) {
      console.error('Failed to verify admin status:', error);
      setIsAdmin(false);
    }
  };

  const fetchBotStatus = async () => {
    const token = authService.getToken();
    if (!token) return;

    try {
      // Fetch ViewBot rotation status from modern API
      const rotationResponse = await fetch('/admin/viewbot/rotation/status', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (rotationResponse.ok) {
        const data = await rotationResponse.json();
        if (data.success && data.status) {
          setViewBotStatus({
            totalBots: data.status.totalVideos || 0,
            streamingBots: data.status.currentBot ? 1 : 0,
            connectedBots: data.status.currentBot ? 1 : 0,
            rotationEnabled: data.status.enabled || false,
            currentLiveBot: data.status.currentBot || null,
            currentLiveBotName: data.status.currentBot || null,
            availableBots: data.status.totalVideos || 0
          });
        }
      }

      // Fetch ChatBot status
      const chatBotResponse = await fetch('/api/chatbots', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (chatBotResponse.ok) {
        const chatBots = await chatBotResponse.json();
        setChatBotStatus({
          totalBots: chatBots.length,
          enabledBots: chatBots.filter((b: any) => b.is_enabled).length,
          movieBotEnabled: false
        });
      }

      // Fetch MovieBot status
      const movieBotResponse = await fetch('/admin/moviebot/status', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (movieBotResponse.ok) {
        const movieBotData = await movieBotResponse.json();
        setChatBotStatus(prev => ({
          ...prev,
          movieBotEnabled: movieBotData.enabled || false
        }));
      }
    } catch (error) {
      console.error('Failed to fetch bot status:', error);
    }
  };

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 3000);
  };

  const toggleRotation = async () => {
    setLoading(true);
    const token = authService.getToken();
    
    try {
      const endpoint = viewBotStatus.rotationEnabled 
        ? '/admin/viewbot/rotation/stop' 
        : '/admin/viewbot/rotation/start';
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const result = await response.json();
        setViewBotStatus(prev => ({
          ...prev,
          rotationEnabled: !prev.rotationEnabled
        }));
        showNotification('success', viewBotStatus.rotationEnabled ? 'Rotation stopped' : 'Rotation started');
        fetchBotStatus(); // Refresh status
      } else {
        showNotification('error', 'Failed to toggle rotation');
      }
    } catch (error) {
      showNotification('error', 'Failed to toggle rotation');
    } finally {
      setLoading(false);
    }
  };

  const forceRotation = async () => {
    if (!window.confirm('Force rotation to next video?')) {
      return;
    }
    
    setLoading(true);
    const token = authService.getToken();
    
    try {
      const response = await fetch('/admin/viewbot/rotation/force', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const result = await response.json();
        showNotification('success', result.message || 'Forced rotation to next video');
        setTimeout(fetchBotStatus, 1000); // Refresh status after a delay
      } else {
        const error = await response.json();
        showNotification('error', error.message || 'Failed to force rotation');
      }
    } catch (error) {
      showNotification('error', 'Failed to force rotation');
    } finally {
      setLoading(false);
    }
  };

  // Removed startAllViewBots and stopAllViewBots - no longer needed with rotation system

  const toggleMovieBot = async () => {
    setLoading(true);
    const token = authService.getToken();
    
    try {
      const endpoint = chatBotStatus.movieBotEnabled ? '/admin/moviebot/disable' : '/admin/moviebot/enable';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      if (response.ok) {
        setChatBotStatus(prev => ({
          ...prev,
          movieBotEnabled: !prev.movieBotEnabled
        }));
        showNotification('success', `MovieBot ${chatBotStatus.movieBotEnabled ? 'disabled' : 'enabled'}`);
        fetchBotStatus(); // Refresh status
      } else {
        showNotification('error', 'Failed to toggle MovieBot');
      }
    } catch (error) {
      showNotification('error', 'Failed to toggle MovieBot');
    } finally {
      setLoading(false);
    }
  };

  const toggleAllChatBots = async (enable: boolean) => {
    setLoading(true);
    const token = authService.getToken();
    
    try {
      const endpoint = enable ? '/api/chatbots/all/enable' : '/api/chatbots/all/disable';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const result = await response.json();
        showNotification('success', `${enable ? 'Enabled' : 'Disabled'} ${result.count} ChatBots`);
        fetchBotStatus();
      } else {
        showNotification('error', 'Failed to toggle ChatBots');
      }
    } catch (error) {
      showNotification('error', 'Failed to toggle ChatBots');
    } finally {
      setLoading(false);
    }
  };

  if (!isAdmin) {
    return null;
  }

  return (
    <>
      {/* Toggle Button - Always visible */}
      <button 
        className={`bots-toggle-btn ${isPanelVisible ? 'panel-open' : 'panel-closed'}`}
        onClick={() => setIsPanelVisible(!isPanelVisible)}
        title={isPanelVisible ? 'Hide Bots Panel' : 'Show Bots Panel'}
      >
        <svg className="toggle-icon" viewBox="0 0 24 24">
          {isPanelVisible ? (
            // Chevron left icon (hide)
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" fill="currentColor"/>
          ) : (
            // Robot icon with chevron right (show)
            <>
              <path d="M12 2C10.9 2 10 2.9 10 4s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 5h-1V5c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v2H6c-1.1 0-2 .9-2 2v12h2v-3h2v3h8v-3h2v3h2V9c0-1.1-.9-2-2-2zM9 5h6v2H9V5zm0 8H7v-2h2v2zm0 3H7v-2h2v2zm8-3h-2v-2h2v2zm0 3h-2v-2h2v2z" fill="currentColor"/>
              <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z" fill="white" transform="translate(0, 0) scale(0.5)"/>
            </>
          )}
        </svg>
      </button>

      {/* Main Panel - Conditionally visible */}
      <div className={`bots-panel ${isPanelVisible ? 'visible' : 'hidden'}`}>
        <div className="bots-header">
          <svg className="robot-icon" viewBox="0 0 24 24">
            <path d="M12 2C10.9 2 10 2.9 10 4s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 5h-1V5c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v2H6c-1.1 0-2 .9-2 2v12h2v-3h2v3h8v-3h2v3h2V9c0-1.1-.9-2-2-2zM9 5h6v2H9V5zm0 8H7v-2h2v2zm0 3H7v-2h2v2zm8-3h-2v-2h2v2zm0 3h-2v-2h2v2z" fill="currentColor"/>
          </svg>
          <h3>Bot Controls</h3>
        </div>

        <div className="bots-tabs">
          <button 
            className={`tab-btn ${activeSection === 'viewbot' ? 'active' : ''}`}
            onClick={() => setActiveSection('viewbot')}
          >
            <svg className="tab-icon" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" fill="currentColor"/>
            </svg>
            ViewBots
          </button>
          <button 
            className={`tab-btn ${activeSection === 'chatbot' ? 'active' : ''}`}
            onClick={() => setActiveSection('chatbot')}
          >
            <svg className="tab-icon" viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" fill="currentColor"/>
            </svg>
            ChatBots
          </button>
        </div>

        <div className="bots-content">
          {activeSection === 'viewbot' && (
            <div className="viewbot-section">
              <div className="status-card">
                <h4>ViewBot Rotation</h4>
                <div className="status-info">
                  <div className="status-row">
                    <span className="status-label">Status:</span>
                    <span className={`status-value ${viewBotStatus.rotationEnabled ? 'active' : 'inactive'}`}>
                      {viewBotStatus.rotationEnabled ? 'Enabled' : 'Disabled'}
                      <span className={`status-indicator ${viewBotStatus.rotationEnabled ? 'active' : ''}`}></span>
                    </span>
                  </div>
                  {viewBotStatus.currentLiveBot && (
                    <div className="status-row">
                      <span className="status-label">Current Video:</span>
                      <span className="status-value">{viewBotStatus.currentLiveBotName || viewBotStatus.currentLiveBot}</span>
                    </div>
                  )}
                  <div className="status-row">
                    <span className="status-label">Available Videos:</span>
                    <span className="status-value">{viewBotStatus.availableBots}</span>
                  </div>
                </div>
                <div className="action-buttons">
                  <button 
                    className={`control-btn ${viewBotStatus.rotationEnabled ? 'danger' : 'success'}`}
                    onClick={toggleRotation}
                    disabled={loading}
                  >
                    <svg className="btn-icon" viewBox="0 0 24 24">
                      <path d="M12 2v4c4.41 0 8 3.59 8 8s-3.59 8-8 8-8-3.59-8-8h4l-5-5-5 5h4c0 6.63 5.37 12 12 12s12-5.37 12-12S18.63 2 12 2z" fill="currentColor"/>
                    </svg>
                    {viewBotStatus.rotationEnabled ? 'Disable Rotation' : 'Enable Rotation'}
                  </button>
                  {viewBotStatus.rotationEnabled && (
                    <button 
                      className="control-btn primary"
                      onClick={forceRotation}
                      disabled={loading || viewBotStatus.availableBots === 0}
                      title={viewBotStatus.availableBots === 0 ? 'No available videos' : 'Force rotation to next video'}
                    >
                      <svg className="btn-icon" viewBox="0 0 24 24">
                        <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" fill="currentColor"/>
                      </svg>
                      Next Video
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'chatbot' && (
            <div className="chatbot-section">
              <div className="status-card">
                <h4>ChatBot Status</h4>
                <div className="status-info">
                  <div className="status-row">
                    <span className="status-label">Total Bots:</span>
                    <span className="status-value">{chatBotStatus.totalBots}</span>
                  </div>
                  <div className="status-row">
                    <span className="status-label">Enabled:</span>
                    <span className="status-value">
                      {chatBotStatus.enabledBots}
                      <span className={`status-indicator ${chatBotStatus.enabledBots > 0 ? 'active' : ''}`}></span>
                    </span>
                  </div>
                  <div className="status-row">
                    <span className="status-label">MovieBot:</span>
                    <span className={`status-value ${chatBotStatus.movieBotEnabled ? 'active' : 'inactive'}`}>
                      {chatBotStatus.movieBotEnabled ? 'Enabled' : 'Disabled'}
                      <span className={`status-indicator ${chatBotStatus.movieBotEnabled ? 'active' : ''}`}></span>
                    </span>
                  </div>
                </div>
                <div className="action-buttons">
                  <button 
                    className="control-btn success"
                    onClick={() => toggleAllChatBots(true)}
                    disabled={loading}
                  >
                    <svg className="btn-icon" viewBox="0 0 24 24">
                      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" fill="currentColor"/>
                    </svg>
                    Enable All
                  </button>
                  <button 
                    className="control-btn danger"
                    onClick={() => toggleAllChatBots(false)}
                    disabled={loading}
                  >
                    <svg className="btn-icon" viewBox="0 0 24 24">
                      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12zM9 11h2V9H9v2zm4 0h2V9h-2v2z" fill="currentColor"/>
                    </svg>
                    Disable All
                  </button>
                </div>
                <div className="moviebot-control">
                  <button 
                    className={`control-btn ${chatBotStatus.movieBotEnabled ? 'danger' : 'primary'}`}
                    onClick={toggleMovieBot}
                    disabled={loading}
                  >
                    <svg className="btn-icon" viewBox="0 0 24 24">
                      <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" fill="currentColor"/>
                    </svg>
                    {chatBotStatus.movieBotEnabled ? 'Disable MovieBot' : 'Enable MovieBot'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Notification Toast */}
      {notification && (
        <div className={`bots-toast ${notification.type}`}>
          {notification.message}
        </div>
      )}
    </>
  );
};

export default BotsPanel;