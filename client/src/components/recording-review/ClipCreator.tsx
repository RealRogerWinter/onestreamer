import React, { useState } from 'react';

interface ClipCreatorProps {
  sessionId: string;
  startMs: number;
  endMs: number;
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  onClose: () => void;
  onCreated: () => void;
  formatDuration: (ms: number) => string;
}

const ClipCreator: React.FC<ClipCreatorProps> = ({
  sessionId,
  startMs,
  endMs,
  makeApiCall,
  onClose,
  onCreated,
  formatDuration
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duration = endMs - startMs;
  const minDuration = 5000; // 5 seconds
  const maxDuration = 120000; // 2 minutes

  const isValidDuration = duration >= minDuration && duration <= maxDuration;

  const handleCreate = async () => {
    if (!title.trim()) {
      setError('Please enter a title');
      return;
    }

    if (!isValidDuration) {
      setError(`Clip must be between 5 seconds and 2 minutes`);
      return;
    }

    try {
      setCreating(true);
      setError(null);

      const response = await makeApiCall(`/admin/review/sessions/${sessionId}/clip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          startMs,
          endMs,
          title: title.trim(),
          description: description.trim()
        })
      });

      if (response.success) {
        onCreated();
      } else {
        setError(response.error || 'Failed to create clip');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create clip');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="clip-creator">
      <div className="clip-creator-header">
        <h4>Create Clip</h4>
        <button className="close-btn" onClick={onClose}>&times;</button>
      </div>

      <div className="clip-creator-body">
        <div className="clip-preview">
          <div className="preview-row">
            <span className="preview-label">Start:</span>
            <span className="preview-value">{formatDuration(startMs)}</span>
          </div>
          <div className="preview-row">
            <span className="preview-label">End:</span>
            <span className="preview-value">{formatDuration(endMs)}</span>
          </div>
          <div className="preview-row">
            <span className="preview-label">Duration:</span>
            <span className={`preview-value ${!isValidDuration ? 'invalid' : ''}`}>
              {formatDuration(duration)}
              {!isValidDuration && (
                <span className="duration-hint">
                  (must be 5s - 2min)
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="clip-title">Title *</label>
          <input
            id="clip-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Enter clip title..."
            maxLength={100}
          />
        </div>

        <div className="form-group">
          <label htmlFor="clip-description">Description (optional)</label>
          <textarea
            id="clip-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a description..."
            maxLength={500}
            rows={3}
          />
        </div>

        {error && <div className="clip-error">{error}</div>}
      </div>

      <div className="clip-creator-footer">
        <button className="cancel-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="create-btn"
          onClick={handleCreate}
          disabled={creating || !isValidDuration}
        >
          {creating ? 'Creating...' : 'Create Clip'}
        </button>
      </div>
    </div>
  );
};

export default ClipCreator;
