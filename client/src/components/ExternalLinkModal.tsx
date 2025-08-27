import React from 'react';
import './ExternalLinkModal.css';

interface ExternalLinkModalProps {
  isOpen: boolean;
  url: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ExternalLinkModal: React.FC<ExternalLinkModalProps> = ({ isOpen, url, onConfirm, onCancel }) => {
  if (!isOpen) return null;

  // Extract domain from URL for display
  const getDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return 'external site';
    }
  };

  const domain = getDomain(url);
  const isOneStreamerDomain = domain === 'onestreamer.com' || 
                              domain === 'www.onestreamer.com' ||
                              domain === 'onestreamer.live' || 
                              domain === 'www.onestreamer.live';

  // Don't show modal for internal links
  if (isOneStreamerDomain) {
    onConfirm();
    return null;
  }

  return (
    <div className="external-link-modal-overlay" onClick={onCancel}>
      <div className="external-link-modal" onClick={(e) => e.stopPropagation()}>
        <div className="external-link-modal-header">
          <h2>⚠️ External Link Warning</h2>
        </div>
        <div className="external-link-modal-content">
          <p>You are about to leave OneStreamer and visit an external website:</p>
          <div className="external-link-url">
            {domain}
          </div>
          <div className="external-link-warning">
            <strong>Please be aware:</strong>
            <ul>
              <li>OneStreamer takes no responsibility for the content of external websites</li>
              <li>Your privacy and security may be at risk on external sites</li>
              <li>Exercise caution when visiting unfamiliar websites</li>
              <li>Never enter your OneStreamer credentials on external sites</li>
            </ul>
          </div>
          <p className="external-link-full-url">
            Full URL: <span>{url}</span>
          </p>
        </div>
        <div className="external-link-modal-footer">
          <button className="external-link-btn-stay" onClick={onCancel}>
            Stay on OneStreamer
          </button>
          <button className="external-link-btn-continue" onClick={onConfirm}>
            Continue to External Site
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExternalLinkModal;