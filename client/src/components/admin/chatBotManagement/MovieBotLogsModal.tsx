import React from 'react';

interface MovieBotLogsModalProps {
  movieBotLogs: any[];
  closeMovieBotLogsModal: () => void;
}

const MovieBotLogsModal: React.FC<MovieBotLogsModalProps> = ({
  movieBotLogs,
  closeMovieBotLogsModal,
}) => {
  return (
    <div className="bot-form-overlay">
      <div className="moviebot-logs-modal">
        <div className="modal-header">
          <h3>🎬 MovieBot Live Prompt Logs</h3>
          <div className="modal-header-actions">
            <span className="live-indicator">🔴 Live Updates</span>
            <button onClick={closeMovieBotLogsModal} className="btn btn-secondary">× Close</button>
          </div>
        </div>
        <div className="logs-container">
          {movieBotLogs.length > 0 ? (
            movieBotLogs.slice().reverse().map((log: any, index: number) => (
              <div key={index} className="log-entry">
                <div className="log-header">
                  <span className="log-time">{new Date(log.timestamp).toLocaleString()}</span>
                  {log.bot && <span className="log-bot">🤖 {log.bot}</span>}
                  <span className="log-event">{log.event || 'PROMPT'}</span>
                </div>
                {log.transcription && (
                  <div className="log-section">
                    <strong>🎙️ Transcription ({log.transcription.length} chars):</strong>
                    <div className="transcription-text">{log.transcription}</div>
                  </div>
                )}
                {log.fullPrompt && (
                  <details className="prompt-details">
                    <summary>📋 Full Prompt ({log.promptLength || log.fullPrompt.length} chars)</summary>
                    <pre className="prompt-text">{log.fullPrompt}</pre>
                  </details>
                )}
                {log.data && log.event && (
                  <div className="log-section">
                    <strong>📄 Event Data:</strong>
                    <pre className="event-data">{JSON.stringify(log.data, null, 2)}</pre>
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="no-messages">
              <div className="loading-indicator">🔄 Waiting for MovieBot activity...</div>
              <div className="help-text">Logs will appear here when MovieBot starts processing transcriptions</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MovieBotLogsModal;
