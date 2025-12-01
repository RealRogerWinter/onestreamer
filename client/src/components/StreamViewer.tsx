import React from 'react';
import WebRTCViewer from './WebRTCViewer';
import WebRTCStreamer from './WebRTCStreamer';
import { Socket } from 'socket.io-client';
import { AudioSettingsConfig, VideoSettingsConfig } from './StreamerSettings';
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
  onVideoSettingsChange
}) => {
  if (!socket) {
    return (
      <div className="stream-viewer">
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
    <div className="stream-viewer">
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
          <WebRTCViewer
            socket={socket}
            isActive={(hasActiveStream || forceViewerMode) && !isStreaming}
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