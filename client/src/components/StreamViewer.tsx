import React from 'react';
import WebRTCViewer from './WebRTCViewer';
import WebRTCStreamer from './WebRTCStreamer';
import { Socket } from 'socket.io-client';
import { AudioSettingsConfig, VideoSettingsConfig, ScreenShareSettingsConfig } from './StreamerSettings';
import './StreamViewer.css';

interface StreamViewerProps {
  socket: Socket | null;
  isStreaming: boolean;
  hasActiveStream: boolean;
  streamType?: string | null;
  forceViewerMode?: boolean;
  currentStreamerId?: string | null;  // CRITICAL: Pass streamerId to detect stream switches
  onStreamStart?: () => void;
  onStreamStop?: () => void;
  audioSettings?: AudioSettingsConfig;
  onAudioSettingsChange?: (settings: AudioSettingsConfig) => void;
  videoSettings?: VideoSettingsConfig;
  onVideoSettingsChange?: (settings: VideoSettingsConfig) => void;
  screenShareSettings?: ScreenShareSettingsConfig;
  isScreenSharing?: boolean;
  onScreenShareChange?: (isSharing: boolean) => void;
  onScreenShareMethodsReady?: (methods: { startScreenShare: () => void; stopScreenShare: () => void }) => void;
  landscapeMode?: boolean;
}

const StreamViewer: React.FC<StreamViewerProps> = ({
  socket,
  isStreaming,
  hasActiveStream,
  streamType,
  forceViewerMode = false,
  currentStreamerId,  // CRITICAL: Used to detect stream switches
  onStreamStart,
  onStreamStop,
  audioSettings,
  onAudioSettingsChange,
  videoSettings,
  onVideoSettingsChange,
  screenShareSettings,
  isScreenSharing = false,
  onScreenShareChange,
  onScreenShareMethodsReady,
  landscapeMode = false
}) => {
  const landscapeStyles: React.CSSProperties = landscapeMode ? {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    maxHeight: '100%',
    minHeight: 0,
    margin: 0,
    padding: 0,
    borderRadius: 0,
    aspectRatio: 'unset',
    overflow: 'hidden'
  } : {};

  if (!socket) {
    return (
      <div className="stream-viewer" style={landscapeStyles}>
        <div className="no-stream">
          <div className="no-stream-content">
            <h2>Connecting...</h2>
            <p>Establishing connection to server</p>
            <div className="placeholder-video">
              <div className="placeholder-icon">🔄</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stream-viewer" style={landscapeStyles}>
      {isStreaming && !forceViewerMode ? (
        <div className="streaming-view">
          <WebRTCStreamer
            socket={socket}
            isStreaming={isStreaming}
            onStreamStart={onStreamStart}
            onStreamStop={onStreamStop}
            audioSettings={audioSettings}
            onAudioSettingsChange={onAudioSettingsChange}
            videoSettings={videoSettings}
            onVideoSettingsChange={onVideoSettingsChange}
            screenShareSettings={screenShareSettings}
            isScreenSharing={isScreenSharing}
            onScreenShareChange={onScreenShareChange}
            onScreenShareMethodsReady={onScreenShareMethodsReady}
            className="webrtc-streamer-container"
          />
          <div className="streaming-indicator">
            <span className="live-badge">LIVE</span>
            <span>You are streaming</span>
          </div>
        </div>
      ) : (
        <div className="viewing-mode">
          {/* Always render WebRTCViewer to handle switching events */}
          {/* CRITICAL FIX: When forceViewerMode is true, isActive MUST be true regardless of isStreaming */}
          {/* This prevents the race condition where isStreaming hasn't updated yet */}
          <WebRTCViewer
            socket={socket}
            isActive={forceViewerMode || (hasActiveStream && !isStreaming)}
            className="webrtc-viewer-container"
            forceInitialize={forceViewerMode}
            currentStreamerId={currentStreamerId}  // CRITICAL: Pass streamerId for switch detection
          />
          {hasActiveStream || forceViewerMode ? (
            <div className="viewer-indicator">
              <span className="live-badge">LIVE</span>
              {streamType && (
                <span className="stream-type">{streamType.toUpperCase()}</span>
              )}
            </div>
          ) : (
            <div className="no-stream">
              <div className="no-stream-content">
                <h2>No Active Stream</h2>
                <p>Be the first to start streaming!</p>
                <div className="placeholder-video">
                  <div className="placeholder-icon">📹</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StreamViewer;