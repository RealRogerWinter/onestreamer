import React, { useState, useEffect } from 'react';
import AdminDashboard from './AdminDashboard';
import UserManagement from './UserManagement';
import ConnectionMonitor from './ConnectionMonitor';
import ViewBotTab from './ViewBotTab';
import ItemManagement from './ItemManagement';
import ChatBotManagement from './ChatBotManagement';
import RecordingManagement from './RecordingManagement';
import TranscriptionManagement from './TranscriptionManagement';
import EmojiManagement from './EmojiManagement';
import ChatModeration from './ChatModeration';
import TutorialEditor from './TutorialEditor';
import authService from '../services/AuthService';
import './AdminPanel.css';

interface AdminPanelProps {
  isVisible: boolean;
  onClose: () => void;
}

const AdminPanel: React.FC<AdminPanelProps> = ({ isVisible, onClose }) => {
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'users' | 'connections' | 'viewbot' | 'items' | 'chatbots' | 'recordings' | 'transcriptions' | 'emojis' | 'moderation' | 'tutorial' | 'logs'>('dashboard');
  const [logs, setLogs] = useState<string[]>([]);


  useEffect(() => {
    // Check if user is authenticated and is admin
    const checkAdminStatus = async () => {
      const isAuth = authService.isAuthenticated();
      if (!isAuth) {
        setIsAdminAuthenticated(false);
        return;
      }
      
      try {
        const isAdmin = await authService.isAdmin();
        setIsAdminAuthenticated(isAuth && isAdmin);
      } catch (error) {
        console.error('Failed to check admin status:', error);
        setIsAdminAuthenticated(false);
      }
    };

    if (isVisible) {
      checkAdminStatus();
    }
  }, [isVisible]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [`[${timestamp}] ${message}`, ...prev.slice(0, 99)]);
  };

  const makeApiCall = async (endpoint: string, options: RequestInit = {}) => {
    try {
      const token = authService.getToken();
      const response = await fetch(`${process.env.REACT_APP_SERVER_URL || ''}${endpoint}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...options.headers
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      addLog(`API Error (${endpoint}): ${errorMessage}`);
      throw error;
    }
  };

  if (!isVisible) return null;

  // If user is not authenticated or not admin, show access denied
  if (!isAdminAuthenticated) {
    return (
      <div className="admin-panel-overlay">
        <div className="admin-panel">
          <div className="admin-panel-header">
            <h2>🔐 Admin Panel</h2>
            <button className="close-button" onClick={onClose}>×</button>
          </div>
          <div className="admin-panel-content">
            <div className="access-denied">
              <h3>Access Denied</h3>
              <p>You must be logged in with an administrator account to access this panel.</p>
              <button onClick={onClose} className="btn">Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-panel-overlay">
      <div className="admin-panel">
        <div className="admin-panel-header">
          <h2>⚙️ OneStreamer Admin</h2>
          <div className="admin-actions">
            <span className="admin-user">Welcome, {authService.getUser()?.username}</span>
            <button className="close-button" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="admin-tabs">
          <button 
            className={`tab ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            📊 Dashboard
          </button>
          <button 
            className={`tab ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            👥 Users
          </button>
          <button 
            className={`tab ${activeTab === 'connections' ? 'active' : ''}`}
            onClick={() => setActiveTab('connections')}
          >
            🔗 Connections
          </button>
          <button 
            className={`tab ${activeTab === 'viewbot' ? 'active' : ''}`}
            onClick={() => setActiveTab('viewbot')}
          >
            🤖 ViewBot
          </button>
          <button 
            className={`tab ${activeTab === 'items' ? 'active' : ''}`}
            onClick={() => setActiveTab('items')}
          >
            🛍️ Items
          </button>
          <button 
            className={`tab ${activeTab === 'chatbots' ? 'active' : ''}`}
            onClick={() => setActiveTab('chatbots')}
          >
            💬 ChatBots
          </button>
          <button 
            className={`tab ${activeTab === 'recordings' ? 'active' : ''}`}
            onClick={() => setActiveTab('recordings')}
          >
            📹 Recordings
          </button>
          <button 
            className={`tab ${activeTab === 'transcriptions' ? 'active' : ''}`}
            onClick={() => setActiveTab('transcriptions')}
          >
            🎙️ Transcriptions
          </button>
          <button 
            className={`tab ${activeTab === 'emojis' ? 'active' : ''}`}
            onClick={() => setActiveTab('emojis')}
          >
            😊 Emojis
          </button>
          <button 
            className={`tab ${activeTab === 'moderation' ? 'active' : ''}`}
            onClick={() => setActiveTab('moderation')}
          >
            🛡️ Moderation
          </button>
          <button 
            className={`tab ${activeTab === 'tutorial' ? 'active' : ''}`}
            onClick={() => setActiveTab('tutorial')}
          >
            📚 Tutorial
          </button>
          <button 
            className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            📝 Logs
          </button>
        </div>

        <div className="admin-panel-content">
          {activeTab === 'dashboard' && <AdminDashboard makeApiCall={makeApiCall} addLog={addLog} />}
          {activeTab === 'users' && <UserManagement addLog={addLog} />}
          {activeTab === 'connections' && <ConnectionMonitor makeApiCall={makeApiCall} addLog={addLog} />}
          {activeTab === 'viewbot' && <ViewBotTab makeApiCall={makeApiCall} addLog={addLog} />}
          {activeTab === 'items' && <ItemManagement addLog={addLog} />}
          {activeTab === 'chatbots' && <ChatBotManagement addLog={addLog} />}
          {activeTab === 'recordings' && <RecordingManagement addLog={addLog} />}
          {activeTab === 'transcriptions' && <TranscriptionManagement addLog={addLog} />}
          {activeTab === 'emojis' && <EmojiManagement addLog={addLog} />}
          {activeTab === 'moderation' && <ChatModeration addLog={addLog} />}
          {activeTab === 'tutorial' && <TutorialEditor addLog={addLog} />}
          {activeTab === 'logs' && (
            <div className="logs-container">
              <h3>System Logs</h3>
              <div className="logs-content">
                {logs.map((log, index) => (
                  <div key={index} className="log-entry">{log}</div>
                ))}
                {logs.length === 0 && (
                  <div className="log-entry">No logs yet...</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;