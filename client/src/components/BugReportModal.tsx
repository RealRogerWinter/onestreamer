import React, { useState } from 'react';
import './BugReportModal.css';

interface BugReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  socket: any;
  isAuthenticated: boolean;
  currentUser: any;
}

const BugReportModal: React.FC<BugReportModalProps> = ({ 
  isOpen, 
  onClose, 
  socket, 
  isAuthenticated,
  currentUser 
}) => {
  const [bugDescription, setBugDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!bugDescription.trim()) {
      setSubmitStatus({ type: 'error', message: 'Please describe the bug' });
      return;
    }

    setSubmitting(true);
    setSubmitStatus(null);

    try {
      // Collect session data
      const sessionData = {
        userAgent: navigator.userAgent,
        screenResolution: `${window.screen.width}x${window.screen.height}`,
        windowSize: `${window.innerWidth}x${window.innerHeight}`,
        url: window.location.href,
        timestamp: new Date().toISOString(),
        platform: navigator.platform,
        language: navigator.language,
        cookiesEnabled: navigator.cookieEnabled,
        onlineStatus: navigator.onLine
      };

      // Send bug report to server
      const response = await fetch('/api/bug-reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': isAuthenticated ? `Bearer ${localStorage.getItem('token')}` : ''
        },
        body: JSON.stringify({
          description: bugDescription,
          username: isAuthenticated ? currentUser?.username : null,
          sessionData
        })
      });

      if (response.ok) {
        setSubmitStatus({ type: 'success', message: 'Bug report submitted successfully!' });
        setBugDescription('');
        setTimeout(() => {
          onClose();
          setSubmitStatus(null);
        }, 2000);
      } else {
        throw new Error('Failed to submit bug report');
      }
    } catch (error) {
      console.error('Error submitting bug report:', error);
      setSubmitStatus({ type: 'error', message: 'Failed to submit bug report. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="bug-report-modal-overlay" onClick={onClose}>
      <div className="bug-report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bug-report-header">
          <h2>Report a Bug</h2>
          <button className="bug-report-close" onClick={onClose}>×</button>
        </div>
        
        <form onSubmit={handleSubmit} className="bug-report-form">
          <div className="bug-report-info">
            <p>Help us improve by reporting any issues you encounter.</p>
            {isAuthenticated ? (
              <p className="bug-report-user">Reporting as: <strong>{currentUser?.username}</strong></p>
            ) : (
              <p className="bug-report-user">Reporting as: <strong>Anonymous</strong></p>
            )}
          </div>

          <div className="bug-report-field">
            <label htmlFor="bug-description">Describe the bug:</label>
            <textarea
              id="bug-description"
              value={bugDescription}
              onChange={(e) => setBugDescription(e.target.value)}
              placeholder="Please describe what happened, what you expected to happen, and steps to reproduce the issue..."
              rows={8}
              maxLength={2000}
              required
              disabled={submitting}
            />
            <div className="character-count">
              {bugDescription.length}/2000 characters
            </div>
          </div>

          {submitStatus && (
            <div className={`bug-report-status ${submitStatus.type}`}>
              {submitStatus.message}
            </div>
          )}

          <div className="bug-report-actions">
            <button 
              type="button" 
              className="bug-report-cancel" 
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="bug-report-submit"
              disabled={submitting || !bugDescription.trim()}
            >
              {submitting ? 'Submitting...' : 'Submit Report'}
            </button>
          </div>
        </form>

        <div className="bug-report-footer">
          <p>Your session information will be included to help diagnose the issue.</p>
        </div>
      </div>
    </div>
  );
};

export default BugReportModal;