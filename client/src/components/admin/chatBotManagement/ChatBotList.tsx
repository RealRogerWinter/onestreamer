import React from 'react';
import { ChatBot } from './types';

interface ChatBotListProps {
  chatbots: ChatBot[];
  togglingAll: boolean;
  editingTimeRemaining: { [key: number]: string };
  setEditingTimeRemaining: (value: { [key: number]: string }) => void;
  setShowCreateForm: (show: boolean) => void;
  handleEnableAll: () => void;
  handleDisableAll: () => void;
  handleExtendTime: (botId: number, additionalMinutes: number) => void;
  handleToggle: (id: number) => void;
  handleToggleMovieBot: (id: number) => void;
  handleSendMessage: (id: number, customMessage?: string) => void;
  handleTest: (id: number) => void;
  handleDelete: (id: number) => void;
  startEdit: (bot: ChatBot) => void;
  fetchBotHistory: (botId: number) => void;
  formatMessageTime: (timestamp: string) => string;
}

const ChatBotList: React.FC<ChatBotListProps> = ({
  chatbots,
  togglingAll,
  editingTimeRemaining,
  setEditingTimeRemaining,
  setShowCreateForm,
  handleEnableAll,
  handleDisableAll,
  handleExtendTime,
  handleToggle,
  handleToggleMovieBot,
  handleSendMessage,
  handleTest,
  handleDelete,
  startEdit,
  fetchBotHistory,
  formatMessageTime,
}) => {
  return (
    <div className="chatbot-list">
      <div className="list-header">
        <h3>Chatbots ({chatbots.length})</h3>
        <div className="header-controls">
          <div className="toggle-all-controls">
            <button
              className="btn btn-secondary"
              onClick={handleEnableAll}
              disabled={togglingAll}
              title="Enable all chatbots"
            >
              {togglingAll ? 'Processing...' : '✅ Enable All'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleDisableAll}
              disabled={togglingAll}
              title="Disable all chatbots"
            >
              {togglingAll ? 'Processing...' : '❌ Disable All'}
            </button>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setShowCreateForm(true)}
          >
            + Create New Bot
          </button>
        </div>
      </div>

      {/* User-Summoned Bots Section */}
      {chatbots.filter(bot => bot.is_temporary).length > 0 && (
        <>
          <div className="section-header" style={{ marginTop: '30px', marginBottom: '20px' }}>
            <h3 style={{ color: '#9c27b0', display: 'flex', alignItems: 'center', gap: '10px' }}>
              🤖 User-Summoned Bots
              <span style={{ fontSize: '0.8em', color: 'rgba(255, 255, 255, 0.6)' }}>
                ({chatbots.filter(bot => bot.is_temporary).length} active)
              </span>
            </h3>
          </div>
          <div className="bots-grid">
            {chatbots.filter(bot => bot.is_temporary).map(bot => (
              <div key={bot.id} className={`bot-card ${bot.is_enabled ? 'enabled' : 'disabled'}`}
                   style={{ borderColor: '#9c27b0', borderWidth: '2px' }}>
                <div className="bot-header">
                  <span className="bot-name">
                    {bot.show_robot_emoji && '🤖 '}{bot.name}
                    <span style={{ marginLeft: '8px', fontSize: '0.8em', color: '#9c27b0' }}>✨ Summoned</span>
                  </span>
                  <span className={`status-badge ${bot.is_connected ? 'connected' : 'disconnected'}`}>
                    {bot.is_connected ? '● Connected' : '○ Disconnected'}
                  </span>
                </div>

                <div className="bot-info">
                  <div className="info-row" style={{ color: '#9c27b0', fontWeight: 'bold' }}>
                    <span>⏱️ Time Remaining:</span>
                    {editingTimeRemaining[bot.id] !== undefined ? (
                      <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                        <input
                          type="number"
                          value={editingTimeRemaining[bot.id]}
                          onChange={(e) => setEditingTimeRemaining({...editingTimeRemaining, [bot.id]: e.target.value})}
                          style={{ width: '60px', padding: '2px 5px' }}
                          placeholder="Minutes"
                        />
                        <span>min</span>
                        <button
                          onClick={() => handleExtendTime(bot.id, parseInt(editingTimeRemaining[bot.id]))}
                          style={{ padding: '2px 8px', fontSize: '0.8em' }}
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => {
                            const newEditing = {...editingTimeRemaining};
                            delete newEditing[bot.id];
                            setEditingTimeRemaining(newEditing);
                          }}
                          style={{ padding: '2px 8px', fontSize: '0.8em' }}
                        >
                          ✗
                        </button>
                      </div>
                    ) : (
                      <span
                        onClick={() => setEditingTimeRemaining({...editingTimeRemaining, [bot.id]: '60'})}
                        style={{ cursor: 'pointer', textDecoration: 'underline' }}
                        title="Click to edit time"
                      >
                        {bot.time_remaining_display || 'Unknown'}
                      </span>
                    )}
                  </div>
                  <div className="info-row">
                    <span>Summoned by:</span>
                    <span>{bot.summoned_by || 'Unknown'}</span>
                  </div>
                  <div className="info-row">
                    <span>Status:</span>
                    <span>{bot.is_enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                </div>

                {bot.personality_prompt && (
                  <div className="bot-prompt" style={{ borderTop: '1px solid rgba(156, 39, 176, 0.2)', paddingTop: '10px', marginTop: '10px' }}>
                    <strong style={{ color: '#9c27b0' }}>User's Personality Request:</strong> {bot.personality_prompt}
                  </div>
                )}

                <div className="bot-prompt" style={{ marginTop: '10px' }}>
                  <strong style={{ color: '#9c27b0' }}>Full System Prompt:</strong>
                  <div style={{ marginTop: '5px', padding: '10px', background: 'rgba(156, 39, 176, 0.05)', borderRadius: '4px', fontSize: '0.9em' }}>
                    {bot.prompt || 'No prompt configured'}
                  </div>
                </div>

                {bot.last_message && (
                  <div className="bot-last-message">
                    <div className="last-message-header">
                      <span className="last-message-label">Last message:</span>
                      {bot.last_message_at && (
                        <span className="last-message-time">
                          {formatMessageTime(bot.last_message_at)}
                        </span>
                      )}
                    </div>
                    <div className="last-message-text">{bot.last_message}</div>
                  </div>
                )}

                <div className="bot-actions">
                  <button
                    className={`btn ${bot.is_enabled ? 'btn-warning' : 'btn-success'}`}
                    onClick={() => handleToggle(bot.id)}
                  >
                    {bot.is_enabled ? '⏸️ Disable' : '▶️ Enable'}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => startEdit(bot)}
                  >
                    ✏️ Edit
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => handleTest(bot.id)}
                  >
                    🧪 Test
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => handleDelete(bot.id)}
                    title="Delete this temporary bot immediately"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Regular Bots Section */}
      {chatbots.filter(bot => !bot.is_temporary).length > 0 && (
        <>
          <div className="section-header" style={{ marginTop: '30px', marginBottom: '20px' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              🤖 System Bots
              <span style={{ fontSize: '0.8em', color: 'rgba(255, 255, 255, 0.6)' }}>
                ({chatbots.filter(bot => !bot.is_temporary).length} total)
              </span>
            </h3>
          </div>
          <div className="bots-grid">
            {chatbots.filter(bot => !bot.is_temporary).map(bot => (
          <div key={bot.id} className={`bot-card ${bot.is_enabled ? 'enabled' : 'disabled'}`}>
            <div className="bot-header">
              <span className="bot-name">
                {bot.show_robot_emoji && '🤖 '}{bot.name}
                {!bot.use_assigned_name && <span className="name-mode"> (random)</span>}
              </span>
              <span className={`status-badge ${bot.is_connected ? 'connected' : 'disconnected'}`}>
                {bot.is_connected ? '● Connected' : '○ Disconnected'}
              </span>
            </div>

            <div className="bot-info">
              <div className="info-row">
                <span>Response interval:</span>
                <span>{bot.response_interval_min}-{bot.response_interval_max}s</span>
              </div>
              <div className="info-row">
                <span>Status:</span>
                <span>{bot.is_enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div className="info-row">
                <span>Model:</span>
                <span className="model-badge">{bot.llm_model || 'Global Default'}</span>
              </div>
              {bot.moviebot_enabled && (
                <div className="info-row">
                  <span>🎬 MovieBot:</span>
                  <span style={{color: '#4CAF50'}}>ACTIVE</span>
                </div>
              )}
            </div>

            {bot.last_message && (
              <div className="bot-last-message">
                <div className="last-message-header">
                  <span className="last-message-label">Last message:</span>
                  {bot.last_message_at && (
                    <span className="last-message-time">
                      {formatMessageTime(bot.last_message_at)}
                    </span>
                  )}
                </div>
                <div className="last-message-text">{bot.last_message}</div>
              </div>
            )}

            <div className="bot-prompt">{bot.prompt.substring(0, 100)}...</div>

            <div className="bot-traits">
              {bot.personality_traits?.enthusiasm && <span className="trait">Enthusiastic</span>}
              {bot.personality_traits?.casual && <span className="trait">Casual</span>}
              {bot.personality_traits?.supportive && <span className="trait">Supportive</span>}
              {bot.personality_traits?.humorous && <span className="trait">Humorous</span>}
              {bot.personality_traits?.curious && <span className="trait">Curious</span>}
            </div>

            <div className="bot-actions">
              <button onClick={() => handleToggle(bot.id)} className="btn btn-small">
                {bot.is_enabled ? 'Disable' : 'Enable'}
              </button>
              <button onClick={() => handleToggleMovieBot(bot.id)} className={`btn btn-small ${bot.moviebot_enabled ? 'btn-secondary' : ''}`}>
                🎬 {bot.moviebot_enabled ? 'MovieBot ON' : 'MovieBot OFF'}
              </button>
              <button onClick={() => handleSendMessage(bot.id)} className="btn btn-small btn-primary">
                📤 Send
              </button>
              <button onClick={() => handleTest(bot.id)} className="btn btn-small">Test</button>
              <button onClick={() => startEdit(bot)} className="btn btn-small">Edit</button>
              <button onClick={() => fetchBotHistory(bot.id)} className="btn btn-small">History</button>
              <button onClick={() => handleDelete(bot.id)} className="btn btn-small btn-danger">Delete</button>
            </div>
          </div>
        ))}
          </div>
        </>
      )}
    </div>
  );
};

export default ChatBotList;
