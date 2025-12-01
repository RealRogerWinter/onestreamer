import React, { useState } from 'react';
import authService from '../../services/AuthService';
import '../../styles/Clips.css';

interface ClipCreationModalProps {
  onClose: () => void;
  onSuccess?: (clipId: string) => void;
}

interface SuccessInfo {
  clipId: string;
  duration: number;
}

const DURATION_OPTIONS = [30, 60, 90, 120];

// Estimate processing time based on clip duration (roughly 1-1.5x real-time)
const getProcessingEstimate = (durationSeconds: number): string => {
  const estimatedSeconds = Math.ceil(durationSeconds * 1.2) + 10; // Add 10s for overhead
  if (estimatedSeconds < 60) {
    return `~${estimatedSeconds} seconds`;
  }
  const minutes = Math.ceil(estimatedSeconds / 60);
  return `~${minutes} minute${minutes > 1 ? 's' : ''}`;
};

const ClipCreationModal: React.FC<ClipCreationModalProps> = ({ onClose, onSuccess }) => {
  const [duration, setDuration] = useState(30);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessInfo | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      setError('Please enter a title for your clip');
      return;
    }

    if (title.length > 100) {
      setError('Title must be 100 characters or less');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const token = authService.getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      // Only add auth header if user is logged in
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/clips/live', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          duration,
          title: title.trim(),
          description: description.trim()
        })
      });

      const data = await response.json();

      if (data.success) {
        setSuccess({ clipId: data.clipId, duration });
        onSuccess?.(data.clipId);
      } else {
        setError(data.error || 'Failed to create clip');
      }
    } catch (err) {
      console.error('Error creating clip:', err);
      setError('Failed to create clip. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Success view
  if (success) {
    const clipUrl = `/clips/${success.clipId}`;
    return (
      <div className="clip-modal-overlay" onClick={handleOverlayClick}>
        <div className="clip-modal clip-modal-success">
          <div className="success-icon">✂️</div>
          <h2>Clip Created!</h2>
          <p className="success-message">
            Your {success.duration}-second clip is now processing.
          </p>
          <p className="processing-estimate">
            Estimated processing time: {getProcessingEstimate(success.duration)}
          </p>
          <div className="clip-link-container">
            <a
              href={clipUrl}
              className="clip-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              View Clip
            </a>
            <button
              type="button"
              className="btn-copy"
              onClick={() => {
                navigator.clipboard.writeText(window.location.origin + clipUrl);
                // Could add a toast here
              }}
              title="Copy link to clipboard"
            >
              Copy Link
            </button>
          </div>
          <button
            type="button"
            className="btn-close-success"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="clip-modal-overlay" onClick={handleOverlayClick}>
      <div className="clip-modal">
        <h2>Create Clip</h2>

        <form onSubmit={handleSubmit}>
          <div className="duration-selector">
            <label>Clip Duration</label>
            <div className="duration-buttons">
              {DURATION_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={duration === d ? 'active' : ''}
                  onClick={() => setDuration(d)}
                >
                  {d}s
                </button>
              ))}
            </div>
            <p>Clips the last {duration} seconds of the stream</p>
          </div>

          <div className="clip-form-group">
            <label htmlFor="clip-title">Title (required)</label>
            <input
              id="clip-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="Give your clip a title"
              autoFocus
            />
          </div>

          <div className="clip-form-group">
            <label htmlFor="clip-description">Description (optional)</label>
            <textarea
              id="clip-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder="Add a description..."
            />
          </div>

          {error && (
            <p style={{ color: '#ff6b6b', fontSize: '14px', marginBottom: '16px' }}>
              {error}
            </p>
          )}

          <div className="clip-modal-actions">
            <button
              type="button"
              className="btn-cancel"
              onClick={onClose}
              disabled={creating}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-create"
              disabled={!title.trim() || creating}
            >
              {creating ? 'Creating...' : 'Create Clip'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ClipCreationModal;
