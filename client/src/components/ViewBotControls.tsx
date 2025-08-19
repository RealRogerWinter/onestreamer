import React, { useState, useEffect } from 'react';

interface ViewBotConfig {
  contentType: 'testPattern' | 'videoFile' | 'webCam' | 'screenCapture' | 'customText';
  videoFile?: string;
  testPattern?: 'color-bars' | 'moving-text' | 'clock' | 'noise' | 'gradient';
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
  timeAllotment?: number; // Manual time allotment in milliseconds
}

interface ViewBot {
  botId: string;
  isConnected: boolean;
  isStreaming: boolean;
  startTime: number | null;
  uptime: number;
  config: ViewBotConfig;
  lastError?: string;
  serverUrl: string;
  // ViewBot rotation system properties
  timeAllotment?: number;
  timeRemaining?: number;
  timeAllotmentFormatted?: string;
  timeRemainingFormatted?: string;
}

interface ViewBotStatus {
  totalBots: number;
  maxBots: number;
  bots: ViewBot[];
}

interface ViewBotHealthStatus {
  service: string;
  status: string;
  totalBots: number;
  streamingBots: number;
  healthyBots: number;
  maxCapacity: number;
  utilizationPercent: number;
  serverUrl: string;
  lastCheck: string;
}

interface ViewBotControlsProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

const ViewBotControls: React.FC<ViewBotControlsProps> = ({ makeApiCall, addLog }) => {
  // Helper function to generate random time allotment (15s - 8min)
  const generateRandomTimeAllotment = (): number => {
    const minTime = 15 * 1000; // 15 seconds in ms
    const maxTime = 8 * 60 * 1000; // 8 minutes in ms
    return Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  };

  // Helper function to format time allotment for display
  const formatTimeAllotment = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m ${seconds}s`;
    }
    return `${minutes}m ${seconds}s`;
  };

  const [status, setStatus] = useState<ViewBotStatus | null>(null);
  const [health, setHealth] = useState<ViewBotHealthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  
  // Bot creation form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createConfig, setCreateConfig] = useState<Partial<ViewBotConfig>>(() => ({
    contentType: 'testPattern',
    testPattern: 'color-bars',
    customText: 'Welcome to OneStreamer!',
    textColor: '#00ff88',
    backgroundColor: '#001122',
    fontSize: 48,
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: '1000k',
    audioBitrate: '128k',
    autoStart: false,
    streamDuration: 0,
    timeAllotment: generateRandomTimeAllotment() // Auto-populate with random value
  }));
  const [uploadingFile, setUploadingFile] = useState(false);
  
  // ViewBot rotation system state
  const [rotationStatus, setRotationStatus] = useState<any>(null);
  const [rotationEnabled, setRotationEnabled] = useState(false);
  const [realStreamerActive, setRealStreamerActive] = useState(false);
  const [timeToNextRotation, setTimeToNextRotation] = useState<number | null>(null);
  const [countdownDisplay, setCountdownDisplay] = useState<string>('');

  const contentTypes = [
    { value: 'testPattern', label: 'Test Pattern' },
    { value: 'customText', label: 'Custom Text' },
    { value: 'videoFile', label: 'Video File' },
    { value: 'webCam', label: 'WebCam (Not Implemented)' },
    { value: 'screenCapture', label: 'Screen Capture (Not Implemented)' }
  ];

  const testPatterns = [
    { value: 'color-bars', label: 'SMPTE Color Bars' },
    { value: 'moving-text', label: 'Scrolling Text' },
    { value: 'clock', label: 'Digital Clock' },
    { value: 'noise', label: 'Random Noise' },
    { value: 'gradient', label: 'Color Gradient' }
  ];

  const resolutions = [
    { value: { width: 1920, height: 1080 }, label: '1920×1080 (Full HD)' },
    { value: { width: 1280, height: 720 }, label: '1280×720 (HD)' },
    { value: { width: 854, height: 480 }, label: '854×480 (SD)' },
    { value: { width: 640, height: 360 }, label: '640×360 (Low)' }
  ];

  const handleVideoFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    console.log('📁 File selection triggered');
    console.log('📋 Current createConfig before file selection:', createConfig);
    
    const file = event.target.files?.[0];
    if (!file) {
      console.log('❌ No file selected');
      return;
    }

    console.log('📋 Selected file:', {
      name: file.name,
      type: file.type,
      size: file.size
    });

    // Validate file type
    if (!file.type.startsWith('video/')) {
      addLog('❌ Please select a valid video file');
      console.error('Invalid file type:', file.type);
      return;
    }

    // Check file size (limit to 5GB for large video files)
    const maxSize = 5 * 1024 * 1024 * 1024; // 5GB
    if (file.size > maxSize) {
      addLog(`❌ File too large. Maximum size is 5GB (file is ${(file.size / 1024 / 1024 / 1024).toFixed(1)}GB)`);
      console.error('File too large:', file.size);
      return;
    }

    try {
      setUploadingFile(true);
      addLog(`📤 Uploading video file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
      console.log('📤 Starting upload...');

      const formData = new FormData();
      formData.append('video', file);

      const uploadUrl = `${process.env.REACT_APP_SERVER_URL || window.location.origin}/admin/upload-video`;
      console.log('📡 Upload URL:', uploadUrl);

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'x-admin-key': localStorage.getItem('onestreamer-admin-key') || ''
        },
        body: formData
      });

      console.log('📡 Upload response status:', response.status);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('📡 Upload result:', result);

      if (result.success) {
        console.log('📋 Upload successful, updating config with file path:', result.filePath);
        
        // Update React state - this should automatically update the controlled text input
        setCreateConfig(prevConfig => {
          console.log('📋 Previous config before update:', prevConfig);
          const newConfig = {
            ...prevConfig,
            videoFile: result.filePath
          };
          console.log('📋 New config after file upload:', newConfig);
          return newConfig;
        });
        
        addLog(`✅ Video uploaded successfully: ${result.filename || file.name}`);
        console.log('📋 Video file set to:', result.filePath);
        
        // Clear the file input to allow re-selection of same file
        const fileInput = document.getElementById('video-file-input') as HTMLInputElement;
        if (fileInput) {
          fileInput.value = '';
          console.log('📋 Cleared file input for re-selection');
        }
      } else {
        addLog(`❌ Upload failed: ${result.error || 'Unknown error'}`);
        console.error('Upload error details:', result);
      }

    } catch (error) {
      addLog(`❌ Upload error: ${error}`);
      console.error('Upload error:', error);
    } finally {
      setUploadingFile(false);
      console.log('📁 Upload process completed');
    }
  };

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const [statusResult, healthResult] = await Promise.all([
        makeApiCall('/admin/viewbot-client/status'),
        makeApiCall('/admin/viewbot-client/health')
      ]);
      
      console.log('📊 Health result:', healthResult);
      
      setStatus(statusResult);
      setHealth(healthResult);
      
      // Use health result for rotation status since it includes the rotation info
      if (healthResult) {
        setRotationStatus({
          rotationEnabled: healthResult.rotationEnabled,
          currentLiveBot: healthResult.currentLiveBot,
          realStreamerActive: healthResult.realStreamerActive,
          availableBots: statusResult.bots?.filter((bot: ViewBot) => bot.isConnected && !bot.isStreaming).length || 0,
          totalBots: statusResult.totalBots,
          nextRotationTime: healthResult.nextRotationTime,
          timeToNextRotation: healthResult.timeToNextRotation,
          timeToNextRotationFormatted: healthResult.timeToNextRotationFormatted
        });
        setRotationEnabled(healthResult.rotationEnabled || false);
        setRealStreamerActive(healthResult.realStreamerActive || false);
        setTimeToNextRotation(healthResult.timeToNextRotation);
      }
      
    } catch (error) {
      addLog(`Failed to fetch ViewBot status: ${error}`);
      console.error('ViewBot status fetch error:', error);
    } finally {
      setLoading(false);
    }
  };

  const toggleRotationSystem = async () => {
    console.log('🔄 Toggle rotation button clicked, current state:', rotationEnabled);
    
    try {
      setLoading(true);
      
      const newEnabledState = !rotationEnabled;
      console.log('🔄 Sending request to toggle rotation to:', newEnabledState);
      
      const result = await makeApiCall('/admin/viewbot-client/rotation/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: newEnabledState })
      });
      
      console.log('🔄 Toggle rotation API response:', result);
      
      if (result.success) {
        const newState = result.rotationEnabled;
        setRotationEnabled(newState);
        addLog(`🔄 ViewBot rotation ${newState ? 'ENABLED' : 'DISABLED'}`);
        console.log('🔄 Rotation state updated to:', newState);
        
        // Don't immediately refresh status to avoid conflicts
        setTimeout(() => {
          fetchStatus(); // Refresh status after a delay
        }, 1000);
      } else {
        addLog(`❌ Failed to toggle rotation: ${result.message}`);
        console.error('❌ Toggle rotation failed:', result);
      }
      
    } catch (error) {
      addLog(`❌ Error toggling rotation: ${error}`);
      console.error('❌ Toggle rotation error:', error);
    } finally {
      setLoading(false);
      console.log('🔄 Toggle rotation completed, loading state reset');
    }
  };

  const toggleRealStreamerStatus = async () => {
    try {
      setLoading(true);
      
      const result = await makeApiCall('/admin/viewbot-client/real-streamer-status', {
        method: 'POST',
        body: JSON.stringify({ isActive: !realStreamerActive })
      });
      
      if (result.success) {
        setRealStreamerActive(result.realStreamerActive);
        addLog(`👤 Real streamer ${result.realStreamerActive ? 'ACTIVE' : 'INACTIVE'}`);
        await fetchStatus(); // Refresh status
      } else {
        addLog(`❌ Failed to toggle real streamer status: ${result.message}`);
      }
      
    } catch (error) {
      addLog(`❌ Error toggling real streamer status: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const forceRotation = async (currentBotId: string) => {
    try {
      setLoading(true);
      
      const result = await makeApiCall('/admin/viewbot-client/rotation/force', {
        method: 'POST',
        body: JSON.stringify({ currentBotId })
      });
      
      if (result.success) {
        addLog(`🔄 Forced rotation: ${result.previousBot} → ${result.newBot}`);
        await fetchStatus(); // Refresh status
      } else {
        addLog(`❌ Failed to force rotation: ${result.message}`);
      }
      
    } catch (error) {
      addLog(`❌ Error forcing rotation: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Debug effect to track videoFile changes
  useEffect(() => {
    console.log('📋 createConfig.videoFile changed:', createConfig.videoFile);
  }, [createConfig.videoFile]);

  // Countdown timer effect
  useEffect(() => {
    if (!rotationEnabled || !timeToNextRotation || timeToNextRotation <= 0) {
      setCountdownDisplay('');
      return;
    }

    const startTime = Date.now();
    const endTime = startTime + timeToNextRotation;

    const updateCountdown = () => {
      const now = Date.now();
      const remaining = Math.max(0, endTime - now);
      
      if (remaining <= 0) {
        setCountdownDisplay('Rotating...');
        return;
      }

      const seconds = Math.floor(remaining / 1000) % 60;
      const minutes = Math.floor(remaining / 60000);
      
      if (minutes > 0) {
        setCountdownDisplay(`${minutes}m ${seconds}s`);
      } else {
        setCountdownDisplay(`${seconds}s`);
      }
    };

    updateCountdown(); // Initial update
    const interval = setInterval(updateCountdown, 1000);
    
    return () => clearInterval(interval);
  }, [timeToNextRotation, rotationEnabled]);

  const handleCreateBot = async () => {
    try {
      setLoading(true);
      
      const result = await makeApiCall('/admin/viewbot-client/create', {
        method: 'POST',
        body: JSON.stringify(createConfig)
      });
      
      if (result.success) {
        addLog(`✅ ViewBot created: ${result.botId}`);
        setShowCreateForm(false);
        await fetchStatus();
      } else {
        // Enhanced error handling
        const errorMessage = result.message || 'Unknown error';
        
        if (errorMessage.includes('capacity') || errorMessage.includes('limit')) {
          addLog(`📊 System capacity reached: Cannot create more ViewBots`);
          addLog(`💡 Try: Destroy unused ViewBots first to free up capacity`);
        } else if (errorMessage.includes('file') && errorMessage.includes('not found')) {
          addLog(`📁 Video file error: Selected file not found or invalid`);
          addLog(`💡 Try: Re-upload the video file or check the file path`);
        } else if (errorMessage.includes('invalid') && errorMessage.includes('config')) {
          addLog(`⚙️ Configuration error: Invalid ViewBot settings`);
          addLog(`💡 Try: Check resolution, frame rate, and content settings`);
        } else {
          addLog(`❌ Failed to create ViewBot: ${errorMessage}`);
          addLog(`🔍 Check server logs for detailed error information`);
        }
      }
      
    } catch (error) {
      addLog(`❌ Network error creating ViewBot: ${error}`);
      addLog(`🔍 Check your connection and server status`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateStreamerBot = async () => {
    try {
      setLoading(true);
      
      // Pre-flight checks
      if (realStreamerActive) {
        addLog(`🚫 Cannot create streaming ViewBot: Real streamer is currently active`);
        addLog(`💡 Tip: Set real streamer to inactive first, or create bot without auto-start`);
        return;
      }
      
      const result = await makeApiCall('/admin/viewbot-client/create-streamer', {
        method: 'POST',
        body: JSON.stringify({ ...createConfig, autoStart: true })
      });
      
      if (result.success) {
        addLog(`✅ Streamer ViewBot created and started: ${result.botId}`);
        setShowCreateForm(false);
        await fetchStatus();
      } else {
        // Enhanced error handling
        const errorMessage = result.message || 'Unknown error';
        
        if (errorMessage.includes('real streamer') || errorMessage.includes('priority') || errorMessage.includes('cannot take over')) {
          addLog(`🚫 ViewBot creation blocked: Real streamer has priority`);
          addLog(`💡 Solution: Set real streamer to inactive, or create bot without auto-start`);
          addLog(`🔧 Try using "Create Bot" instead of "Create & Start Streaming"`);
        } else if (errorMessage.includes('capacity') || errorMessage.includes('limit')) {
          addLog(`📊 System capacity reached: Cannot create more ViewBots`);
          addLog(`💡 Try: Destroy unused ViewBots first`);
        } else if (errorMessage.includes('file') && errorMessage.includes('not found')) {
          addLog(`📁 Video file error: Selected file not found`);
          addLog(`💡 Try: Re-upload the video file or check the file path`);
        } else {
          addLog(`❌ Failed to create streamer ViewBot: ${errorMessage}`);
          addLog(`🔍 Check server logs for detailed error information`);
        }
      }
      
    } catch (error) {
      addLog(`❌ Network error creating streamer ViewBot: ${error}`);
      addLog(`🔍 Check your connection and server status`);
    } finally {
      setLoading(false);
    }
  };

  const handleStartBot = async (botId: string) => {
    try {
      setLoading(true);
      
      // Pre-flight checks with user-friendly messages
      if (realStreamerActive) {
        addLog(`🚫 Cannot start ViewBot: Real streamer is currently active`);
        addLog(`💡 Tip: Set real streamer to inactive first, or wait for them to stop streaming`);
        return;
      }
      
      // Check if rotation is enabled and provide appropriate feedback
      if (rotationEnabled) {
        addLog(`🔄 Starting ViewBot ${botId.substring(0, 12)}... (rotation system active)`);
      } else {
        addLog(`▶️ Starting ViewBot ${botId.substring(0, 12)}...`);
      }
      
      const result = await makeApiCall(`/admin/viewbot-client/${botId}/start`, {
        method: 'POST'
      });
      
      if (result.success) {
        if (rotationEnabled) {
          addLog(`✅ ViewBot streaming started with rotation: ${botId.substring(0, 12)}... (fresh time allotment assigned)`);
        } else {
          addLog(`✅ ViewBot streaming started: ${botId.substring(0, 12)}...`);
        }
        await fetchStatus();
      } else {
        // Enhanced error handling with specific error types
        const errorMessage = result.message || 'Unknown error';
        
        if (errorMessage.includes('real streamer') || errorMessage.includes('priority') || errorMessage.includes('cannot take over')) {
          addLog(`🚫 ViewBot blocked: Real streamer has priority`);
          addLog(`💡 Solution: Wait for real streamer to finish, or set real streamer status to inactive`);
          addLog(`🔧 Use "Set Real Streamer Inactive" button above if no real user is streaming`);
        } else if (errorMessage.includes('already streaming') || errorMessage.includes('bot is active')) {
          addLog(`⚠️ ViewBot is already streaming`);
          addLog(`💡 Tip: Stop the current ViewBot first, or use rotation controls`);
        } else if (errorMessage.includes('not connected') || errorMessage.includes('disconnected')) {
          addLog(`🔌 ViewBot connection error: ${botId.substring(0, 12)}... is not connected`);
          addLog(`💡 Try: Refresh status, or destroy and recreate this ViewBot`);
        } else if (errorMessage.includes('capacity') || errorMessage.includes('limit')) {
          addLog(`📊 System capacity reached: Cannot start more ViewBots`);
          addLog(`💡 Try: Stop other ViewBots first, or increase system capacity`);
        } else {
          addLog(`❌ Failed to start ViewBot: ${errorMessage}`);
          addLog(`🔍 Check server logs for detailed error information`);
        }
      }
      
    } catch (error) {
      addLog(`❌ Network error starting ViewBot: ${error}`);
      addLog(`🔍 Check your connection and server status`);
    } finally {
      setLoading(false);
    }
  };

  const handleStopBot = async (botId: string) => {
    try {
      setLoading(true);
      
      // Check if rotation is enabled and provide appropriate feedback
      if (rotationEnabled) {
        addLog(`🔄 Stopping ViewBot ${botId.substring(0, 12)}... (rotation system will auto-start next bot)`);
      } else {
        addLog(`⏹️ Stopping ViewBot ${botId.substring(0, 12)}...`);
      }
      
      const result = await makeApiCall(`/admin/viewbot-client/${botId}/stop`, {
        method: 'POST'
      });
      
      if (result.success) {
        if (rotationEnabled) {
          addLog(`✅ ViewBot stopped with auto-rotation: ${botId.substring(0, 12)}... (next bot starting automatically)`);
        } else {
          addLog(`✅ ViewBot streaming stopped: ${botId.substring(0, 12)}...`);
        }
        await fetchStatus();
      } else {
        addLog(`❌ Failed to stop ViewBot: ${result.message}`);
      }
      
    } catch (error) {
      addLog(`❌ Error stopping ViewBot: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDestroyBot = async (botId: string) => {
    if (!window.confirm(`Are you sure you want to destroy ViewBot ${botId}?`)) {
      return;
    }
    
    try {
      setLoading(true);
      
      const result = await makeApiCall(`/admin/viewbot-client/${botId}`, {
        method: 'DELETE'
      });
      
      if (result.success) {
        addLog(`🗑️ ViewBot destroyed: ${botId}`);
        await fetchStatus();
      } else {
        addLog(`❌ Failed to destroy ViewBot: ${result.message}`);
      }
      
    } catch (error) {
      addLog(`❌ Error destroying ViewBot: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDestroyAllBots = async () => {
    if (!window.confirm('Are you sure you want to destroy ALL ViewBots? This cannot be undone.')) {
      return;
    }
    
    try {
      setLoading(true);
      
      const result = await makeApiCall('/admin/viewbot-client/all', {
        method: 'DELETE'
      });
      
      if (result.success) {
        addLog(`🗑️ All ViewBots destroyed`);
        await fetchStatus();
      } else {
        addLog(`❌ Failed to destroy all ViewBots: ${result.message}`);
      }
      
    } catch (error) {
      addLog(`❌ Error destroying all ViewBots: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  };

  const formatUptime = (uptime: number): string => {
    if (uptime === 0) return 'Not running';
    return formatDuration(uptime);
  };

  if (loading && !status) {
    return <div className="loading">Loading ViewBot status...</div>;
  }

  return (
    <div className="viewbot-controls">
      <div className="controls-header">
        <h3>🤖 ViewBot Client Controls</h3>
        <div className="header-controls">
          <label className="auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (3s)
          </label>
          <button onClick={fetchStatus} className="refresh-button" disabled={loading}>
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* Health Status */}
      {health && (
        <div className="controls-section">
          <h4>🏥 Service Health</h4>
          <div className="health-grid">
            <div className="health-item">
              <span>Service Status:</span>
              <span className={`status ${health.status === 'running' ? 'active' : 'inactive'}`}>
                {health.status.toUpperCase()}
              </span>
            </div>
            <div className="health-item">
              <span>Total Bots:</span>
              <span>{health.totalBots} / {health.maxCapacity}</span>
            </div>
            <div className="health-item">
              <span>Streaming:</span>
              <span className={health.streamingBots > 0 ? 'streaming' : 'idle'}>
                {health.streamingBots}
              </span>
            </div>
            <div className="health-item">
              <span>Healthy:</span>
              <span className={health.healthyBots === health.totalBots ? 'healthy' : 'warning'}>
                {health.healthyBots}
              </span>
            </div>
            <div className="health-item">
              <span>Utilization:</span>
              <span>{health.utilizationPercent}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Real Streamer Priority Warning */}
      {realStreamerActive && (
        <div className="controls-section">
          <div className="priority-warning">
            <h4>🚫 Real Streamer Active - ViewBots Blocked</h4>
            <div className="warning-content">
              <p>⚠️ A real streamer is currently active and has priority over ViewBots.</p>
              <p>💡 ViewBot operations (start, create & start) are currently blocked.</p>
              <div className="warning-actions">
                <button
                  onClick={toggleRealStreamerStatus}
                  className="warning-button"
                  disabled={loading}
                >
                  💤 Set Real Streamer Inactive
                </button>
                <span className="warning-hint">
                  Use this if no real user is actually streaming
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ViewBot Rotation System */}
      {rotationStatus && (
        <div className="controls-section">
          <div className="section-header">
            <h4>🔄 ViewBot Rotation System</h4>
            {rotationEnabled && rotationStatus.timeToNextRotation > 0 && (
              <div className="rotation-countdown-widget">
                <div className="countdown-label">Next Rotation:</div>
                <div className={`countdown-clock ${countdownDisplay === 'Rotating...' ? 'rotating' : ''}`}>
                  {countdownDisplay || rotationStatus.timeToNextRotationFormatted || 'N/A'}
                </div>
              </div>
            )}
          </div>
          <div className="rotation-controls">
            <div className="rotation-table">
              <div className="table-header">
                <span>Property</span>
                <span>Status</span>
                <span>Details</span>
              </div>
              
              <div className="table-row">
                <span>System Status</span>
                <span className={`status ${rotationEnabled ? 'active' : 'inactive'}`}>
                  {rotationEnabled ? '✅ ENABLED' : '❌ DISABLED'}
                </span>
                <span>
                  {rotationEnabled ? 'Automatic rotation active' : 'Manual control only'}
                </span>
              </div>
              
              <div className="table-row">
                <span>Real Streamer</span>
                <span className={`status ${realStreamerActive ? 'warning' : 'inactive'}`}>
                  {realStreamerActive ? '👤 ACTIVE' : '💤 INACTIVE'}
                </span>
                <span>
                  {realStreamerActive ? 'ViewBots blocked from streaming' : 'ViewBots can stream'}
                </span>
              </div>
              
              <div className="table-row">
                <span>Current Live Bot</span>
                <span className={rotationStatus.currentLiveBot ? 'active' : 'inactive'}>
                  {rotationStatus.currentLiveBot ? rotationStatus.currentLiveBot.substring(0, 12) + '...' : 'None'}
                </span>
                <span>
                  {rotationStatus.currentLiveBot ? 'Currently broadcasting' : 'No active ViewBot'}
                </span>
              </div>
              
              <div className="table-row">
                <span>Available Bots</span>
                <span>{rotationStatus.availableBots}</span>
                <span>Ready for rotation</span>
              </div>
              
              {rotationEnabled && rotationStatus.timeToNextRotation > 0 && (
                <div className="table-row">
                  <span>Next Rotation</span>
                  <span className={`countdown ${countdownDisplay === 'Rotating...' ? 'rotating' : ''}`}>
                    {countdownDisplay || rotationStatus.timeToNextRotationFormatted || 'N/A'}
                  </span>
                  <span>
                    {countdownDisplay === 'Rotating...' ? 'Switching ViewBot now' : 'Live countdown'}
                  </span>
                </div>
              )}
            </div>
            
            <div className="rotation-actions">
              <button
                onClick={toggleRotationSystem}
                className={rotationEnabled ? 'danger-button' : 'create-button'}
                disabled={loading}
              >
                {rotationEnabled ? '🛑 Disable Rotation' : '🔄 Enable Rotation'}
              </button>
              
              <button
                onClick={toggleRealStreamerStatus}
                className={realStreamerActive ? 'danger-button' : 'warning-button'}
                disabled={loading}
              >
                {realStreamerActive ? '💤 Set Inactive' : '👤 Set Real Streamer Active'}
              </button>
              
              {rotationEnabled && rotationStatus.currentLiveBot && (
                <button
                  onClick={() => forceRotation(rotationStatus.currentLiveBot)}
                  className="warning-button"
                  disabled={loading}
                >
                  🔄 Force Rotation Now
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bot Management */}
      <div className="controls-section">
        <div className="section-header">
          <h4>🎛️ Bot Management</h4>
          <div className="section-actions">
            <button 
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="create-button"
              disabled={loading}
            >
              {showCreateForm ? '❌ Cancel' : '➕ Create Bot'}
            </button>
            {status && status.totalBots > 0 && (
              <button 
                onClick={handleDestroyAllBots}
                className="danger-button"
                disabled={loading}
              >
                🗑️ Destroy All
              </button>
            )}
          </div>
        </div>

        {/* Create Bot Form */}
        {showCreateForm && (
          <div className="create-form">
            <h5>Create New ViewBot</h5>
            
            <div className="config-grid">
              <div className="config-group">
                <label>Content Type:</label>
                <select
                  value={createConfig.contentType}
                  onChange={(e) => setCreateConfig({ 
                    ...createConfig, 
                    contentType: e.target.value as ViewBotConfig['contentType']
                  })}
                >
                  {contentTypes.map(type => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              {createConfig.contentType === 'testPattern' && (
                <div className="config-group">
                  <label>Test Pattern:</label>
                  <select
                    value={createConfig.testPattern}
                    onChange={(e) => setCreateConfig({ 
                      ...createConfig, 
                      testPattern: e.target.value as ViewBotConfig['testPattern']
                    })}
                  >
                    {testPatterns.map(pattern => (
                      <option key={pattern.value} value={pattern.value}>
                        {pattern.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {createConfig.contentType === 'videoFile' && (
                <div className="config-group">
                  <label>Video File:</label>
                  <div className="file-input-group">
                    <input
                      type="file"
                      accept="video/*"
                      onChange={handleVideoFileSelect}
                      className="file-input"
                      id="video-file-input"
                      disabled={uploadingFile || loading}
                    />
                    <label 
                      htmlFor="video-file-input" 
                      className={`file-input-label ${uploadingFile ? 'uploading' : ''}`}
                      onClick={(e) => {
                        console.log('📁 File button clicked');
                        e.preventDefault();
                        const fileInput = document.getElementById('video-file-input') as HTMLInputElement;
                        if (fileInput) {
                          console.log('📁 File input found, triggering click');
                          fileInput.click();
                        } else {
                          console.error('❌ File input not found!');
                        }
                      }}
                    >
                      {uploadingFile ? '⏳ Uploading...' : '📁 Choose Video File'}
                    </label>
                    <input
                      type="text"
                      value={createConfig.videoFile || ''}
                      onChange={(e) => {
                        console.log('📋 Manual path input changed:', e.target.value);
                        setCreateConfig(prevConfig => ({
                          ...prevConfig, 
                          videoFile: e.target.value
                        }));
                      }}
                      placeholder="Or enter file path manually"
                      className="file-path-input"
                      onFocus={() => console.log('📋 Text input focused, current value:', createConfig.videoFile)}
                      onBlur={() => console.log('📋 Text input blurred, current value:', createConfig.videoFile)}
                    />
                  </div>
                  {createConfig.videoFile && (
                    <div className="selected-file">
                      📹 Selected: {createConfig.videoFile.split(/[/\\]/).pop()}
                      <br />
                      <small style={{ opacity: 0.7 }}>Path: {createConfig.videoFile}</small>
                    </div>
                  )}
                  {createConfig.contentType === 'videoFile' && !createConfig.videoFile && (
                    <div className="no-file-warning" style={{ 
                      padding: '8px 12px', 
                      background: 'rgba(255, 152, 0, 0.2)', 
                      border: '1px solid rgba(255, 152, 0, 0.3)', 
                      borderRadius: '6px', 
                      color: '#ff9800',
                      fontSize: '13px'
                    }}>
                      ⚠️ No video file selected. Please choose a file or enter a path.
                    </div>
                  )}
                </div>
              )}

              {createConfig.contentType === 'customText' && (
                <div className="config-group">
                  <label>Custom Text Configuration:</label>
                  
                  <div className="text-config-grid">
                    <div className="text-input-group">
                      <label>Text to Display:</label>
                      <textarea
                        value={createConfig.customText || ''}
                        onChange={(e) => setCreateConfig({ 
                          ...createConfig, 
                          customText: e.target.value 
                        })}
                        placeholder="Enter text to display..."
                        rows={3}
                        className="text-input"
                      />
                    </div>
                    
                    <div className="color-input-group">
                      <div className="color-input">
                        <label>Text Color:</label>
                        <input
                          type="color"
                          value={createConfig.textColor || '#00ff88'}
                          onChange={(e) => setCreateConfig({ 
                            ...createConfig, 
                            textColor: e.target.value 
                          })}
                          className="color-picker"
                        />
                        <span className="color-value">{createConfig.textColor || '#00ff88'}</span>
                      </div>
                      
                      <div className="color-input">
                        <label>Background Color:</label>
                        <input
                          type="color"
                          value={createConfig.backgroundColor || '#001122'}
                          onChange={(e) => setCreateConfig({ 
                            ...createConfig, 
                            backgroundColor: e.target.value 
                          })}
                          className="color-picker"
                        />
                        <span className="color-value">{createConfig.backgroundColor || '#001122'}</span>
                      </div>
                    </div>
                    
                    <div className="font-size-group">
                      <label>Font Size:</label>
                      <input
                        type="range"
                        min="16"
                        max="96"
                        value={createConfig.fontSize || 48}
                        onChange={(e) => setCreateConfig({ 
                          ...createConfig, 
                          fontSize: parseInt(e.target.value) 
                        })}
                        className="font-size-slider"
                      />
                      <span className="font-size-value">{createConfig.fontSize || 48}px</span>
                    </div>
                  </div>
                  
                  <div className="text-preview">
                    <div 
                      style={{
                        backgroundColor: createConfig.backgroundColor || '#001122',
                        color: createConfig.textColor || '#00ff88',
                        fontSize: `${Math.min(createConfig.fontSize || 48, 24)}px`,
                        padding: '8px',
                        borderRadius: '4px',
                        textAlign: 'center',
                        fontFamily: 'Arial, sans-serif',
                        fontWeight: 'bold',
                        minHeight: '40px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      {createConfig.customText || 'Preview text...'}
                    </div>
                  </div>
                </div>
              )}

              <div className="config-group">
                <label>Resolution:</label>
                <select
                  value={`${createConfig.width}x${createConfig.height}`}
                  onChange={(e) => {
                    const selected = resolutions.find(r => 
                      `${r.value.width}x${r.value.height}` === e.target.value
                    );
                    if (selected) {
                      setCreateConfig({ 
                        ...createConfig, 
                        width: selected.value.width, 
                        height: selected.value.height 
                      });
                    }
                  }}
                >
                  {resolutions.map(res => (
                    <option key={`${res.value.width}x${res.value.height}`} value={`${res.value.width}x${res.value.height}`}>
                      {res.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="config-group">
                <label>Frame Rate:</label>
                <input
                  type="number"
                  value={createConfig.frameRate}
                  onChange={(e) => setCreateConfig({ 
                    ...createConfig, 
                    frameRate: parseInt(e.target.value) 
                  })}
                  min="15"
                  max="60"
                  step="5"
                />
              </div>

              <div className="config-group">
                <label>Time Allotment:</label>
                <div className="time-allotment-input">
                  <input
                    type="number"
                    value={Math.floor((createConfig.timeAllotment || 0) / 1000)}
                    onChange={(e) => {
                      const seconds = parseInt(e.target.value) || 0;
                      setCreateConfig({ 
                        ...createConfig, 
                        timeAllotment: seconds * 1000 
                      });
                    }}
                    min="15"
                    max="480"
                    step="5"
                    placeholder="Seconds"
                  />
                  <span className="time-unit">seconds</span>
                  <button
                    type="button"
                    onClick={() => setCreateConfig({ 
                      ...createConfig, 
                      timeAllotment: generateRandomTimeAllotment() 
                    })}
                    className="randomize-button"
                  >
                    🎲 Randomize
                  </button>
                </div>
                <div className="time-preview">
                  Preview: {createConfig.timeAllotment ? formatTimeAllotment(createConfig.timeAllotment) : 'N/A'}
                </div>
              </div>
            </div>

            <div className="form-actions">
              <button 
                onClick={handleCreateBot}
                className="create-button"
                disabled={loading}
              >
                🤖 Create Bot
              </button>
              <button 
                onClick={handleCreateStreamerBot}
                className="start-button"
                disabled={loading}
              >
                🎬 Create & Start Streaming
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Active Bots */}
      {status && status.bots && status.bots.length > 0 && (
        <div className="controls-section">
          <h4>🤖 Active ViewBots ({status.totalBots})</h4>
          
          <div className="bots-table">
            <div className="table-header">
              <span>Bot ID</span>
              <span>Status</span>
              <span>Content</span>
              <span>Resolution</span>
              <span>Uptime</span>
              <span>Time Allotment</span>
              <span>Time Remaining</span>
              <span>Actions</span>
            </div>
            
            {status.bots.map((bot) => (
              <div key={bot.botId} className="table-row">
                <span className="bot-id" title={bot.botId}>
                  {bot.botId.substring(0, 12)}...
                </span>
                <span className="bot-status">
                  <span className={`status-dot ${bot.isConnected ? 'connected' : 'disconnected'}`}></span>
                  {bot.isStreaming ? (
                    <span className="streaming">🎬 Streaming</span>
                  ) : bot.isConnected ? (
                    <span className="connected">🔌 Connected</span>
                  ) : (
                    <span className="disconnected">❌ Disconnected</span>
                  )}
                </span>
                <span className="bot-content">
                  {bot.config.contentType === 'testPattern' 
                    ? bot.config.testPattern || 'color-bars'
                    : bot.config.contentType === 'videoFile'
                    ? bot.config.videoFile?.split('/').pop() || 'Video File'
                    : bot.config.contentType === 'customText'
                    ? `"${(bot.config.customText || '').substring(0, 20)}${(bot.config.customText || '').length > 20 ? '...' : ''}"`
                    : bot.config.contentType
                  }
                </span>
                <span className="bot-resolution">
                  {bot.config.width}×{bot.config.height}
                </span>
                <span className="bot-uptime">
                  {formatUptime(bot.uptime)}
                </span>
                <span className="bot-time-allotment">
                  {bot.timeAllotmentFormatted || 'N/A'}
                </span>
                <span className={`bot-time-remaining ${bot.isStreaming && bot.timeRemaining && bot.timeRemaining < 60000 ? 'warning' : ''}`}>
                  {bot.isStreaming ? (bot.timeRemainingFormatted || 'N/A') : '-'}
                </span>
                <span className="bot-actions">
                  {!bot.isStreaming ? (
                    <button 
                      onClick={() => handleStartBot(bot.botId)}
                      className="start-button-small"
                      disabled={loading || realStreamerActive}
                      title={realStreamerActive ? 'Cannot start - real streamer is active' : 
                             rotationEnabled ? 'Start ViewBot (will integrate with rotation system)' : 
                             'Start ViewBot streaming'}
                    >
                      {rotationEnabled ? '🔄' : '▶️'}
                    </button>
                  ) : (
                    <button 
                      onClick={() => handleStopBot(bot.botId)}
                      className="stop-button-small"
                      disabled={loading}
                      title={rotationEnabled ? 'Stop ViewBot (rotation will auto-start next bot)' : 
                             'Stop ViewBot streaming'}
                    >
                      {rotationEnabled ? '🔄' : '⏹️'}
                    </button>
                  )}
                  <button 
                    onClick={() => handleDestroyBot(bot.botId)}
                    className="destroy-button-small"
                    disabled={loading}
                  >
                    🗑️
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No Bots Message */}
      {status && status.totalBots === 0 && (
        <div className="controls-section">
          <div className="no-bots">
            <p>No ViewBots currently active</p>
            <p>Create a ViewBot to get started with automated streaming</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ViewBotControls;