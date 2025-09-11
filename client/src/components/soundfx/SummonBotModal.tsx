import React, { useState, useEffect } from 'react';
import './SummonBotModal.css';

interface SummonBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (botName: string, personalityPrompt: string) => Promise<void>;
  itemName: string;
  itemEmoji: string;
}

const SummonBotModal: React.FC<SummonBotModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  itemName,
  itemEmoji
}) => {
  const [botName, setBotName] = useState('');
  const [personalityPrompt, setPersonalityPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setBotName('');
      setPersonalityPrompt('');
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Basic validation
    if (!botName.trim()) {
      setError('Bot name is required');
      return;
    }
    
    if (botName.trim().length < 2) {
      setError('Bot name must be at least 2 characters');
      return;
    }
    
    if (botName.trim().length > 30) {
      setError('Bot name must be 30 characters or less');
      return;
    }
    
    if (!personalityPrompt.trim()) {
      setError('Personality description is required');
      return;
    }
    
    if (personalityPrompt.trim().length < 10) {
      setError('Personality must be at least 10 characters');
      return;
    }
    
    if (personalityPrompt.trim().length > 200) {
      setError('Personality must be 200 characters or less');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onSubmit(botName.trim(), personalityPrompt.trim());
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to summon bot');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      onClose();
    }
  };

  const getCharCountClass = (length: number, max: number) => {
    const percentage = (length / max) * 100;
    if (percentage >= 90) return 'summon-bot-char-count error';
    if (percentage >= 75) return 'summon-bot-char-count warning';
    return 'summon-bot-char-count';
  };

  return (
    <div className="summon-bot-modal-overlay" onClick={handleClose}>
      <div className="summon-bot-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="summon-bot-modal-header">
          <h2>
            <span className="summon-bot-item-emoji">{itemEmoji}</span>
            {itemName}
          </h2>
          <button className="summon-bot-modal-close" onClick={handleClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="summon-bot-modal-form">
          <div className="summon-bot-form-group">
            <label htmlFor="bot-name">Bot Name</label>
            <input
              id="bot-name"
              type="text"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              placeholder="Enter a creative name for your bot"
              maxLength={30}
              disabled={isSubmitting}
              autoFocus
            />
            <div className={getCharCountClass(botName.length, 30)}>
              {botName.length}/30 characters
            </div>
          </div>

          <div className="summon-bot-form-group">
            <label htmlFor="personality">Personality Description</label>
            <textarea
              id="personality"
              value={personalityPrompt}
              onChange={(e) => setPersonalityPrompt(e.target.value)}
              placeholder="Describe your bot's personality, interests, and how it should behave in chat..."
              maxLength={200}
              rows={4}
              disabled={isSubmitting}
            />
            <div className={getCharCountClass(personalityPrompt.length, 200)}>
              {personalityPrompt.length}/200 characters
            </div>
          </div>

          <div className="summon-bot-info-box">
            <p>🤖 Your bot will join the chat for 1 hour</p>
            <p>💬 It will respond based on your personality description</p>
            <p>⏰ 1 hour cooldown between summons</p>
            <p>🔒 Content must be appropriate and respectful</p>
          </div>

          {error && (
            <div className="summon-bot-error-message">
              {error}
            </div>
          )}

          <div className="summon-bot-modal-actions">
            <button
              type="button"
              className="summon-bot-btn summon-bot-btn-cancel"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="summon-bot-btn summon-bot-btn-submit"
              disabled={isSubmitting || !botName.trim() || !personalityPrompt.trim()}
            >
              {isSubmitting ? (
                <>
                  <div className="summon-bot-spinner" />
                  Summoning...
                </>
              ) : (
                <>
                  🤖 Summon Bot
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SummonBotModal;