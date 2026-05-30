import React from 'react';

interface HistoryModalProps {
  selectedBotHistory: { botId: number; messages: any[] };
  setSelectedBotHistory: (value: { botId: number; messages: any[] } | null) => void;
}

const HistoryModal: React.FC<HistoryModalProps> = ({
  selectedBotHistory,
  setSelectedBotHistory,
}) => {
  return (
    <div className="history-overlay">
      <div className="history-modal">
        <h3>Message History & Prompt Logs</h3>
        <div className="history-messages">
          {selectedBotHistory.messages.map(msg => (
            <div key={msg.id} className="history-message">
              <div className="message-header">
                <span className="history-time">
                  {new Date(msg.created_at).toLocaleString()}
                </span>
              </div>
              <div className="message-content">
                <div className="response-section">
                  <strong>Response:</strong> {msg.message}
                </div>
                {msg.exact_prompt && (
                  <details className="prompt-details" open>
                    <summary>Exact Prompt Sent to Model</summary>
                    <pre className="prompt-text">{msg.exact_prompt}</pre>
                  </details>
                )}
                {msg.context && (
                  <details className="prompt-details">
                    <summary>Chat Context</summary>
                    <pre className="prompt-text">{JSON.stringify(JSON.parse(msg.context), null, 2)}</pre>
                  </details>
                )}
              </div>
            </div>
          ))}
          {selectedBotHistory.messages.length === 0 && (
            <div className="no-messages">No message history found for this bot.</div>
          )}
        </div>
        <button onClick={() => setSelectedBotHistory(null)} className="btn">Close</button>
      </div>
    </div>
  );
};

export default HistoryModal;
