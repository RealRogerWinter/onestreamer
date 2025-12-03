import React, { useEffect, useState, useRef } from 'react';
import CookieService, { COOKIE_NAMES } from '../services/CookieService';
import './StreamerSettings.css';

export interface VideoSettingsConfig {
  resolution: '480p' | '720p';
  frameRate: 15 | 24 | 30 | 60;
  bitrate: number;
  facingMode: 'user' | 'environment';
  videoEnabled: boolean;
  mirror: boolean;
  videoDeviceId?: string;
}

export interface AudioSettingsConfig {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  sampleRate: number;
  channelCount: number;
  profile: 'raw' | 'microphone' | 'music' | 'streaming';
  inputDeviceId?: string;
  outputDeviceId?: string;
}

export interface ScreenShareSettingsConfig {
  cursor: 'always' | 'motion' | 'never';
  audio: boolean;
  displaySurface: 'monitor' | 'window' | 'browser';
}

export interface StreamerSettingsConfig {
  audio: AudioSettingsConfig;
  video: VideoSettingsConfig;
  screenShare?: ScreenShareSettingsConfig;
}

interface StreamerSettingsProps {
  settings: StreamerSettingsConfig;
  onSettingsChange: (settings: StreamerSettingsConfig) => void;
  isStreaming?: boolean;
  compact?: boolean;
  isScreenSharing?: boolean;
  onStartScreenShare?: () => void;
  onStopScreenShare?: () => void;
}

const StreamerSettings: React.FC<StreamerSettingsProps> = ({
  settings,
  onSettingsChange,
  isStreaming = false,
  compact = false,
  isScreenSharing = false,
  onStartScreenShare,
  onStopScreenShare
}) => {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [expanded, setExpanded] = useState(!compact);
  const [activeTab, setActiveTab] = useState<'audio' | 'video' | 'screen'>('audio');
  const [screenShareSupported] = useState(() => {
    return !!(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices);
  });
  
  // Wrapper function to save settings to cookies when they change
  const handleSettingsChange = (newSettings: StreamerSettingsConfig) => {
    // Save individual settings to cookies
    CookieService.setCookie(COOKIE_NAMES.AUDIO_SETTINGS, newSettings.audio);
    CookieService.setCookie(COOKIE_NAMES.VIDEO_SETTINGS, newSettings.video);
    CookieService.setCookie(COOKIE_NAMES.STREAMER_SETTINGS, newSettings);
    
    // Call the original onSettingsChange prop
    onSettingsChange(newSettings);
  };
  
  // Preview and test states
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [peakLevel, setPeakLevel] = useState<number>(0);
  const [isMicTesting, setIsMicTesting] = useState(false);
  const [isCameraPreview, setIsCameraPreview] = useState(false);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const peakHoldTimeRef = useRef<number>(0);

  // Cleanup function for media streams
  const cleanupStreams = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      setMicStream(null);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsMicTesting(false);
    setIsCameraPreview(false);
    setAudioLevel(0);
    setPeakLevel(0);
  };

  // Function to request permissions and get devices when user opens settings
  const requestPermissionsAndGetDevices = async () => {
    // Check if mediaDevices is available (requires HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('Media devices not available. HTTPS or localhost required for WebRTC.');
      return;
    }
    
    try {
      // Request permissions first if needed
      await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(stream => {
          // Stop the stream immediately, we just needed permissions
          stream.getTracks().forEach(track => track.stop());
        });
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioIns = devices.filter(device => device.kind === 'audioinput');
      const audioOuts = devices.filter(device => device.kind === 'audiooutput');
      const videoIns = devices.filter(device => device.kind === 'videoinput');
      
      setAudioInputs(audioIns);
      setAudioOutputs(audioOuts);
      setVideoInputs(videoIns);
      
      // Set default devices if not already set
      let updatedSettings = { ...settings };
      let needsUpdate = false;
      
      if (!settings.audio.inputDeviceId && audioIns.length > 0) {
        updatedSettings.audio = { ...updatedSettings.audio, inputDeviceId: audioIns[0].deviceId };
        needsUpdate = true;
      }
      if (!settings.audio.outputDeviceId && audioOuts.length > 0) {
        updatedSettings.audio = { ...updatedSettings.audio, outputDeviceId: audioOuts[0].deviceId };
        needsUpdate = true;
      }
      if (!settings.video.videoDeviceId && videoIns.length > 0) {
        updatedSettings.video = { ...updatedSettings.video, videoDeviceId: videoIns[0].deviceId };
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        handleSettingsChange(updatedSettings);
      }
    } catch (error) {
      console.error('Failed to enumerate devices:', error);
    }
  };

  useEffect(() => {
    // Get available devices without requesting permissions
    const getDevices = async () => {
      // Check if mediaDevices is available (requires HTTPS or localhost)
      if (!navigator.mediaDevices) {
        console.warn('Media devices not available. HTTPS or localhost required for WebRTC.');
        return;
      }
      
      try {
        // Try to get devices without permissions first
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioIns = devices.filter(device => device.kind === 'audioinput');
        const audioOuts = devices.filter(device => device.kind === 'audiooutput');
        const videoIns = devices.filter(device => device.kind === 'videoinput');
        
        // Only update if we have actual device labels (means we have permissions)
        if (audioIns.length > 0 && audioIns[0].label) {
          setAudioInputs(audioIns);
          setAudioOutputs(audioOuts);
          setVideoInputs(videoIns);
        }
      } catch (error) {
        console.error('Failed to enumerate devices:', error);
      }
    };

    // Only get devices if the settings panel is expanded
    if (expanded || !compact) {
      // If we're expanded, request permissions and get devices
      requestPermissionsAndGetDevices();
    } else {
      // If not expanded, just try to get devices without permissions
      getDevices();
    }

    // Listen for device changes (only if mediaDevices is available)
    if (navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', getDevices);
      return () => {
        navigator.mediaDevices.removeEventListener('devicechange', getDevices);
        cleanupStreams();
      };
    } else {
      return () => {
        cleanupStreams();
      };
    }
  }, [expanded, compact]);
  
  // Cleanup streams when panel closes
  useEffect(() => {
    if (!expanded && compact) {
      cleanupStreams();
    }
  }, [expanded, compact]);

  const handleAudioToggle = (setting: keyof AudioSettingsConfig) => {
    if (typeof settings.audio[setting] === 'boolean') {
      handleSettingsChange({
        ...settings,
        audio: {
          ...settings.audio,
          [setting]: !settings.audio[setting]
        }
      });
    }
  };

  const handleVideoToggle = (setting: keyof VideoSettingsConfig) => {
    if (typeof settings.video[setting] === 'boolean') {
      handleSettingsChange({
        ...settings,
        video: {
          ...settings.video,
          [setting]: !settings.video[setting]
        }
      });
    }
  };

  const handleScreenShareToggle = (setting: keyof ScreenShareSettingsConfig) => {
    const currentValue = settings.screenShare?.[setting];
    if (typeof currentValue === 'boolean' || setting === 'audio') {
      handleSettingsChange({
        ...settings,
        screenShare: {
          ...getDefaultScreenShareSettings(),
          ...settings.screenShare,
          [setting]: !(currentValue ?? false)
        }
      });
    }
  };

  const handleScreenShareSelectChange = (setting: keyof ScreenShareSettingsConfig, value: string) => {
    handleSettingsChange({
      ...settings,
      screenShare: {
        ...getDefaultScreenShareSettings(),
        ...settings.screenShare,
        [setting]: value
      }
    });
  };

  const getDefaultScreenShareSettings = (): ScreenShareSettingsConfig => ({
    cursor: 'always',
    audio: false,
    displaySurface: 'monitor'
  });

  const handleAudioSelectChange = (setting: keyof AudioSettingsConfig, value: string | number) => {
    handleSettingsChange({
      ...settings,
      audio: {
        ...settings.audio,
        [setting]: setting === 'sampleRate' || setting === 'channelCount' ? Number(value) : value
      }
    });
  };

  const handleVideoSelectChange = (setting: keyof VideoSettingsConfig, value: string | number) => {
    handleSettingsChange({
      ...settings,
      video: {
        ...settings.video,
        [setting]: setting === 'frameRate' || setting === 'bitrate' ? Number(value) : value
      }
    });
  };

  // Camera preview functionality
  const toggleCameraPreview = async () => {
    // console.log('📹 toggleCameraPreview called, current state:', isCameraPreview);
    
    if (isCameraPreview) {
      // Stop preview
      // console.log('📹 Stopping camera preview...');
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => {
          // console.log('📹 Stopping track:', track.kind, track.label);
          track.stop();
        });
        setCameraStream(null);
      }
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = null;
      }
      setIsCameraPreview(false);
    } else {
      // Start preview
      // console.log('📹 Starting camera preview...');
      try {
        // Build video constraints based on settings
        const getResolutionConstraints = () => {
          switch (settings.video.resolution) {
            case '480p':
              return { width: { ideal: 854 }, height: { ideal: 480 } };
            case '720p':
              return { width: { ideal: 1280 }, height: { ideal: 720 } };
            default:
              return { width: { ideal: 1280 }, height: { ideal: 720 } };
          }
        };
        
        const videoConstraints: any = {
          ...getResolutionConstraints(),
          frameRate: { ideal: settings.video.frameRate }
        };
        
        // Add device ID if specified, otherwise use facingMode
        if (settings.video.videoDeviceId) {
          videoConstraints.deviceId = { exact: settings.video.videoDeviceId };
        } else {
          videoConstraints.facingMode = settings.video.facingMode;
        }
        
        const constraints = {
          video: videoConstraints,
          audio: false
        };
        
        // console.log('📹 Requesting user media with constraints:', constraints);
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        // console.log('📹 Got stream:', stream);
        // console.log('📹 Video tracks:', stream.getVideoTracks());
        
        setCameraStream(stream);
        
        // Set stream to video element immediately
        if (videoPreviewRef.current) {
          // console.log('📹 Setting srcObject on video element');
          videoPreviewRef.current.srcObject = stream;
          
          // Apply mirror effect if enabled
          if (settings.video.mirror) {
            videoPreviewRef.current.style.transform = 'scaleX(-1)';
          } else {
            videoPreviewRef.current.style.transform = 'scaleX(1)';
          }
          
          // Try to play
          try {
            await videoPreviewRef.current.play();
            // console.log('📹 Video playing successfully');
          } catch (playErr) {
            console.error('📹 Error playing video:', playErr);
          }
        }
        
        setIsCameraPreview(true);
      } catch (error) {
        console.error('📹 Failed to start camera preview:', error);
        alert('Failed to access camera. Please check permissions.');
        setIsCameraPreview(false);
      }
    }
  };
  
  // Microphone test functionality
  const toggleMicTest = async () => {
    if (isMicTesting) {
      // Stop test
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        setMicStream(null);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setIsMicTesting(false);
      setAudioLevel(0);
      setPeakLevel(0);
    } else {
      // Start test
      try {
        const constraints = {
          audio: {
            deviceId: settings.audio.inputDeviceId ? { exact: settings.audio.inputDeviceId } : undefined,
            echoCancellation: settings.audio.echoCancellation,
            noiseSuppression: settings.audio.noiseSuppression,
            autoGainControl: settings.audio.autoGainControl,
            sampleRate: { ideal: settings.audio.sampleRate }
          }
        };
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setMicStream(stream);
        setIsMicTesting(true);
        
        // Set up audio analysis
        audioContextRef.current = new AudioContext();
        const source = audioContextRef.current.createMediaStreamSource(stream);
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 256;
        source.connect(analyserRef.current);
        
        // Start monitoring audio levels
        const updateLevel = () => {
          if (analyserRef.current) {
            // Use time domain data for accurate level measurement
            const bufferLength = analyserRef.current.fftSize;
            const dataArray = new Float32Array(bufferLength);
            analyserRef.current.getFloatTimeDomainData(dataArray);
            
            // Calculate RMS (Root Mean Square) for accurate level
            let sum = 0;
            let peak = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const value = Math.abs(dataArray[i]);
              sum += value * value;
              peak = Math.max(peak, value);
            }
            const rms = Math.sqrt(sum / dataArray.length);
            
            // Convert to 0-1 range with appropriate scaling
            // RMS values typically range from 0 to ~0.7 for normal speech
            // Use peak for better visual feedback
            const scaledLevel = Math.min(1, Math.max(rms * 5, peak * 2));
            
            // Update peak hold
            const currentTime = Date.now();
            if (scaledLevel > peakLevel || currentTime - peakHoldTimeRef.current > 2000) {
              setPeakLevel(scaledLevel);
              peakHoldTimeRef.current = currentTime;
            }
            
            // Debug logging to check if audio is being detected
            if (scaledLevel > 0.01) {
              console.log('🎤 Audio detected - RMS:', rms.toFixed(4), 'Peak:', peak.toFixed(4), 'Level:', scaledLevel.toFixed(2));
            }
            
            setAudioLevel(scaledLevel);
            animationFrameRef.current = requestAnimationFrame(updateLevel);
          }
        };
        updateLevel();
      } catch (error) {
        console.error('Failed to start microphone test:', error);
        alert('Failed to access microphone. Please check permissions.');
      }
    }
  };
  
  const applyAudioPreset = (preset: 'raw' | 'microphone' | 'music' | 'streaming') => {
    const presets = {
      raw: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'raw' as const
      },
      microphone: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,
        profile: 'microphone' as const
      },
      music: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'music' as const
      },
      streaming: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
        profile: 'streaming' as const
      }
    };

    handleSettingsChange({
      ...settings,
      audio: {
        ...settings.audio,
        ...presets[preset]
      }
    });
  };

  const applyVideoPreset = (preset: 'low' | 'max') => {
    const presets = {
      low: {
        resolution: '480p' as const,
        frameRate: 15 as const,
        bitrate: 500000
      },
      max: {
        resolution: '720p' as const,
        frameRate: 30 as const,
        bitrate: 1500000
      }
    };

    handleSettingsChange({
      ...settings,
      video: {
        ...settings.video,
        ...presets[preset]
      }
    });
  };

  // Compact mode - just show the button
  if (compact && !expanded) {
    return (
      <div className="streamer-settings compact">
        <button 
          className="expand-button"
          onClick={() => setExpanded(true)}
          title="Expand Streamer Settings"
        >
          ⚙️ Streamer Settings
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Backdrop when expanded in compact mode */}
      {compact && expanded && (
        <div 
          className="streamer-settings-backdrop"
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            zIndex: 99
          }}
        />
      )}
      
      <div className={`streamer-settings ${compact ? 'compact-expanded' : ''}`}>
        <div className="streamer-settings-header">
          <h3>⚙️ Streamer Settings</h3>
          {compact && (
            <button 
              className="collapse-button"
              onClick={() => setExpanded(false)}
              title="Collapse"
            >
              ✕
            </button>
          )}
          {isStreaming && (
            <span className="streaming-warning" style={{ color: '#00ff00' }}>🔴 Live - Changes apply instantly</span>
          )}
        </div>

        {/* Tab Navigation */}
        <div className="settings-tabs">
          <button
            className={`tab-button ${activeTab === 'audio' ? 'active' : ''}`}
            onClick={() => setActiveTab('audio')}
          >
            🎵 Audio
          </button>
          <button
            className={`tab-button ${activeTab === 'video' ? 'active' : ''}`}
            onClick={() => setActiveTab('video')}
          >
            📹 Video
          </button>
          {screenShareSupported && (
            <button
              className={`tab-button ${activeTab === 'screen' ? 'active' : ''} ${isScreenSharing ? 'screen-active' : ''}`}
              onClick={() => setActiveTab('screen')}
            >
              🖥️ Screen {isScreenSharing && '🔴'}
            </button>
          )}
        </div>

        {/* Audio Settings Tab */}
        {activeTab === 'audio' && (
          <div className="settings-panel audio-panel">
            <div className="audio-presets">
              <label>Quick Audio Presets:</label>
              <div className="preset-buttons">
                <button 
                  className={`preset-btn ${settings.audio.profile === 'raw' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('raw')}
                  title="No processing - ideal for music or testing"
                >
                  Raw Audio
                </button>
                <button 
                  className={`preset-btn ${settings.audio.profile === 'microphone' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('microphone')}
                  title="Optimized for microphone input"
                >
                  Microphone
                </button>
                <button 
                  className={`preset-btn ${settings.audio.profile === 'music' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('music')}
                  title="High quality for music streaming"
                >
                  Music
                </button>
                <button 
                  className={`preset-btn ${settings.audio.profile === 'streaming' ? 'active' : ''}`}
                  onClick={() => applyAudioPreset('streaming')}
                  title="Balanced for general streaming"
                >
                  Streaming
                </button>
              </div>
            </div>

            <div className="settings-grid">
              {/* Device Selectors */}
              <div className="setting-group device-selector">
                <label className="setting-label">
                  <span>Input (Mic)</span>
                  <select
                    value={settings.audio.inputDeviceId || ''}
                    onChange={(e) => handleAudioSelectChange('inputDeviceId', e.target.value)}
                    disabled={isMicTesting}
                    title={isStreaming ? "Change microphone during stream" : "Select microphone input device"}
                  >
                    {audioInputs.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Mic ${device.deviceId.slice(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              
              {/* Microphone Test */}
              <div className="setting-group mic-test">
                <button
                  className={`test-button ${isMicTesting ? 'active' : ''}`}
                  onClick={toggleMicTest}
                  disabled={false}
                >
                  {isMicTesting ? '🔴 Stop Test' : '🎤 Test Microphone'}
                </button>
                {isMicTesting && (
                  <div className="audio-level-meter">
                    <div className="meter-header">
                      <span className="level-label">Audio Level</span>
                      <span className="db-value">
                        {audioLevel > 0.001 
                          ? `${Math.round(20 * Math.log10(audioLevel))} dB` 
                          : '-∞ dB'}
                      </span>
                    </div>
                    
                    <div className="db-scale">
                      <span>-60</span>
                      <span>-48</span>
                      <span>-36</span>
                      <span>-24</span>
                      <span>-12</span>
                      <span>-6</span>
                      <span>0</span>
                    </div>
                    
                    <div className="level-bar-container">
                      {/* Simple gradient bar for now */}
                      <div 
                        className="level-bar-fill"
                        style={{
                          width: `${Math.max(1, audioLevel * 100)}%`,
                          background: `linear-gradient(90deg, 
                            #00ff00 0%, 
                            #00ff00 50%, 
                            #ffff00 65%, 
                            #ff8800 80%, 
                            #ff0000 95%)`
                        }}
                      />
                      
                      {/* Peak indicator */}
                      <div 
                        className="peak-indicator"
                        style={{
                          left: `${Math.min(98, peakLevel * 100)}%`
                        }}
                      />
                    </div>
                    
                    {/* Tick marks below */}
                    <div className="meter-ticks">
                      <div className="tick" style={{ left: '0%' }} />
                      <div className="tick" style={{ left: '20%' }} />
                      <div className="tick" style={{ left: '40%' }} />
                      <div className="tick" style={{ left: '60%' }} />
                      <div className="tick" style={{ left: '80%' }} />
                      <div className="tick" style={{ left: '90%' }} />
                      <div className="tick major" style={{ left: '100%' }} />
                    </div>
                  </div>
                )}
              </div>

              <div className="setting-group device-selector">
                <label className="setting-label">
                  <span>Output</span>
                  <select
                    value={settings.audio.outputDeviceId || ''}
                    onChange={(e) => handleAudioSelectChange('outputDeviceId', e.target.value)}
                    disabled={false}
                  >
                    {audioOutputs.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Speakers ${device.deviceId.slice(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Processing Settings */}
              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.audio.echoCancellation}
                    onChange={() => handleAudioToggle('echoCancellation')}
                    disabled={false}
                  />
                  <span>Echo Cancellation</span>
                </label>
                <small>Removes echo and feedback from speakers</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.audio.noiseSuppression}
                    onChange={() => handleAudioToggle('noiseSuppression')}
                    disabled={false}
                  />
                  <span>Noise Suppression</span>
                </label>
                <small>Reduces background noise</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.audio.autoGainControl}
                    onChange={() => handleAudioToggle('autoGainControl')}
                    disabled={false}
                  />
                  <span>Auto Gain Control</span>
                </label>
                <small>Automatically adjusts volume levels</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Sample Rate</span>
                  <select
                    value={settings.audio.sampleRate}
                    onChange={(e) => handleAudioSelectChange('sampleRate', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="16000">16 kHz (Voice)</option>
                    <option value="24000">24 kHz (Standard)</option>
                    <option value="44100">44.1 kHz (CD Quality)</option>
                    <option value="48000">48 kHz (Studio)</option>
                  </select>
                </label>
                <small>Higher = better quality, more bandwidth</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Channels</span>
                  <select
                    value={settings.audio.channelCount}
                    onChange={(e) => handleAudioSelectChange('channelCount', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="1">Mono</option>
                    <option value="2">Stereo</option>
                  </select>
                </label>
                <small>Stereo for music, Mono for voice</small>
              </div>
            </div>
          </div>
        )}

        {/* Video Settings Tab */}
        {activeTab === 'video' && (
          <div className="settings-panel video-panel">
            <div className="video-presets">
              <label>Quick Video Presets:</label>
              <div className="preset-buttons">
                <button 
                  className="preset-btn"
                  onClick={() => applyVideoPreset('low')}
                  title="Low quality - minimal bandwidth"
                >
                  Low (480p)
                </button>
                <button 
                  className="preset-btn"
                  onClick={() => applyVideoPreset('max')}
                  title="Maximum quality - 720p HD"
                >
                  Max (720p)
                </button>
              </div>
            </div>

            <div className="settings-grid">
              {/* Camera Selector */}
              <div className="setting-group device-selector">
                <label className="setting-label">
                  <span>Camera</span>
                  <select
                    value={settings.video.videoDeviceId || ''}
                    disabled={false}
                    title={isStreaming ? "Change camera during stream" : "Select camera device"}
                    onChange={async (e) => {
                      const newDeviceId = e.target.value;
                      
                      // Update settings with new device ID - this will trigger real-time update if streaming
                      handleVideoSelectChange('videoDeviceId', newDeviceId);
                      
                      // If preview is active, restart it with new camera
                      if (isCameraPreview) {
                        // console.log('📹 Camera changed, restarting preview...');
                        
                        // Stop current preview
                        if (cameraStream) {
                          cameraStream.getTracks().forEach(track => track.stop());
                          setCameraStream(null);
                        }
                        if (videoPreviewRef.current) {
                          videoPreviewRef.current.srcObject = null;
                        }
                        setIsCameraPreview(false);
                        
                        // Start with new camera after a brief delay
                        setTimeout(() => {
                          toggleCameraPreview();
                        }, 100);
                      }
                    }}
                  >
                    {videoInputs.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Camera ${device.deviceId.slice(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              
              {/* Camera Preview */}
              <div className="setting-group camera-preview">
                <button
                  className={`test-button ${isCameraPreview ? 'active' : ''}`}
                  onClick={toggleCameraPreview}
                  disabled={false}
                >
                  {isCameraPreview ? '🔴 Stop Preview' : '📹 Preview Camera'}
                </button>
                <div className="video-preview-container" style={{ display: isCameraPreview ? 'block' : 'none' }}>
                  <video
                    ref={videoPreviewRef}
                    autoPlay
                    muted
                    playsInline
                    className="video-preview"
                    style={{
                      width: '100%',
                      height: 'auto',
                      maxHeight: '200px',
                      borderRadius: '4px',
                      backgroundColor: '#000',
                      transform: settings.video.mirror ? 'scaleX(-1)' : 'scaleX(1)'
                    }}
                  />
                </div>
              </div>

              {/* Video Settings */}
              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.video.videoEnabled}
                    onChange={() => handleVideoToggle('videoEnabled')}
                    disabled={isStreaming}
                  />
                  <span>Enable Video</span>
                </label>
                <small>Turn video on/off</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.video.mirror}
                    onChange={() => handleVideoToggle('mirror')}
                    disabled={isStreaming}
                  />
                  <span>Mirror Video</span>
                </label>
                <small>Flip video horizontally</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Resolution</span>
                  <select
                    value={settings.video.resolution}
                    onChange={(e) => handleVideoSelectChange('resolution', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="480p">480p (854x480)</option>
                    <option value="720p">720p HD (1280x720)</option>
                  </select>
                </label>
                <small>Higher resolution = better quality</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Frame Rate</span>
                  <select
                    value={settings.video.frameRate}
                    onChange={(e) => handleVideoSelectChange('frameRate', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="15">15 FPS</option>
                    <option value="24">24 FPS</option>
                    <option value="30">30 FPS</option>
                    <option value="60">60 FPS</option>
                  </select>
                </label>
                <small>Higher FPS = smoother motion</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Bitrate</span>
                  <select
                    value={settings.video.bitrate}
                    onChange={(e) => handleVideoSelectChange('bitrate', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="500000">500 Kbps</option>
                    <option value="1000000">1 Mbps</option>
                    <option value="1500000">1.5 Mbps</option>
                    <option value="2000000">2 Mbps</option>
                    <option value="2500000">2.5 Mbps</option>
                    <option value="3000000">3 Mbps (Max)</option>
                  </select>
                </label>
                <small>Higher bitrate = better quality</small>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  <span>Camera Mode</span>
                  <select
                    value={settings.video.facingMode}
                    onChange={(e) => handleVideoSelectChange('facingMode', e.target.value)}
                    disabled={isStreaming}
                  >
                    <option value="user">Front Camera</option>
                    <option value="environment">Back Camera</option>
                  </select>
                </label>
                <small>Choose camera orientation</small>
              </div>
            </div>
          </div>
        )}

        {/* Screen Share Settings Tab */}
        {activeTab === 'screen' && screenShareSupported && (
          <div className="settings-panel screen-panel">
            {/* Screen Share Status Banner */}
            {isScreenSharing && (
              <div className="screen-share-active-banner" style={{
                background: 'linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%)',
                color: 'white',
                padding: '12px 16px',
                borderRadius: '8px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                boxShadow: '0 2px 8px rgba(255, 107, 107, 0.3)'
              }}>
                <span style={{ fontWeight: 'bold' }}>🖥️ Screen Sharing Active</span>
                <button
                  onClick={onStopScreenShare}
                  style={{
                    background: 'rgba(255, 255, 255, 0.2)',
                    border: '1px solid rgba(255, 255, 255, 0.4)',
                    color: 'white',
                    padding: '6px 12px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold'
                  }}
                >
                  Stop Sharing
                </button>
              </div>
            )}

            {/* Screen Share Controls */}
            <div className="settings-grid">
              {/* Start/Stop Screen Share Button */}
              <div className="setting-group" style={{ gridColumn: '1 / -1' }}>
                <button
                  type="button"
                  className="screen-share-main-button"
                  onClick={() => {
                    console.log('🖥️ Screen share button clicked, isStreaming:', isStreaming, 'isScreenSharing:', isScreenSharing);
                    if (!isStreaming) {
                      console.log('🖥️ Not streaming, ignoring click');
                      return;
                    }
                    if (isScreenSharing) {
                      console.log('🖥️ Calling onStopScreenShare:', typeof onStopScreenShare);
                      onStopScreenShare?.();
                    } else {
                      console.log('🖥️ Calling onStartScreenShare:', typeof onStartScreenShare);
                      onStartScreenShare?.();
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '12px',
                    fontSize: '16px',
                    background: isStreaming
                      ? (isScreenSharing
                        ? 'linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%)'
                        : 'linear-gradient(135deg, #4ecdc4 0%, #44b3ab 100%)')
                      : '#444',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: isStreaming ? 'pointer' : 'not-allowed',
                    opacity: isStreaming ? 1 : 0.6,
                    position: 'relative',
                    zIndex: 10
                  }}
                >
                  {isScreenSharing ? '🔴 Stop Screen Share' : '🖥️ Start Screen Share'}
                </button>
                {!isStreaming && (
                  <small style={{ color: '#ff9800', display: 'block', marginTop: '8px' }}>
                    Start streaming first to enable screen sharing
                  </small>
                )}
              </div>

              {/* Display Surface */}
              <div className="setting-group">
                <label className="setting-label">
                  <span>Share Type</span>
                  <select
                    value={settings.screenShare?.displaySurface || 'monitor'}
                    onChange={(e) => handleScreenShareSelectChange('displaySurface', e.target.value)}
                    disabled={isScreenSharing}
                  >
                    <option value="monitor">Entire Screen</option>
                    <option value="window">Application Window</option>
                    <option value="browser">Browser Tab</option>
                  </select>
                </label>
                <small>What to share with viewers</small>
              </div>

              {/* Cursor Visibility */}
              <div className="setting-group">
                <label className="setting-label">
                  <span>Cursor</span>
                  <select
                    value={settings.screenShare?.cursor || 'always'}
                    onChange={(e) => handleScreenShareSelectChange('cursor', e.target.value)}
                    disabled={isScreenSharing}
                  >
                    <option value="always">Always Visible</option>
                    <option value="motion">Show on Motion</option>
                    <option value="never">Hidden</option>
                  </select>
                </label>
                <small>Mouse cursor visibility</small>
              </div>

              {/* System Audio */}
              <div className="setting-group">
                <label className="setting-label">
                  <input
                    type="checkbox"
                    checked={settings.screenShare?.audio ?? false}
                    onChange={() => handleScreenShareToggle('audio')}
                    disabled={isScreenSharing}
                  />
                  <span>Include System Audio</span>
                </label>
                <small>Share audio from screen (Chrome/Edge only)</small>
                {settings.screenShare?.audio && (
                  <div style={{
                    marginTop: '8px',
                    padding: '8px',
                    background: 'rgba(76, 175, 80, 0.15)',
                    border: '1px solid rgba(76, 175, 80, 0.4)',
                    borderRadius: '4px',
                    fontSize: '12px',
                    color: '#81c784'
                  }}>
                    <strong>Tip:</strong> When the browser dialog appears, check the <strong>"Share system audio"</strong> checkbox at the bottom to capture game/app audio.
                    <br />This works for Entire Screen, Window, or Tab sharing.
                  </div>
                )}
              </div>
            </div>

            {/* Screen Share Info */}
            <div className="screen-share-info" style={{
              marginTop: '16px',
              padding: '12px',
              background: 'rgba(78, 205, 196, 0.1)',
              borderRadius: '8px',
              border: '1px solid rgba(78, 205, 196, 0.3)'
            }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>
                <strong>Tips:</strong>
                <br />• Viewers will see your screen instead of camera
                <br />• Your microphone will be replaced with system audio if enabled
                <br />• Click stop or use browser controls to end sharing
              </p>
            </div>
          </div>
        )}

        <div className="settings-info">
          <p className="current-profile">
            Audio: <strong>{settings.audio.profile}</strong> |
            Video: <strong>{settings.video.resolution} @ {settings.video.frameRate}fps</strong>
            {isScreenSharing && <> | Screen: <strong style={{ color: '#ff6b6b' }}>Sharing</strong></>}
          </p>
        </div>
      </div>
    </>
  );
};

export default StreamerSettings;