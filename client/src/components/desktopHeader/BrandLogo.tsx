import React from 'react';

const BrandLogo: React.FC = () => (
  <div className="header-v2-left">
    <div className="brand-logo-modern">
      <div className="logo-wrapper">
        <div className="logo-icon">
          <div className="logo-glow-ring"></div>
          <div className="logo-sparkles">
            <span className="sparkle sparkle-1"></span>
            <span className="sparkle sparkle-2"></span>
            <span className="sparkle sparkle-3"></span>
          </div>
          <img
            src="/logo-header-v2.png"
            alt="OneStreamer Logo"
            className="header-logo-img"
          />
        </div>
        <span className="brand-name">OneStreamer</span>
      </div>
    </div>
  </div>
);

export default BrandLogo;
