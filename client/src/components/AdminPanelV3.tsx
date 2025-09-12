import React, { useState, useEffect } from 'react';
import AdminDashboardV3 from './AdminDashboardV3';
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
import BugReportsManagement from './BugReportsManagement';
import IPBanManagement from './IPBanManagement';
import StreamingLogs from './StreamingLogs';
import StreamBotManager from './StreamBotManager';
import authService from '../services/AuthService';
import './AdminPanelV3.css';

interface AdminPanelProps {
  isVisible: boolean;
  onClose: () => void;
  initialTab?: string;
}

interface NavItem {
  id: string;
  label: string;
  icon: string;
  component?: React.ComponentType<any>;
  category?: string;
}

const AdminPanelV3: React.FC<AdminPanelProps> = ({ isVisible, onClose, initialTab = 'dashboard' }) => {
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [isModeratorAuthenticated, setIsModeratorAuthenticated] = useState(false);
  const [activeView, setActiveView] = useState<string>(initialTab);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showQuickActions, setShowQuickActions] = useState(false);

  // Navigation structure with categories
  const navigationItems: NavItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊', category: 'Overview' },
    { id: 'users', label: 'User Management', icon: '👥', category: 'Users & Access' },
    { id: 'connections', label: 'Connections', icon: '🔗', category: 'Monitoring' },
    { id: 'viewbot', label: 'ViewBot Control', icon: '🤖', category: 'Services' },
    { id: 'items', label: 'Items & Shop', icon: '🛍️', category: 'Content' },
    { id: 'chatbots', label: 'Chat Bots', icon: '💬', category: 'Services' },
    { id: 'streambot', label: 'StreamBot', icon: '📢', category: 'Services' },
    { id: 'recordings', label: 'Recordings', icon: '📹', category: 'Media' },
    { id: 'transcriptions', label: 'Transcriptions', icon: '🎙️', category: 'Media' },
    { id: 'emojis', label: 'Emoji Manager', icon: '😊', category: 'Content' },
    { id: 'moderation', label: 'Chat Moderation', icon: '🛡️', category: 'Moderation' },
    { id: 'ipbans', label: 'IP Ban Management', icon: '🚫', category: 'Moderation' },
    { id: 'streaminglogs', label: 'Streaming Logs', icon: '📊', category: 'Monitoring' },
    { id: 'tutorial', label: 'Tutorial Editor', icon: '📚', category: 'Content' },
    { id: 'bugs', label: 'Bug Reports', icon: '🐛', category: 'Support' },
    { id: 'logs', label: 'System Logs', icon: '📝', category: 'Monitoring' }
  ];

  // We'll move this after we define availableNavItems

  useEffect(() => {
    setActiveView(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const checkAdminStatus = async () => {
      const isAuth = authService.isAuthenticated();
      if (!isAuth) {
        setIsAdminAuthenticated(false);
        setIsModeratorAuthenticated(false);
        return;
      }
      
      try {
        const isAdmin = await authService.isAdmin();
        const isModerator = await authService.isModerator();
        setIsAdminAuthenticated(isAuth && isAdmin);
        setIsModeratorAuthenticated(isAuth && isModerator);
      } catch (error) {
        console.error('Failed to check admin/moderator status:', error);
        setIsAdminAuthenticated(false);
        setIsModeratorAuthenticated(false);
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

  const handleQuickAction = (action: string) => {
    switch (action) {
      case 'clear-stream':
        // Handle clear stream
        break;
      case 'restart-services':
        // Handle restart services
        break;
      case 'view-logs':
        setActiveView('logs');
        break;
      case 'manage-users':
        setActiveView('users');
        break;
    }
    setShowQuickActions(false);
  };

  if (!isVisible) return null;

  if (!isAdminAuthenticated && !isModeratorAuthenticated) {
    return (
      <div className="admin-panel-v3-overlay">
        <div className="admin-panel-v3">
          <div className="admin-panel-v3-header">
            <h2>🔐 Admin Panel</h2>
            <button className="close-button" onClick={onClose}>×</button>
          </div>
          <div className="admin-panel-v3-content">
            <div className="access-denied">
              <h3>Access Denied</h3>
              <p>You must be logged in with an administrator or moderator account to access this panel.</p>
              <button onClick={onClose} className="btn">Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Filter navigation items based on user role
  const getAvailableNavItems = () => {
    if (isAdminAuthenticated) {
      return navigationItems; // Admins get everything
    } else if (isModeratorAuthenticated) {
      // Moderators get limited access
      const moderatorAllowedViews = ['moderation', 'ipbans', 'streaminglogs'];
      return navigationItems.filter(item => moderatorAllowedViews.includes(item.id));
    }
    return [];
  };

  const availableNavItems = getAvailableNavItems();

  // Group available navigation items by category
  const groupedNavItems = availableNavItems.reduce((acc, item) => {
    const category = item.category || 'Other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(item);
    return acc;
  }, {} as Record<string, NavItem[]>);

  // Filter navigation items based on search (from available items only)
  const filteredNavItems = searchQuery
    ? availableNavItems.filter(item =>
        item.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : null;

  const renderContent = () => {
    switch (activeView) {
      case 'dashboard':
        return <AdminDashboardV3 makeApiCall={makeApiCall} addLog={addLog} />;
      case 'users':
        return <UserManagement addLog={addLog} />;
      case 'connections':
        return <ConnectionMonitor makeApiCall={makeApiCall} addLog={addLog} />;
      case 'viewbot':
        // console.log('Rendering ViewBotTab in AdminPanelV3');
        return <ViewBotTab makeApiCall={makeApiCall} addLog={addLog} />;
      case 'items':
        return <ItemManagement addLog={addLog} />;
      case 'chatbots':
        return <ChatBotManagement addLog={addLog} />;
      case 'streambot':
        return <StreamBotManager />;
      case 'recordings':
        return <RecordingManagement addLog={addLog} />;
      case 'transcriptions':
        return <TranscriptionManagement addLog={addLog} />;
      case 'emojis':
        return <EmojiManagement addLog={addLog} />;
      case 'moderation':
        return <ChatModeration addLog={addLog} />;
      case 'ipbans':
        return <IPBanManagement addLog={addLog} />;
      case 'streaminglogs':
        return <StreamingLogs addLog={addLog} />;
      case 'tutorial':
        return <TutorialEditor addLog={addLog} />;
      case 'bugs':
        return <BugReportsManagement makeApiCall={makeApiCall} addLog={addLog} />;
      case 'logs':
        return (
          <div className="logs-container">
            <div className="logs-header">
              <h3>System Logs</h3>
              <button 
                className="clear-logs-btn"
                onClick={() => setLogs([])}
              >
                Clear Logs
              </button>
            </div>
            <div className="logs-content">
              {logs.map((log, index) => (
                <div key={index} className="log-entry">{log}</div>
              ))}
              {logs.length === 0 && (
                <div className="log-entry">No logs yet...</div>
              )}
            </div>
          </div>
        );
      default:
        return <div>Section not found</div>;
    }
  };

  return (
    <div className="admin-panel-v3-overlay">
      <div className="admin-panel-v3">
        {/* Header */}
        <div className="admin-panel-v3-header">
          <div className="header-left">
            <button 
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              ☰
            </button>
            <h2>⚙️ OneStreamer {isAdminAuthenticated ? 'Admin' : 'Moderator'} Panel</h2>
          </div>
          
          <div className="header-center">
            <div className="search-bar">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                placeholder="Search features..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />
            </div>
          </div>

          <div className="header-right">
            <button 
              className="quick-actions-btn"
              onClick={() => setShowQuickActions(!showQuickActions)}
            >
              ⚡ Quick Actions
            </button>
            <span className="admin-user">{authService.getUser()?.username}</span>
            <button className="close-button" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Quick Actions Dropdown */}
        {showQuickActions && (
          <div className="quick-actions-dropdown">
            <button onClick={() => handleQuickAction('clear-stream')}>
              🗑️ Clear Stream
            </button>
            <button onClick={() => handleQuickAction('restart-services')}>
              🔄 Restart Services
            </button>
            <button onClick={() => handleQuickAction('view-logs')}>
              📝 View Logs
            </button>
            <button onClick={() => handleQuickAction('manage-users')}>
              👥 Manage Users
            </button>
          </div>
        )}

        <div className="admin-panel-v3-body">
          {/* Sidebar Navigation */}
          <div className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
            {/* Search Results */}
            {filteredNavItems && (
              <div className="search-results">
                <div className="sidebar-category">Search Results</div>
                {filteredNavItems.map(item => (
                  <button
                    key={item.id}
                    className={`sidebar-item ${activeView === item.id ? 'active' : ''}`}
                    onClick={() => {
                      setActiveView(item.id);
                      setSearchQuery('');
                    }}
                  >
                    <span className="sidebar-icon">{item.icon}</span>
                    {!sidebarCollapsed && <span className="sidebar-label">{item.label}</span>}
                  </button>
                ))}
              </div>
            )}

            {/* Regular Navigation */}
            {!filteredNavItems && Object.entries(groupedNavItems).map(([category, items]) => (
              <div key={category} className="sidebar-section">
                {!sidebarCollapsed && (
                  <div className="sidebar-category">{category}</div>
                )}
                {items.map(item => (
                  <button
                    key={item.id}
                    className={`sidebar-item ${activeView === item.id ? 'active' : ''}`}
                    onClick={() => setActiveView(item.id)}
                    title={sidebarCollapsed ? item.label : ''}
                  >
                    <span className="sidebar-icon">{item.icon}</span>
                    {!sidebarCollapsed && <span className="sidebar-label">{item.label}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Main Content Area */}
          <div className="admin-main-content">
            <div className="content-wrapper">
              {renderContent()}
            </div>
          </div>
        </div>

        {/* Status Bar */}
        <div className="admin-panel-v3-statusbar">
          <div className="status-left">
            <span className="status-item">
              🟢 Connected
            </span>
            <span className="status-item">
              Last refresh: {new Date().toLocaleTimeString()}
            </span>
          </div>
          <div className="status-right">
            <span className="status-item">
              {logs.length} logs
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanelV3;