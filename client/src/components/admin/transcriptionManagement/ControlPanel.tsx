import React from 'react';
import { TranscriptionConfig } from './types';

interface ControlPanelProps {
  config: TranscriptionConfig;
  setConfig: React.Dispatch<React.SetStateAction<TranscriptionConfig>>;
  hasActiveStream: boolean;
  isLoading: boolean;
  isRecording: boolean;
  recordingTimeLeft: number;
  currentSessionId: string | null;
  applySettings: () => void;
  startTranscription: () => void;
  stopTranscription: () => void;
}

const ControlPanel: React.FC<ControlPanelProps> = ({
  config,
  setConfig,
  hasActiveStream,
  isLoading,
  isRecording,
  recordingTimeLeft,
  currentSessionId,
  applySettings,
  startTranscription,
  stopTranscription,
}) => {
  return (
    <div className="transcription-control">
      <h4>Control Panel</h4>

      <div className="control-group">
        <label>
          <input
            type="checkbox"
            checked={config.enableTranscription}
            onChange={(e) => setConfig({...config, enableTranscription: e.target.checked})}
          />
          Enable Transcription System
        </label>
      </div>

      <div className="control-group">
        <label>
          <input
            type="checkbox"
            checked={config.autoStart}
            onChange={(e) => setConfig({...config, autoStart: e.target.checked})}
            disabled={!config.enableTranscription}
          />
          Auto-Start on Stream
        </label>
        <span className="help-text">Automatically start transcription when a stream begins</span>
      </div>

      <div className="control-group">
        <label>Whisper Model</label>
        <div className="model-display">
          <strong>Base Model (142 MB)</strong>
          <span className="model-description">Balanced speed and accuracy</span>
        </div>
      </div>

      <div className="control-group">
        <label>Language</label>
        <select
          value={config.language}
          onChange={(e) => setConfig({...config, language: e.target.value})}
        >
          <option value="auto">Auto-detect</option>
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="it">Italian</option>
          <option value="pt">Portuguese</option>
          <option value="ru">Russian</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="zh">Chinese</option>
        </select>
      </div>

      <div className="control-group">
        <label>Advanced Settings</label>
        <div className="advanced-settings">
          <div className="setting-item">
            <label>Processing Interval</label>
            <select
              value={config.chunkDuration}
              onChange={(e) => setConfig({...config, chunkDuration: parseInt(e.target.value)})}
              disabled={!config.enableTranscription}
            >
              <option value="3000">3 seconds</option>
              <option value="5000">5 seconds (recommended)</option>
              <option value="10000">10 seconds</option>
            </select>
          </div>
          <div className="setting-item">
            <label>Buffer Duration</label>
            <select
              value={config.bufferDuration}
              onChange={(e) => setConfig({...config, bufferDuration: parseInt(e.target.value)})}
              disabled={!config.enableTranscription}
            >
              <option value="30">30 seconds</option>
              <option value="60">60 seconds (recommended)</option>
              <option value="120">120 seconds</option>
            </select>
          </div>
        </div>
      </div>

      <div className="control-group">
        <label>System Status</label>
        <div className="stream-status">
          {hasActiveStream ? (
            <span className="status-indicator active">● Stream Active</span>
          ) : (
            <span className="status-indicator inactive">● No Active Stream</span>
          )}
          {config.enableTranscription ? (
            <span className="status-indicator active">● System Enabled</span>
          ) : (
            <span className="status-indicator inactive">● System Disabled</span>
          )}
        </div>
      </div>

      <div className="button-group">
        <button
          className="btn btn-primary"
          onClick={applySettings}
          disabled={isLoading || isRecording}
        >
          Apply Settings
        </button>
      </div>

      <div className="transcription-action-section">
        <div className="section-divider"></div>
        <h5>Transcription Control</h5>
        {isRecording ? (
          <div className="recording-status">
            <div className="recording-indicator">
              <span className="recording-dot"></span>
              Recording... {recordingTimeLeft}s remaining
            </div>
            <div className="recording-progress">
              <div
                className="recording-progress-bar"
                style={{ width: `${((config.bufferDuration - recordingTimeLeft) / config.bufferDuration) * 100}%` }}
              ></div>
            </div>
            <button
              className="btn btn-danger"
              onClick={stopTranscription}
              disabled={isLoading}
            >
              Stop Early
            </button>
          </div>
        ) : (
          <>
            <p className="help-text">
              Record and transcribe the next {config.bufferDuration} seconds of audio
            </p>
            <button
              className="btn btn-transcribe"
              onClick={startTranscription}
              disabled={isLoading || !hasActiveStream || !!currentSessionId}
            >
              {isLoading ? 'Starting...' : `Record & Transcribe Next ${config.bufferDuration}s`}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default ControlPanel;
