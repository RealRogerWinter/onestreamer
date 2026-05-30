import React from 'react';
import { ChatBot, ChatBotFormData, PromptTemplate } from './types';

interface BotFormProps {
  editingBot: ChatBot | null;
  formData: ChatBotFormData;
  setFormData: React.Dispatch<React.SetStateAction<ChatBotFormData>>;
  currentModel: any;
  promptTemplates: PromptTemplate[];
  handleCreate: () => void;
  handleUpdate: () => void;
  setShowCreateForm: (show: boolean) => void;
  setEditingBot: (bot: ChatBot | null) => void;
  resetForm: () => void;
}

const BotForm: React.FC<BotFormProps> = ({
  editingBot,
  formData,
  setFormData,
  currentModel,
  promptTemplates,
  handleCreate,
  handleUpdate,
  setShowCreateForm,
  setEditingBot,
  resetForm,
}) => {
  return (
    <div className="bot-form-overlay">
      <div className="bot-form">
        <h3>
          {editingBot ? (
            <>
              Edit Chatbot
              {editingBot.is_temporary && (
                <span style={{
                  marginLeft: '10px',
                  fontSize: '0.8em',
                  color: '#9c27b0',
                  padding: '2px 8px',
                  background: 'rgba(156, 39, 176, 0.1)',
                  borderRadius: '4px'
                }}>
                  ✨ User-Summoned Bot
                </span>
              )}
            </>
          ) : 'Create New Chatbot'}
        </h3>

        {editingBot?.is_temporary && (
          <div style={{
            background: 'rgba(156, 39, 176, 0.1)',
            border: '1px solid rgba(156, 39, 176, 0.3)',
            borderRadius: '6px',
            padding: '12px',
            marginBottom: '20px'
          }}>
            <div style={{ marginBottom: '8px' }}>
              <strong>Summoned by:</strong> {editingBot.summoned_by || 'Unknown'}
            </div>
            <div style={{ marginBottom: '8px' }}>
              <strong>Time Remaining:</strong> {editingBot.time_remaining_display || 'Unknown'}
            </div>
            {editingBot.personality_prompt && (
              <div>
                <strong>User's Original Request:</strong> {editingBot.personality_prompt}
              </div>
            )}
          </div>
        )}

        <div className="form-group">
          <label>Name (leave empty for random)</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder="e.g., FriendlyBot or leave empty for Lion1234"
          />
        </div>

        <div className="form-group">
          <label>System Prompt</label>
          <div className="prompt-templates">
            {promptTemplates.map(template => (
              <button
                key={template.label}
                onClick={() => setFormData({ ...formData, prompt: template.prompt })}
                className="template-btn"
              >
                {template.label}
              </button>
            ))}
          </div>
          <textarea
            value={formData.prompt}
            onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
            rows={4}
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Min Response Interval (seconds)</label>
            <input
              type="number"
              value={formData.response_interval_min}
              onChange={(e) => setFormData({ ...formData, response_interval_min: parseInt(e.target.value) })}
              min="10"
              max="600"
            />
          </div>

          <div className="form-group">
            <label>Max Response Interval (seconds)</label>
            <input
              type="number"
              value={formData.response_interval_max}
              onChange={(e) => setFormData({ ...formData, response_interval_max: parseInt(e.target.value) })}
              min="10"
              max="600"
            />
          </div>
        </div>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={formData.show_robot_emoji}
              onChange={(e) => setFormData({ ...formData, show_robot_emoji: e.target.checked })}
            />
            Show robot emoji in chat
          </label>
        </div>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={formData.use_assigned_name}
              onChange={(e) => setFormData({ ...formData, use_assigned_name: e.target.checked })}
            />
            Use assigned name (unchecked = random animal name)
          </label>
        </div>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={formData.moviebot_enabled}
              onChange={(e) => setFormData({ ...formData, moviebot_enabled: e.target.checked })}
            />
            🎬 Enable MovieBot (bot will comment on film content)
          </label>
        </div>

        <div className="form-group">
          <label>LLM Model (Leave as "Global Default" to use system-wide model)</label>
          <select
            value={formData.llm_model || ''}
            onChange={(e) => setFormData({ ...formData, llm_model: e.target.value || null })}
            className="model-select"
          >
            <option value="">Global Default ({currentModel?.info.displayName || 'Loading...'})</option>
            <optgroup label="Ultra-Fast Models (< 1GB)">
              <option value="qwen2.5:0.5b">Qwen 2.5 0.5B - Ultra-lightweight (400 MB)</option>
              <option value="tinyllama">TinyLlama 1.1B - Extremely fast (700 MB)</option>
            </optgroup>
            <optgroup label="Fast Models (1-2GB)">
              <option value="llama3.2:1b">Llama 3.2 1B - Very fast (1.3 GB)</option>
              <option value="gemma2:2b">Gemma 2 2B - Google's efficient (1.6 GB)</option>
              <option value="deepseek-r1:1.5b">DeepSeek R1 1.5B - Reasoning-focused (1.0 GB)</option>
            </optgroup>
            <optgroup label="Balanced Models (2-4GB)">
              <option value="llama3.2:3b">Llama 3.2 3B - Balanced (2.0 GB)</option>
              <option value="phi3.5:3.8b">Phi 3.5 3.8B - Microsoft's efficient (2.2 GB)</option>
              <option value="codellama:7b">CodeLlama 7B - Code-specialized (3.8 GB)</option>
            </optgroup>
            <optgroup label="High-Quality Models (4-8GB)">
              <option value="mistral">Mistral 7B - High-quality (4.1 GB)</option>
              <option value="llama3.1:8b">Llama 3.1 8B - General purpose (4.7 GB)</option>
              <option value="qwen2.5:7b">Qwen 2.5 7B - Good reasoning (4.4 GB)</option>
              <option value="deepseek-r1:7b">DeepSeek R1 7B - Advanced reasoning (4.1 GB)</option>
            </optgroup>
            <optgroup label="Large Models (8GB+)">
              <option value="deepseek-r1:14b">DeepSeek R1 14B - Excellent performance (8.1 GB)</option>
              <option value="qwen2.5:14b">Qwen 2.5 14B - Strong reasoning (8.7 GB)</option>
              <option value="solar:10.7b">Solar 10.7B - Efficient mid-size (6.1 GB)</option>
              <option value="llama3.3:70b">Llama 3.3 70B - Large model (40 GB, requires significant VRAM)</option>
            </optgroup>
          </select>
          <small className="form-help">
            Different models have different personalities and response styles. Smaller models are faster but less sophisticated.
          </small>
        </div>

        <div className="form-group">
          <label>Personality Traits</label>
          <div className="traits-grid">
            <label>
              <input
                type="checkbox"
                checked={formData.personality_traits.enthusiasm}
                onChange={(e) => setFormData({
                  ...formData,
                  personality_traits: { ...formData.personality_traits, enthusiasm: e.target.checked }
                })}
              />
              Enthusiastic
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.personality_traits.casual}
                onChange={(e) => setFormData({
                  ...formData,
                  personality_traits: { ...formData.personality_traits, casual: e.target.checked }
                })}
              />
              Casual
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.personality_traits.supportive}
                onChange={(e) => setFormData({
                  ...formData,
                  personality_traits: { ...formData.personality_traits, supportive: e.target.checked }
                })}
              />
              Supportive
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.personality_traits.humorous}
                onChange={(e) => setFormData({
                  ...formData,
                  personality_traits: { ...formData.personality_traits, humorous: e.target.checked }
                })}
              />
              Humorous
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.personality_traits.curious}
                onChange={(e) => setFormData({
                  ...formData,
                  personality_traits: { ...formData.personality_traits, curious: e.target.checked }
                })}
              />
              Curious
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>Response Creativity (Temperature: {formData.personality_traits.temperature})</label>
          <input
            type="range"
            min="0.1"
            max="1.0"
            step="0.1"
            value={formData.personality_traits.temperature}
            onChange={(e) => setFormData({
              ...formData,
              personality_traits: { ...formData.personality_traits, temperature: parseFloat(e.target.value) }
            })}
          />
          <div className="temperature-labels">
            <span>Conservative</span>
            <span>Balanced</span>
            <span>Creative</span>
          </div>
        </div>

        <div className="form-actions">
          <button
            onClick={editingBot ? handleUpdate : handleCreate}
            className="btn btn-primary"
          >
            {editingBot ? 'Update' : 'Create'}
          </button>
          <button
            onClick={() => {
              setShowCreateForm(false);
              setEditingBot(null);
              resetForm();
            }}
            className="btn"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default BotForm;
