import React, { useState, useEffect } from 'react';
import './TTSInputModal.css';

interface Voice {
  id: string;
  name: string;
  gender: string;
  description: string;
}

interface TTSInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (text: string, voiceId: string) => void;
  itemId: number;
  itemName: string;
  itemEmoji: string;
}

const TTSInputModal: React.FC<TTSInputModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  itemId,
  itemName,
  itemEmoji
}) => {
  const [text, setText] = useState('');
  const [voiceId, setVoiceId] = useState('alloy');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [charCount, setCharCount] = useState(0);
  const maxChars = 200;

  useEffect(() => {
    if (isOpen) {
      fetchVoices();
      setText('');
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    setCharCount(text.length);
  }, [text]);

  const fetchVoices = async () => {
    try {
      const response = await fetch('/api/soundfx/voices');
      if (!response.ok) throw new Error('Failed to fetch voices');
      const data = await response.json();
      setVoices(data);
    } catch (err) {
      console.error('Error fetching voices:', err);
      // Use default voices as fallback
      setVoices([
        { id: 'alloy', name: 'Alloy', gender: 'neutral', description: 'Neutral, professional voice' },
        { id: 'echo', name: 'Echo', gender: 'male', description: 'Male, warm voice' },
        { id: 'fable', name: 'Fable', gender: 'neutral', description: 'British accent' },
        { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Deep male voice' },
        { id: 'nova', name: 'Nova', gender: 'female', description: 'Female, energetic voice' },
        { id: 'shimmer', name: 'Shimmer', gender: 'female', description: 'Soft female voice' }
      ]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!text.trim()) {
      setError('Please enter a message');
      return;
    }

    if (text.length > maxChars) {
      setError(`Message is too long (max ${maxChars} characters)`);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await onSubmit(text.trim(), voiceId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to send TTS message');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    if (newText.length <= maxChars) {
      setText(newText);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="tts-modal-overlay" onClick={onClose}>
      <div className="tts-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="tts-modal-header">
          <h2>
            <span className="tts-item-emoji">{itemEmoji}</span>
            {itemName}
          </h2>
          <button className="tts-modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="tts-modal-form">
          <div className="tts-form-group">
            <label htmlFor="tts-text">Message</label>
            <textarea
              id="tts-text"
              value={text}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder="Enter your message (max 200 characters)"
              rows={4}
              disabled={isLoading}
              autoFocus
            />
            <div className={`tts-char-count ${charCount > maxChars * 0.9 ? 'warning' : ''}`}>
              {charCount}/{maxChars}
            </div>
          </div>

          <div className="tts-form-group">
            <label htmlFor="tts-voice">Voice</label>
            <select
              id="tts-voice"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              disabled={isLoading}
            >
              {voices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} - {voice.description}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="tts-error-message">
              {error}
            </div>
          )}

          <div className="tts-modal-actions">
            <button
              type="button"
              className="tts-btn tts-btn-cancel"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="tts-btn tts-btn-submit"
              disabled={isLoading || !text.trim()}
            >
              {isLoading ? 'Sending...' : 'Send TTS'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TTSInputModal;