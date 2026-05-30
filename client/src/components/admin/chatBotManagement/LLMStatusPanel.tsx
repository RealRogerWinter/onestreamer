import React from 'react';

interface LLMStatusPanelProps {
  llmStatus: { available: boolean; model: string; host: string } | null;
}

const LLMStatusPanel: React.FC<LLMStatusPanelProps> = ({ llmStatus }) => {
  return (
    <div className="llm-status">
      <h3>LLM Status</h3>
      {llmStatus ? (
        <div className={`status-indicator ${llmStatus.available ? 'available' : 'unavailable'}`}>
          <span className="status-dot"></span>
          <span>{llmStatus.available ? 'Connected' : 'Not Available'}</span>
          <span className="model-info">Model: {llmStatus.model}</span>
        </div>
      ) : (
        <div>Checking...</div>
      )}
      {!llmStatus?.available && (
        <div className="llm-warning">
          ⚠️ Cannot detect Ollama from browser (CORS restriction).
          <br />
          Check server logs for: "✅ ChatBot LLM: Connected to Ollama with model mistral"
          <br />
          If not connected, run: <code>ollama serve</code> then restart the server.
        </div>
      )}
    </div>
  );
};

export default LLMStatusPanel;
