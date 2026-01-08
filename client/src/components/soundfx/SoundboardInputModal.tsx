import React, { useState, useEffect } from 'react';
import './SoundboardInputModal.css';

interface SoundboardInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (soundUrl: string) => void;
  itemId: number;
  itemName: string;
  itemEmoji: string;
}

const SoundboardInputModal: React.FC<SoundboardInputModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  itemId,
  itemName,
  itemEmoji
}) => {
  const [soundUrl, setSoundUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isValidUrl, setIsValidUrl] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSoundUrl('');
      setError(null);
      setIsValidUrl(false);
    }
  }, [isOpen]);

  useEffect(() => {
    // Validate URL as user types
    if (soundUrl.trim()) {
      const isValid = validateSoundboardUrl(soundUrl);
      setIsValidUrl(isValid);
      if (!isValid && soundUrl.length > 10) {
        setError('Please enter a valid 101soundboards.com URL (e.g., https://www.101soundboards.com/sounds/12345-sound-name)');
      } else {
        setError(null);
      }
    } else {
      setIsValidUrl(false);
      setError(null);
    }
  }, [soundUrl]);

  const validateSoundboardUrl = (url: string): boolean => {
    // Accept various formats:
    // - Full URL: https://www.101soundboards.com/sounds/12345-sound-name
    // - Without protocol: www.101soundboards.com/sounds/12345-sound-name
    // - Without www: 101soundboards.com/sounds/12345-sound-name
    // - Just the path: /sounds/12345-sound-name
    const patterns = [
      /^https?:\/\/(www\.)?101soundboards\.com\/sounds\/\d+/,
      /^(www\.)?101soundboards\.com\/sounds\/\d+/,
      /^\/sounds\/\d+/,
    ];
    
    return patterns.some(pattern => pattern.test(url));
  };

  const normalizeSoundboardUrl = (url: string): string => {
    // If it's just a path, prepend the domain
    if (url.startsWith('/sounds/')) {
      return `https://www.101soundboards.com${url}`;
    }
    // If it doesn't have protocol, add it
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return `https://${url}`;
    }
    return url;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!soundUrl.trim()) {
      setError('Please enter a 101soundboards URL');
      return;
    }

    if (!isValidUrl) {
      setError('Invalid 101soundboards URL format');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const normalizedUrl = normalizeSoundboardUrl(soundUrl.trim());
      await onSubmit(normalizedUrl);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to play soundboard');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    // Auto-validate on paste
    const target = e.currentTarget;
    setTimeout(() => {
      if (target) {
        const pastedText = target.value;
        if (validateSoundboardUrl(pastedText)) {
          setError(null);
        }
      }
    }, 0);
  };

  if (!isOpen) return null;

  return (
    <div className="soundboard-modal-overlay" onClick={onClose}>
      <div className="soundboard-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="soundboard-modal-header">
          <h2>
            <span className="soundboard-item-emoji">{itemEmoji}</span>
            {itemName}
          </h2>
          <button className="soundboard-modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="soundboard-modal-form">
          <div className="soundboard-form-group">
            <label htmlFor="soundboard-url">Sound URL from 101soundboards.com</label>
            <input
              id="soundboard-url"
              type="text"
              value={soundUrl}
              onChange={(e) => setSoundUrl(e.target.value)}
              onPaste={handlePaste}
              placeholder="https://www.101soundboards.com/sounds/..."
              disabled={isLoading}
              autoFocus
              className={isValidUrl ? 'valid' : ''}
            />
            <div className="soundboard-help-text">
              <a 
                href="https://www.101soundboards.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="soundboard-link"
              >
                Browse 101soundboards.com →
              </a>
              <span className="soundboard-info">
                Find a sound, copy its URL, and paste it here
              </span>
            </div>
            {soundUrl && isValidUrl && (
              <div className="soundboard-url-valid">
                ✓ Valid 101soundboards URL
              </div>
            )}
          </div>

          <div className="soundboard-info-box">
            <p>📣 Sounds will be heard by all users on the stream</p>
            <p>⏱️ Maximum duration: 60 seconds</p>
            <p>🎵 Sounds are queued if multiple are playing</p>
          </div>

          {error && (
            <div className="soundboard-error-message">
              {error}
            </div>
          )}

          <div className="soundboard-modal-actions">
            <button
              type="button"
              className="soundboard-btn soundboard-btn-cancel"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="soundboard-btn soundboard-btn-submit"
              disabled={isLoading || !soundUrl.trim() || !isValidUrl}
            >
              {isLoading ? 'Playing...' : 'Play Sound'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SoundboardInputModal;