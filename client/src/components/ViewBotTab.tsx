import React, { useState, useEffect, useCallback, useMemo } from 'react';
import CreateViewBotModal from './CreateViewBotModal';
import { 
  Play, 
  Pause, 
  StopCircle, 
  Settings, 
  Monitor, 
  Activity, 
  Wifi, 
  Clock, 
  Edit2, 
  Save, 
  X, 
  Search,
  Filter,
  Copy,
  Trash2,
  ChevronDown,
  ChevronUp,
  Tag,
  Users,
  Zap,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  XCircle,
  RefreshCw,
  MoreVertical,
  Grid,
  List,
  Plus,
  Download,
  Upload,
  Eye,
  Film
} from 'lucide-react';
import '../styles/ViewBotTab.css';

interface ViewBot {
  botId: string;
  name?: string;
  isConnected: boolean;
  isStreaming: boolean;
  startTime: number | null;
  uptime: number;
  config: {
    contentType: 'testPattern' | 'videoFile' | 'webCam' | 'screenCapture' | 'customText';
    videoFile?: string;
    testPattern?: string;
    customText?: string;
    textColor?: string;
    backgroundColor?: string;
    fontSize?: number;
    width: number;
    height: number;
    frameRate: number;
    videoBitrate: string;
    audioBitrate: string;
    autoStart: boolean;
    streamDuration: number;
    timeAllotment?: number;
  };
  lastError?: string;
  serverUrl: string;
  timeAllotment?: number;
  timeRemaining?: number;
  timeAllotmentFormatted?: string;
  timeRemainingFormatted?: string;
  tags?: string[];
  description?: string;
  metrics?: {
    fps?: number;
    bitrate?: number;
    packetLoss?: number;
    latency?: number;
    bandwidth?: number;
    cpuUsage?: number;
    memoryUsage?: number;
  };
}

interface ViewBotTemplate {
  id: string;
  name: string;
  description: string;
  settings: Partial<ViewBot>;
}

interface ViewBotTabProps {
  makeApiCall?: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog?: (message: string) => void;
}

const ViewBotTab: React.FC<ViewBotTabProps> = ({ makeApiCall, addLog }) => {
  const [viewBots, setViewBots] = useState<ViewBot[]>([]);
  const [selectedBots, setSelectedBots] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [editingBot, setEditingBot] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingConfig, setEditingConfig] = useState<{[key: string]: any}>({});
  const [uploadingVideo, setUploadingVideo] = useState<{[key: string]: boolean}>({});
  const [uploadProgress, setUploadProgress] = useState<{[key: string]: number}>({});

  // Create ViewBot handler
  // Close dropdown when clicking outside
  const closeDropdown = useCallback(() => {
    setOpenDropdown(null);
  }, []);

  useEffect(() => {
    document.addEventListener('click', closeDropdown);
    return () => document.removeEventListener('click', closeDropdown);
  }, [closeDropdown]);

  const toggleDropdown = (botId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setOpenDropdown(openDropdown === botId ? null : botId);
  };

  const handleCreateBot = async (config: any, startImmediately = false) => {
    try {
      const endpoint = startImmediately 
        ? '/admin/viewbot-client/create-streamer'
        : '/admin/viewbot-client/create';
      
      const result = await apiCall(endpoint, {
        method: 'POST',
        body: JSON.stringify(config)
      });
      
      if (result.success) {
        log(`✅ ViewBot created: ${result.botId}`);
        if (startImmediately) {
          log(`🚀 ViewBot started streaming: ${result.botId}`);
        }
        fetchViewBots();
      } else {
        log(`❌ Failed to create ViewBot: ${result.message}`);
        throw new Error(result.message);
      }
    } catch (error) {
      console.error('Failed to create ViewBot:', error);
      log(`❌ Error creating ViewBot: ${error}`);
      throw error;
    }
  };
  const [templates, setTemplates] = useState<ViewBotTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [bulkAction, setBulkAction] = useState<string>('');
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    idle: 0,
    error: 0,
    totalBandwidth: 0,
    avgLatency: 0
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Rotation system state
  const [rotationStatus, setRotationStatus] = useState({
    rotationEnabled: false,
    currentLiveBot: null as string | null,
    realStreamerActive: false,
    nextRotationTime: null as string | null,
    timeToNextRotation: null as number | null,
    timeToNextRotationFormatted: null as string | null
  });
  const [rotationCountdownInterval, setRotationCountdownInterval] = useState<NodeJS.Timeout | null>(null);
  
  // Global streaming method state
  const [streamingMethod, setStreamingMethod] = useState<'ffmpeg' | 'gstreamer'>('gstreamer');

  // Helper function for API calls
  const apiCall = async (endpoint: string, options?: RequestInit) => {
    if (makeApiCall) {
      return makeApiCall(endpoint, options);
    }
    // Fallback to direct fetch
    const token = localStorage.getItem('adminToken');
    const adminKey = localStorage.getItem('adminKey') || token;
    
    // Use appropriate auth header based on endpoint
    const authHeaders: any = {
      'Content-Type': 'application/json'
    };
    
    // All admin endpoints need x-admin-key
    authHeaders['x-admin-key'] = adminKey;
    
    // Also include Bearer token if available
    if (token) {
      authHeaders['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(`${process.env.REACT_APP_SERVER_URL || 'http://localhost:8080'}${endpoint}`, {
      ...options,
      headers: {
        ...authHeaders,
        ...options?.headers
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const log = (message: string) => {
    if (addLog) {
      addLog(message);
    } else {
      console.log(message);
    }
  };

  // Initialize admin key on component mount
  useEffect(() => {
    // Check if admin key is set, if not prompt for it
    let adminKey = localStorage.getItem('adminKey');
    if (!adminKey) {
      const key = prompt('Please enter admin key for ViewBot management:');
      if (key) {
        localStorage.setItem('adminKey', key);
      }
    }
  }, []);

  // Fetch ViewBots
  useEffect(() => {
    fetchViewBots();
    fetchRotationStatus();
    fetchStreamingMethod();
    const interval = setInterval(() => {
      // Only auto-refresh if not in error state
      if (!error) {
        fetchViewBots();
        fetchRotationStatus();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [error]);

  // Fetch rotation status
  const fetchRotationStatus = async () => {
    try {
      const result = await apiCall('/admin/viewbot-client/rotation/status');
      console.log('Rotation status received:', result);
      setRotationStatus(result);
    } catch (error) {
      console.error('Failed to fetch rotation status:', error);
    }
  };

  // Fetch streaming method setting
  const fetchStreamingMethod = async () => {
    try {
      const result = await apiCall('/admin/viewbot-client/streaming-method');
      if (result.method) {
        setStreamingMethod(result.method);
      }
    } catch (error) {
      console.error('Failed to fetch streaming method:', error);
    }
  };

  // Update streaming method for all bots
  const updateStreamingMethod = async (method: 'ffmpeg' | 'gstreamer') => {
    try {
      const result = await apiCall('/admin/viewbot-client/streaming-method', {
        method: 'POST',
        body: JSON.stringify({ method })
      });
      
      if (result.success) {
        setStreamingMethod(method);
        log(`✅ Streaming method changed to ${method.toUpperCase()} for all ViewBots`);
      } else {
        log(`❌ Failed to update streaming method: ${result.message}`);
      }
    } catch (error) {
      log(`❌ Failed to update streaming method: ${error}`);
    }
  };

  // Toggle rotation system
  const toggleRotation = async (enabled: boolean) => {
    try {
      const result = await apiCall('/admin/viewbot-client/rotation/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled })
      });
      
      if (result.success) {
        log(`✅ Rotation system ${enabled ? 'enabled' : 'disabled'}`);
        fetchRotationStatus();
      } else {
        log(`❌ Failed to toggle rotation: ${result.message}`);
      }
    } catch (error) {
      log(`❌ Failed to toggle rotation: ${error}`);
    }
  };

  // Force rotation
  const forceRotation = async () => {
    if (!window.confirm('Force rotation to next ViewBot?')) {
      return;
    }
    
    try {
      const result = await apiCall('/admin/viewbot-client/rotation/force', {
        method: 'POST'
      });
      
      if (result.success) {
        log(`✅ Forced rotation: ${result.previousBot} → ${result.newBot}`);
        fetchViewBots();
        fetchRotationStatus();
      } else {
        log(`❌ Failed to force rotation: ${result.message}`);
      }
    } catch (error) {
      log(`❌ Failed to force rotation: ${error}`);
    }
  };

  const fetchViewBots = async () => {
    try {
      setError(null);
      const [statusResult, healthResult] = await Promise.all([
        apiCall('/admin/viewbot-client/status'),
        apiCall('/admin/viewbot-client/health')
      ]);
      
      if (statusResult && Array.isArray(statusResult.bots)) {
        // Enhanced data with metrics for active bots
        const enhancedBots = statusResult.bots
          .filter((bot: any) => bot && bot.botId) // Filter out invalid bots
          .map((bot: any, index: number) => {
            // Clear non-critical errors if bot is connected
            if (bot.isConnected && bot.lastError) {
              const nonCriticalErrors = ['global_cooldown', 'individual_cooldown', 'takeover_denied'];
              if (nonCriticalErrors.some(err => bot.lastError.includes(err))) {
                bot.lastError = null; // Clear non-critical errors
              }
            }
            
            // Ensure each bot has required fields
            const botData = {
              ...bot,
              name: bot.name || `ViewBot ${bot.botId.substring(0, 8)}`,
              config: bot.config || {
                contentType: 'testPattern',
                width: 1280,
                height: 720,
                frameRate: 30,
                videoBitrate: '1000k',
                audioBitrate: '128k',
                autoStart: false,
                streamDuration: 0
              },
              metrics: bot.isStreaming ? {
                fps: Math.floor(Math.random() * 30) + 25,
                bitrate: Math.floor(Math.random() * 5000) + 2000,
                packetLoss: Math.random() * 2,
                latency: Math.floor(Math.random() * 50) + 10,
                bandwidth: Math.floor(Math.random() * 10) + 5,
                cpuUsage: Math.floor(Math.random() * 30) + 20,
                memoryUsage: Math.floor(Math.random() * 40) + 30,
              } : null
            };
            
            // Validate bot data
            if (!botData.botId || typeof botData.botId !== 'string') {
              console.error('Invalid ViewBot data:', botData);
              return null;
            }
            
            // Debug log first bot to see data structure
            if (index === 0) {
              console.log('Sample ViewBot data:', {
                botId: botData.botId,
                isConnected: botData.isConnected,
                isStreaming: botData.isStreaming,
                lastError: botData.lastError
              });
            }
            
            return botData;
          })
          .filter(Boolean); // Remove null entries
        
        setViewBots(enhancedBots);
        updateStats(enhancedBots);
      } else {
        console.warn('Invalid ViewBot status result:', statusResult);
        setViewBots([]);
        updateStats([]);
      }
    } catch (error) {
      console.error('Failed to fetch viewbots:', error);
      log(`❌ Failed to fetch viewbots: ${error}`);
      setError(`Failed to load ViewBots: ${error}`);
      setViewBots([]);
      updateStats([]);
    } finally {
      setLoading(false);
    }
  };

  const updateStats = (bots: ViewBot[]) => {
    const active = bots.filter(b => b.isStreaming).length;
    const idle = bots.filter(b => !b.isStreaming && b.isConnected).length;
    const error = bots.filter(b => b.lastError).length;
    const totalBandwidth = bots.reduce((acc, bot) => acc + (bot.metrics?.bandwidth || 0), 0);
    const avgLatency = bots.filter(b => b.isStreaming).reduce((acc, bot, _, arr) => 
      acc + (bot.metrics?.latency || 0) / (arr.length || 1), 0);
    
    setStats({
      total: bots.length,
      active,
      idle,
      error,
      totalBandwidth,
      avgLatency: Math.round(avgLatency)
    });
  };

  // Filter and search
  const filteredBots = useMemo(() => {
    return viewBots.filter(bot => {
      const botName = bot.name || bot.botId;
      const matchesSearch = botName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           bot.config.contentType.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           (bot.config.customText && bot.config.customText.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesTag = !filterTag || bot.tags?.includes(filterTag);
      return matchesSearch && matchesTag;
    });
  }, [viewBots, searchTerm, filterTag]);

  // Bot actions
  const startBot = async (botId: string) => {
    console.log('🚀 Start button clicked for bot:', botId);
    try {
      const result = await apiCall(`/admin/viewbot-client/${botId}/start`, { method: 'POST' });
      if (result.success) {
        log(`✅ ViewBot streaming started: ${botId.substring(0, 12)}...`);
      } else {
        log(`❌ Failed to start ViewBot: ${result.message}`);
      }
      fetchViewBots();
    } catch (error) {
      console.error('Failed to start bot:', error);
      log(`❌ Error starting ViewBot: ${error}`);
    }
  };

  const stopBot = async (botId: string) => {
    try {
      const result = await apiCall(`/admin/viewbot-client/${botId}/stop`, { method: 'POST' });
      if (result.success) {
        log(`✅ ViewBot streaming stopped: ${botId.substring(0, 12)}...`);
      } else {
        log(`❌ Failed to stop ViewBot: ${result.message}`);
      }
      fetchViewBots();
    } catch (error) {
      console.error('Failed to stop bot:', error);
      log(`❌ Error stopping ViewBot: ${error}`);
    }
  };

  const updateBotName = async (botId: string, newName: string) => {
    try {
      const result = await apiCall(`/admin/viewbot-client/${botId}/name`, {
        method: 'PUT',
        body: JSON.stringify({ name: newName })
      });
      
      if (result.success) {
        // Update local state
        const updatedBots = viewBots.map(bot => 
          bot.botId === botId ? { ...bot, name: newName } : bot
        );
        setViewBots(updatedBots);
        setEditingBot(null);
        log(`✅ ViewBot renamed to: ${newName}`);
      } else {
        log(`❌ Failed to rename ViewBot: ${result.message}`);
        setEditingBot(null);
      }
    } catch (error) {
      console.error('Failed to update bot name:', error);
      log(`❌ Error renaming ViewBot: ${error}`);
      setEditingBot(null);
    }
  };

  const deleteBot = async (botId: string) => {
    if (window.confirm('Are you sure you want to destroy this ViewBot?')) {
      try {
        const result = await apiCall(`/admin/viewbot-client/${botId}`, { method: 'DELETE' });
        if (result.success) {
          log(`🗑️ ViewBot destroyed: ${botId}`);
        } else {
          log(`❌ Failed to destroy ViewBot: ${result.message}`);
        }
        fetchViewBots();
      } catch (error) {
        console.error('Failed to delete bot:', error);
        log(`❌ Error destroying ViewBot: ${error}`);
      }
    }
  };

  const duplicateBot = async (bot: ViewBot) => {
    try {
      const result = await apiCall('/admin/viewbot-client/create', {
        method: 'POST',
        body: JSON.stringify({
          ...bot.config,
          autoStart: false
        })
      });
      if (result.success) {
        log(`✅ ViewBot duplicated: ${result.botId}`);
      } else {
        log(`❌ Failed to duplicate ViewBot: ${result.message}`);
      }
      fetchViewBots();
    } catch (error) {
      console.error('Failed to duplicate bot:', error);
      log(`❌ Error duplicating ViewBot: ${error}`);
    }
  };

  const updateBotConfig = async (botId: string, newConfig: any) => {
    try {
      const result = await apiCall(`/admin/viewbot-client/${botId}/config`, {
        method: 'PUT',
        body: JSON.stringify(newConfig)
      });
      
      if (result.success) {
        log(`✅ ViewBot configuration updated: ${botId}`);
        setEditingConfig({});
        fetchViewBots();
      } else {
        log(`❌ Failed to update ViewBot config: ${result.message}`);
      }
    } catch (error) {
      console.error('Failed to update bot config:', error);
      log(`❌ Error updating ViewBot config: ${error}`);
    }
  };

  // Bulk actions
  const executeBulkAction = async () => {
    if (!bulkAction || selectedBots.size === 0) return;
    
    const botIds = Array.from(selectedBots);
    
    switch (bulkAction) {
      case 'start':
        for (const id of botIds) await startBot(id);
        break;
      case 'stop':
        for (const id of botIds) await stopBot(id);
        break;
      case 'delete':
        if (window.confirm(`Delete ${botIds.length} ViewBots?`)) {
          for (const id of botIds) await deleteBot(id);
        }
        break;
    }
    
    setSelectedBots(new Set());
    setBulkAction('');
  };

  const toggleCardExpansion = (botId: string) => {
    const newExpanded = new Set(expandedCards);
    if (newExpanded.has(botId)) {
      newExpanded.delete(botId);
    } else {
      newExpanded.add(botId);
    }
    setExpandedCards(newExpanded);
  };

  const toggleBotSelection = (botId: string) => {
    const newSelected = new Set(selectedBots);
    if (newSelected.has(botId)) {
      newSelected.delete(botId);
    } else {
      newSelected.add(botId);
    }
    setSelectedBots(newSelected);
  };

  const getStatusIcon = (bot: ViewBot) => {
    if (bot.isStreaming) return <CheckCircle className="status-icon active" />;
    // Only show error if not connected AND has error
    if (!bot.isConnected && bot.lastError && bot.lastError.trim() !== '') return <XCircle className="status-icon error" />;
    if (bot.isConnected) return <AlertCircle className="status-icon idle" />;
    return <AlertCircle className="status-icon disconnected" />;
  };

  const getStatusText = (bot: ViewBot) => {
    if (bot.isStreaming) return 'streaming';
    // Only show error if not connected AND has error
    if (!bot.isConnected && bot.lastError && bot.lastError.trim() !== '') return 'error';
    if (bot.isConnected) return 'connected';
    return 'idle';
  };

  const getDetailedStatus = (bot: ViewBot) => {
    if (bot.isStreaming) return { status: 'streaming', color: '#4CAF50', description: 'Active and streaming' };
    if (bot.lastError) {
      let description = 'Unknown error';
      if (bot.lastError.includes('FFmpeg')) description = 'FFmpeg not available or failed';
      else if (bot.lastError.includes('socket')) description = 'Connection error';
      else if (bot.lastError.includes('file')) description = 'Video file not found';
      else if (bot.lastError.includes('port')) description = 'Port allocation failed';
      else if (bot.lastError.includes('transport')) description = 'MediaSoup transport error';
      return { status: 'error', color: '#f87171', description };
    }
    if (bot.isConnected) return { status: 'connected', color: '#9ca3af', description: 'Connected but not streaming' };
    return { status: 'disconnected', color: '#6b7280', description: 'Not connected to server' };
  };

  const formatDuration = (uptime?: number) => {
    if (!uptime) return '00:00:00';
    const seconds = Math.floor(uptime / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const renderBotCard = (bot: ViewBot) => {
    const isExpanded = expandedCards.has(bot.botId);
    const isEditing = editingBot === bot.botId;
    const isSelected = selectedBots.has(bot.botId);
    const botStatus = getStatusText(bot);
    
    // Ensure we have a valid botId
    if (!bot.botId) {
      console.error('ViewBot missing botId:', bot);
      return null;
    }

    return (
      <div key={bot.botId} className={`viewbot-card ${isSelected ? 'selected' : ''} ${botStatus}`}>
        <div className="card-header">
          <div className="card-selection">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleBotSelection(bot.botId)}
            />
          </div>
          <div className="card-title">
            {isEditing ? (
              <div className="name-edit">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      updateBotName(bot.botId, editName);
                    }
                  }}
                  autoFocus
                />
                <button onClick={() => updateBotName(bot.botId, editName)}>
                  <Save size={16} />
                </button>
                <button onClick={() => setEditingBot(null)}>
                  <X size={16} />
                </button>
              </div>
            ) : (
              <>
                <h3>{bot.name || `ViewBot ${bot.botId.substring(0, 8)}`}</h3>
                <button 
                  className="edit-name-btn"
                  onClick={() => {
                    setEditingBot(bot.botId);
                    setEditName(bot.name || `ViewBot ${bot.botId.substring(0, 8)}`);
                  }}
                >
                  <Edit2 size={14} />
                </button>
              </>
            )}
          </div>
          <div className="card-status">
            {getStatusIcon(bot)}
            <span className="status-text">{botStatus}</span>
          </div>
          <div className="card-actions">
            <div className="dropdown-container">
              <button 
                className="action-menu" 
                onClick={(e) => toggleDropdown(bot.botId, e)}
                type="button"
              >
                <MoreVertical size={18} />
              </button>
              {openDropdown === bot.botId && (
                <div className="dropdown-menu" onClick={(e) => e.stopPropagation()}>
                  <button 
                    className="dropdown-item"
                    onClick={() => {
                      duplicateBot(bot);
                      setOpenDropdown(null);
                    }}
                    type="button"
                  >
                    <Copy size={14} /> Clone Bot
                  </button>
                  <button 
                    className="dropdown-item"
                    onClick={() => {
                      setEditingBot(bot.botId);
                      setEditName(bot.name || `ViewBot ${bot.botId.substring(0, 8)}`);
                      setOpenDropdown(null);
                    }}
                    type="button"
                  >
                    <Edit2 size={14} /> Rename
                  </button>
                  <div className="dropdown-divider"></div>
                  <button 
                    className="dropdown-item danger"
                    onClick={() => {
                      deleteBot(bot.botId);
                      setOpenDropdown(null);
                    }}
                    type="button"
                  >
                    <Trash2 size={14} /> Delete Bot
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card-body">
          <div className="quick-info">
            <div className="info-item">
              <Monitor size={14} />
              <span>{bot.config.contentType}</span>
            </div>
            <div className="info-item">
              <Users size={14} />
              <span>{bot.config.width}x{bot.config.height}</span>
            </div>
            <div className="info-item">
              <Clock size={14} />
              <span>{formatDuration(bot.uptime)}</span>
            </div>
            {/* Duration information for rotation */}
            {bot.isStreaming && rotationStatus.rotationEnabled && (
              <>
                {bot.timeAllotment && (
                  <div className="info-item">
                    <Zap size={14} />
                    <span title="Time Allotment">{formatDuration(bot.timeAllotment)}</span>
                  </div>
                )}
                {bot.timeRemaining && (
                  <div className="info-item time-remaining">
                    <RefreshCw size={14} />
                    <span title="Time Remaining">{formatDuration(bot.timeRemaining)}</span>
                  </div>
                )}
              </>
            )}
            {bot.config.streamDuration && bot.config.streamDuration > 0 && !rotationStatus.rotationEnabled && (
              <div className="info-item">
                <Film size={14} />
                <span title="Stream Duration">{bot.config.streamDuration} min</span>
              </div>
            )}
          </div>

          {bot.isStreaming && bot.metrics && (
            <div className="live-metrics">
              <div className="metric">
                <span className="metric-label">FPS</span>
                <span className="metric-value">{bot.metrics?.fps || 0}</span>
              </div>
              <div className="metric">
                <span className="metric-label">Bitrate</span>
                <span className="metric-value">{bot.metrics?.bitrate || 0} kbps</span>
              </div>
              <div className="metric">
                <span className="metric-label">Latency</span>
                <span className="metric-value">{bot.metrics?.latency || 0} ms</span>
              </div>
              <div className="metric">
                <span className="metric-label">CPU</span>
                <span className="metric-value">{bot.metrics?.cpuUsage || 0}%</span>
              </div>
            </div>
          )}

          <div className="card-controls">
            {!bot.isStreaming ? (
              <button 
                className="control-btn start" 
                onClick={() => startBot(bot.botId)}
                type="button"
              >
                <Play size={16} /> Start
              </button>
            ) : (
              <button 
                className="control-btn stop" 
                onClick={() => stopBot(bot.botId)}
                type="button"
              >
                <StopCircle size={16} /> Stop
              </button>
            )}
            <button 
              className="control-btn" 
              onClick={() => duplicateBot(bot)}
              type="button"
            >
              <Copy size={16} /> Clone
            </button>
            <button 
              className="control-btn expand" 
              onClick={() => toggleCardExpansion(bot.botId)}
              type="button"
            >
              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          {isExpanded && (
            <div className="expanded-content">
              <div className="settings-section">
                <h4>Stream Configuration</h4>
                <div className="setting-row">
                  <label>Content Type</label>
                  {editingConfig[bot.botId] ? (
                    <select 
                      value={editingConfig[bot.botId].contentType || bot.config.contentType}
                      onChange={(e) => setEditingConfig({
                        ...editingConfig,
                        [bot.botId]: {
                          ...editingConfig[bot.botId],
                          contentType: e.target.value
                        }
                      })}
                    >
                      <option value="testPattern">Test Pattern</option>
                      <option value="videoFile">Video File</option>
                      <option value="customText">Custom Text</option>
                      <option value="webCam">Web Camera</option>
                      <option value="screenCapture">Screen Capture</option>
                    </select>
                  ) : (
                    <span>{bot.config.contentType}</span>
                  )}
                </div>
                
                {(editingConfig[bot.botId]?.contentType === 'videoFile' || (!editingConfig[bot.botId] && bot.config.contentType === 'videoFile')) && (
                  <div className="setting-row">
                    <label>Video File</label>
                    {editingConfig[bot.botId] ? (
                      <div className="video-file-input-group">
                        <input 
                          type="text"
                          value={editingConfig[bot.botId].videoFile || bot.config.videoFile || ''}
                          onChange={(e) => setEditingConfig({
                            ...editingConfig,
                            [bot.botId]: {
                              ...editingConfig[bot.botId],
                              videoFile: e.target.value
                            }
                          })}
                          placeholder="Enter video file path or URL"
                        />
                        <div className="file-upload-wrapper">
                          <input
                            type="file"
                            id={`file-upload-${bot.botId}`}
                            accept="video/*"
                            disabled={uploadingVideo[bot.botId]}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                // Set uploading state
                                setUploadingVideo({ ...uploadingVideo, [bot.botId]: true });
                                setUploadProgress({ ...uploadProgress, [bot.botId]: 0 });
                                
                                // Create FormData for file upload
                                const formData = new FormData();
                                formData.append('video', file);
                                
                                try {
                                  const token = localStorage.getItem('adminToken');
                                  const adminKey = localStorage.getItem('adminKey') || token;
                                  
                                  // Create XMLHttpRequest to track upload progress
                                  const xhr = new XMLHttpRequest();
                                  
                                  // Track upload progress
                                  xhr.upload.addEventListener('progress', (event) => {
                                    if (event.lengthComputable) {
                                      const percentComplete = Math.round((event.loaded / event.total) * 100);
                                      setUploadProgress(prev => ({ ...prev, [bot.botId]: percentComplete }));
                                    }
                                  });
                                  
                                  // Handle completion
                                  await new Promise((resolve, reject) => {
                                    xhr.onload = () => {
                                      if (xhr.status === 200) {
                                        try {
                                          const result = JSON.parse(xhr.responseText);
                                          // Update the video file path with the uploaded file path
                                          setEditingConfig({
                                            ...editingConfig,
                                            [bot.botId]: {
                                              ...editingConfig[bot.botId],
                                              videoFile: result.filePath
                                            }
                                          });
                                          log(`✅ Video uploaded: ${result.filePath}`);
                                          resolve(result);
                                        } catch (error) {
                                          reject(error);
                                        }
                                      } else {
                                        log(`❌ Failed to upload video: ${xhr.statusText}`);
                                        reject(new Error(xhr.statusText));
                                      }
                                    };
                                    
                                    xhr.onerror = () => reject(new Error('Network error'));
                                    
                                    xhr.open('POST', `${process.env.REACT_APP_SERVER_URL || 'http://localhost:8080'}/admin/viewbot-client/upload-video`);
                                    xhr.setRequestHeader('x-admin-key', adminKey || '');
                                    if (token) {
                                      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                                    }
                                    xhr.send(formData);
                                  });
                                } catch (error) {
                                  console.error('File upload error:', error);
                                  log(`❌ Error uploading video: ${error}`);
                                } finally {
                                  // Reset upload state
                                  setUploadingVideo({ ...uploadingVideo, [bot.botId]: false });
                                  setUploadProgress({ ...uploadProgress, [bot.botId]: 0 });
                                }
                              }
                            }}
                            style={{ display: 'none' }}
                          />
                          {uploadingVideo[bot.botId] ? (
                            <div className="upload-progress">
                              <div className="upload-progress-bar">
                                <div 
                                  className="upload-progress-fill" 
                                  style={{ width: `${uploadProgress[bot.botId] || 0}%` }}
                                />
                              </div>
                              <span className="upload-progress-text">
                                Uploading... {uploadProgress[bot.botId] || 0}%
                              </span>
                            </div>
                          ) : (
                            <label htmlFor={`file-upload-${bot.botId}`} className="file-upload-btn">
                              <Upload size={16} /> Upload Video
                            </label>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="video-file-info">
                        <span className="file-path">{bot.config.videoFile || 'No file selected'}</span>
                      </div>
                    )}
                  </div>
                )}

                {(editingConfig[bot.botId]?.contentType === 'customText' || (!editingConfig[bot.botId] && bot.config.contentType === 'customText')) && (
                  <>
                    <div className="setting-row">
                      <label>Custom Text</label>
                      {editingConfig[bot.botId] ? (
                        <input 
                          type="text"
                          value={editingConfig[bot.botId].customText || bot.config.customText || ''}
                          onChange={(e) => setEditingConfig({
                            ...editingConfig,
                            [bot.botId]: {
                              ...editingConfig[bot.botId],
                              customText: e.target.value
                            }
                          })}
                          placeholder="Enter custom text to display"
                        />
                      ) : (
                        <span>{bot.config.customText || 'Welcome to OneStreamer!'}</span>
                      )}
                    </div>
                    <div className="setting-row">
                      <label>Text Color</label>
                      {editingConfig[bot.botId] ? (
                        <input 
                          type="color"
                          value={editingConfig[bot.botId].textColor || bot.config.textColor || '#00ff88'}
                          onChange={(e) => setEditingConfig({
                            ...editingConfig,
                            [bot.botId]: {
                              ...editingConfig[bot.botId],
                              textColor: e.target.value
                            }
                          })}
                        />
                      ) : (
                        <span style={{color: bot.config.textColor}}>{bot.config.textColor || '#00ff88'}</span>
                      )}
                    </div>
                  </>
                )}

                <div className="setting-row">
                  <label>Resolution</label>
                  <span>{bot.config.width} x {bot.config.height}</span>
                </div>
                <div className="setting-row">
                  <label>Frame Rate</label>
                  <span>{bot.config.frameRate} fps</span>
                </div>
                <div className="setting-row">
                  <label>Video Bitrate</label>
                  <span>{bot.config.videoBitrate}</span>
                </div>
                <div className="setting-row">
                  <label>Audio Bitrate</label>
                  <span>{bot.config.audioBitrate}</span>
                </div>
                
                <div className="setting-row">
                  <label>Stream Duration (minutes)</label>
                  {editingConfig[bot.botId] ? (
                    <input 
                      type="number"
                      min="0"
                      value={editingConfig[bot.botId].streamDuration !== undefined ? editingConfig[bot.botId].streamDuration : bot.config.streamDuration}
                      onChange={(e) => setEditingConfig({
                        ...editingConfig,
                        [bot.botId]: {
                          ...editingConfig[bot.botId],
                          streamDuration: parseInt(e.target.value) || 0
                        }
                      })}
                      placeholder="0 for infinite"
                      style={{ width: '120px', padding: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: '#e0e0e0' }}
                    />
                  ) : (
                    <span>{bot.config.streamDuration || 0} {bot.config.streamDuration === 0 ? '(Infinite)' : 'min'}</span>
                  )}
                </div>
                
                {editingConfig[bot.botId] && (
                  <div className="config-actions">
                    <button 
                      className="config-save-btn"
                      onClick={() => {
                        const newConfig = {
                          ...bot.config,
                          ...editingConfig[bot.botId]
                        };
                        updateBotConfig(bot.botId, newConfig);
                      }}
                    >
                      <Save size={14} /> Save Changes
                    </button>
                    <button 
                      className="config-cancel-btn"
                      onClick={() => {
                        const newEditingConfig = {...editingConfig};
                        delete newEditingConfig[bot.botId];
                        setEditingConfig(newEditingConfig);
                      }}
                    >
                      <X size={14} /> Cancel
                    </button>
                  </div>
                )}
                
                {!editingConfig[bot.botId] && (
                  <button 
                    className="config-edit-btn"
                    onClick={() => setEditingConfig({
                      ...editingConfig,
                      [bot.botId]: {
                        contentType: bot.config.contentType,
                        videoFile: bot.config.videoFile,
                        customText: bot.config.customText,
                        textColor: bot.config.textColor,
                        backgroundColor: bot.config.backgroundColor,
                        streamDuration: bot.config.streamDuration || 0
                      }
                    })}
                  >
                    <Edit2 size={14} /> Edit Configuration
                  </button>
                )}
              </div>
              
              <div className="advanced-section">
                <h4>Advanced</h4>
                {bot.lastError && (
                  <div className="setting-row error-row">
                    <label>Error Details</label>
                    <div className="error-details">
                      <span className="error-text">{bot.lastError}</span>
                      <div className="error-actions">
                        <button 
                          className="error-btn diagnose"
                          onClick={async () => {
                            try {
                              const result = await apiCall('/admin/viewbot/diagnostics');
                              console.log('Diagnostics:', result);
                              log(`🔍 Diagnostics completed - FFmpeg: ${result.ffmpeg.available ? '✅' : '❌'}`);
                            } catch (error) {
                              log(`❌ Diagnostics failed: ${error}`);
                            }
                          }}
                        >
                          🔍 Diagnose
                        </button>
                        <button 
                          className="error-btn retry"
                          onClick={() => {
                            // Try to reinitialize the bot
                            deleteBot(bot.botId);
                            setTimeout(() => {
                              setShowCreateModal(true);
                            }, 1000);
                          }}
                        >
                          🔄 Recreate
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="danger-zone">
                  <button className="delete-btn" onClick={() => deleteBot(bot.botId)}>
                    <Trash2 size={16} /> Destroy ViewBot
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="viewbot-tab">
      {stats.error > 0 && (
        <div className="system-alert error">
          <AlertCircle size={20} />
          <div className="alert-content">
            <strong>System Issues Detected</strong>
            <p>{stats.error} ViewBot{stats.error > 1 ? 's have' : ' has'} errors. Check individual ViewBots for details and run diagnostics.</p>
          </div>
          <button 
            className="alert-action"
            onClick={async () => {
              try {
                await apiCall('/admin/viewbot/test-creation', { method: 'POST' });
                log('🧪 Test completed - check console for details');
              } catch (error) {
                log(`❌ Test failed: ${error}`);
              }
            }}
          >
            Run Test
          </button>
        </div>
      )}
      <div className="tab-header">
        <div className="header-top">
          <h2><Monitor className="header-icon" /> ViewBot Manager</h2>
          <div className="header-stats">
            <div className="stat">
              <span className="stat-label">Total</span>
              <span className="stat-value">{stats.total}</span>
            </div>
            <div className="stat active">
              <span className="stat-label">Active</span>
              <span className="stat-value">{stats.active}</span>
            </div>
            {stats.error > 0 && (
              <div className="stat error">
                <span className="stat-label">Errors</span>
                <span className="stat-value">{stats.error}</span>
              </div>
            )}
            <div className="stat">
              <span className="stat-label">Bandwidth</span>
              <span className="stat-value">{stats.totalBandwidth} Mbps</span>
            </div>
            <div className="stat">
              <span className="stat-label">Avg Latency</span>
              <span className="stat-value">{stats.avgLatency} ms</span>
            </div>
            <button 
              className="stat-button diagnose"
              onClick={async () => {
                try {
                  const result = await apiCall('/admin/viewbot/diagnostics');
                  console.log('System Diagnostics:', result);
                  log(`🔍 System check - FFmpeg: ${result.ffmpeg?.available ? '✅' : '❌'}, MediaSoup: ${result.mediasoup?.initialized ? '✅' : '❌'}`);
                } catch (error) {
                  log(`❌ System diagnostics failed: ${error}`);
                }
              }}
              title="Run system diagnostics"
            >
              🔍 Diagnose System
            </button>
          </div>
        </div>

        {/* Rotation System Controls */}
        <div className="rotation-controls-panel">
          <div className="rotation-header">
            <h3>
              <RefreshCw size={18} className={rotationStatus.rotationEnabled ? 'rotating' : ''} />
              Rotation System
            </h3>
          </div>
          <div className="rotation-controls">
            <div className="rotation-control-item">
              <label className="control-label">System Status</label>
              <div className="rotation-toggle">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={rotationStatus.rotationEnabled}
                    onChange={(e) => toggleRotation(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
                <span className={`status-text ${rotationStatus.rotationEnabled ? 'active' : ''}`}>
                  {rotationStatus.rotationEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>

            <div className="rotation-control-item">
              <label className="control-label">Current Live Bot</label>
              <div className="current-bot">
                {rotationStatus.currentLiveBot ? (
                  <span className="bot-id">{rotationStatus.currentLiveBot}</span>
                ) : (
                  <span className="no-bot">None</span>
                )}
              </div>
            </div>

            <div className="rotation-control-item">
              <label className="control-label">Next Rotation</label>
              <div className="countdown">
                {rotationStatus.rotationEnabled && rotationStatus.timeToNextRotationFormatted ? (
                  <span className="countdown-time">{rotationStatus.timeToNextRotationFormatted}</span>
                ) : (
                  <span className="countdown-inactive">--:--:--</span>
                )}
              </div>
            </div>

            <div className="rotation-control-item">
              <button
                className="force-rotate-btn"
                onClick={forceRotation}
                disabled={!rotationStatus.rotationEnabled || !rotationStatus.currentLiveBot}
              >
                <RefreshCw size={16} />
                Force Rotate
              </button>
            </div>

            {rotationStatus.realStreamerActive && (
              <div className="rotation-warning">
                <AlertCircle size={16} />
                Real streamer is active - rotation paused
              </div>
            )}
          </div>
        </div>

        {/* Streaming Method Controls */}
        <div className="streaming-method-panel">
          <div className="streaming-method-header">
            <h3>
              <Film size={18} />
              Streaming Method
            </h3>
          </div>
          <div className="streaming-method-controls">
            <div className="method-selector">
              <label className="method-option">
                <input
                  type="radio"
                  name="streamingMethod"
                  value="gstreamer"
                  checked={streamingMethod === 'gstreamer'}
                  onChange={() => updateStreamingMethod('gstreamer')}
                />
                <span className="method-label">
                  <strong>GStreamer</strong>
                  <small>Default, optimized for streaming</small>
                </span>
              </label>
              <label className="method-option">
                <input
                  type="radio"
                  name="streamingMethod"
                  value="ffmpeg"
                  checked={streamingMethod === 'ffmpeg'}
                  onChange={() => updateStreamingMethod('ffmpeg')}
                />
                <span className="method-label">
                  <strong>FFmpeg</strong>
                  <small>Alternative, widely compatible</small>
                </span>
              </label>
            </div>
            <div className="method-info">
              <AlertCircle size={14} />
              <span>Applies to all ViewBots streaming video files</span>
            </div>
          </div>
        </div>
        
        <div className="header-controls">
          <div className="search-filter">
            <div className="search-box">
              <Search size={18} />
              <input
                type="text"
                placeholder="Search ViewBots..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="filter-box">
              <Filter size={18} />
              <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
                <option value="">All Tags</option>
                <option value="test">Test</option>
                <option value="production">Production</option>
                <option value="debug">Debug</option>
              </select>
            </div>
          </div>
          
          <div className="view-controls">
            {selectedBots.size > 0 && (
              <div className="bulk-actions">
                <span>{selectedBots.size} selected</span>
                <select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
                  <option value="">Bulk Actions</option>
                  <option value="start">Start All</option>
                  <option value="stop">Stop All</option>
                  <option value="delete">Delete All</option>
                </select>
                <button onClick={executeBulkAction} disabled={!bulkAction}>
                  Apply
                </button>
              </div>
            )}
            
            <div className="view-mode">
              <button 
                className={viewMode === 'grid' ? 'active' : ''}
                onClick={() => setViewMode('grid')}
              >
                <Grid size={18} />
              </button>
              <button 
                className={viewMode === 'list' ? 'active' : ''}
                onClick={() => setViewMode('list')}
              >
                <List size={18} />
              </button>
            </div>
            
            <button className="create-btn" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} /> New ViewBot
            </button>
          </div>
        </div>
      </div>

      <div className={`viewbot-container ${viewMode}`}>
        {error ? (
          <div className="error-state">
            <AlertCircle size={48} className="error-icon" />
            <h3>Failed to Load ViewBots</h3>
            <p>{error}</p>
            <button className="retry-btn" onClick={() => {
              setError(null);
              setLoading(true);
              fetchViewBots();
            }}>
              <RefreshCw size={18} /> Retry
            </button>
          </div>
        ) : loading ? (
          <div className="loading-state">
            <RefreshCw size={48} className="loading-spinner" />
            <h3>Loading ViewBots...</h3>
            <p>Fetching ViewBot status and configurations</p>
          </div>
        ) : filteredBots.length === 0 ? (
          <div className="empty-state">
            <Monitor size={48} />
            <h3>No ViewBots Found</h3>
            <p>Create your first ViewBot to get started</p>
            <button className="create-btn" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} /> Create ViewBot
            </button>
          </div>
        ) : (
          <div className="viewbot-grid">
            {filteredBots
              .filter((bot, index, array) => {
                // Remove duplicates based on botId
                return array.findIndex(b => b.botId === bot.botId) === index;
              })
              .map(bot => {
                const card = renderBotCard(bot);
                return card;
              })
              .filter(Boolean)
            }
          </div>
        )}
      </div>
      
      <CreateViewBotModal
        isVisible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreateBot={handleCreateBot}
      />
    </div>
  );
};

export default ViewBotTab;