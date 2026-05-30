import React from 'react';
import { MovieBotStatus } from './types';

interface MovieBotSectionProps {
  movieBotStatus: MovieBotStatus | null;
  transcriptionDuration: number;
  setTranscriptionDuration: (value: number) => void;
  transcriptionFrequency: number;
  setTranscriptionFrequency: (value: number) => void;
  groqEnabled: boolean;
  setGroqEnabled: (value: boolean) => void;
  groqApiKey: string;
  setGroqApiKey: (value: string) => void;
  groqModel: string;
  setGroqModel: (value: string) => void;
  groqModels: any[];
  updateMovieBotConfig: (key: string, value: number | boolean | string) => void;
  updateGroqConfig: (enabled: boolean, apiKey?: string, model?: string) => void;
  enableMovieBot: () => void;
  disableMovieBot: () => void;
  openMovieBotLogsModal: () => void;
  addLog: (message: string) => void;
}

const MovieBotSection: React.FC<MovieBotSectionProps> = ({
  movieBotStatus,
  transcriptionDuration,
  setTranscriptionDuration,
  transcriptionFrequency,
  setTranscriptionFrequency,
  groqEnabled,
  setGroqEnabled,
  groqApiKey,
  setGroqApiKey,
  groqModel,
  setGroqModel,
  groqModels,
  updateMovieBotConfig,
  updateGroqConfig,
  enableMovieBot,
  disableMovieBot,
  openMovieBotLogsModal,
  addLog,
}) => {
  return (
    <div className="moviebot-section">
      <h3>🎬 MovieBot - AI Film Commentary</h3>
      <div className="moviebot-controls">
        <div className="moviebot-status">
          <div className="status-item">
            <strong>Status:</strong>
            <span className={`status-badge ${movieBotStatus?.enabled ? 'active' : 'inactive'}`}>
              {movieBotStatus?.enabled ? '● Enabled' : '○ Disabled'}
            </span>
          </div>
          {movieBotStatus?.isActive && (
            <>
              <div className="status-item">
                <strong>Current Stream:</strong> {movieBotStatus.currentStreamerId || 'None'}
              </div>
              <div className="status-item">
                <strong>Transcription:</strong> {movieBotStatus.config.transcriptionDuration}s chunks
              </div>
              <div className="status-item">
                <strong>Interval:</strong> {Math.floor(movieBotStatus.config.minInterval / 1000)}-{Math.floor(movieBotStatus.config.maxInterval / 1000)}s
              </div>
            </>
          )}
        </div>

        {/* MovieBot Timing Configuration */}
        <div className="moviebot-config">
          <h4>Timing Configuration</h4>
          <div className="config-grid">
            <div className="config-item">
              <label>Transcription Duration:</label>
              <input
                type="number"
                min="10"
                max="120"
                value={transcriptionDuration}
                onChange={(e) => {
                  setTranscriptionDuration(parseInt(e.target.value) || 45);
                }}
                onBlur={(e) => {
                  const value = parseInt(e.target.value) || 45;
                  setTranscriptionDuration(value);
                  updateMovieBotConfig('transcriptionDuration', value);
                }}
                className="config-input"
              />
              <small>How long to record audio (seconds)</small>
            </div>

            <div className="config-item">
              <label>Transcription Frequency:</label>
              <input
                type="number"
                min="30"
                max="600"
                value={transcriptionFrequency}
                onChange={(e) => {
                  setTranscriptionFrequency(parseInt(e.target.value) || 120);
                }}
                onBlur={(e) => {
                  const value = parseInt(e.target.value) || 120;
                  setTranscriptionFrequency(value);
                  updateMovieBotConfig('transcriptionFrequency', value);
                }}
                className="config-input"
              />
              <small>How often to run transcriptions (seconds)</small>
            </div>

            <div className="config-item" style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input
                  type="checkbox"
                  checked={groqEnabled}
                  onChange={(e) => {
                    const newValue = e.target.checked;
                    // console.log('Global Groq checkbox clicked:', newValue);
                    setGroqEnabled(newValue);
                    localStorage.setItem('groqEnabled', String(newValue));
                    // Update global Groq settings for ALL chatbots
                    updateGroqConfig(newValue);
                  }}
                  style={{ width: 'auto' }}
                />
                Use Groq API for ALL Chatbots (Ultra-Fast Responses)
              </label>
              <small>Enable Groq API globally for ALL chatbots and MovieBots - ~500ms response times instead of 10-30s with local models</small>

              <div style={{ marginTop: '10px' }}>
                <label>Groq API Key:</label>
                <input
                  type="password"
                  placeholder="gsk_..."
                  value={groqApiKey}
                  onChange={(e) => {
                    const newKey = e.target.value;
                    setGroqApiKey(newKey);
                    // Store in localStorage for persistence
                    localStorage.setItem('groqApiKey', newKey);
                  }}
                  onBlur={(e) => {
                    // Send to server when user finishes typing (on blur)
                    const key = e.target.value;
                    if (key && key.startsWith('gsk_')) {
                      // console.log('Sending Groq API key globally...');
                      updateGroqConfig(groqEnabled, key, groqModel);
                    } else if (key) {
                      console.error('Invalid Groq API key format - should start with gsk_');
                      addLog('Invalid Groq API key format - should start with gsk_');
                    }
                  }}
                  className="config-input"
                  style={{ width: '100%', opacity: groqEnabled ? 1 : 0.5 }}
                  disabled={!groqEnabled}
                />
                <small>Get your API key from <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">console.groq.com/keys</a></small>

                {/* Groq Model Selection */}
                {groqEnabled && (
                  <div style={{ marginTop: '15px' }}>
                    <label>Groq Model:</label>
                    <select
                      value={groqModel}
                      onChange={(e) => {
                        const newModel = e.target.value;
                        setGroqModel(newModel);
                        // console.log('Groq model changed to:', newModel);
                        updateGroqConfig(true, undefined, newModel);
                      }}
                      className="config-input"
                      style={{ width: '100%' }}
                    >
                      {groqModels.map(model => (
                        <option key={model.id} value={model.id}>
                          {model.name} - {model.speed} ({model.contextWindow} tokens)
                        </option>
                      ))}
                    </select>
                    <small style={{ display: 'block', marginTop: '5px' }}>
                      {groqModels.find(m => m.id === groqModel)?.description || ''}
                    </small>
                  </div>
                )}

                {groqEnabled && groqApiKey && (
                  <button
                    className="btn btn-primary btn-small"
                    onClick={() => {
                      // console.log('Saving Groq API key globally...');
                      updateGroqConfig(true, groqApiKey);
                      addLog('Groq API key saved globally for ALL chatbots');
                    }}
                    style={{ marginTop: '10px', display: 'block' }}
                  >
                    Save API Key Globally
                  </button>
                )}
                {!groqEnabled && (
                  <small style={{ color: '#ff9800', display: 'block', marginTop: '5px' }}>
                    ⚠️ Check "Use Groq API" above to enable this field
                  </small>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="moviebot-actions">
          {!movieBotStatus?.enabled ? (
            <button
              className="btn btn-primary"
              onClick={enableMovieBot}
            >
              🎬 Enable MovieBot
            </button>
          ) : (
            <button
              className="btn btn-danger"
              onClick={disableMovieBot}
            >
              ⏹️ Disable MovieBot
            </button>
          )}

          <button
            className="btn btn-secondary"
            onClick={openMovieBotLogsModal}
          >
            📋 View Live Prompt Logs
          </button>
        </div>

        <div className="moviebot-description">
          <small>
            When enabled, MovieBot will periodically transcribe 10-second chunks of the stream audio
            and use them to generate contextual commentary from your chatbots about what's happening in the film.
            Bots will respond to the film content and incorporate chat reactions.
          </small>
        </div>
      </div>
    </div>
  );
};

export default MovieBotSection;
