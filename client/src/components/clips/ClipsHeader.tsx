import React from 'react';

interface ClipsHeaderProps {
  showBackToClips?: boolean;
}

const ClipsHeader: React.FC<ClipsHeaderProps> = ({ showBackToClips = false }) => {
  return (
    <header className="clips-header">
      <div className="clips-header-container">
        <a href="/" className="clips-header-logo">
          <img
            src="/logo-header-v2.png"
            alt="OneStreamer"
            className="clips-logo-img"
          />
          <span className="clips-brand-name">OneStreamer</span>
        </a>

        <nav className="clips-header-nav">
          <span className="clips-nav-divider">/</span>
          {showBackToClips ? (
            <a href="/clips" className="clips-nav-link">Clips</a>
          ) : (
            <span className="clips-nav-current">Clips</span>
          )}
        </nav>
      </div>
    </header>
  );
};

export default ClipsHeader;
