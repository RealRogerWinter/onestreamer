import React, { useState } from 'react';
import CookieService, { COOKIE_NAMES } from '../../services/CookieService';
import ScreenSharePanel from './ScreenSharePanel';
import AudioPanel from './streamerSettings/AudioPanel';
import VideoPanel from './streamerSettings/VideoPanel';
import { useStreamerDevices } from './streamerSettings/useStreamerDevices';
import {
  AudioSettingsConfig,
  VideoSettingsConfig,
  ScreenShareSettingsConfig,
  StreamerSettingsConfig,
  getDefaultScreenShareSettings,
} from './streamerSettings/types';
import './StreamerSettings.css';

// Re-export the config types so existing importers (StreamViewer, WebRTCStreamer,
// ScreenSharePanel, TheatreControls, useStreamerSettings, …) keep working.
export type {
  VideoSettingsConfig,
  AudioSettingsConfig,
  PipPosition,
  ScreenShareSettingsConfig,
  StreamerSettingsConfig,
} from './streamerSettings/types';

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

  const {
    audioInputs,
    audioOutputs,
    videoInputs,
    cameraStream,
    setCameraStream,
    audioLevel,
    peakLevel,
    isMicTesting,
    isCameraPreview,
    setIsCameraPreview,
    videoPreviewRef,
    toggleCameraPreview,
    toggleMicTest,
  } = useStreamerDevices({ settings, handleSettingsChange, expanded, compact });

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

  const handleScreenShareGainChange = (setting: 'micGain' | 'systemGain', value: number) => {
    handleSettingsChange({
      ...settings,
      screenShare: {
        ...getDefaultScreenShareSettings(),
        ...settings.screenShare,
        [setting]: value
      }
    });
  };

  const handlePipSizeChange = (value: number) => {
    handleSettingsChange({
      ...settings,
      screenShare: {
        ...getDefaultScreenShareSettings(),
        ...settings.screenShare,
        pipSize: value
      }
    });
  };

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
          <AudioPanel
            settings={settings}
            isStreaming={isStreaming}
            audioInputs={audioInputs}
            audioOutputs={audioOutputs}
            isMicTesting={isMicTesting}
            audioLevel={audioLevel}
            peakLevel={peakLevel}
            toggleMicTest={toggleMicTest}
            applyAudioPreset={applyAudioPreset}
            handleAudioToggle={handleAudioToggle}
            handleAudioSelectChange={handleAudioSelectChange}
          />
        )}

        {/* Video Settings Tab */}
        {activeTab === 'video' && (
          <VideoPanel
            settings={settings}
            isStreaming={isStreaming}
            videoInputs={videoInputs}
            isCameraPreview={isCameraPreview}
            setIsCameraPreview={setIsCameraPreview}
            cameraStream={cameraStream}
            setCameraStream={setCameraStream}
            videoPreviewRef={videoPreviewRef}
            toggleCameraPreview={toggleCameraPreview}
            applyVideoPreset={applyVideoPreset}
            handleVideoToggle={handleVideoToggle}
            handleVideoSelectChange={handleVideoSelectChange}
          />
        )}

        {/* Screen Share Settings Tab */}
        {activeTab === 'screen' && screenShareSupported && (
          <ScreenSharePanel
            settings={settings}
            isStreaming={isStreaming}
            isScreenSharing={isScreenSharing}
            onStartScreenShare={onStartScreenShare}
            onStopScreenShare={onStopScreenShare}
            handleScreenShareToggle={handleScreenShareToggle}
            handleScreenShareSelectChange={handleScreenShareSelectChange}
            handleScreenShareGainChange={handleScreenShareGainChange}
            handlePipSizeChange={handlePipSizeChange}
          />
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
